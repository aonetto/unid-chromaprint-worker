import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface FingerprintResult {
  fingerprint: string;
  duration: number; // seconds
}

/**
 * Fingerprint audio using Chromaprint (fpcalc).
 *
 * Writes the audio buffer to a per-request temp directory, invokes
 * `fpcalc -json -length 120 <file>`, parses the JSON, and unconditionally
 * cleans up the temp dir.
 *
 * The temp file lives only for the duration of the fingerprint call
 * (single-digit seconds for normal clips). UNID's R2 audio is already
 * deleted within 60s of upload — this worker preserves that posture
 * by never persisting audio beyond a single request lifecycle.
 */
export async function fingerprint(audio: Buffer): Promise<FingerprintResult> {
  const dir = await mkdtemp(join(tmpdir(), 'unid-fp-'));
  const audioPath = join(dir, 'input');

  try {
    await writeFile(audioPath, audio);
    const result = await runFpcalc(audioPath);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Cleanup failure is non-fatal: audio was already fingerprinted,
      // and the OS will eventually reap /tmp. Don't block the response.
    });
  }
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
      if (killed) return; // already rejected via timeout
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
