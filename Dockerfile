FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime: Python image (for yt-dlp + faster-whisper) with the Node binary copied in.
# faster-whisper decodes audio with its bundled PyAV, so no ffmpeg/apt packages are needed.
FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements.txt ./
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/transcripter.db \
    WHISPER_MODEL_DIR=/data/models \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    WHISPER_PYTHON=/opt/venv/bin/python
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY package.json ./
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
