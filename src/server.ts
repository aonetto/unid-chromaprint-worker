import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { fingerprint, fingerprintChunked, AudioDecodeError } from './fingerprint';
import crypto from 'node:crypto';

// Wave E2 — Chromaprint fingerprinting worker.
//
// Standalone Node.js service deployed to Railway. Wraps the fpcalc
// (Chromaprint CLI) binary behind a single authed POST endpoint.
// The Next.js app (lib/chromaprint.ts) is the only client.
//
// Why a separate service: fpcalc is a native binary (libchromaprint-tools
// + ffmpeg, ~80MB system deps). Vercel functions can't ship it. Railway
// is the cheapest place to host a Node service that can run native
// binaries, and the worker stays trivial (~50 LOC) so any swap to a
// different host later is a one-day port.

const WORKER_SECRET = process.env.WORKER_SECRET;
if (!WORKER_SECRET) {
  console.error('FATAL: WORKER_SECRET not set');
  process.exit(1);
}

// Fingerprint format version. Stored per Fingerprint row in the main
// DB and returned on every worker response so the identify path can
// refuse to score mismatched versions (defensive against future
// worker format changes producing silent noise-floor regressions —
// exactly the bug we debugged in the `-raw` vs compressed incident).
//
// Bump this string when the on-wire fingerprint binary format changes
// (NOT when fpcalc version or Chromaprint SHA changes without affecting
// the output encoding). Every version bump requires a full reseed of
// stored fingerprints before old rows become unmatchable.
const FINGERPRINT_FORMAT_VERSION = 'chromaprint_v2';

const app = Fastify({
  logger: true,
  bodyLimit: 200 * 1024 * 1024, // 200MB max audio (long-form DJ sets, full albums)
});

app.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: 1,
  },
});

// Auth middleware: every request except /health must carry the bearer
// token via Authorization header. Timing-safe comparison so we don't
// leak length or content via response timing.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const token = auth.slice(7);
  const expected = Buffer.from(WORKER_SECRET);
  const given = Buffer.from(token);
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(expected, given)
  ) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
});

app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

app.post('/fingerprint', async (req, reply) => {
  const file = await req.file();
  if (!file) {
    return reply.code(400).send({ error: 'no_file' });
  }

  const buffer = await file.toBuffer();

  if (buffer.length === 0) {
    return reply.code(400).send({ error: 'empty_file' });
  }

  try {
    const result = await fingerprint(buffer);
    return {
      fingerprint: result.fingerprint,
      duration: result.duration,
      byteLength: buffer.length,
      version: FINGERPRINT_FORMAT_VERSION,
    };
  } catch (err) {
    return handleFingerprintError(err, req, reply);
  }
});

// E2.7 — chunked fingerprinting. For artist-upload seeding: generate
// an array of 30-second window fingerprints stepping by 15s across
// the full track. Each chunk is a standalone 30s fingerprint, so
// identify queries (also 30s-normalized) can compare directly via
// same-length XOR without subsequence sliding.
app.post('/fingerprint-chunked', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no_file' });

  const buffer = await file.toBuffer();
  if (buffer.length === 0) return reply.code(400).send({ error: 'empty_file' });

  try {
    const result = await fingerprintChunked(buffer);
    return {
      chunks: result.chunks,
      totalDuration: result.totalDuration,
      byteLength: buffer.length,
      version: FINGERPRINT_FORMAT_VERSION,
    };
  } catch (err) {
    return handleFingerprintError(err, req, reply);
  }
});

// Shared error handler so /fingerprint and /fingerprint-chunked
// surface the same structured 422 response on decode errors.
function handleFingerprintError(err: unknown, req: any, reply: any) {
  if (err instanceof AudioDecodeError) {
    req.log.warn({
      reason: err.reason,
      stderr: err.stderr,
      inputBytes: err.inputBytes,
      inputDurationSeconds: err.inputDurationSeconds,
    }, 'audio decode failed');
    return reply.code(422).send({
      error: 'audio_decode_failed',
      reason: err.reason,
      message: err.message,
      inputBytes: err.inputBytes,
      inputDurationSeconds: err.inputDurationSeconds,
    });
  }
  req.log.error({ err }, 'fingerprint failed');
  return reply.code(500).send({
    error: 'fingerprint_failed',
    message: err instanceof Error ? err.message : 'unknown',
  });
}

const port = parseInt(process.env.PORT ?? '8080', 10);
const host = '0.0.0.0';

app.listen({ port, host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Chromaprint worker listening at ${address}`);
});
