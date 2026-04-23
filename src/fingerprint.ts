import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface FingerprintResult {
  fingerprint: string;
  duration: number; // seconds
}

export interface ChunkResult {
  offsetSeconds: number;
  windowSeconds: number;
  fingerprint: string;
  duration: number;
}

export interface ChunkedResult {
  chunks: ChunkResult[];
  totalDuration: number;
  byteLength: number;
}

export type AudioDecodeReason =
  | 'audio_too_short'
  | 'ffmpeg_error'
  | 'ffprobe_error';

export class AudioDecodeError extends Error {
  reason: AudioDecodeReason;
  inputBytes?: number;
  inputDurationSeconds?: number;
  stderr?: string;

  constructor(
    reason: AudioDecodeReason,
    message: string,
    extra?: {
      inputBytes?: number;
      inputDurationSeconds?: number;
      stderr?: string;
    },
  ) {
    super(message);
    this.name = 'AudioDecodeError';
    this.reason = reason;
    if (extra) Object.assign(this, extra);
  }
}

// Chunked fingerprinting constants. Both stored (artist-upload) and
// query-side (identify) fingerprints MUST use the same window size so
// direct XOR comparison works without subsequence sliding.
const WINDOW_SECONDS = 30;
const STEP_SECONDS = 15; // 50% overlap between adjacent windows

/**
 * E2.7 — chunked fingerprinting.
 *
 * fpcalc 1.5.1 (Debian bookworm) can't decode short inputs reliably.
 * Workaround: every fingerprint in the system is now exactly 30 seconds
 * long. Stored fingerprints are a sliding window of 30s chunks across
 * the full track (step 15s). Query fingerprints are always normalized
 * to exactly 30 seconds (truncate longer inputs, pad shorter with
 * silence). Comparison is a direct same-length XOR — no subsequence
 * sliding needed.
 *
 * Two entry points:
 *   - fingerprint(audio) → single 30s FP (for identify queries)
 *   - fingerprintChunked(audio) → array of 30s FPs at offsets
 *     [0, 15, 30, ...] (for artist-upload seeding)
 *
 * Both use the same piped ffmpeg → fpcalc -raw approach that bypasses
 * fpcalc's buggy WAV decoder.
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const reqId = randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), `unid-fp-${reqId}-`));
  const inputPath = join(dir, 'input');

  console.log(`[fp:${reqId}] input: ${audio.length} bytes (single 30s-normalized fingerprint)`);
  logInputMagic(audio, reqId);

  try {
    await writeFile(inputPath, audio);
    // Normalize input to exactly 30s (truncate if longer, pad with
    // silence if shorter) before fingerprinting.
    return await runPipedFingerprint(inputPath, {
      ssSeconds: null,
      normalizeToWindow: true,
      reqId,
      label: 'single',
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fingerprintChunked(audio: Buffer): Promise<ChunkedResult> {
  const reqId = randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), `unid-fp-${reqId}-`));
  const inputPath = join(dir, 'input');

  console.log(`[fp:${reqId}] input: ${audio.length} bytes (chunked)`);
  logInputMagic(audio, reqId);

  try {
    await writeFile(inputPath, audio);

    // Probe total duration so we know how many windows to generate.
    let totalDuration: number;
    try {
      totalDuration = await runFfprobe(inputPath, reqId);
    } catch (err) {
      throw new AudioDecodeError('ffprobe_error',
        `Could not determine audio duration: ${err instanceof Error ? err.message : 'unknown'}`,
        { inputBytes: audio.length });
    }
    console.log(`[fp:${reqId}] total duration: ${totalDuration.toFixed(2)}s`);

    // Generate window offsets. For a 420s track: [0, 15, 30, ..., 390].
    // Short tracks (< 30s) still get one window at offset 0; the
    // normalize-to-30s step pads with silence.
    const offsets: number[] = [];
    if (totalDuration <= WINDOW_SECONDS) {
      offsets.push(0);
    } else {
      const maxOffset = totalDuration - WINDOW_SECONDS;
      for (let o = 0; o <= maxOffset; o += STEP_SECONDS) {
        offsets.push(o);
      }
      // Include a final window aligned to end-of-track if the last
      // step didn't land exactly at maxOffset.
      if (offsets[offsets.length - 1] < maxOffset - 0.5) {
        offsets.push(maxOffset);
      }
    }
    console.log(`[fp:${reqId}] generating ${offsets.length} windows at offsets ${offsets.map(o => o.toFixed(1)).join(',')}`);

    // Sequential generation — Railway containers are CPU-bound; parallel
    // ffmpeg+fpcalc pairs would contend and slow each other down.
    const chunks: ChunkResult[] = [];
    for (const offset of offsets) {
      const result = await runPipedFingerprint(inputPath, {
        ssSeconds: offset,
        normalizeToWindow: true,
        reqId,
        label: `chunk@${offset.toFixed(1)}s`,
      });
      chunks.push({
        offsetSeconds: offset,
        windowSeconds: WINDOW_SECONDS,
        fingerprint: result.fingerprint,
        duration: result.duration,
      });
    }

    console.log(`[fp:${reqId}] generated ${chunks.length} chunk fingerprints`);
    return { chunks, totalDuration, byteLength: audio.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function logInputMagic(audio: Buffer, reqId: string) {
  const magic = audio.subarray(0, 16);
  console.log(`[fp:${reqId}] input magic (hex): ${magic.toString('hex')}`);
  console.log(`[fp:${reqId}] input magic (ascii): ${magic.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);
}

/**
 * Pipe ffmpeg → fpcalc -raw stdin. All fingerprinting goes through
 * this path — it bypasses fpcalc's WAV decoder (broken on short files
 * in 1.5.1) by reading raw interleaved PCM samples from stdin.
 *
 * Options:
 *   ssSeconds         → if set, `-ss <N>` seeks to that offset before decoding
 *   normalizeToWindow → if true, pads with silence AND truncates to
 *                       exactly WINDOW_SECONDS (30s). Same length
 *                       guaranteed → direct XOR comparison works.
 */
function runPipedFingerprint(
  inputPath: string,
  opts: {
    ssSeconds: number | null;
    normalizeToWindow: boolean;
    reqId: string;
    label: string;
  },
): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    const { ssSeconds, normalizeToWindow, reqId, label } = opts;

    // ffmpeg args. Note: -ss BEFORE -i is fast (demuxer-level seek);
    // after -i is accurate but slow (decode-to-seek). Input-side -ss
    // is fine for our 30s windows — alignment precision below a frame
    // doesn't matter for fingerprint comparison.
    const ffmpegArgs: string[] = ['-hide_banner', '-loglevel', 'warning'];
    if (ssSeconds !== null) {
      ffmpegArgs.push('-ss', String(ssSeconds));
    }
    ffmpegArgs.push(
      '-i', inputPath,
      '-vn', '-map', '0:a:0?',
      '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
      '-fflags', '+discardcorrupt+genpts',
      '-err_detect', 'ignore_err',
    );

    if (normalizeToWindow) {
      // apad=whole_dur=30 pads with silence if audio ends before 30s.
      // -t 30 truncates if audio is longer. Combined → exactly 30s.
      ffmpegArgs.push('-af', `apad=whole_dur=${WINDOW_SECONDS}`);
      ffmpegArgs.push('-t', String(WINDOW_SECONDS));
    }

    ffmpegArgs.push('-f', 's16le', 'pipe:1');

    // fpcalc reads raw s16le PCM from stdin (`-`). `-format s16le`
    // tells it the input is signed 16-bit little-endian PCM samples
    // at the declared sample rate + channel count. This bypasses
    // fpcalc's WAV/AAC/etc. demuxers entirely.
    const fpcalcArgs = [
      '-format', 's16le',
      '-rate', '44100',
      '-channels', '1',
      '-length', String(WINDOW_SECONDS),
      '-json',
      '-',
    ];

    console.log(`[fp:${reqId}] ${label} ffmpeg: ${ffmpegArgs.join(' ')}`);
    console.log(`[fp:${reqId}] ${label} fpcalc: ${fpcalcArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    const fpcalc = spawn('fpcalc', fpcalcArgs);

    let ffmpegStderr = '';
    let fpcalcStdout = '';
    let fpcalcStderr = '';
    let bytesPiped = 0;
    let settled = false;

    ffmpeg.stderr.on('data', (d) => { ffmpegStderr += d.toString(); });
    fpcalc.stdout.on('data', (d) => { fpcalcStdout += d.toString(); });
    fpcalc.stderr.on('data', (d) => { fpcalcStderr += d.toString(); });
    ffmpeg.stdout.on('data', (chunk: Buffer) => { bytesPiped += chunk.length; });

    ffmpeg.stdout.pipe(fpcalc.stdin);

    // EPIPE handling: expected when fpcalc closes stdin at -length cap.
    ffmpeg.stdout.on('error', () => {});
    fpcalc.stdin.on('error', () => {});

    const settle = (err: Error | null, result?: FingerprintResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ffmpeg.kill(); } catch {}
      try { fpcalc.kill(); } catch {}
      if (err) reject(err);
      else if (result) resolve(result);
    };

    ffmpeg.on('error', (err) => settle(new AudioDecodeError('ffmpeg_error', `ffmpeg ${label} spawn: ${err.message}`, { stderr: ffmpegStderr.slice(-1500) })));
    fpcalc.on('error', (err) => settle(new Error(`fpcalc ${label} spawn: ${err.message}`)));

    ffmpeg.on('close', (code) => {
      console.log(`[fp:${reqId}] ${label} ffmpeg exit: ${code}, piped ${bytesPiped} bytes PCM`);
      if (ffmpegStderr) console.log(`[fp:${reqId}] ${label} ffmpeg stderr:\n${ffmpegStderr}`);
      // ffmpeg exit 0 OR EPIPE-on-close (null/SIGPIPE) both OK — the
      // important thing is whether fpcalc got enough bytes to
      // fingerprint. Actual failure surfaces when fpcalc exits non-0.
    });

    fpcalc.on('close', (code) => {
      console.log(`[fp:${reqId}] ${label} fpcalc exit: ${code}`);
      if (fpcalcStderr) console.log(`[fp:${reqId}] ${label} fpcalc stderr:\n${fpcalcStderr}`);

      if (code !== 0) {
        settle(new Error(`fpcalc ${label} exited ${code}: ${fpcalcStderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(fpcalcStdout);
        if (!parsed.fingerprint || typeof parsed.duration !== 'number') {
          settle(new Error(`fpcalc ${label} invalid JSON: ${fpcalcStdout.slice(0, 200)}`));
          return;
        }
        console.log(`[fp:${reqId}] ${label} success — duration=${parsed.duration}s, fp_length=${parsed.fingerprint.length}`);
        settle(null, { fingerprint: parsed.fingerprint, duration: parsed.duration });
      } catch (err) {
        settle(new Error(`fpcalc ${label} JSON parse: ${err instanceof Error ? err.message : 'unknown'}`));
      }
    });

    const timer = setTimeout(() => {
      settle(new Error(`fingerprint ${label} timeout after 60s`));
    }, 60_000);
  });
}

// ─── ffprobe (duration only) ───────────────────────────────────────────────
function runFfprobe(filePath: string, reqId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('ffprobe timeout after 10s'));
    }, 10_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe spawn: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        console.warn(`[fp:${reqId}] ffprobe exited ${code}, stderr: ${stderr.trim()}`);
        reject(new Error(`ffprobe exited ${code}`));
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (!isFinite(duration)) {
        reject(new Error(`ffprobe non-numeric duration: ${stdout.trim()}`));
        return;
      }
      resolve(duration);
    });
  });
}
