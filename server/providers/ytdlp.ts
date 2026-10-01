import type { LocalConfig } from "../config.js";
import { channelRefToUrl, parseChannelInput } from "../youtube-url.js";
import { runProcess, type Runner } from "./process.js";
import {
  ProviderError,
  type ChannelInfo,
  type ChannelSource,
  type ListVideosOptions,
  type VideoKind,
  type VideoMetadata,
  type VideoRef,
} from "./types.js";

/** Spaces out YouTube requests with a randomised gap so traffic looks like a person, not a scraper. */
export class Pacer {
  private next = 0;
  constructor(private readonly delayMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.delayMs * (0.7 + Math.random() * 0.6);
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** Fields of yt-dlp's JSON output that we use. */
export interface YtDlpInfo {
  id: string;
  title?: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: { id?: string; url: string; width?: number }[];
  upload_date?: string; // YYYYMMDD
  timestamp?: number;
  release_timestamp?: number;
  live_status?: "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";
  language?: string | null;
  channel?: string;
  channel_id?: string;
  uploader?: string;
  uploader_id?: string;
  subtitles?: Record<string, { ext: string; url: string; name?: string }[]> | null;
  automatic_captions?: Record<string, { ext: string; url: string; name?: string }[]> | null;
  entries?: YtDlpInfo[];
}

/** Thin wrapper around the yt-dlp command line, shared by channel listing and transcription. */
export class YtDlp {
  readonly pacer: Pacer;

  constructor(
    readonly config: LocalConfig,
    private readonly runner: Runner = runProcess,
  ) {
    this.pacer = new Pacer(config.requestDelayMs);
  }

  /** Runs yt-dlp with our standard options and returns stdout, or throws a classified ProviderError. */
  async run(args: string[], options: { timeoutMs?: number; paced?: boolean } = {}): Promise<string> {
    if (options.paced !== false) await this.pacer.wait();
    const base = [
      "--ignore-config",
      "--no-progress",
      // Pause between the several requests yt-dlp makes per video, too.
      "--sleep-requests",
      "1",
      // YouTube needs a JavaScript runtime to solve its player challenges; Node is always available here.
      "--js-runtimes",
      `node:${process.execPath}`,
    ];
    if (this.config.cookiesFile) base.push("--cookies", this.config.cookiesFile);

    let result;
    try {
      result = await this.runner(this.config.ytdlpPath, [...base, ...args], { timeoutMs: options.timeoutMs ?? 5 * 60_000 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderError(
          `yt-dlp was not found ("${this.config.ytdlpPath}"). Install it with: pip install -U "yt-dlp[default]"`,
          "not-configured",
          true,
          5 * 60_000,
        );
      }
      throw err;
    }
    if (result.code !== 0) throw classifyYtDlpError(result.stderr, this.config.blockPauseMs);
    return result.stdout;
  }

  async json(args: string[], options?: { timeoutMs?: number }): Promise<YtDlpInfo> {
    const stdout = await this.run(["--dump-single-json", ...args], options);
    try {
      return JSON.parse(stdout) as YtDlpInfo;
    } catch {
      throw new ProviderError("yt-dlp returned output that is not JSON", "bad-response", true);
    }
  }

  async version(): Promise<string> {
    return (await this.run(["--version"], { paced: false, timeoutMs: 30_000 })).trim();
  }
}

/**
 * Turns yt-dlp's error output into a ProviderError the worker knows how to handle.
 * "rate-limited" makes the worker pause the whole queue instead of failing videos one by one.
 */
export function classifyYtDlpError(stderr: string, blockPauseMs: number): ProviderError {
  const errorLines = stderr.split("\n").filter((l) => l.includes("ERROR"));
  const message = (errorLines.at(-1) ?? stderr.trim().split("\n").at(-1) ?? "yt-dlp failed")
    .replace(/^ERROR:\s*/, "")
    .replace(/;?\s*please report this issue.*$/i, "")
    .replace(/\s*\(caused by .*$/, "")
    .slice(0, 500);

  if (/not a bot|HTTP Error 429|Too Many Requests|rate.?limit|try again later|been blocked|unusual traffic/i.test(stderr)) {
    return new ProviderError(
      `YouTube is temporarily blocking requests from this connection ("${message}"). ` +
        `Pausing for ${Math.round(blockPauseMs / 60_000)} min, then resuming automatically.`,
      "rate-limited",
      true,
      blockPauseMs,
    );
  }
  if (/confirm your age|age.?restricted|inappropriate for some users/i.test(stderr)) {
    return new ProviderError(`Age-restricted video — set YTDLP_COOKIES_FILE to transcribe it. (${message})`, "age-restricted", false);
  }
  if (/does not have a \w+ tab|This channel does not have/i.test(stderr)) {
    return new ProviderError(message, "no-tab", false);
  }
  if (/live event will begin|Premieres in|Premiere will begin|is_upcoming|This live stream recording is not available/i.test(stderr)) {
    return new ProviderError(`Not available yet: ${message}`, "not-ready", true, 12 * 60 * 60_000);
  }
  if (
    /Private video|Video unavailable|has been removed|terminated|members.only|Join this channel|channel's members|not available in your country|copyright|does not exist|404: Not Found/i.test(
      stderr,
    )
  ) {
    return new ProviderError(message, "not-found", false);
  }
  if (/Unable to download|timed out|Connection reset|name resolution|Network is unreachable|SSL|Remote end closed/i.test(stderr)) {
    return new ProviderError(`Network problem reaching YouTube: ${message}`, "network", true);
  }
  return new ProviderError(`yt-dlp: ${message}`, "ytdlp-error", true);
}

export function infoToMetadata(info: YtDlpInfo): VideoMetadata {
  const timestamp = info.timestamp ?? info.release_timestamp;
  let publishedAt: string | undefined;
  if (timestamp) publishedAt = new Date(timestamp * 1000).toISOString();
  else if (info.upload_date && /^\d{8}$/.test(info.upload_date)) {
    const d = info.upload_date;
    publishedAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00.000Z`;
  }
  return {
    id: info.id,
    title: info.title,
    description: info.description,
    durationSeconds: info.duration ? Math.round(info.duration) : undefined,
    thumbnailUrl: info.thumbnail,
    publishedAt,
  };
}

const TABS: [tab: string, kind: VideoKind, option: keyof ListVideosOptions | null][] = [
  ["videos", "video", null],
  ["streams", "live", "includeLive"],
  ["shorts", "short", "includeShorts"],
];

/** Free channel listing straight from youtube.com via yt-dlp — no API key. */
export class YtDlpChannelSource implements ChannelSource {
  readonly name = "yt-dlp";

  constructor(private readonly ytdlp: YtDlp) {}

  async resolveChannel(input: string): Promise<ChannelInfo> {
    const base = channelRefToUrl(parseChannelInput(input));
    let info: YtDlpInfo;
    try {
      info = await this.ytdlp.json(["--flat-playlist", "--playlist-items", "1", `${base}/videos`]);
    } catch (err) {
      // Channels with only Shorts or streams have no Videos tab; the bare URL lists all uploads.
      if (!(err instanceof ProviderError) || err.code !== "no-tab") throw err;
      info = await this.ytdlp.json(["--flat-playlist", "--playlist-items", "1", base]);
    }
    const youtubeId = info.channel_id ?? (info.id?.startsWith("UC") ? info.id : undefined);
    if (!youtubeId) throw new ProviderError(`Could not find a channel at ${base}`, "not-found", false);
    const avatar = info.thumbnails?.find((t) => t.id === "avatar_uncropped") ?? info.thumbnails?.at(-1);
    return {
      youtubeId,
      title: info.channel ?? info.uploader ?? info.title?.replace(/ - Videos$/, "") ?? youtubeId,
      handle: info.uploader_id?.startsWith("@") ? info.uploader_id : undefined,
      description: info.description,
      thumbnailUrl: avatar?.url,
    };
  }

  async listVideos(channelId: string, options: ListVideosOptions): Promise<VideoRef[]> {
    const refs: VideoRef[] = [];
    for (const [tab, kind, option] of TABS) {
      if (option && !options[option]) continue;
      let info: YtDlpInfo;
      try {
        info = await this.ytdlp.json(
          [
            "--flat-playlist",
            "--playlist-end",
            String(options.limit),
            // Gives each entry an (approximate) upload date without an extra request per video.
            "--extractor-args",
            "youtubetab:approximate_date",
            `https://www.youtube.com/channel/${channelId}/${tab}`,
          ],
          { timeoutMs: 15 * 60_000 },
        );
      } catch (err) {
        if (err instanceof ProviderError && err.code === "no-tab") continue; // e.g. channel has no Shorts
        throw err;
      }
      for (const entry of info.entries ?? []) {
        if (!entry?.id || entry.live_status === "is_upcoming" || entry.live_status === "is_live") continue;
        const metadata = infoToMetadata(entry);
        delete metadata.thumbnailUrl; // flat entries carry tiny thumbnails; the UI derives a better one
        refs.push({ id: entry.id, kind, metadata });
      }
    }
    return refs;
  }

  /** Not needed: listing already returns titles, and exact details are saved during transcription. */
  async getVideoMetadata(): Promise<VideoMetadata[]> {
    return [];
  }
}
