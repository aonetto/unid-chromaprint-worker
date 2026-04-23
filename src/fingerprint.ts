import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface FingerprintResult {
  fingerprint: string;
  duration: number; // seconds
}

export class AudioDecodeError extends Error {
  constructor(message: string, public stderr: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

/**
 * Fingerprint audio using Chromaprint (fpcalc).
 *
 * Two-stage pipeline (E2.3 fix):
 *   1. ffmpeg transcode → 16-bit mono PCM WAV @ 44.1kHz. Strips any
 *      container/codec quirks (trimmed M4A from QuickTime, AAC variants
 *      with missing headers, browser-recorded webm/opus, etc.) and
 *      gives fpcalc a guaranteed-clean input. Previously fpcalc was
 *      called directly on user audio and failed with "Error decoding
 *      audio frame (End of file)" on a long tail of formats.
 *   2. fpcalc → fingerprint of the transcoded WAV.
 *
 * Both temp files live only for the duration of the call. UNID's R2
 * audio is already deleted within 60s of upload — this worker
 * preserves that posture by never persisting audio beyond a single
 * request lifecycle.
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const dir = await mkdtemp(join(tmpdir(), 'unid-fp-'));
  const inputPath = join(dir, 'input');
  const wavPath = join(dir, 'normalized.wav');

  try {
    await writeFile(inputPath, audio);
    await transcodeToWav(inputPath, wavPath);
    return await runFpcalc(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Cleanup failure is non-fatal: audio was already fingerprinted,
      // and the OS will eventually reap /tmp. Don't block the response.
    });
  }
}

/**
 * Transcode arbitrary input audio to 16-bit mono PCM WAV @ 44.1 kHz.
 *
 *   -ac 1            → mono (fingerprinting is mono; saves CPU)
 *   -ar 44100        → 44.1 kHz sample rate (chromaprint reference rate)
 *   -sample_fmt s16  → 16-bit PCM (decoder-friendly, no float quirks)
 *   -f wav -y        → force WAV container, overwrite if exists
 *
 * On failure throws AudioDecodeError with the ffmpeg stderr captured
 * (Railway logs it; the worker surfaces a friendlier message upstream).
 */
function transcodeToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-ac', '1',
      '-ar', '44100',
      '-sample_fmt', 's16',
      '-f', 'wav',
      '-y',
      outputPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new AudioDecodeError('ffmpeg transcode timeout after 30s', stderr.slice(-800)));
    }, 30_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new AudioDecodeError(`ffmpeg spawn failed: ${err.message}`, stderr.slice(-800)));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        // Log full stderr to Railway logs for debugging future formats.
        console.error(`[fingerprint] ffmpeg exited ${code}\nstderr:\n${stderr}`);
        reject(new AudioDecodeError(
          `Could not decode audio file (ffmpeg exited ${code})`,
          stderr.slice(-800),
        ));
        return;
      }
      resolve();
    });
  });
}

function runFpcalc(audioPath: string): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('fpcalc', [
      '-json',
      '-length', '120', // sample first 120s of audio
      audioPath,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('fpcalc timeout after 30s'));
    }, 30_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`fpcalc spawn failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        // After the ffmpeg transcode the input is normalized PCM WAV,
        // so fpcalc should never fail at the decoder layer. If it
        // does, log full stderr — it's a real fpcalc bug worth seeing.
        console.error(`[fingerprint] fpcalc exited ${code} on transcoded WAV\nstderr:\n${stderr}`);
        reject(new Error(`fpcalc exited ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.fingerprint || typeof parsed.duration !== 'number') {
          reject(new Error(`fpcalc returned invalid JSON: ${stdout.slice(0, 200)}`));
          return;
        }
        resolve({
          fingerprint: parsed.fingerprint,
          duration: parsed.duration,
        });
      } catch (err) {
        reject(new Error(`fpcalc JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`));
      }
    });
  });
}
