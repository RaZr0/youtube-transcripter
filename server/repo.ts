import type { DB } from "./db.js";
import type { ChannelInfo, TranscriptResult, VideoMetadata, VideoRef } from "./providers/types.js";

export type VideoStatus = "pending" | "processing" | "completed" | "failed" | "unavailable";

export interface ChannelRow {
  id: number;
  youtube_id: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnail_url: string | null;
  source_url: string;
  include_shorts: number;
  include_live: number;
  sync_status: "idle" | "syncing" | "error";
  sync_error: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface ChannelStats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  unavailable: number;
}

export interface VideoRow {
  id: string;
  channel_id: number;
  kind: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  status: VideoStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  provider_job_id: string | null;
  discovered_at: string;
  updated_at: string;
}

export interface TranscriptRow {
  video_id: string;
  language: string | null;
  available_languages: string | null;
  segments: string;
  full_text: string;
  word_count: number;
  provider: string;
  created_at: string;
}

const now = () => new Date().toISOString();

export class Repo {
  constructor(readonly db: DB) {}

  // ---- channels -------------------------------------------------------------------------------

  createChannel(info: ChannelInfo, sourceUrl: string, options: { includeShorts: boolean; includeLive: boolean }): ChannelRow {
    return this.db
      .prepare(
        `INSERT INTO channels (youtube_id, title, handle, description, thumbnail_url, source_url, include_shorts, include_live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        info.youtubeId,
        info.title,
        info.handle ?? null,
        info.description ?? null,
        info.thumbnailUrl ?? null,
        sourceUrl,
        options.includeShorts ? 1 : 0,
        options.includeLive ? 1 : 0,
      ) as ChannelRow;
  }

  updateChannelInfo(id: number, info: ChannelInfo): void {
    this.db
      .prepare(
        `UPDATE channels SET title = ?, handle = COALESCE(?, handle), description = COALESCE(?, description),
         thumbnail_url = COALESCE(?, thumbnail_url) WHERE id = ?`,
      )
      .run(info.title, info.handle ?? null, info.description ?? null, info.thumbnailUrl ?? null, id);
  }

  getChannel(id: number): ChannelRow | undefined {
    return this.db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined;
  }

  getChannelByYoutubeId(youtubeId: string): ChannelRow | undefined {
    return this.db.prepare(`SELECT * FROM channels WHERE youtube_id = ?`).get(youtubeId) as ChannelRow | undefined;
  }

  listChannels(): (ChannelRow & { stats: ChannelStats })[] {
    const channels = this.db.prepare(`SELECT * FROM channels ORDER BY created_at DESC`).all() as ChannelRow[];
    return channels.map((channel) => ({ ...channel, stats: this.channelStats(channel.id) }));
  }

  channelStats(channelId: number): ChannelStats {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM videos WHERE channel_id = ? GROUP BY status`)
      .all(channelId) as { status: VideoStatus; n: number }[];
    const stats: ChannelStats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, unavailable: 0 };
    for (const row of rows) {
      stats[row.status] = row.n;
      stats.total += row.n;
    }
    return stats;
  }

  setChannelSync(id: number, status: ChannelRow["sync_status"], error: string | null = null): void {
    const syncedAt = status === "idle" ? now() : null;
    this.db
      .prepare(
        `UPDATE channels SET sync_status = ?, sync_error = ?, last_synced_at = COALESCE(?, last_synced_at) WHERE id = ?`,
      )
      .run(status, error, syncedAt, id);
  }

  setChannelOptions(id: number, options: { includeShorts?: boolean; includeLive?: boolean }): void {
    if (options.includeShorts !== undefined) {
      this.db.prepare(`UPDATE channels SET include_shorts = ? WHERE id = ?`).run(options.includeShorts ? 1 : 0, id);
    }
    if (options.includeLive !== undefined) {
      this.db.prepare(`UPDATE channels SET include_live = ? WHERE id = ?`).run(options.includeLive ? 1 : 0, id);
    }
  }

  deleteChannel(id: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM transcripts_fts WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)`)
        .run(id);
      this.db.prepare(`DELETE FROM channels WHERE id = ?`).run(id); // cascades to videos and transcripts
    })();
  }

  // ---- videos ---------------------------------------------------------------------------------

  /** Adds videos we have not seen before. Existing rows (and their transcripts) are never touched. */
  addVideos(channelId: number, refs: VideoRef[]): number {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO videos (id, channel_id, kind) VALUES (?, ?, ?)`);
    return this.db.transaction(() => {
      let added = 0;
      for (const ref of refs) added += insert.run(ref.id, channelId, ref.kind).changes;
      return added;
    })();
  }

  videoIdsMissingMetadata(channelId: number): string[] {
    return (
      this.db.prepare(`SELECT id FROM videos WHERE channel_id = ? AND title IS NULL`).all(channelId) as { id: string }[]
    ).map((row) => row.id);
  }

  saveMetadata(items: VideoMetadata[]): void {
    const update = this.db.prepare(
      `UPDATE videos SET
         title = COALESCE(?, title), description = COALESCE(?, description), thumbnail_url = COALESCE(?, thumbnail_url),
         published_at = COALESCE(?, published_at), duration_seconds = COALESCE(?, duration_seconds), updated_at = ?
       WHERE id = ?`,
    );
    const updateFts = this.db.prepare(`UPDATE transcripts_fts SET title = ? WHERE video_id = ?`);
    this.db.transaction(() => {
      for (const m of items) {
        update.run(
          m.title ?? null,
          m.description ?? null,
          m.thumbnailUrl ?? null,
          m.publishedAt ?? null,
          m.durationSeconds ?? null,
          now(),
          m.id,
        );
        if (m.title) updateFts.run(m.title, m.id);
      }
    })();
  }

  getVideo(id: string): VideoRow | undefined {
    return this.db.prepare(`SELECT * FROM videos WHERE id = ?`).get(id) as VideoRow | undefined;
  }

  listVideos(
    channelId: number,
    options: { status?: VideoStatus; query?: string; limit: number; offset: number },
  ): { items: (VideoRow & { word_count: number | null })[]; total: number } {
    const where = ["v.channel_id = ?"];
    const params: unknown[] = [channelId];
    if (options.status) {
      where.push("v.status = ?");
      params.push(options.status);
    }
    if (options.query) {
      where.push("(v.title LIKE ? OR v.id = ?)");
      params.push(`%${options.query}%`, options.query);
    }
    const clause = where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${clause}`).get(...params) as { n: number }).n;
    const items = this.db
      .prepare(
        `SELECT v.*, t.word_count FROM videos v LEFT JOIN transcripts t ON t.video_id = v.id
         WHERE ${clause}
         ORDER BY COALESCE(v.published_at, v.discovered_at) DESC, v.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset) as (VideoRow & { word_count: number | null })[];
    return { items, total };
  }

  getTranscript(videoId: string): TranscriptRow | undefined {
    return this.db.prepare(`SELECT * FROM transcripts WHERE video_id = ?`).get(videoId) as TranscriptRow | undefined;
  }

  // ---- queue ----------------------------------------------------------------------------------

  /** On startup: anything left "processing" by a crash goes back in the queue (keeping its job id). */
  recoverInterrupted(): number {
    return this.db.prepare(`UPDATE videos SET status = 'pending' WHERE status = 'processing'`).run().changes;
  }

  /** Atomically takes the next due videos off the queue, newest uploads first. */
  claimNext(limit: number, maxAttempts: number): VideoRow[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM videos
           WHERE (status = 'pending' OR (status = 'failed' AND attempts < ?))
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY status = 'failed', COALESCE(published_at, discovered_at) DESC
           LIMIT ?`,
        )
        .all(maxAttempts, now(), limit) as VideoRow[];
      const mark = this.db.prepare(`UPDATE videos SET status = 'processing', updated_at = ? WHERE id = ?`);
      for (const row of rows) mark.run(now(), row.id);
      return rows;
    })();
  }

  setJobId(videoId: string, jobId: string | null): void {
    this.db.prepare(`UPDATE videos SET provider_job_id = ?, updated_at = ? WHERE id = ?`).run(jobId, now(), videoId);
  }

  /** Puts a video back in the queue without counting a failed attempt (e.g. job still running). */
  requeue(videoId: string, delayMs: number, note: string | null = null): void {
    this.db
      .prepare(`UPDATE videos SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + delayMs).toISOString(), note, now(), videoId);
  }

  saveTranscript(videoId: string, provider: string, result: TranscriptResult): void {
    const segments = result.segments.map((s) => ({
      start: Math.round(s.start * 100) / 100,
      duration: Math.round(s.duration * 100) / 100,
      text: s.text.replace(/\s+/g, " ").trim(),
    }));
    const fullText = segments.map((s) => s.text).join(" ");
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO transcripts (video_id, language, available_languages, segments, full_text, word_count, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET language = excluded.language, available_languages = excluded.available_languages,
             segments = excluded.segments, full_text = excluded.full_text, word_count = excluded.word_count,
             provider = excluded.provider, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(
          videoId,
          result.language ?? null,
          result.availableLanguages ? JSON.stringify(result.availableLanguages) : null,
          JSON.stringify(segments),
          fullText,
          wordCount,
          provider,
        );
      const title = (this.db.prepare(`SELECT title FROM videos WHERE id = ?`).get(videoId) as { title: string | null })
        ?.title;
      this.db.prepare(`DELETE FROM transcripts_fts WHERE video_id = ?`).run(videoId);
      this.db.prepare(`INSERT INTO transcripts_fts (video_id, title, body) VALUES (?, ?, ?)`).run(videoId, title ?? "", fullText);
      this.db
        .prepare(
          `UPDATE videos SET status = 'completed', last_error = NULL, next_attempt_at = NULL, provider_job_id = NULL,
           updated_at = ? WHERE id = ?`,
        )
        .run(now(), videoId);
    })();
  }

  markFailed(videoId: string, error: string, options: { retryInMs?: number; permanent?: boolean; keepJob?: boolean }): void {
    const status: VideoStatus = options.permanent ? "unavailable" : "failed";
    const next = options.retryInMs !== undefined ? new Date(Date.now() + options.retryInMs).toISOString() : null;
    this.db
      .prepare(
        `UPDATE videos SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
         provider_job_id = CASE WHEN ? THEN provider_job_id ELSE NULL END, updated_at = ? WHERE id = ?`,
      )
      .run(status, error.slice(0, 1000), next, options.keepJob ? 1 : 0, now(), videoId);
  }

  /** Re-queues failed (and optionally unavailable) videos so they are tried again from scratch. */
  retryVideos(filter: { channelId?: number; videoId?: string; includeUnavailable?: boolean }): number {
    const statuses = filter.includeUnavailable ? `('failed', 'unavailable')` : `('failed')`;
    const where = [`status IN ${statuses}`];
    const params: unknown[] = [];
    if (filter.channelId !== undefined) {
      where.push("channel_id = ?");
      params.push(filter.channelId);
    }
    if (filter.videoId !== undefined) {
      where.push("id = ?");
      params.push(filter.videoId);
    }
    return this.db
      .prepare(
        `UPDATE videos SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
         WHERE ${where.join(" AND ")}`,
      )
      .run(now(), ...params).changes;
  }

  queueStats(): ChannelStats {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM videos GROUP BY status`).all() as {
      status: VideoStatus;
      n: number;
    }[];
    const stats: ChannelStats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, unavailable: 0 };
    for (const row of rows) {
      stats[row.status] = row.n;
      stats.total += row.n;
    }
    return stats;
  }

  // ---- search ---------------------------------------------------------------------------------

  search(query: string, options: { channelId?: number; limit: number; offset: number }) {
    const match = toFtsQuery(query);
    if (!match) return { items: [], total: 0 };
    const where = ["transcripts_fts MATCH ?"];
    const params: unknown[] = [match];
    if (options.channelId !== undefined) {
      where.push("v.channel_id = ?");
      params.push(options.channelId);
    }
    const from = `FROM transcripts_fts JOIN videos v ON v.id = transcripts_fts.video_id JOIN channels c ON c.id = v.channel_id
                  WHERE ${where.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
    const items = this.db
      .prepare(
        `SELECT v.id, v.title, v.thumbnail_url, v.published_at, v.channel_id, c.title AS channel_title,
           snippet(transcripts_fts, 2, '[[', ']]', ' … ', 24) AS snippet
         ${from}
         ORDER BY rank
         LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset);
    return { items, total };
  }
}

/** Turns free text into a safe FTS5 query: every word must appear; "quoted phrases" are kept. */
export function toFtsQuery(input: string): string {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const raw = (m[1] ?? m[2]).replace(/"/g, "").trim();
    if (!raw) continue;
    terms.push(m[1] ? `"${raw}"` : `"${raw}"*`);
  }
  return terms.join(" ");
}
