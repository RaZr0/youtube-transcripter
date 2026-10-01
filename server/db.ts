import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

/**
 * Schema migrations. Each entry runs exactly once, in order, inside a transaction.
 * Never edit an existing migration: append a new one so existing databases upgrade safely.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id      TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    handle          TEXT,
    description     TEXT,
    thumbnail_url   TEXT,
    source_url      TEXT NOT NULL,
    include_shorts  INTEGER NOT NULL DEFAULT 0,
    include_live    INTEGER NOT NULL DEFAULT 1,
    sync_status     TEXT NOT NULL DEFAULT 'idle',   -- idle | syncing | error
    sync_error      TEXT,
    last_synced_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE videos (
    id                 TEXT PRIMARY KEY,               -- YouTube video id
    channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL DEFAULT 'video',  -- video | short | live
    title              TEXT,
    description        TEXT,
    thumbnail_url      TEXT,
    published_at       TEXT,
    duration_seconds   INTEGER,
    status             TEXT NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed | unavailable
    attempts           INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    next_attempt_at    TEXT,
    provider_job_id    TEXT,                           -- async job id, kept so restarts resume instead of re-paying
    discovered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX videos_channel_idx ON videos(channel_id, published_at DESC);
  CREATE INDEX videos_queue_idx ON videos(status, next_attempt_at);

  CREATE TABLE transcripts (
    video_id      TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    language      TEXT,
    available_languages TEXT,                          -- JSON array
    segments      TEXT NOT NULL,                       -- JSON array of {start, duration, text}
    full_text     TEXT NOT NULL,
    word_count    INTEGER NOT NULL,
    provider      TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE VIRTUAL TABLE transcripts_fts USING fts5(
    video_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // crash-safe, concurrent readers while the worker writes
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
