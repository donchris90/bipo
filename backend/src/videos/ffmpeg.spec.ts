import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EDIT_EFFECTS, EDIT_FILTERS, cleanEditSpec } from './edit-spec';
import { buildRenderArgs, canvasFit, ffmpegPath, parseProbe, probeFile, run, thumbnailArgs } from './ffmpeg';

const spec = (over: any = {}) => cleanEditSpec(over);
const probe = { durationMs: 3000, width: 320, height: 568, hasAudio: true };

describe('parseProbe', () => {
  it('reads length, size, and whether there is sound', () => {
    const report = `Input #0, mov,mp4\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 117 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1080x1920, 39 kb/s, 30 fps\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, mono`;
    expect(parseProbe(report)).toEqual({ durationMs: 62_500, width: 1080, height: 1920, hasAudio: true });
  });

  it('swaps the size for a phone video stored sideways with a rotation flag', () => {
    const report = `  Duration: 00:00:05.00, start: 0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n    displaymatrix: rotation of -90.00 degrees`;
    expect(parseProbe(report)).toMatchObject({ width: 1080, height: 1920, hasAudio: false });
  });

  it('refuses something that is not a video', () => {
    expect(() => parseProbe('garbage')).toThrow(/could not be read as a video/);
  });
});

describe('buildRenderArgs (the command, without running it)', () => {
  const base = { srcPath: 'in.mp4', outPath: 'out.mp4', probe };

  it('a plain render re-encodes to phone-friendly H.264/AAC on a 720x1280 canvas', () => {
    const { args, outputSeconds, width, height } = buildRenderArgs({ ...base, spec: spec() });
    expect([width, height]).toEqual([720, 1280]);
    expect(outputSeconds).toBeCloseTo(3, 1);
    expect(args).toEqual(expect.arrayContaining(['libx264', 'aac', '+faststart', 'yuv420p']));
  });

  it('a phone-shaped video fills the canvas; another shape sits inside it with bars (the app previews the same rule)', () => {
    expect(canvasFit(9 / 16)).toBe('cover');
    expect(canvasFit(1080 / 1920)).toBe('cover');
    expect(canvasFit(16 / 9)).toBe('contain');
    expect(canvasFit(1)).toBe('contain');
    expect(canvasFit(9 / 21)).toBe('contain');
    const cover = buildRenderArgs({ ...base, spec: spec() }).args.join(' ');
    expect(cover).toContain('force_original_aspect_ratio=increase,crop=720:1280');
    const contain = buildRenderArgs({ ...base, probe: { ...probe, width: 1280, height: 720 }, spec: spec() }).args.join(' ');
    expect(contain).toContain('force_original_aspect_ratio=decrease,pad=720:1280');
  });

  it('trim and speed change the length: 2x speed halves it, 0.5x doubles it', () => {
    expect(buildRenderArgs({ ...base, spec: spec({ trim: { startMs: 1000, endMs: 3000 } }) }).outputSeconds).toBeCloseTo(2, 1);
    const fast = buildRenderArgs({ ...base, spec: spec({ speed: 2 }) });
    expect(fast.outputSeconds).toBeCloseTo(1.5, 1);
    expect(fast.args.join(' ')).toContain('setpts=PTS/2');
    expect(fast.args.join(' ')).toContain('atempo=2');
    expect(buildRenderArgs({ ...base, spec: spec({ speed: 0.5 }) }).outputSeconds).toBeCloseTo(6, 1);
  });

  it('a video without sound gets no audio track unless music is added', () => {
    const mute = { ...probe, hasAudio: false };
    expect(buildRenderArgs({ ...base, probe: mute, spec: spec() }).args).toContain('-an');
    const withMusic = buildRenderArgs({ ...base, probe: mute, musicPath: 'm.m4a', spec: spec() }).args.join(' ');
    expect(withMusic).not.toContain('-an');
    expect(withMusic).not.toContain('amix');
  });

  it('music with original sound is mixed, at the chosen volumes, and loops if it is short', () => {
    const cmd = buildRenderArgs({ ...base, musicPath: 'm.m4a', spec: spec({ music: { volumeOriginal: 0.3, volumeMusic: 0.9 } }) }).args.join(' ');
    expect(cmd).toContain('amix=inputs=2');
    expect(cmd).toContain('volume=0.3');
    expect(cmd).toContain('volume=0.9');
    expect(cmd).toContain('-stream_loop -1');
  });

  it('the text/sticker layer is scaled to the video and laid over it', () => {
    expect(buildRenderArgs({ ...base, overlayPath: 'o.png', spec: spec() }).args.join(' ')).toContain('scale2ref');
  });

  it('every filter and effect has a chain (nothing in the app is missing on the server)', () => {
    for (const filter of EDIT_FILTERS) expect(() => buildRenderArgs({ ...base, spec: spec({ filter }) })).not.toThrow();
    for (const effect of EDIT_EFFECTS) expect(() => buildRenderArgs({ ...base, spec: spec({ effect }) })).not.toThrow();
  });

  it('the output can never exceed 3 minutes', () => {
    const long = { ...probe, durationMs: 600_000 };
    expect(buildRenderArgs({ ...base, probe: long, spec: spec() }).outputSeconds).toBe(180);
  });
});

// ── real renders with the real ffmpeg ────────────────────────────────────────────
let bin = '';
try {
  bin = ffmpegPath();
} catch {
  /* ffmpeg missing: the integration tests below are skipped */
}
const real = bin ? describe : describe.skip;

real('rendering with the real ffmpeg', () => {
  jest.setTimeout(120_000);
  let dir = '';
  const src = () => join(dir, 'src.mp4');
  const silent = () => join(dir, 'silent.mp4');
  const overlay = () => join(dir, 'ov.png');
  const music = () => join(dir, 'music.m4a');
  const out = (n: string) => join(dir, `${n}.mp4`);
  const gen = (args: string[]) => execFileSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  // average red of the first frame, 0-255
  const avgRed = (file: string) => {
    const raw = execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=16:16', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
    let sum = 0;
    for (let i = 0; i < raw.length; i += 3) sum += raw[i];
    return sum / (raw.length / 3);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
    gen(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x568:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src()]);
    gen(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x568:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent()]);
    gen(['-f', 'lavfi', '-i', 'color=c=red@0.8:s=200x300,format=rgba', '-frames:v', '1', overlay()]);
    gen(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'aac', music()]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const render = async (name: string, s: any, extra: { overlay?: boolean; music?: boolean; source?: string } = {}) => {
    const source = extra.source ?? src();
    const p = await probeFile(source);
    const plan = buildRenderArgs({ srcPath: source, overlayPath: extra.overlay ? overlay() : null, musicPath: extra.music ? music() : null, outPath: out(name), probe: p, spec: cleanEditSpec(s) });
    const res = await run(plan.args, 90_000);
    if (res.code !== 0) throw new Error(`ffmpeg failed for ${name}: ${res.stderr}`);
    return { probe: await probeFile(out(name)), plan };
  };

  it('a plain render produces a playable video of the same length, with sound', async () => {
    const { probe: o } = await render('plain', {});
    expect(o.durationMs).toBeGreaterThan(2800);
    expect(o.durationMs).toBeLessThan(3300);
    expect(o).toMatchObject({ width: 720, height: 1280, hasAudio: true });
  });

  it('a landscape video is fitted inside the portrait canvas with bars', async () => {
    const land = join(dir, 'landscape-source.mp4');
    gen(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', land]);
    const { probe: o } = await render('land', {}, { source: land });
    expect([o.width, o.height]).toEqual([720, 1280]);
  });

  it('trim cuts to the chosen part', async () => {
    const { probe: o } = await render('trim', { trim: { startMs: 1000, endMs: 2500 } });
    expect(o.durationMs).toBeGreaterThan(1300);
    expect(o.durationMs).toBeLessThan(1800);
  });

  it('speed changes the length and keeps the sound', async () => {
    const fast = (await render('fast', { speed: 2 })).probe;
    expect(fast.durationMs).toBeLessThan(1800);
    expect(fast.hasAudio).toBe(true);
    const slow = (await render('slow', { speed: 0.5 })).probe;
    expect(slow.durationMs).toBeGreaterThan(5500);
  });

  it.each([...EDIT_FILTERS])('filter "%s" renders', async (filter) => {
    const { probe: o } = await render(`f-${filter}`, { filter });
    expect(o.durationMs).toBeGreaterThan(2800);
  });

  it.each([...EDIT_EFFECTS])('effect "%s" renders', async (effect) => {
    const { probe: o } = await render(`e-${effect}`, { effect });
    expect(o.durationMs).toBeGreaterThan(2800);
  });

  it('the text/sticker layer really appears on the picture', async () => {
    await render('plain2', {});
    await render('withov', {}, { overlay: true });
    // a strong red layer over the whole video raises the average red
    expect(avgRed(out('withov'))).toBeGreaterThan(avgRed(out('plain2')) + 20);
  });

  it('music is mixed into a video that has sound, and given to one that has none', async () => {
    const mixed = (await render('mixed', { music: { volumeOriginal: 0.5, volumeMusic: 1 } }, { music: true })).probe;
    expect(mixed.hasAudio).toBe(true);
    const onto = (await render('onto-silent', {}, { music: true, source: silent() })).probe;
    expect(onto.hasAudio).toBe(true);
    // the 2-second song loops to cover the 3-second video
    expect(onto.durationMs).toBeGreaterThan(2800);
  });

  it('everything together, and a thumbnail', async () => {
    const { probe: o } = await render('all', { trim: { startMs: 500, endMs: 2800 }, speed: 1.5, filter: 'warm', effect: 'vignette', music: { volumeOriginal: 0.4, volumeMusic: 0.9, startMs: 200 } }, { overlay: true, music: true });
    expect(o.durationMs).toBeGreaterThan(1300);
    expect(o.hasAudio).toBe(true);
    const thumb = join(dir, 'thumb.jpg');
    const res = await run(thumbnailArgs(out('all'), thumb, 0.5), 30_000);
    expect(res.code).toBe(0);
    expect(existsSync(thumb)).toBe(true);
    expect(statSync(thumb).size).toBeGreaterThan(500);
  });

  it('a file that is not a video is refused, not crashed on', async () => {
    const junk = join(dir, 'junk.mp4');
    require('fs').writeFileSync(junk, 'this is not a video');
    await expect(probeFile(junk)).rejects.toThrow(/could not be read as a video/);
  });
});
