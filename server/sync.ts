import type { Config } from "./config.js";
import type { ChannelSource } from "./providers/types.js";
import type { ChannelRow, Repo } from "./repo.js";
import type { TranscriptionWorker } from "./worker.js";
import { channelRefToUrl, parseChannelInput } from "./youtube-url.js";

const METADATA_CHUNK = 50;

/**
 * Discovers a channel's videos and adds new ones to the transcription queue. Syncing is purely
 * additive: videos and transcripts already stored are never removed or overwritten, even if the
 * video later disappears from YouTube.
 */
export class ChannelSync {
  private readonly syncing = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly source: ChannelSource,
    private readonly worker: TranscriptionWorker,
    private readonly config: Pick<Config, "maxVideosPerChannel" | "syncIntervalHours">,
  ) {}

  /** Resolves the URL, stores the channel and starts the first sync in the background. */
  async addChannel(
    input: string,
    options: { includeShorts: boolean; includeLive: boolean },
  ): Promise<{ channel: ChannelRow; created: boolean }> {
    const ref = parseChannelInput(input); // throws a friendly error for bad input
    const sourceUrl = channelRefToUrl(ref);
    const info = await this.source.resolveChannel(ref.type === "id" ? ref.value : sourceUrl);
    const existing = this.repo.getChannelByYoutubeId(info.youtubeId);
    if (existing) {
      void this.syncChannel(existing.id);
      return { channel: existing, created: false };
    }
    const channel = this.repo.createChannel(info, sourceUrl, options);
    void this.syncChannel(channel.id);
    return { channel, created: true };
  }

  isSyncing(channelId: number): boolean {
    return this.syncing.has(channelId);
  }

  /** Runs one sync; concurrent requests for the same channel are ignored. */
  async syncChannel(channelId: number): Promise<void> {
    if (this.syncing.has(channelId)) return;
    const channel = this.repo.getChannel(channelId);
    if (!channel) return;

    this.syncing.add(channelId);
    this.repo.setChannelSync(channelId, "syncing");
    try {
      const refs = await this.source.listVideos(channel.youtube_id, {
        includeShorts: !!channel.include_shorts,
        includeLive: !!channel.include_live,
        limit: this.config.maxVideosPerChannel,
      });
      const added = this.repo.addVideos(channelId, refs);
      const listed = refs.flatMap((ref) => (ref.metadata ? [ref.metadata] : []));
      if (listed.length) this.repo.fillMissingMetadata(listed);
      if (added) {
        console.log(`[sync] ${channel.title}: ${added} new video(s) queued`);
        this.worker.notify();
      }

      const missing = this.repo.videoIdsMissingMetadata(channelId);
      for (let i = 0; i < missing.length; i += METADATA_CHUNK) {
        if (!this.repo.getChannel(channelId)) return; // deleted mid-sync
        this.repo.saveMetadata(await this.source.getVideoMetadata(missing.slice(i, i + METADATA_CHUNK)));
      }
      this.repo.setChannelSync(channelId, "idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[sync] ${channel.title} failed: ${message}`);
      if (this.repo.getChannel(channelId)) this.repo.setChannelSync(channelId, "error", message);
    } finally {
      this.syncing.delete(channelId);
    }
  }

  /** Resumes syncs interrupted by a restart and re-syncs every channel periodically for new uploads. */
  start(): void {
    for (const channel of this.repo.listChannels()) {
      if (channel.sync_status === "syncing" || this.isDue(channel)) void this.syncChannel(channel.id);
    }
    if (this.config.syncIntervalHours > 0) {
      this.timer = setInterval(() => {
        for (const channel of this.repo.listChannels()) if (this.isDue(channel)) void this.syncChannel(channel.id);
      }, 10 * 60_000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private isDue(channel: ChannelRow): boolean {
    if (this.config.syncIntervalHours <= 0) return false;
    if (!channel.last_synced_at) return channel.sync_status !== "syncing";
    return Date.now() - Date.parse(channel.last_synced_at) > this.config.syncIntervalHours * 3600_000;
  }
}
