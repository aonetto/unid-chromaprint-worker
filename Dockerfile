FROM node:20-bookworm-slim

# Install fpcalc (Chromaprint CLI) + ffmpeg (for audio conversion)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libchromaprint-tools \
      ffmpeg \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]
