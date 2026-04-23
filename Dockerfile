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

# Build Chromaprint from source.
# BUILD_TOOLS=ON compiles fpcalc linked against system FFmpeg libs.
# FFT_LIB=avfft uses FFmpeg's FFT (avoids FFTW3 dep).
RUN git clone --depth 1 --branch v1.5.1 \
      https://github.com/acoustid/chromaprint.git /tmp/chromaprint && \
    cd /tmp/chromaprint && \
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_TOOLS=ON \
          -DFFT_LIB=avfft \
          . && \
    make -j$(nproc) && \
    make install && \
    ldconfig && \
    rm -rf /tmp/chromaprint

# Verify fpcalc is installed and works.
RUN fpcalc -version && \
    echo "fpcalc installed successfully"

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
