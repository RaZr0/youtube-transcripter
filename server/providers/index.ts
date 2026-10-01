import type { Config } from "../config.js";
import { LocalTranscriber } from "./local.js";
import { MockProvider } from "./mock.js";
import { SupadataClient } from "./supadata.js";
import { ProviderError, type ChannelSource, type TranscriptProvider } from "./types.js";
import { YouTubeDataApiSource } from "./youtube-data-api.js";
import { YtDlp, YtDlpChannelSource } from "./ytdlp.js";

export interface Providers {
  channels: ChannelSource;
  transcripts: TranscriptProvider;
  /** Human-readable reason the app cannot transcribe yet (e.g. missing API key), if any. */
  configurationError?: string;
  /** Set for the local provider: reports whether yt-dlp / Whisper are installed. */
  local?: LocalTranscriber;
}

/** Fails every call with a clear message, so the UI can explain what to configure. */
class Unconfigured implements ChannelSource, TranscriptProvider {
  readonly name = "unconfigured";
  constructor(private readonly message: string) {}
  private fail(): never {
    throw new ProviderError(this.message, "not-configured", true, 5 * 60_000);
  }
  resolveChannel = async () => this.fail();
  listVideos = async () => this.fail();
  getVideoMetadata = async () => this.fail();
  requestTranscript = async () => this.fail();
  pollTranscript = async () => this.fail();
}

export function createProviders(config: Config): Providers {
  if (config.provider === "mock") {
    const mock = new MockProvider();
    return { channels: mock, transcripts: mock };
  }

  const youtube = config.youtubeApiKey ? new YouTubeDataApiSource(config.youtubeApiKey) : undefined;

  if (config.provider === "local") {
    const ytdlp = new YtDlp(config.local);
    const local = new LocalTranscriber(ytdlp, config.transcriptLang);
    // The official API is free and more robust for listing when a key is configured.
    return { channels: youtube ?? new YtDlpChannelSource(ytdlp), transcripts: local, local };
  }

  if (!config.supadataApiKey) {
    const message =
      "SUPADATA_API_KEY is not set. Get a key at https://supadata.ai and restart the server (or set TRANSCRIPT_PROVIDER=mock to try the app with fake data).";
    const unconfigured = new Unconfigured(message);
    return { channels: youtube ?? unconfigured, transcripts: unconfigured, configurationError: message };
  }

  const supadata = new SupadataClient({
    apiKey: config.supadataApiKey,
    baseUrl: config.supadataBaseUrl,
    mode: config.transcriptMode,
    lang: config.transcriptLang,
    requestsPerSecond: config.requestsPerSecond,
  });
  return { channels: youtube ?? supadata, transcripts: supadata };
}
