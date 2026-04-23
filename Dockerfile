FROM node:20-bookworm-slim

# Install build dependencies + ffmpeg + runtime deps.
# Debian's libchromaprint-tools ships fpcalc 1.5.1 compiled with
# minimal codec support — it fails on short files and many formats.
# Build from source against system FFmpeg instead for full codec
# coverage (avcodec backend).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      git \
      libavcodec-dev \
      libavformat-dev \
      libavutil-dev \
      libswresample-dev \
      ffmpeg \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build Chromaprint from a pinned master SHA (ffmpeg 5.x compatibility).
# v1.5.1 tag predates the ffmpeg 5.x migration (removed
# avcodec_decode_audio4, AVStream::codec, channel_layout, const
# correctness on AVInputFormat, etc.) — only post-migration master
# compiles clean against Debian bookworm's ffmpeg 5.1.x.
#
# Pinned to master SHA 6b13ce3a (captured 2026-04-23).
# To bump: `git ls-remote https://github.com/acoustid/chromaprint.git HEAD`
# Then verify locally:
#   1. Rebuild this image.
#   2. `npx tsx scripts/reseed-fingerprints.ts` (from main repo) against
#      a staging worker URL.
#   3. Re-run identify tests via /admin/identify-debug.
#   4. Only then update the SHA and deploy.
# Unpinned `git clone --depth 1` risks a silent noise-floor regression
# on any future Railway redeploy if upstream changes item encoding.
#
# BUILD_TOOLS=ON compiles fpcalc linked against system FFmpeg libs.
# BUILD_TESTS=OFF skips googletest fetch/compile (~30s saved).
# FFT_LIB=avfft uses FFmpeg's FFT (avoids FFTW3 dep).
ARG CHROMAPRINT_SHA=6b13ce3a81ae931e7477c4856a86bece99157cd8
RUN git clone https://github.com/acoustid/chromaprint.git /tmp/chromaprint && \
    cd /tmp/chromaprint && \
    git checkout ${CHROMAPRINT_SHA} && \
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_TOOLS=ON \
          -DBUILD_TESTS=OFF \
          -DFFT_LIB=avfft \
          . && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    rm -rf /tmp/chromaprint

# Verify fpcalc is installed + dump help so build logs show exactly
# which flags this build supports (-raw vs -format s16le varies
# between Chromaprint versions).
RUN fpcalc -version && \
    echo "--- fpcalc -h ---" && \
    (fpcalc -h 2>&1 | head -40 || true) && \
    echo "--- end fpcalc -h ---"

WORKDIR /app

# Install ALL deps (including dev) so we can compile TS in-container.
COPY package*.json tsconfig.json ./
RUN npm ci

# Build TypeScript → dist/
COPY src ./src
RUN npm run build

# Strip dev deps after build to slim the final image.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health check. start-period bumped to 30s — source build makes
# first deploy slower to become healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]
