// Accepts one simple HTTP byte range ("bytes=0-1023", "bytes=500-", "bytes=-500")
// and returns it unchanged, or null for anything else (multiple ranges, junk).
// Video players ask for ranges to seek and to start playing before the whole
// file has downloaded.
export function parseByteRange(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] !== '' && m[2] !== '' && Number(m[1]) > Number(m[2])) return null;
  return `bytes=${m[1]}-${m[2]}`;
}

// Only keys this app writes for public playback are served. Everything else in
// the bucket stays private, and nothing can climb out of these prefixes.
const KEY_RE = /^(videos|thumbnails)\/[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*\.[A-Za-z0-9]{2,5}$/;
export function isServableKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 240 && KEY_RE.test(key) && !key.includes('..');
}
