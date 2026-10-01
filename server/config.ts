import fs from "node:fs";
import path from "node:path";

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return value;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
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
  /**
   * "local"    = free: yt-dlp for captions + Whisper on this machine for videos without captions
   * "supadata" = paid API
   * "mock"     = fake data for development / demos
   */
  provider: "local" | "supadata" | "mock";
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
  local: LocalConfig;
}

export interface LocalConfig {
  /** yt-dlp executable. */
  ytdlpPath: string;
  /** Optional Netscape cookies file passed to yt-dlp (use a spare Google account). */
  cookiesFile: string | undefined;
  /** Average pause between YouTube requests (randomised ±30%) to avoid being rate-limited. */
  requestDelayMs: number;
  /** How long to pause the whole queue when YouTube starts blocking. */
  blockPauseMs: number;
  whisperEnabled: boolean;
  /** "auto" = large-v3-turbo with an NVIDIA GPU, "small" on CPU. Or tiny/base/small/medium/large-v3/... */
  whisperModel: string;
  /** auto | cpu | cuda */
  whisperDevice: string;
  /** Python interpreter that has faster-whisper installed. */
  pythonPath: string;
  /** Where Whisper models are downloaded and cached. */
  modelDir: string;
  /** Upgrade yt-dlp on startup and daily (YouTube changes often break old versions). */
  autoUpdate: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Default: the paid API when a key is configured, otherwise the free local pipeline.
  const provider = (env.TRANSCRIPT_PROVIDER || (env.SUPADATA_API_KEY ? "supadata" : "local")).toLowerCase();
  if (provider !== "local" && provider !== "supadata" && provider !== "mock") {
    throw new Error(`TRANSCRIPT_PROVIDER must be "local", "supadata" or "mock", got "${provider}"`);
  }
  const mode = (env.TRANSCRIPT_MODE ?? "auto").toLowerCase();
  if (mode !== "native" && mode !== "auto" && mode !== "generate") {
    throw new Error(`TRANSCRIPT_MODE must be "native", "auto" or "generate", got "${mode}"`);
  }
  return {
    port: int(env, "PORT", 3000),
    host: env.HOST ?? "0.0.0.0",
    databasePath: path.resolve(env.DATABASE_PATH ?? "data/transcripter.db"),
    provider,
    supadataApiKey: env.SUPADATA_API_KEY || undefined,
    supadataBaseUrl: env.SUPADATA_BASE_URL ?? "https://api.supadata.ai/v1",
    transcriptMode: mode,
    transcriptLang: env.TRANSCRIPT_LANG || undefined,
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    workerConcurrency: Math.max(1, int(env, "WORKER_CONCURRENCY", 2)),
    maxAttempts: Math.max(1, int(env, "MAX_ATTEMPTS", 5)),
    requestsPerSecond: Math.max(0.1, num(env, "REQUESTS_PER_SECOND", 1)),
    syncIntervalHours: Math.max(0, num(env, "SYNC_INTERVAL_HOURS", 12)),
    maxVideosPerChannel: Math.min(5000, Math.max(1, int(env, "MAX_VIDEOS_PER_CHANNEL", 5000))),
    local: {
      // `npm run setup:local` installs everything into .venv; use it automatically when present.
      ytdlpPath: env.YTDLP_PATH || venvFile(["bin/yt-dlp", "Scripts/yt-dlp.exe"]) || "yt-dlp",
      cookiesFile: env.YTDLP_COOKIES_FILE || undefined,
      requestDelayMs: Math.max(0, num(env, "YOUTUBE_REQUEST_DELAY_SECONDS", 8)) * 1000,
      blockPauseMs: Math.max(1, num(env, "YOUTUBE_BLOCK_PAUSE_MINUTES", 60)) * 60_000,
      whisperEnabled: (env.WHISPER_ENABLED ?? "true").toLowerCase() !== "false",
      whisperModel: env.WHISPER_MODEL || "auto",
      whisperDevice: env.WHISPER_DEVICE || "auto",
      pythonPath:
        env.WHISPER_PYTHON || venvFile(["bin/python", "Scripts/python.exe"]) || (process.platform === "win32" ? "python" : "python3"),
      modelDir: path.resolve(env.WHISPER_MODEL_DIR || "data/models"),
      autoUpdate: (env.YTDLP_AUTO_UPDATE ?? "true").toLowerCase() !== "false",
    },
  };
}

function venvFile(candidates: string[]): string | undefined {
  return candidates.map((c) => path.resolve(".venv", c)).find((p) => fs.existsSync(p));
}
