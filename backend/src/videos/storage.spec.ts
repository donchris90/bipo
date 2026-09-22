import { Readable } from 'stream';
import { StorageController } from './storage.controller';
import { isServableKey, parseByteRange } from './storage-range';
import { S3StorageProvider } from './providers/s3-storage-provider';
import { UnavailableStorageProvider } from './providers/storage-provider.interface';

describe('parseByteRange', () => {
  it('accepts a single simple range and rejects the rest', () => {
    expect(parseByteRange('bytes=0-1023')).toBe('bytes=0-1023');
    expect(parseByteRange('bytes=500-')).toBe('bytes=500-');
    expect(parseByteRange('bytes=-500')).toBe('bytes=-500');
    expect(parseByteRange('bytes=0-1,5-9')).toBeNull();
    expect(parseByteRange('bytes=10-5')).toBeNull();
    expect(parseByteRange('bytes=-')).toBeNull();
    expect(parseByteRange('lines=1-2')).toBeNull();
    expect(parseByteRange(undefined)).toBeNull();
  });
});

describe('isServableKey', () => {
  it('serves only public playback keys and nothing that climbs out of them', () => {
    expect(isServableKey('videos/ab12/cd-34.mp4')).toBe(true);
    expect(isServableKey('thumbnails/x/y.jpg')).toBe(true);
    for (const bad of ['kyc/x.jpg', 'videos/../secret.txt', '../videos/a.mp4', 'videos//a.mp4', 'videos/a', 'videos/a.mp4/../../x.mp4', '', undefined, 'videos/' + 'a'.repeat(300) + '.mp4', 'videos/a b.mp4']) {
      expect(isServableKey(bad as any)).toBe(false);
    }
  });
});

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: [] as Buffer[], destroyed: false };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  res.json = (b: any) => { res.jsonBody = b; return res; };
  res.write = (c: any) => { res.body.push(Buffer.from(c)); return true; };
  res.end = () => { res.finished = true; };
  res.on = () => res; res.once = () => res; res.emit = () => true; res.removeListener = () => res;
  res.destroy = () => { res.destroyed = true; };
  return res;
}
const waitEnd = (res: any) => new Promise<void>((r) => { const t = setInterval(() => { if (res.finished || res.jsonBody || res.destroyed) { clearInterval(t); r(); } }, 5); });

describe('StorageController', () => {
  const build = (read: jest.Mock | undefined) => new StorageController({ readObject: read } as any);
  const call = async (c: StorageController, key: string, range?: string) => {
    const res = fakeRes();
    await c.file({ params: { 0: key }, headers: range ? { range } : {} } as any, res);
    await waitEnd(res);
    return res;
  };

  it('streams a video with the headers players need', async () => {
    const read = jest.fn().mockResolvedValue({ body: Readable.from([Buffer.from('abc')]), contentType: 'video/mp4', contentLength: 3, contentRange: null, partial: false });
    const res = await call(build(read), 'videos/u/a.mp4');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('3');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('serves a byte range as 206 with Content-Range, passing the range to storage', async () => {
    const read = jest.fn().mockResolvedValue({ body: Readable.from([Buffer.from('ab')]), contentType: 'video/mp4', contentLength: 2, contentRange: 'bytes 0-1/100', partial: true });
    const res = await call(build(read), 'videos/u/a.mp4', 'bytes=0-1');
    expect(read).toHaveBeenCalledWith('videos/u/a.mp4', 'bytes=0-1');
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-1/100');
  });

  it('404s for a missing object and for any key outside the public prefixes, without touching storage', async () => {
    const read = jest.fn().mockResolvedValue(null);
    expect((await call(build(read), 'videos/u/gone.mp4')).statusCode).toBe(404);
    const read2 = jest.fn();
    expect((await call(build(read2), 'kyc/u/id.jpg')).statusCode).toBe(404);
    expect(read2).not.toHaveBeenCalled();
  });

  it('when storage is not configured it answers 503 with the reason', async () => {
    const c = new StorageController(new UnavailableStorageProvider('set S3_ENDPOINT') as any);
    const res = await call(c, 'videos/u/a.mp4');
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.message).toContain('set S3_ENDPOINT');
  });
});

describe('S3 configuration', () => {
  const cfg = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as any;
  const base = { S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_BASE_URL: 'https://api.example.com/api/v1/storage/files' };

  it('region "auto" without an endpoint (Cloudflare R2) is refused with a message that says what to add', () => {
    expect(() => new S3StorageProvider(cfg({ ...base, S3_REGION: 'auto' }))).toThrow(/S3_ENDPOINT is required/);
    expect(() => new S3StorageProvider(cfg(base))).toThrow(/S3_ENDPOINT is required/); // region defaults to auto
  });

  it('accepts R2 with its endpoint, and AWS with a real region', () => {
    expect(() => new S3StorageProvider(cfg({ ...base, S3_REGION: 'auto', S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com' }))).not.toThrow();
    expect(() => new S3StorageProvider(cfg({ ...base, S3_REGION: 'eu-west-1' }))).not.toThrow();
  });

  it('builds the public URL from S3_PUBLIC_BASE_URL, so it can point at the API proxy', () => {
    const p = new S3StorageProvider(cfg({ ...base, S3_REGION: 'auto', S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com' }));
    expect(p.publicUrl('videos/u/a.mp4')).toBe('https://api.example.com/api/v1/storage/files/videos/u/a.mp4');
  });
});

describe('S3StorageProvider.check (the admin storage self-test)', () => {
  const make = (send: jest.Mock) => {
    const values: Record<string, string> = { S3_BUCKET: 'ryda', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_BASE_URL: 'https://a/b', S3_REGION: 'auto', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' };
    const p = new S3StorageProvider({ get: (k: string) => values[k] } as any);
    (p as any).client = { send };
    return p;
  };

  it('reports success without revealing any credential', async () => {
    const res = await make(jest.fn().mockResolvedValue({})).check();
    expect(res).toEqual({ ok: true, bucket: 'ryda', endpointHost: 'acct.r2.cloudflarestorage.com' });
    expect(JSON.stringify(res)).not.toMatch(/"k"|"s"/);
  });

  it.each([
    ['InvalidAccessKeyId', 403, /access key id is wrong/],
    ['SignatureDoesNotMatch', 403, /secret key is wrong/],
    ['AccessDenied', 403, /Object Read & Write/],
    ['NoSuchBucket', 404, /check S3_BUCKET/],
    ['ENOTFOUND', undefined, /endpoint address does not exist/],
  ])('names the problem and what to look at: %s', async (name, status, hint) => {
    const err: any = Object.assign(new Error('boom'), { name, $metadata: { httpStatusCode: status } });
    const res = await make(jest.fn().mockRejectedValue(err)).check();
    expect(res.ok).toBe(false);
    expect(res.errorName).toBe(name);
    expect(res.hint).toMatch(hint);
  });

  it('the file route logs the real cause but keeps the public answer generic', async () => {
    const read = jest.fn().mockRejectedValue(Object.assign(new Error('The secret is wrong'), { name: 'SignatureDoesNotMatch' }));
    const c = new StorageController({ readObject: read } as any);
    const res = fakeRes();
    await c.file({ params: { 0: 'videos/u/a.mp4' }, headers: {} } as any, res);
    expect(res.statusCode).toBe(502);
    expect(res.jsonBody.message).toBe('Could not read that file');
    expect(JSON.stringify(res.jsonBody)).not.toContain('secret');
  });
});
