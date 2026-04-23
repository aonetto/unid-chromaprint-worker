import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, readFile } from 'node:fs/promises';
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
 * Two-stage pipeline:
 *   1. ffmpeg transcode → 16-bit mono PCM WAV @ 44.1kHz
 *   2. fpcalc → fingerprint of the transcoded WAV
 *
 * E2.4 — verbose diagnostic logging at every stage so Railway logs
 * surface exactly what bytes flow through and what each tool emits.
 * Logs:
 *   - input buffer size + first 16 bytes (magic bytes)
 *   - ffmpeg full stdout + stderr (not just on error)
 *   - transcoded WAV file size + first 44 bytes (RIFF header)
 *   - fpcalc command + stdout + stderr
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const dir = await mkdtemp(join(tmpdir(), 'unid-fp-'));
  const inputPath = join(dir, 'input');
  const wavPath = join(dir, 'normalized.wav');

  // ── Diagnostic: input buffer ──────────────────────────────────────
  const inputMagic = audio.subarray(0, 16);
  console.log(`[fingerprint] input buffer: ${audio.length} bytes`);
  console.log(`[fingerprint] input magic (hex): ${inputMagic.toString('hex')}`);
  console.log(`[fingerprint] input magic (ascii): ${inputMagic.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);

  try {
    await writeFile(inputPath, audio);
    await transcodeToWav(inputPath, wavPath);
    return await runFpcalc(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function transcodeToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-ac', '1',
      '-ar', '44100',
      '-sample_fmt', 's16',
      '-f', 'wav',
      '-y',
      outputPath,
    ];
    console.log(`[fingerprint] ffmpeg ${args.join(' ')}`);

    const proc = spawn('ffmpeg', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new AudioDecodeError('ffmpeg transcode timeout after 30s', stderr.slice(-1500)));
    }, 30_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new AudioDecodeError(`ffmpeg spawn failed: ${err.message}`, stderr.slice(-1500)));
    });

    proc.on('close', async (code) => {
      clearTimeout(timer);
      if (killed) return;

      // Always log full ffmpeg output (not only on error) — diagnoses
      // silent-success cases where ffmpeg writes a 0-byte WAV.
      console.log(`[fingerprint] ffmpeg exited ${code}`);
      if (stdout) console.log(`[fingerprint] ffmpeg stdout:\n${stdout}`);
      if (stderr) console.log(`[fingerprint] ffmpeg stderr:\n${stderr}`);

      if (code !== 0) {
        reject(new AudioDecodeError(
          `Could not decode audio file (ffmpeg exited ${code})`,
          stderr.slice(-1500),
        ));
        return;
      }

      // Inspect the transcoded WAV.
      try {
        const st = await stat(outputPath);
        console.log(`[fingerprint] transcoded WAV: ${st.size} bytes`);
        if (st.size === 0) {
          reject(new AudioDecodeError('ffmpeg produced empty WAV', stderr.slice(-1500)));
          return;
        }
        const head = await readFile(outputPath);
        const header44 = head.subarray(0, Math.min(44, head.length));
        console.log(`[fingerprint] WAV header (hex): ${header44.toString('hex')}`);
        console.log(`[fingerprint] WAV header (ascii): ${header44.toString('utf8').replace(/[^\x20-\x7e]/g, '.')}`);
        // Sanity check: should start with "RIFF" and contain "WAVEfmt "
        if (!header44.subarray(0, 4).equals(Buffer.from('RIFF'))) {
          console.warn(`[fingerprint] WARNING: transcoded file does NOT start with RIFF`);
        }
      } catch (err) {
        console.error(`[fingerprint] failed to inspect transcoded WAV:`, err);
      }

      resolve();
    });
  });
}

function runFpcalc(audioPath: string): Promise<FingerprintResult> {
  return new Promise((resolve, reject) => {
    const args = ['-json', '-length', '120', audioPath];
    console.log(`[fingerprint] fpcalc ${args.join(' ')}`);

    const proc = spawn('fpcalc', args);
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

      console.log(`[fingerprint] fpcalc exited ${code}`);
      if (stderr) console.log(`[fingerprint] fpcalc stderr:\n${stderr}`);
      if (stdout) {
        // Truncate stdout in logs — fingerprint base64 is huge.
        console.log(`[fingerprint] fpcalc stdout (head): ${stdout.slice(0, 200)}`);
      }

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
        console.log(`[fingerprint] success — duration=${parsed.duration}s, fp_length=${parsed.fingerprint.length}`);
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
