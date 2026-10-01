import { channelRefToUrl, parseChannelInput, parseIsoDuration } from "../youtube-url.js";
import { getJson } from "./http.js";
import {
  ProviderError,
  type ChannelInfo,
  type ChannelSource,
  type ListVideosOptions,
  type VideoKind,
  type VideoMetadata,
  type VideoRef,
} from "./types.js";

/**
 * Official YouTube Data API v3. Optional: when YOUTUBE_API_KEY is set, channel listing and video
 * metadata come from here (free daily quota, 50 videos per request) instead of spending
 * transcription-provider credits on them.
 */

const BASE = "https://www.googleapis.com/youtube/v3";

interface Thumbnails {
  default?: { url: string };
  medium?: { url: string };
  high?: { url: string };
}

interface ApiError {
  error?: { code: number; message: string; errors?: { reason?: string }[] };
}

export class YouTubeDataApiSource implements ChannelSource {
  readonly name = "youtube-data-api";

  constructor(private readonly apiKey: string) {}

  async resolveChannel(input: string): Promise<ChannelInfo> {
    const ref = parseChannelInput(input);
    const lookup: Record<string, string> = { part: "snippet" };
    if (ref.type === "id") lookup.id = ref.value;
    else if (ref.type === "handle") lookup.forHandle = `@${ref.value}`;
    else if (ref.type === "username") lookup.forUsername = ref.value;
    else {
      // Legacy /c/ URLs have no direct lookup; fall back to search (costs more quota).
      const search = await this.call<{ items?: { id: { channelId: string } }[] }>("search", {
        part: "snippet",
        type: "channel",
        maxResults: "1",
        q: ref.value,
      });
      const channelId = search.items?.[0]?.id.channelId;
      if (!channelId) throw new ProviderError(`No channel found for ${channelRefToUrl(ref)}`, "not-found", false);
      lookup.id = channelId;
    }

    const body = await this.call<{
      items?: { id: string; snippet: { title: string; description?: string; customUrl?: string; thumbnails?: Thumbnails } }[];
    }>("channels", lookup);
    const channel = body.items?.[0];
    if (!channel) throw new ProviderError(`No channel found for ${channelRefToUrl(ref)}`, "not-found", false);
    return {
      youtubeId: channel.id,
      title: channel.snippet.title,
      handle: channel.snippet.customUrl,
      description: channel.snippet.description,
      thumbnailUrl: bestThumbnail(channel.snippet.thumbnails),
    };
  }

  async listVideos(channelId: string, options: ListVideosOptions): Promise<VideoRef[]> {
    // Every channel has hidden playlists per content type: UULF (long-form), UUSH (shorts), UULV (live).
    const suffix = channelId.slice(2);
    const playlists: [string, VideoKind][] = [[`UULF${suffix}`, "video"]];
    if (options.includeLive) playlists.push([`UULV${suffix}`, "live"]);
    if (options.includeShorts) playlists.push([`UUSH${suffix}`, "short"]);

    const refs: VideoRef[] = [];
    for (const [playlistId, kind] of playlists) {
      try {
        const ids = await this.playlistVideoIds(playlistId, options.limit);
        refs.push(...ids.map((id) => ({ id, kind })));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== "not-found") throw err;
        if (kind === "video") {
          // Older channels may lack UULF; fall back to the full uploads playlist.
          const ids = await this.playlistVideoIds(`UU${suffix}`, options.limit);
          refs.push(...ids.map((id) => ({ id, kind })));
        }
        // A missing UUSH/UULV playlist just means the channel has no shorts/streams.
      }
    }
    return refs;
  }

  async getVideoMetadata(ids: string[]): Promise<VideoMetadata[]> {
    const out: VideoMetadata[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const body = await this.call<{
        items?: {
          id: string;
          snippet: { title: string; description?: string; publishedAt?: string; thumbnails?: Thumbnails };
          contentDetails?: { duration?: string };
        }[];
      }>("videos", { part: "snippet,contentDetails", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
      for (const item of body.items ?? []) {
        out.push({
          id: item.id,
          title: item.snippet.title,
          description: item.snippet.description,
          publishedAt: item.snippet.publishedAt,
          thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
        });
      }
    }
    return out;
  }

  private async playlistVideoIds(playlistId: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = { part: "contentDetails", playlistId, maxResults: "50" };
      if (pageToken) params.pageToken = pageToken;
      const body = await this.call<{ items?: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>(
        "playlistItems",
        params,
      );
      for (const item of body.items ?? []) ids.push(item.contentDetails.videoId);
      pageToken = body.nextPageToken;
    } while (pageToken && ids.length < limit);
    return ids.slice(0, limit);
  }

  private async call<T>(resource: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("key", this.apiKey);
    const { status, body } = await getJson<T & ApiError>(url.toString());
    if (status >= 300) {
      const reason = body?.error?.errors?.[0]?.reason ?? "";
      const message = `YouTube Data API: ${body?.error?.message ?? `HTTP ${status}`}`;
      if (status === 404 || reason === "playlistNotFound") throw new ProviderError(message, "not-found", false);
      if (reason === "quotaExceeded" || reason === "rateLimitExceeded") {
        throw new ProviderError(message, "rate-limited", true, 60 * 60_000);
      }
      throw new ProviderError(message, `youtube-${status}`, status >= 500);
    }
    return body;
  }
}

function bestThumbnail(thumbnails: Thumbnails | undefined): string | undefined {
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url;
}
