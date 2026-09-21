import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { CleanEditSpec, EditEffect, EditFilter } from './edit-spec';
import { MAX_OUTPUT_SECONDS } from './edit-spec';

// The ffmpeg program: FFMPEG_PATH if set, otherwise the one bundled by the
// `ffmpeg-static` package (installed with the server, so nothing to set up).
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bundled = require('ffmpeg-static') as string | null;
  if (!bundled || !existsSync(bundled)) throw new Error('ffmpeg is not available on this server');
  return bundled;
}

export interface Probe {
  durationMs: number;
  width: number; // as displayed (rotation already applied)
  height: number;
  hasAudio: boolean;
}

// Reads a media file's basics from ffmpeg's own report (the static build has no
// separate ffprobe). Throws if it is not readable as a video.
export function parseProbe(report: string): Probe {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report);
  const v = /Stream #\d+:\d+.*?: Video:.*?(\d{2,5})x(\d{2,5})/.exec(report);
  if (!d || !v) throw new Error('This file could not be read as a video');
  const durationMs = Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000);
  let width = Number(v[1]);
  let height = Number(v[2]);
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(report);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return { durationMs, width, height, hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(report) };
}

export function run(args: string[], timeoutMs: number, bin = ffmpegPath()): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-6000); // keep the tail: that is where the reason is
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Rendering took too long and was stopped'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export async function probeFile(path: string): Promise<Probe> {
  const { stderr } = await run(['-hide_banner', '-i', path], 30_000); // exits non-zero: it has no output file, which is fine
  return parseProbe(stderr);
}

// ── the look of each preset (the app shows the same names) ────────────────────

export const FILTER_CHAIN: Record<EditFilter, string> = {
  none: '',
  vivid: 'eq=saturation=1.35:contrast=1.08',
  warm: 'colortemperature=temperature=4600,eq=saturation=1.08',
  cool: 'colortemperature=temperature=9000',
  mono: 'hue=s=0,eq=contrast=1.12',
  vintage: 'curves=preset=vintage,eq=saturation=0.9',
  fade: 'eq=saturation=0.78:contrast=0.92:brightness=0.04',
  dramatic: 'eq=contrast=1.28:saturation=1.1:brightness=-0.03:gamma=0.92',
};

// Effects that are a single filter. (Glow needs the picture twice, so it is built into the graph.)
export const EFFECT_CHAIN: Record<Exclude<EditEffect, 'glow'>, string> = {
  none: '',
  vignette: 'vignette=PI/4',
  grain: 'noise=alls=14:allf=t+u',
  pulse: "eq=brightness='0.07*sin(2*PI*t*2)':eval=frame",
  sharpen: 'unsharp=5:5:0.9:5:5:0.0',
};

export interface RenderPlan {
  srcPath: string;
  overlayPath?: string | null;
  musicPath?: string | null;
  outPath: string;
  probe: Probe;
  spec: CleanEditSpec;
}

export const CANVAS_WIDTH = 720;
export const CANVAS_HEIGHT = 1280;

// The app's preview uses the same rule (keep the two in step): a video whose shape is
// close to a phone screen fills the canvas; anything else is shown whole with bars.
export function canvasFit(aspect: number): 'cover' | 'contain' {
  return aspect >= 0.5 && aspect <= 0.66 ? 'cover' : 'contain';
}

// The exact ffmpeg command for an edit. Pure, so it can be tested without running
// anything. Also returns the length of the finished video.
export function buildRenderArgs(plan: RenderPlan): { args: string[]; outputSeconds: number; width: number; height: number } {
  const { probe, spec } = plan;
  const startMs = Math.min(spec.trim?.startMs ?? 0, Math.max(0, probe.durationMs - 1000));
  const endMs = Math.min(spec.trim?.endMs ?? probe.durationMs, probe.durationMs);
  const clipSeconds = Math.max(0.5, (endMs - startMs) / 1000);
  const outputSeconds = Math.min(clipSeconds / spec.speed, MAX_OUTPUT_SECONDS);

  // Every edited video is a 9:16 phone-screen canvas (720x1280), the same shape as
  // the editor's preview, so the text and stickers the creator placed land exactly
  // where they put them. A video close to that shape fills it (edges trimmed); any
  // other shape sits inside it with black bars.
  const fit = canvasFit(probe.width / probe.height);
  const width = CANVAS_WIDTH;

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', (startMs / 1000).toFixed(3), '-t', clipSeconds.toFixed(3), '-i', plan.srcPath];
  let next = 1;
  let overlayIdx = -1;
  let musicIdx = -1;
  if (plan.overlayPath) {
    overlayIdx = next++;
    // The picture is looped for the length of the clip. (A one-frame image on its
    // own stalls ffmpeg as soon as any second audio input is present — found by
    // testing every combination — so it is always given a length.)
    args.push('-loop', '1', '-framerate', '30', '-t', clipSeconds.toFixed(3), '-i', plan.overlayPath);
  }
  if (plan.musicPath) {
    musicIdx = next++;
    // Looped so a short song covers the whole video, but bounded so the input ends.
    args.push('-stream_loop', '-1', '-t', (spec.music.startMs / 1000 + outputSeconds + 0.5).toFixed(3), '-i', plan.musicPath);
  }

  // ── picture ──
  const v: string[] = [];
  if (spec.speed !== 1) v.push(`setpts=PTS/${spec.speed}`);
  v.push(fit === 'cover' ? `scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:force_original_aspect_ratio=increase,crop=${CANVAS_WIDTH}:${CANVAS_HEIGHT}` : `scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:force_original_aspect_ratio=decrease,pad=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`);
  if (FILTER_CHAIN[spec.filter]) v.push(FILTER_CHAIN[spec.filter]);
  if (spec.effect !== 'glow' && EFFECT_CHAIN[spec.effect]) v.push(EFFECT_CHAIN[spec.effect]);
  v.push('format=yuv420p');

  const graph: string[] = [];
  let cur = 'vbase';
  graph.push(`[0:v]${v.join(',')}[${cur}]`);
  if (spec.effect === 'glow') {
    graph.push(`[${cur}]split[g1][g2]`, '[g2]gblur=sigma=14[gb]', '[g1][gb]blend=all_mode=screen:all_opacity=0.35[vglow]');
    cur = 'vglow';
  }
  if (overlayIdx >= 0) {
    // The text and stickers, drawn by the app as one see-through picture, laid over the whole video.
    graph.push(`[${overlayIdx}:v]format=rgba[ovraw]`, `[ovraw][${cur}]scale2ref[ovs][vb]`, '[vb][ovs]overlay=0:0:format=auto,format=yuv420p[vout]');
  } else {
    graph.push(`[${cur}]null[vout]`);
  }

  // ── sound ──
  const hasOriginal = probe.hasAudio;
  let audioLabel: string | null = null;
  if (hasOriginal) {
    const a = [];
    if (spec.speed !== 1) a.push(`atempo=${spec.speed}`);
    a.push(`volume=${spec.music.volumeOriginal}`);
    graph.push(`[0:a]${a.join(',')}[a0]`);
    audioLabel = 'a0';
  }
  if (musicIdx >= 0) {
    const start = (spec.music.startMs / 1000).toFixed(3);
    graph.push(`[${musicIdx}:a]atrim=start=${start}:duration=${outputSeconds.toFixed(3)},asetpts=PTS-STARTPTS,volume=${spec.music.volumeMusic}[a1]`);
    if (audioLabel) {
      graph.push('[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
      audioLabel = 'aout';
    } else {
      audioLabel = 'a1';
    }
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (audioLabel) args.push('-map', `[${audioLabel}]`, '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', outputSeconds.toFixed(3), plan.outPath);
  return { args, outputSeconds, width, height: CANVAS_HEIGHT };
}

export function thumbnailArgs(videoPath: string, outPath: string, atSeconds: number): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', atSeconds.toFixed(2), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', outPath];
}
