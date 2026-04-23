import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface FingerprintResult {
  fingerprint: string;
  duration: number; // seconds
}

// Reason codes mirrored in the HTTP 422 response body so the client
// can branch on a stable identifier instead of parsing free text.
export type AudioDecodeReason =
  | 'audio_too_short'
  | 'transcoded_too_small'
  | 'invalid_wav_header'
  | 'ffmpeg_error'
  | 'ffprobe_error';

export class AudioDecodeError extends Error {
  reason: AudioDecodeReason;
  inputBytes?: number;
  inputDurationSeconds?: number;
  wavBytes?: number;
  wavDurationSeconds?: number;
  stderr?: string;

  constructor(
    reason: AudioDecodeReason,
    message: string,
    extra?: {
      inputBytes?: number;
      inputDurationSeconds?: number;
      wavBytes?: number;
      wavDurationSeconds?: number;
      stderr?: string;
    },
  ) {
    super(message);
    this.name = 'AudioDecodeError';
    this.reason = reason;
    if (extra) Object.assign(this, extra);
  }
}

const MIN_AUDIO_SECONDS = 3; // fpcalc needs at least 3 seconds of audio
const MIN_WAV_BYTES = 10_000; // 10 KB sanity floor for transcoded WAV
const FALLBACK_DURATION_RATIO = 0.8; // retry if primary loses >20% of audio

/**
 * Fingerprint audio using Chromaprint (fpcalc).
 *
 * Defensive pipeline (E2.5 — real-world clip support):
 *   1. ffprobe input duration (informational; for fallback ratio check)
 *   2. ffmpeg primary transcode (aggressive error tolerance, video stripped)
 *   3. ffprobe transcoded WAV duration
 *   4. If WAV duration < 80% of input duration → fallback transcode
 *      (aresample=async=1 fills broken-timestamp gaps with silence)
 *   5. Validate WAV: size ≥ 10 KB, header starts "RIFF....WAVE"
 *   6. Reject if WAV duration < 3 seconds (fpcalc min)
 *   7. Run fpcalc on the validated WAV
 *
 * Every stage logs with a request ID prefix `[fp:<id>]` so Railway
 * logs can be filtered to a single invocation.
 *
 * AudioDecodeError encodes the failure mode (audio_too_short,
 * transcoded_too_small, invalid_wav_header, ffmpeg_error, ffprobe_error)
 * + measured byte/duration counts so the HTTP response itself tells
 * the caller why decoding failed.
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const reqId = randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), `unid-fp-${reqId}-`));
  const inputPath = join(dir, 'input');
  const wavPath = join(dir, 'normalized.wav');

  // ── Diagnostic: input ────────────────────────────────────────────
  const inputMagic = audio.subarray(0, 16);
  console.log(`[fp:${reqId}] input: ${audio.length} bytes`);
  console.log(`[fp:${reqId}] input magic (hex): ${inputMagic.toString('hex')}`);
  console.log(`[fp:${reqId}] input magic (ascii): ${inputMagic.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);

  try {
    await writeFile(inputPath, audio);

    // Probe input duration (best-effort; ffprobe may fail on weird formats
    // but ffmpeg can still transcode them, so don't abort here).
    let inputDuration = NaN;
    try {
      inputDuration = await runFfprobe(inputPath, reqId);
      console.log(`[fp:${reqId}] input duration (ffprobe): ${inputDuration.toFixed(2)}s`);
    } catch (err) {
      console.warn(`[fp:${reqId}] ffprobe input failed (continuing):`, err instanceof Error ? err.message : err);
    }

    // ── Attempt 1: primary transcode ──────────────────────────────
    await runFfmpegPrimary(inputPath, wavPath, reqId);
    let wavStats = await stat(wavPath);
    let wavDuration = await runFfprobe(wavPath, reqId).catch(() => NaN);
    console.log(`[fp:${reqId}] WAV attempt 1: ${wavStats.size} bytes, ${isFinite(wavDuration) ? wavDuration.toFixed(2) + 's' : 'unknown duration'}`);

    // ── Attempt 2: fallback if too much audio was lost ────────────
    const lostTooMuch = isFinite(inputDuration) && isFinite(wavDuration)
      && inputDuration > 0
      && wavDuration / inputDuration < FALLBACK_DURATION_RATIO;

    if (lostTooMuch) {
      console.warn(
        `[fp:${reqId}] primary lost ${((1 - wavDuration / inputDuration) * 100).toFixed(1)}% of audio ` +
        `(${wavDuration.toFixed(1)}s / ${inputDuration.toFixed(1)}s). Trying fallback.`,
      );
      await unlink(wavPath).catch(() => {});
      await runFfmpegFallback(inputPath, wavPath, reqId);
      wavStats = await stat(wavPath);
      wavDuration = await runFfprobe(wavPath, reqId).catch(() => NaN);
      console.log(`[fp:${reqId}] WAV attempt 2: ${wavStats.size} bytes, ${isFinite(wavDuration) ? wavDuration.toFixed(2) + 's' : 'unknown duration'}`);
    }

    // ── Validation ────────────────────────────────────────────────
    if (wavStats.size < MIN_WAV_BYTES) {
      throw new AudioDecodeError('transcoded_too_small',
        `Transcoded WAV is only ${wavStats.size} bytes (need ${MIN_WAV_BYTES} minimum). Input audio may be corrupted or truncated.`,
        { inputBytes: audio.length, inputDurationSeconds: inputDuration, wavBytes: wavStats.size, wavDurationSeconds: wavDuration });
    }

    await assertValidWavHeader(wavPath, reqId, {
      inputBytes: audio.length,
      inputDurationSeconds: inputDuration,
      wavBytes: wavStats.size,
      wavDurationSeconds: wavDuration,
    });

    if (!isFinite(wavDuration) || wavDuration < MIN_AUDIO_SECONDS) {
      throw new AudioDecodeError('audio_too_short',
        `Audio is ${isFinite(wavDuration) ? wavDuration.toFixed(1) + 's' : 'unknown duration'}. Need at least ${MIN_AUDIO_SECONDS} seconds to fingerprint.`,
        { inputBytes: audio.length, inputDurationSeconds: inputDuration, wavBytes: wavStats.size, wavDurationSeconds: wavDuration });
    }

    // ── Fingerprint ───────────────────────────────────────────────
    return await runFpcalc(wavPath, reqId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── ffmpeg primary: aggressive error tolerance ─────────────────────────────
//
//   -hide_banner -loglevel warning  → quieter output
//   -i <input>                     → source file
//   -vn                            → strip video (TikTok / IG clips have video+audio)
//   -map 0:a:0?                    → grab first audio track; `?` makes optional
//                                     (some files have multiple audio streams)
//   -ac 1 -ar 44100 -sample_fmt s16 → mono PCM @ 44.1 kHz, 16-bit
//   -fflags +discardcorrupt+genpts  → skip corrupt packets, regen timestamps
//   -err_detect ignore_err          → continue past decode errors
//   -f wav -y                       → WAV container, overwrite
function runFfmpegPrimary(inputPath: string, outputPath: string, reqId: string): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputPath,
    '-vn', '-map', '0:a:0?',
    '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
    '-fflags', '+discardcorrupt+genpts',
    '-err_detect', 'ignore_err',
    '-f', 'wav', '-y',
    outputPath,
  ];
  return runFfmpeg(args, reqId, 'primary');
}

// ─── ffmpeg fallback: aresample=async=1 fills missing-packet gaps ───────────
//
// aresample's async mode handles broken timestamps and missing packets by
// inserting silence at the correct offset, instead of truncating output
// at the first gap.
function runFfmpegFallback(inputPath: string, outputPath: string, reqId: string): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputPath,
    '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
    '-acodec', 'pcm_s16le',
    '-af', 'aresample=async=1:first_pts=0',
    '-f', 'wav', '-y',
    outputPath,
  ];
  return runFfmpeg(args, reqId, 'fallback');
}

function runFfmpeg(args: string[], reqId: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[fp:${reqId}] ffmpeg ${label}: ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new AudioDecodeError('ffmpeg_error', `ffmpeg ${label} timeout after 30s`, { stderr: stderr.slice(-1500) }));
    }, 30_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new AudioDecodeError('ffmpeg_error', `ffmpeg ${label} spawn failed: ${err.message}`, { stderr: stderr.slice(-1500) }));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      console.log(`[fp:${reqId}] ffmpeg ${label} exited ${code}`);
      if (stdout) console.log(`[fp:${reqId}] ffmpeg ${label} stdout:\n${stdout}`);
      if (stderr) console.log(`[fp:${reqId}] ffmpeg ${label} stderr:\n${stderr}`);
      if (code !== 0) {
        reject(new AudioDecodeError('ffmpeg_error',
          `ffmpeg ${label} exited ${code}`,
          { stderr: stderr.slice(-1500) }));
        return;
      }
      resolve();
    });
  });
}

// ─── ffprobe: returns duration in seconds (NaN on probe failure) ────────────
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
      reject(new AudioDecodeError('ffprobe_error', 'ffprobe timeout after 10s', { stderr: stderr.slice(-500) }));
    }, 10_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new AudioDecodeError('ffprobe_error', `ffprobe spawn failed: ${err.message}`, { stderr: stderr.slice(-500) }));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        console.warn(`[fp:${reqId}] ffprobe exited ${code}, stderr: ${stderr.trim()}`);
        reject(new AudioDecodeError('ffprobe_error', `ffprobe exited ${code}`, { stderr: stderr.slice(-500) }));
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (!isFinite(duration)) {
        reject(new AudioDecodeError('ffprobe_error', `ffprobe returned non-numeric duration: ${stdout.trim()}`, { stderr: stderr.slice(-500) }));
        return;
      }
      resolve(duration);
    });
  });
}

// ─── WAV header validator ────────────────────────────────────────────────────
async function assertValidWavHeader(
  wavPath: string,
  reqId: string,
  errorContext: {
    inputBytes?: number;
    inputDurationSeconds?: number;
    wavBytes?: number;
    wavDurationSeconds?: number;
  },
): Promise<void> {
  const head = await readFile(wavPath);
  const header = head.subarray(0, Math.min(44, head.length));
  console.log(`[fp:${reqId}] WAV header (hex): ${header.toString('hex')}`);
  console.log(`[fp:${reqId}] WAV header (ascii): ${header.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);

  // RIFF....WAVE — bytes 0-3 must be "RIFF", bytes 8-11 must be "WAVE"
  if (header.length < 12) {
    throw new AudioDecodeError('invalid_wav_header',
      `Transcoded file is too small to be a valid WAV (${header.length} bytes)`,
      errorContext);
  }
  const riff = header.subarray(0, 4).toString('ascii');
  const wave = header.subarray(8, 12).toString('ascii');
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new AudioDecodeError('invalid_wav_header',
      `Transcoded file is not a valid WAV (header: "${riff}...${wave}", expected "RIFF...WAVE"). ffmpeg output is malformed.`,
      errorContext);
  }
}

// ─── fpcalc ──────────────────────────────────────────────────────────────────
function runFpcalc(audioPath: string, reqId: string): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    const args = ['-json', '-length', '120', audioPath];
    console.log(`[fp:${reqId}] fpcalc: ${args.join(' ')}`);
    const proc = spawn('fpcalc', args);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error(`fpcalc timeout after 30s`));
    }, 30_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`fpcalc spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      console.log(`[fp:${reqId}] fpcalc exit: ${code}`);
      if (stderr) console.log(`[fp:${reqId}] fpcalc stderr:\n${stderr}`);
      if (code !== 0) {
        // After WAV validation + duration check, fpcalc should never
        // fail at the decoder layer. If it does, surface as a regular
        // 500 (not AudioDecodeError) — this is a real worker bug.
        reject(new Error(`fpcalc exited ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.fingerprint || typeof parsed.duration !== 'number') {
          reject(new Error(`fpcalc returned invalid JSON: ${stdout.slice(0, 200)}`));
          return;
        }
        console.log(`[fp:${reqId}] fingerprint length: ${parsed.fingerprint.length}, duration: ${parsed.duration}s`);
        resolve({ fingerprint: parsed.fingerprint, duration: parsed.duration });
      } catch (err) {
        reject(new Error(`fpcalc JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`));
      }
    });
  });
}
