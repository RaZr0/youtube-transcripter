import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "./config.js";
import { ProviderError } from "./providers/types.js";
import type { Repo, TranscriptRow, VideoRow, VideoStatus } from "./repo.js";
import type { ChannelSync } from "./sync.js";
import type { TranscriptionWorker } from "./worker.js";
import { ChannelInputError } from "./youtube-url.js";

export interface AppDeps {
  repo: Repo;
  sync: ChannelSync;
  worker: TranscriptionWorker;
  config: Config;
  providerName: string;
  configurationError?: string;
  /** Directory with the built frontend (served when present). */
  staticDir?: string;
}

const STATUSES = ["pending", "processing", "completed", "failed", "unavailable"] as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(deps: AppDeps) {
  const { repo, sync, worker } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();

  api.get("/status", (_req, res) => {
    res.json({
      provider: deps.providerName,
      channelSource: deps.config.youtubeApiKey ? "youtube-data-api" : deps.providerName,
      transcriptMode: deps.config.transcriptMode,
      configurationError: deps.configurationError ?? null,
      worker: worker.status(),
      queue: repo.queueStats(),
    });
  });

  api.post("/worker/resume", (_req, res) => {
    worker.resume();
    res.json(worker.status());
  });

  // ---- channels ----

  api.get("/channels", (_req, res) => {
    res.json(repo.listChannels().map((c) => serializeChannel(c, sync.isSyncing(c.id))));
  });

  api.post("/channels", async (req, res) => {
    const body = z
      .object({
        url: z.string().min(1).max(500),
        includeShorts: z.boolean().optional().default(false),
        includeLive: z.boolean().optional().default(true),
      })
      .parse(req.body);
    const { channel, created } = await sync.addChannel(body.url, body);
    res.status(created ? 201 : 200).json({ ...serializeChannel({ ...channel, stats: repo.channelStats(channel.id) }, true), created });
  });

  api.get("/channels/:id", (req, res) => {
    const channel = repo.getChannel(channelId(req));
    if (!channel) throw new HttpError(404, "Channel not found");
    res.json(serializeChannel({ ...channel, stats: repo.channelStats(channel.id) }, sync.isSyncing(channel.id)));
  });

  api.patch("/channels/:id", (req, res) => {
    const id = channelId(req);
    if (!repo.getChannel(id)) throw new HttpError(404, "Channel not found");
    const body = z.object({ includeShorts: z.boolean().optional(), includeLive: z.boolean().optional() }).parse(req.body);
    repo.setChannelOptions(id, body);
    void sync.syncChannel(id);
    const channel = repo.getChannel(id)!;
    res.json(serializeChannel({ ...channel, stats: repo.channelStats(id) }, true));
  });

  api.post("/channels/:id/sync", (req, res) => {
    const id = channelId(req);
    if (!repo.getChannel(id)) throw new HttpError(404, "Channel not found");
    void sync.syncChannel(id);
    res.status(202).json({ ok: true });
  });

  api.post("/channels/:id/retry", (req, res) => {
    const id = channelId(req);
    if (!repo.getChannel(id)) throw new HttpError(404, "Channel not found");
    const includeUnavailable = req.query.includeUnavailable === "true";
    const count = repo.retryVideos({ channelId: id, includeUnavailable });
    worker.notify();
    res.json({ requeued: count });
  });

  api.delete("/channels/:id", (req, res) => {
    const id = channelId(req);
    const channel = repo.getChannel(id);
    if (!channel) throw new HttpError(404, "Channel not found");
    // Deleting throws away transcripts that cost money, so require the caller to say so explicitly.
    if (req.query.confirm !== channel.youtube_id) {
      throw new HttpError(400, "Pass ?confirm=<youtube channel id> to delete a channel and all its transcripts");
    }
    repo.deleteChannel(id);
    res.status(204).end();
  });

  api.get("/channels/:id/videos", (req, res) => {
    const id = channelId(req);
    if (!repo.getChannel(id)) throw new HttpError(404, "Channel not found");
    const query = z
      .object({
        status: z.enum(STATUSES).optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const result = repo.listVideos(id, { status: query.status as VideoStatus | undefined, query: query.q, limit: query.limit, offset: query.offset });
    res.json({ total: result.total, items: result.items.map((v) => ({ ...serializeVideo(v), wordCount: v.word_count })) });
  });

  api.get("/channels/:id/export", (req, res) => {
    const channel = repo.getChannel(channelId(req));
    if (!channel) throw new HttpError(404, "Channel not found");
    const { items } = repo.listVideos(channel.id, { status: "completed", limit: 1_000_000, offset: 0 });
    const videos = items.map((v) => {
      const t = repo.getTranscript(v.id)!;
      return { ...serializeVideo(v), transcript: serializeTranscript(t) };
    });
    const filename = `${slug(channel.title)}-transcripts.json`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json({ channel: { youtubeId: channel.youtube_id, title: channel.title, url: channel.source_url }, exportedAt: new Date().toISOString(), videos });
  });

  // ---- videos ----

  api.get("/videos/:id", (req, res) => {
    const video = repo.getVideo(String(req.params.id));
    if (!video) throw new HttpError(404, "Video not found");
    const channel = repo.getChannel(video.channel_id)!;
    const transcript = repo.getTranscript(video.id);
    res.json({
      ...serializeVideo(video),
      channel: { id: channel.id, title: channel.title },
      transcript: transcript ? serializeTranscript(transcript) : null,
    });
  });

  api.get("/videos/:id/transcript.txt", (req, res) => {
    const video = repo.getVideo(String(req.params.id));
    const transcript = video && repo.getTranscript(video.id);
    if (!video || !transcript) throw new HttpError(404, "Transcript not found");
    const withTimestamps = req.query.timestamps !== "false";
    const segments = JSON.parse(transcript.segments) as { start: number; text: string }[];
    const body = withTimestamps
      ? segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n")
      : transcript.full_text;
    const header = `${video.title ?? video.id}\nhttps://www.youtube.com/watch?v=${video.id}\n\n`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug(video.title ?? video.id)}.txt"`);
    res.send(header + body + "\n");
  });

  api.post("/videos/:id/retry", (req, res) => {
    const count = repo.retryVideos({ videoId: String(req.params.id), includeUnavailable: true });
    if (!count) throw new HttpError(409, "Only failed or unavailable videos can be retried");
    worker.notify();
    res.json({ requeued: count });
  });

  // ---- search ----

  api.get("/search", (req, res) => {
    const query = z
      .object({
        q: z.string().min(1).max(200),
        channelId: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    res.json(repo.search(query.q, query));
  });

  api.use((_req, _res, next) => next(new HttpError(404, "Not found")));
  app.use("/api", api);

  if (deps.staticDir && fs.existsSync(path.join(deps.staticDir, "index.html"))) {
    app.use(express.static(deps.staticDir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof ProviderError) {
      res.status(err.code === "not-found" ? 404 : 502).json({ error: err.message });
    } else if (err instanceof ChannelInputError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof SyntaxError && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body" });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}

function channelId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, "Channel not found");
  return id;
}

function serializeChannel(c: ReturnType<Repo["listChannels"]>[number], syncing: boolean) {
  return {
    id: c.id,
    youtubeId: c.youtube_id,
    title: c.title,
    handle: c.handle,
    description: c.description,
    thumbnailUrl: c.thumbnail_url,
    url: c.source_url,
    includeShorts: !!c.include_shorts,
    includeLive: !!c.include_live,
    syncStatus: syncing ? "syncing" : c.sync_status,
    syncError: c.sync_error,
    lastSyncedAt: c.last_synced_at,
    createdAt: c.created_at,
    stats: c.stats,
  };
}

function serializeVideo(v: VideoRow) {
  return {
    id: v.id,
    channelId: v.channel_id,
    kind: v.kind,
    title: v.title,
    description: v.description,
    thumbnailUrl: v.thumbnail_url ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    publishedAt: v.published_at,
    durationSeconds: v.duration_seconds,
    status: v.status,
    inProgress: v.status === "processing" || !!v.provider_job_id,
    attempts: v.attempts,
    lastError: v.last_error,
    nextAttemptAt: v.next_attempt_at,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  };
}

function serializeTranscript(t: TranscriptRow) {
  return {
    language: t.language,
    availableLanguages: t.available_languages ? (JSON.parse(t.available_languages) as string[]) : [],
    segments: JSON.parse(t.segments) as { start: number; duration: number; text: string }[],
    text: t.full_text,
    wordCount: t.word_count,
    provider: t.provider,
    createdAt: t.created_at,
  };
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "transcript";
}
