# UNID Chromaprint worker

Standalone Node.js HTTP service that wraps the `fpcalc` (Chromaprint CLI)
binary behind an authed `POST /fingerprint` endpoint. The Next.js app
(`lib/chromaprint.ts`) is the only client.

This service is intentionally trivial (~50 LOC of business logic) so it
can be ported off Railway in a day if needed. State is zero — no DB, no
cache. Every request is independent.

## Why a separate service

`fpcalc` requires `libchromaprint-tools` + `ffmpeg` (about 80MB of
system deps). Vercel functions can't ship native binaries. Railway is
cheap and supports Dockerfile builds.

## Endpoints

### `GET /health`

Unauthenticated. Returns `{"status":"ok","uptime":<seconds>}`. Used by
Railway's health check + the Next.js smoke test.

### `POST /fingerprint`

Authenticated. Headers: `Authorization: Bearer <WORKER_SECRET>`.
Body: `multipart/form-data` with one field `file` (audio buffer, ≤50MB).

Success response:

```json
{
  "fingerprint": "AQADtJSSiVUSHEEFx...",  // base64 chromaprint
  "duration": 178.3,                        // seconds
  "byteLength": 4823091                     // input audio size
}
```

Error responses:
- `400 {"error":"no_file"}` — missing `file` field
- `400 {"error":"empty_file"}` — `file` field present but empty
- `401 {"error":"unauthorized"}` — missing/invalid bearer token
- `500 {"error":"fingerprint_failed","message":"..."}` — fpcalc errored

## Local development

```bash
npm install
WORKER_SECRET=$(openssl rand -hex 32) npm run dev
# Server listens on :8080
```

You'll need `fpcalc` installed locally for `npm run dev` to actually
work end-to-end:

- macOS: `brew install chromaprint`
- Debian/Ubuntu: `apt install libchromaprint-tools ffmpeg`

## Deploying to Railway (one-time setup)

### 1. Create a new GitHub repo for this service

This worker lives as a separate deploy from the main UNID Next.js app.
Suggested repo name: `unid-chromaprint-worker`.

```bash
cd chromaprint-worker
git init
git add .
git commit -m "feat: chromaprint worker initial"
gh repo create aonetto/unid-chromaprint-worker --private --source=. --push
```

### 2. Create a Railway project

- railway.app → **New Project** → **Deploy from GitHub repo**
- Select `aonetto/unid-chromaprint-worker`
- Railway auto-detects the `Dockerfile` at the repo root

### 3. Set environment variables

In the Railway project's **Variables** tab:

| Var | Value |
|---|---|
| `WORKER_SECRET` | Generate via `openssl rand -hex 32`. Save this — you'll need the same value in Vercel. |
| `PORT` | (Optional) defaults to 8080. Railway injects this automatically; leave unset. |

### 4. Trigger the first deploy

Railway builds the Dockerfile (installs `fpcalc` + `ffmpeg` + npm deps).
First build takes ~2-3 minutes; subsequent builds use the layer cache and
are fast.

### 5. Verify the deployment

Railway gives you a public URL like
`https://unid-chromaprint-worker-production.up.railway.app`.

```bash
curl https://YOUR-URL/health
# Expected: {"status":"ok","uptime":12.3}
```

### 6. Add the worker URL + secret to Vercel

In the Vercel project (`unid`), under **Settings → Environment Variables**,
add to **Production + Preview + Development**:

| Var | Value |
|---|---|
| `CHROMAPRINT_WORKER_URL` | Your Railway URL (no trailing slash) |
| `CHROMAPRINT_WORKER_SECRET` | Same value as Railway's `WORKER_SECRET` |

Redeploy the Vercel project so the new env vars take effect.

### 7. Smoke test from the Next.js side

With all three Wave E2 feature flags still **off** in `/admin/flags`:

```bash
curl -X POST https://unid.dev/api/identify \
  -H "Cookie: $ADMIN_COOKIE" \
  -F "file=@/path/to/test.mp3"
```

Expected response:

```json
{"kind":"no_match","reason":"no_providers_configured","attemptedProviders":[]}
```

This means the code path is wired correctly but the providers are gated
off at the flag layer. Now follow the staged activation in
`docs/WAVE_E2_OPERATIONS.md` to flip them on one at a time.

## Cost expectations

Railway charges per resource hour. This worker idles at roughly:
- ~150MB RAM
- <1% CPU at rest
- Spikes to ~300MB / 50% CPU per fingerprint call (sub-second)

At UNID's launch volume (low hundreds of identifies per day), expect
$5-10/month. Scale linearly with identify volume.

## Operational notes

- **Statelessness:** the service has no DB or cache. Restart at any time.
- **Temp files:** every fingerprint call writes to `/tmp` and unconditionally
  removes the directory in a `finally` block. Audio never persists beyond
  one request lifecycle (preserves UNID's R2 60s-delete posture).
- **Timeouts:** fpcalc is killed with SIGKILL after 30s. The HTTP client
  in the Next.js app times out at 45s.
- **Auth:** timing-safe Bearer comparison. Worker secret must be ≥32 chars.
- **Limits:** 50MB max audio file, 1 file per request.
