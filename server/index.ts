import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createProviders } from "./providers/index.js";
import type { LocalStatus } from "./providers/local.js";
import { killAllProcesses, runProcess } from "./providers/process.js";
import { Repo } from "./repo.js";
import { ChannelSync } from "./sync.js";
import { TranscriptionWorker } from "./worker.js";

try {
  process.loadEnvFile(); // optional .env in the working directory
} catch {
  // no .env file — rely on the real environment
}

const config = loadConfig();
const db = openDatabase(config.databasePath);
const repo = new Repo(db);
const providers = createProviders(config);
const worker = new TranscriptionWorker(repo, providers.transcripts, config);
const sync = new ChannelSync(repo, providers.channels, worker, config);

// Checking yt-dlp / Whisper spawns processes, so do it at startup and every 10 minutes, not per request.
let localStatus: LocalStatus | null = null;
async function refreshLocalStatus() {
  if (!providers.local) return;
  localStatus = await providers.local.status();
  if (localStatus.ytdlpError) console.warn(`  WARNING: ${localStatus.ytdlpError}`);
  else if (localStatus.whisperEnabled && !localStatus.whisperAvailable) {
    console.warn(`  WARNING: ${localStatus.whisperError} — videos without captions will be skipped`);
  }
}

/**
 * YouTube changes often break old yt-dlp versions, so keep it current — but only when yt-dlp lives in
 * the same virtualenv as our Python (set up by `npm run setup:local` or the Docker image).
 */
async function updateYtDlp() {
  const { ytdlpPath, pythonPath, autoUpdate } = config.local;
  if (!providers.local || !autoUpdate || !path.isAbsolute(ytdlpPath) || path.dirname(ytdlpPath) !== path.dirname(pythonPath)) return;
  const result = await runProcess(pythonPath, ["-m", "pip", "install", "--quiet", "--upgrade", "yt-dlp[default]"], {
    timeoutMs: 5 * 60_000,
  }).catch((err: Error) => ({ code: 1, stdout: "", stderr: err.message }));
  if (result.code !== 0) console.warn(`[yt-dlp] auto-update failed: ${result.stderr.trim().split("\n").at(-1)}`);
}

void updateYtDlp().then(refreshLocalStatus);
setInterval(() => void refreshLocalStatus(), 10 * 60_000).unref();
setInterval(() => void updateYtDlp().then(refreshLocalStatus), 24 * 60 * 60_000).unref();

const here = path.dirname(fileURLToPath(import.meta.url));
const app = createApp({
  repo,
  sync,
  worker,
  config,
  providerName: providers.transcripts.name,
  channelSourceName: providers.channels.name,
  configurationError: providers.configurationError,
  localStatus: () => localStatus,
  // Built frontend: dist/web, whether running compiled (dist/server) or from source via tsx (server/).
  staticDir: process.env.STATIC_DIR ?? path.resolve(here, path.basename(path.dirname(here)) === "dist" ? "../web" : "../dist/web"),
});

const server = app.listen(config.port, config.host, () => {
  console.log(`YouTube Transcripter listening on http://localhost:${config.port}`);
  console.log(`  database:   ${config.databasePath}`);
  console.log(`  provider:   ${providers.transcripts.name} (mode: ${config.transcriptMode})`);
  console.log(`  channels:   ${providers.channels.name}`);
  if (providers.configurationError) console.warn(`  WARNING: ${providers.configurationError}`);
});

worker.start();
sync.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);
  server.close();
  sync.stop();
  const stopped = worker.stop(); // stop first, so videos interrupted below are re-queued, not counted as failures
  killAllProcesses(); // yt-dlp / Whisper
  await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  db.close(); // checkpoints the WAL so the .db file is complete on its own
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
