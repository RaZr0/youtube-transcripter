import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return value;
}

export type TranscriptMode = "native" | "auto" | "generate";

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** "supadata" (real transcription) or "mock" (fake data for local development / demos). */
  provider: "supadata" | "mock";
  supadataApiKey: string | undefined;
  supadataBaseUrl: string;
  /** native = only existing captions, auto = captions or AI fallback, generate = always AI. */
  transcriptMode: TranscriptMode;
  /** Preferred transcript language (ISO 639-1). Empty = the video's original language. */
  transcriptLang: string | undefined;
  /** Optional: when set, channel listing and video metadata come from the free YouTube Data API. */
  youtubeApiKey: string | undefined;
  workerConcurrency: number;
  maxAttempts: number;
  /** Max outbound requests per second to the transcription provider. */
  requestsPerSecond: number;
  /** Automatically re-sync every channel to pick up new uploads. 0 disables. */
  syncIntervalHours: number;
  maxVideosPerChannel: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.TRANSCRIPT_PROVIDER ?? "supadata").toLowerCase();
  if (provider !== "supadata" && provider !== "mock") {
    throw new Error(`TRANSCRIPT_PROVIDER must be "supadata" or "mock", got "${provider}"`);
  }
  const mode = (env.TRANSCRIPT_MODE ?? "auto").toLowerCase();
  if (mode !== "native" && mode !== "auto" && mode !== "generate") {
    throw new Error(`TRANSCRIPT_MODE must be "native", "auto" or "generate", got "${mode}"`);
  }
  return {
    port: int("PORT", 3000),
    host: env.HOST ?? "0.0.0.0",
    databasePath: path.resolve(env.DATABASE_PATH ?? "data/transcripter.db"),
    provider,
    supadataApiKey: env.SUPADATA_API_KEY || undefined,
    supadataBaseUrl: env.SUPADATA_BASE_URL ?? "https://api.supadata.ai/v1",
    transcriptMode: mode,
    transcriptLang: env.TRANSCRIPT_LANG || undefined,
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    workerConcurrency: Math.max(1, int("WORKER_CONCURRENCY", 2)),
    maxAttempts: Math.max(1, int("MAX_ATTEMPTS", 5)),
    requestsPerSecond: Math.max(0.1, num("REQUESTS_PER_SECOND", 1)),
    syncIntervalHours: Math.max(0, num("SYNC_INTERVAL_HOURS", 12)),
    maxVideosPerChannel: Math.min(5000, Math.max(1, int("MAX_VIDEOS_PER_CHANNEL", 5000))),
  };
}
