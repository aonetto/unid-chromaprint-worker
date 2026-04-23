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
const MIN_WAV_BYTES = 10_000; // 10 KB sanity floor for transcoded WAV (fallback path)
const FALLBACK_DURATION_RATIO = 0.8; // retry if primary WAV loses >20% of audio

/**
 * Fingerprint audio using Chromaprint (fpcalc).
 *
 * Two-path strategy (E2.6 — fpcalc 1.5.1 can't decode short WAV files):
 *
 * PATH 1 — piped (preferred): ffmpeg decodes input to raw 16-bit mono
 *   PCM and pipes directly to fpcalc's stdin in raw mode. fpcalc's
 *   WAV decoder is bypassed entirely, so the "Error decoding audio
 *   frame (End of file)" bug on short WAV inputs doesn't apply.
 *   Works on any input ffmpeg can read, including TikTok MP4,
 *   QuickTime-trimmed M4A, browser webm/opus, etc.
 *
 * PATH 2 — WAV file (fallback): ffmpeg transcodes input to a
 *   normalized PCM WAV on disk, runs fpcalc on the file. Kept as a
 *   fallback in case the piped approach fails for an unexpected
 *   reason (EPIPE on ffmpeg, fpcalc -raw mode issue, etc.). Retains
 *   all the previous validation (WAV header check, min duration,
 *   fallback transcode with aresample).
 *
 * Both paths share:
 *   - reqId-prefixed logs (`[fp:<id>]`) for per-invocation filtering
 *   - AudioDecodeError with structured reason + measured counts for
 *     the HTTP 422 response body
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const reqId = randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), `unid-fp-${reqId}-`));
  const inputPath = join(dir, 'input');

  // ── Diagnostic: input ────────────────────────────────────────────
  const inputMagic = audio.subarray(0, 16);
  console.log(`[fp:${reqId}] input: ${audio.length} bytes`);
  console.log(`[fp:${reqId}] input magic (hex): ${inputMagic.toString('hex')}`);
  console.log(`[fp:${reqId}] input magic (ascii): ${inputMagic.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);

  try {
    await writeFile(inputPath, audio);

    // ── PATH 1: piped (ffmpeg → raw PCM → fpcalc stdin) ─────────
    const pipedStart = Date.now();
    try {
      const result = await fingerprintPiped(inputPath, reqId);
      console.log(`[fp:${reqId}] method: piped — success in ${Date.now() - pipedStart}ms`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fp:${reqId}] method: piped — failed in ${Date.now() - pipedStart}ms: ${msg}`);
      // Fall through to WAV-file fallback
    }

    // ── PATH 2: WAV file fallback ────────────────────────────────
    const fallbackStart = Date.now();
    try {
      const result = await fingerprintWavFile(inputPath, audio, dir, reqId);
      console.log(`[fp:${reqId}] method: fallback_wav — success in ${Date.now() - fallbackStart}ms`);
      return result;
    } catch (err) {
      console.warn(`[fp:${reqId}] method: fallback_wav — failed in ${Date.now() - fallbackStart}ms`);
      throw err; // AudioDecodeError or generic 500
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── PATH 1: piped — ffmpeg raw PCM → fpcalc stdin ──────────────────────────
//
// Command equivalent (conceptually):
//   ffmpeg -i <input> -ac 1 -ar 44100 -f s16le pipe:1 \
//     | fpcalc -raw -rate 44100 -channels 1 -length 120 -json -
//
// fpcalc's `-raw` flag skips its WAV decoder entirely — it reads raw
// interleaved PCM samples from the given file (`-` = stdin) at the
// declared sample rate + channel count. This is the workaround for
// the fpcalc 1.5.1 "End of file" bug on short WAV inputs.
async function fingerprintPiped(inputPath: string, reqId: string): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-hide_banner', '-loglevel', 'warning',
      '-i', inputPath,
      '-vn', '-map', '0:a:0?',
      '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
      '-fflags', '+discardcorrupt+genpts',
      '-err_detect', 'ignore_err',
      '-f', 's16le',
      'pipe:1',
    ];
    const fpcalcArgs = [
      '-raw',
      '-rate', '44100',
      '-channels', '1',
      '-length', '120',
      '-json',
      '-',
    ];
    console.log(`[fp:${reqId}] piped ffmpeg: ${ffmpegArgs.join(' ')}`);
    console.log(`[fp:${reqId}] piped fpcalc: ${fpcalcArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    const fpcalc = spawn('fpcalc', fpcalcArgs);

    let ffmpegStderr = '';
    let fpcalcStdout = '';
    let fpcalcStderr = '';
    let ffmpegExit: number | null = null;
    let fpcalcExit: number | null = null;
    let settled = false;
    let bytesPiped = 0;

    ffmpeg.stderr.on('data', (d) => { ffmpegStderr += d.toString(); });
    fpcalc.stdout.on('data', (d) => { fpcalcStdout += d.toString(); });
    fpcalc.stderr.on('data', (d) => { fpcalcStderr += d.toString(); });

    // Count bytes flowing through the pipe (diagnostic).
    ffmpeg.stdout.on('data', (chunk: Buffer) => { bytesPiped += chunk.length; });

    // Pipe ffmpeg stdout → fpcalc stdin.
    ffmpeg.stdout.pipe(fpcalc.stdin);

    // Handle EPIPE gracefully: if fpcalc closes stdin before ffmpeg
    // finishes (e.g. fpcalc reached -length cap), the pipe errors.
    // This isn't a failure — fpcalc got enough audio.
    ffmpeg.stdout.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code || err.message;
      if (msg === 'EPIPE') {
        console.log(`[fp:${reqId}] piped: ffmpeg EPIPE (fpcalc closed stdin early — expected when input > 120s)`);
      } else {
        console.warn(`[fp:${reqId}] piped: ffmpeg stdout error: ${msg}`);
      }
    });
    fpcalc.stdin.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code || err.message;
      if (msg === 'EPIPE') {
        console.log(`[fp:${reqId}] piped: fpcalc stdin EPIPE (ok if -length cap reached)`);
      } else {
        console.warn(`[fp:${reqId}] piped: fpcalc stdin error: ${msg}`);
      }
    });

    const settle = (err: Error | null, result?: FingerprintResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ffmpeg.kill(); } catch {}
      try { fpcalc.kill(); } catch {}
      if (err) reject(err);
      else if (result) resolve(result);
    };

    ffmpeg.on('error', (err) => settle(new Error(`piped ffmpeg spawn: ${err.message}`)));
    fpcalc.on('error', (err) => settle(new Error(`piped fpcalc spawn: ${err.message}`)));

    ffmpeg.on('close', (code) => {
      ffmpegExit = code;
      console.log(`[fp:${reqId}] piped ffmpeg exit: ${code}, piped ${bytesPiped} bytes of PCM`);
      if (ffmpegStderr) console.log(`[fp:${reqId}] piped ffmpeg stderr:\n${ffmpegStderr}`);
    });

    fpcalc.on('close', (code) => {
      fpcalcExit = code;
      console.log(`[fp:${reqId}] piped fpcalc exit: ${code}`);
      if (fpcalcStderr) console.log(`[fp:${reqId}] piped fpcalc stderr:\n${fpcalcStderr}`);

      if (code !== 0) {
        settle(new Error(`piped fpcalc exited ${code}: ${fpcalcStderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(fpcalcStdout);
        if (!parsed.fingerprint || typeof parsed.duration !== 'number') {
          settle(new Error(`piped fpcalc returned invalid JSON: ${fpcalcStdout.slice(0, 200)}`));
          return;
        }
        console.log(`[fp:${reqId}] piped success — duration=${parsed.duration}s, fp_length=${parsed.fingerprint.length}`);
        settle(null, { fingerprint: parsed.fingerprint, duration: parsed.duration });
      } catch (err) {
        settle(new Error(`piped fpcalc JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`));
      }
    });

    const timer = setTimeout(() => {
      console.warn(`[fp:${reqId}] piped timeout — ffmpeg exit=${ffmpegExit}, fpcalc exit=${fpcalcExit}, piped=${bytesPiped}B`);
      settle(new Error('piped fingerprint timeout after 60s'));
    }, 60_000);
  });
}

// ─── PATH 2: WAV file fallback ──────────────────────────────────────────────
//
// Retains the previous defensive pipeline: ffprobe input duration,
// ffmpeg transcode with -bitexact + -map_metadata -1 (strips LIST
// chunks), ffprobe WAV duration, fallback aresample transcode if
// primary lost too much audio, WAV header + size + duration
// validation, then fpcalc on the file.
async function fingerprintWavFile(
  inputPath: string,
  audio: Buffer,
  dir: string,
  reqId: string,
): Promise<FingerprintResult> {
  const wavPath = join(dir, 'normalized.wav');

  let inputDuration = NaN;
  try {
    inputDuration = await runFfprobe(inputPath, reqId);
    console.log(`[fp:${reqId}] input duration (ffprobe): ${inputDuration.toFixed(2)}s`);
  } catch (err) {
    console.warn(`[fp:${reqId}] ffprobe input failed (continuing):`, err instanceof Error ? err.message : err);
  }

  await runFfmpegPrimary(inputPath, wavPath, reqId);
  let wavStats = await stat(wavPath);
  let wavDuration = await runFfprobe(wavPath, reqId).catch(() => NaN);
  console.log(`[fp:${reqId}] WAV attempt 1: ${wavStats.size} bytes, ${isFinite(wavDuration) ? wavDuration.toFixed(2) + 's' : 'unknown duration'}`);

  const lostTooMuch = isFinite(inputDuration) && isFinite(wavDuration)
    && inputDuration > 0
    && wavDuration / inputDuration < FALLBACK_DURATION_RATIO;

  if (lostTooMuch) {
    console.warn(
      `[fp:${reqId}] primary lost ${((1 - wavDuration / inputDuration) * 100).toFixed(1)}% of audio. Trying fallback.`,
    );
    await unlink(wavPath).catch(() => {});
    await runFfmpegFallback(inputPath, wavPath, reqId);
    wavStats = await stat(wavPath);
    wavDuration = await runFfprobe(wavPath, reqId).catch(() => NaN);
    console.log(`[fp:${reqId}] WAV attempt 2: ${wavStats.size} bytes, ${isFinite(wavDuration) ? wavDuration.toFixed(2) + 's' : 'unknown duration'}`);
  }

  if (wavStats.size < MIN_WAV_BYTES) {
    throw new AudioDecodeError('transcoded_too_small',
      `Transcoded WAV is only ${wavStats.size} bytes (need ${MIN_WAV_BYTES} minimum).`,
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

  return await runFpcalc(wavPath, reqId);
}

// ─── ffmpeg primary (file output) ──────────────────────────────────────────
function runFfmpegPrimary(inputPath: string, outputPath: string, reqId: string): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputPath,
    '-vn', '-map', '0:a:0?',
    '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
    '-fflags', '+discardcorrupt+genpts',
    '-err_detect', 'ignore_err',
    '-bitexact',
    '-map_metadata', '-1',
    '-f', 'wav', '-y',
    outputPath,
  ];
  return runFfmpeg(args, reqId, 'primary');
}

function runFfmpegFallback(inputPath: string, outputPath: string, reqId: string): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputPath,
    '-ac', '1', '-ar', '44100', '-sample_fmt', 's16',
    '-acodec', 'pcm_s16le',
    '-af', 'aresample=async=1:first_pts=0',
    '-bitexact',
    '-map_metadata', '-1',
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
