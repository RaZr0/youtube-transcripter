# YouTube Transcripter

Paste a YouTube channel URL and every video on it is discovered, queued and transcribed in the
background. Transcripts are stored in a local SQLite database, shown in the browser next to the
video, and searchable across all your channels. You can add as many channels as you like, and new
uploads are picked up automatically.

It can run **for free on your own computer** (YouTube captions plus local Whisper), or through a
**paid API** (Supadata) if you'd rather not deal with YouTube at all.

## Features

- **Any channel URL:** `https://www.youtube.com/@handle`, `/channel/UC…`, `/c/name`, `/user/name`,
  or just `@handle`.
- **Whole-channel transcription:** regular videos, plus past live streams and Shorts if you want
  them (configurable per channel).
- **Background queue:** each video moves through queued → transcribing → done, with automatic
  retries and backoff. Blocking, rate limits and a bad API key pause the queue instead of failing
  every video.
- **Transcript viewer:** an embedded player with clickable timestamps, find-in-transcript, a
  plain-text view, copy, and `.txt` download. Each transcript shows where it came from (YouTube
  captions, automatic captions, or Whisper).
- **Full-text search** across every transcript. Put a phrase in `"quotes"` to match it exactly.
- **Export** a whole channel as JSON.

## Option 1: free, on your own computer (default)

For each video the app:

1. downloads YouTube's own captions with [yt-dlp](https://github.com/yt-dlp/yt-dlp). Human-made
   captions are used when they exist, otherwise YouTube's automatic captions in the video's original
   language. This is instant and covers the vast majority of videos.
2. if a video has no captions at all, downloads just its audio and transcribes it locally with
   [Whisper](https://github.com/SYSTRAN/faster-whisper). The audio file is deleted afterwards.

There are no API keys, accounts or per-video costs.

### Setup

Requires **Node.js 22+** and **Python 3.9+**.

```bash
npm install
npm run setup:local     # creates .venv with yt-dlp + faster-whisper (re-run any time to update)
npm run build
npm start               # http://localhost:3000
```

The Whisper model downloads on first use (about 0.5 GB for `small`) into `data/models`.

### About YouTube blocking

YouTube temporarily refuses connections that make too many requests too quickly ("Sign in to
confirm you're not a bot", HTTP 429). The block is on your IP address, not your Google account, and
usually lifts within hours. The app is built around this:

- **It goes slowly on purpose:** about one video every 8 seconds, randomised
  (`YOUTUBE_REQUEST_DELAY_SECONDS`), plus a 1-second gap between yt-dlp's own requests. An
  800-video channel takes roughly 2 hours.
- **If YouTube blocks anyway,** the whole queue pauses for `YOUTUBE_BLOCK_PAUSE_MINUTES` (60) and
  then resumes by itself. No attempts are used up, nothing is lost, and the banner at the top shows
  what's happening. You can also click "Resume now".
- **Run it from home.** Cloud servers (AWS, GCP, VPS hosting) are often blocked outright; home
  connections are treated much more leniently.
- **yt-dlp is kept up to date automatically** (`YTDLP_AUTO_UPDATE`), because YouTube changes
  regularly break older versions.
- **Optional: cookies.** `YTDLP_COOKIES_FILE` makes requests look like a logged-in browser. This
  helps with heavy blocking and age-restricted videos, but ties the activity to that Google account,
  so use a spare one.

Downloading from YouTube is a grey area under its Terms of Service. Keep it personal-scale.

### Whisper speed

Whisper only runs for videos without captions. With `WHISPER_MODEL=auto` the app uses
`large-v3-turbo` when it finds an NVIDIA GPU (a 30-minute video in about a minute or two), and
`small` on CPU (roughly 2–5× faster than real time, depending on the machine). One Whisper job runs
at a time. Set `WHISPER_ENABLED=false` to skip caption-less videos entirely.

## Option 2: paid API (Supadata)

Set `SUPADATA_API_KEY` (from [supadata.ai](https://supadata.ai)) and the app uses it
automatically. Supadata fetches captions or runs AI transcription on its own servers, so there is no
blocking to deal with and nothing to install. Pricing at the time of writing: 1 credit per video with
captions, 1 credit per minute for AI transcription; 100 free credits a month, $17/month for 3,000.
Use `TRANSCRIPT_MODE=native` to never pay for AI transcription.

## Data safety

- Everything is stored in one SQLite file (`data/transcripter.db`) in WAL mode, which is crash-safe.
- Syncing **only adds** videos. Existing videos and transcripts are never overwritten or removed,
  even if a video is later deleted from YouTube.
- The queue lives in the database. After a crash or restart, interrupted videos go back in the
  queue automatically.
- Deleting a channel requires typing its channel id to confirm.
- Back up by copying `data/transcripter.db` (stop the app first, or use
  `sqlite3 transcripter.db ".backup copy.db"`).

## Docker

```bash
cp .env.example .env
docker compose up -d --build     # http://localhost:3000
```

The image includes yt-dlp and faster-whisper (CPU). The database and Whisper models are stored in
`./data` on the host. For GPU Whisper, run natively with `npm run setup:local` instead.

## Configuration

All settings are environment variables (or a `.env` file). See [`.env.example`](.env.example) for
the full list with explanations. The most useful ones:

| Variable | Default | Description |
| --- | --- | --- |
| `TRANSCRIPT_PROVIDER` | `local`, or `supadata` if a key is set | `local`, `supadata` or `mock` |
| `TRANSCRIPT_LANG` | original | Preferred language, e.g. `en` |
| `YOUTUBE_REQUEST_DELAY_SECONDS` | `8` | Pause between videos (local mode) |
| `YOUTUBE_BLOCK_PAUSE_MINUTES` | `60` | Pause length when YouTube blocks (local mode) |
| `WHISPER_MODEL` | `auto` | `tiny` … `large-v3-turbo` |
| `WHISPER_ENABLED` | `true` | Transcribe videos without captions |
| `YTDLP_COOKIES_FILE` | – | Optional browser cookies (spare account) |
| `SUPADATA_API_KEY` | – | Paid mode |
| `YOUTUBE_API_KEY` | – | Optional, more reliable channel listing |
| `DATABASE_PATH` | `data/transcripter.db` | SQLite file |
| `SYNC_INTERVAL_HOURS` | `12` | Auto re-sync interval, `0` to disable |

## Development

```bash
npm run dev          # API on :3000 (auto-reload) + Vite UI on http://localhost:5173
npm run dev:mock     # same, with generated fake data (no YouTube access needed)
npm test             # unit + API tests
npm run typecheck
```

## Architecture

```
server/
  index.ts              entry point: wiring, yt-dlp auto-update, graceful shutdown
  app.ts                REST API (Express) + serves the built UI
  db.ts                 SQLite schema + versioned migrations
  repo.ts               all SQL: channels, videos, transcripts, queue, search
  sync.ts               channel discovery: list videos → add new ones → fill metadata
  worker.ts             transcription queue: claim → transcribe → save, retries, pausing
  youtube-url.ts        channel URL parsing
  providers/
    ytdlp.ts            yt-dlp wrapper, pacing, error classification, free channel listing
    local.ts            free transcriber: captions, else Whisper
    captions.ts         caption track selection + json3/VTT parsing
    supadata.ts         paid API client
    youtube-data-api.ts optional official API for channel listing
    mock.ts             offline fake provider
scripts/
  whisper_transcribe.py faster-whisper runner (one audio file → JSON)
  setup-local.mjs       creates .venv with yt-dlp + faster-whisper
web/src/                React UI (Vite)
tests/                  Vitest tests
```

### REST API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/status` | provider, tool, queue and worker state |
| `GET` / `POST` | `/api/channels` | list / add (`{ url, includeShorts?, includeLive? }`) |
| `GET` / `PATCH` / `DELETE` | `/api/channels/:id` | details / options / delete (`?confirm=<youtube id>`) |
| `POST` | `/api/channels/:id/sync` | check for new videos now |
| `POST` | `/api/channels/:id/retry` | re-queue failed videos |
| `GET` | `/api/channels/:id/videos` | `?status=&q=&limit=&offset=` |
| `GET` | `/api/channels/:id/export` | all transcripts as JSON |
| `GET` | `/api/videos/:id` | video and transcript |
| `GET` | `/api/videos/:id/transcript.txt` | plain text (`?timestamps=false`) |
| `POST` | `/api/videos/:id/retry` | retry one video |
| `POST` | `/api/worker/resume` | end a pause early |
| `GET` | `/api/search?q=` | full-text search |
