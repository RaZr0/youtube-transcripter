# YouTube Transcripter

Paste a YouTube channel URL and every video on it is discovered, queued and transcribed in the
background by a third-party API. Transcripts are stored in a local SQLite database, shown in the
browser next to the video, and searchable across all your channels. You can add as many channels
as you like, and new uploads are picked up automatically.

## Features

- **Any channel URL:** `https://www.youtube.com/@handle`, `/channel/UC…`, `/c/name`, `/user/name`,
  or just `@handle`.
- **Whole-channel transcription:** regular videos, plus past live streams and Shorts if you want
  them (configurable per channel).
- **Background queue:** each video moves through queued → transcribing → done, with automatic
  retries and exponential backoff. Rate limits, quota errors and a bad API key pause the queue
  instead of failing every video.
- **Transcript viewer:** an embedded player with clickable timestamps, find-in-transcript, a
  plain-text view, copy, and `.txt` download.
- **Full-text search** across every transcript (SQLite FTS5). Put a phrase in `"quotes"` to match
  it exactly.
- **Export** a whole channel as JSON.
- **Auto-sync:** each channel is re-checked for new uploads every `SYNC_INTERVAL_HOURS`.

## Data safety

- Everything is stored in one SQLite file (`data/transcripter.db` by default) in WAL mode, which
  is crash-safe.
- Syncing **only adds** videos. Existing videos and transcripts are never overwritten or removed,
  even if a video is later deleted from YouTube.
- The queue lives in the database. After a crash or restart, interrupted videos go back in the
  queue. Async transcription jobs resume polling with their saved job id, so they are not paid
  for twice.
- Deleting a channel requires typing its channel id to confirm.
- Back up by copying `data/transcripter.db` (stop the app first, or use `sqlite3 transcripter.db ".backup copy.db"`).
  With Docker, the `./data` volume keeps it across rebuilds.

## Third-party APIs

| Purpose | Service | Required |
| --- | --- | --- |
| Transcripts, channel listing, video metadata | [Supadata](https://supadata.ai) | yes (`SUPADATA_API_KEY`) |
| Cheaper channel listing and video metadata | [YouTube Data API v3](https://developers.google.com/youtube/v3) | optional (`YOUTUBE_API_KEY`) |

Supadata returns YouTube's own captions when a video has them. In `TRANSCRIPT_MODE=auto` (the
default) it falls back to AI speech-to-text for videos without captions. Use `native` to only take
existing captions (cheapest), or `generate` to always use AI.

If you set `YOUTUBE_API_KEY`, listing a channel and fetching titles, dates and durations uses
Google's free daily quota (about 1 unit per 50 videos) instead of one Supadata credit per video.

## Quick start

Requires Node.js 22+.

```bash
npm install
cp .env.example .env        # then put your SUPADATA_API_KEY in .env
npm run build
npm start                   # http://localhost:3000
```

To try it without an API key, `TRANSCRIPT_PROVIDER=mock npm start` uses generated fake channels
and transcripts.

### Development

```bash
npm run dev          # API on :3000 (auto-reload) + Vite UI on http://localhost:5173
npm run dev:mock     # same, with fake data
npm test             # unit + API tests
npm run typecheck
```

### Docker

```bash
cp .env.example .env   # add your key
docker compose up -d --build
```

The database is stored in `./data` on the host.

## Configuration

All settings are environment variables (or a `.env` file). See [`.env.example`](.env.example) for
the full list. The main ones:

| Variable | Default | Description |
| --- | --- | --- |
| `SUPADATA_API_KEY` | – | Transcription API key |
| `TRANSCRIPT_MODE` | `auto` | `native`, `auto` or `generate` |
| `TRANSCRIPT_LANG` | original | Preferred language, e.g. `en` |
| `YOUTUBE_API_KEY` | – | Optional, for channel listing and metadata |
| `DATABASE_PATH` | `data/transcripter.db` | SQLite file |
| `WORKER_CONCURRENCY` | `2` | Videos transcribed in parallel |
| `REQUESTS_PER_SECOND` | `1` | Max calls per second to Supadata (match your plan) |
| `SYNC_INTERVAL_HOURS` | `12` | Auto re-sync interval, `0` to disable |

## Architecture

```
server/
  index.ts              entry point: wires everything together, graceful shutdown
  app.ts                REST API (Express) + serves the built UI
  db.ts                 SQLite schema + versioned migrations
  repo.ts               all SQL: channels, videos, transcripts, queue, search
  sync.ts               channel discovery: list videos → add new ones → fill metadata
  worker.ts             transcription queue: claim → request/poll → save, retries, pausing
  youtube-url.ts        channel URL parsing
  providers/
    supadata.ts         Supadata client (transcripts + channel listing)
    youtube-data-api.ts optional YouTube Data API source
    mock.ts             offline fake provider
web/src/                React UI (Vite)
tests/                  Vitest tests
```

To add another transcription service, implement `TranscriptProvider` from
`server/providers/types.ts` and register it in `server/providers/index.ts`.

### REST API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/status` | provider, queue and worker state |
| `GET` / `POST` | `/api/channels` | list / add (`{ url, includeShorts?, includeLive? }`) |
| `GET` / `PATCH` / `DELETE` | `/api/channels/:id` | details / options / delete (`?confirm=<youtube id>`) |
| `POST` | `/api/channels/:id/sync` | check for new videos now |
| `POST` | `/api/channels/:id/retry` | re-queue failed videos |
| `GET` | `/api/channels/:id/videos` | `?status=&q=&limit=&offset=` |
| `GET` | `/api/channels/:id/export` | all transcripts as JSON |
| `GET` | `/api/videos/:id` | video and transcript |
| `GET` | `/api/videos/:id/transcript.txt` | plain text (`?timestamps=false`) |
| `POST` | `/api/videos/:id/retry` | retry one video |
| `GET` | `/api/search?q=` | full-text search |
