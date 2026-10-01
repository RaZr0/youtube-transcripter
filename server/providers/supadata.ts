import type { TranscriptMode } from "../config.js";
import { getJson, RateLimiter } from "./http.js";
import {
  ProviderError,
  type ChannelInfo,
  type ChannelSource,
  type ListVideosOptions,
  type TranscriptPending,
  type TranscriptProvider,
  type TranscriptResult,
  type VideoMetadata,
  type VideoRef,
} from "./types.js";

/**
 * Supadata (https://supadata.ai) — one API key gives channel listing, video metadata and
 * transcripts. Transcripts come from YouTube captions when they exist and, in "auto"/"generate"
 * mode, from Supadata's own speech-to-text when they don't.
 */

interface SupadataErrorBody {
  error?: string;
  message?: string;
  details?: string;
}

interface SupadataChunk {
  text: string;
  offset: number; // milliseconds
  duration: number; // milliseconds
  lang?: string;
}

interface SupadataTranscript {
  content: SupadataChunk[] | string;
  lang?: string;
  availableLangs?: string[];
}

interface SupadataJob {
  status: "queued" | "active" | "completed" | "failed";
  result?: SupadataTranscript | null;
  content?: SupadataTranscript["content"];
  lang?: string;
  availableLangs?: string[];
  error?: SupadataErrorBody | null;
}

export interface SupadataOptions {
  apiKey: string;
  baseUrl: string;
  mode: TranscriptMode;
  lang?: string;
  requestsPerSecond: number;
}

export class SupadataClient implements ChannelSource, TranscriptProvider {
  readonly name = "supadata";
  private readonly limiter: RateLimiter;

  constructor(private readonly options: SupadataOptions) {
    this.limiter = new RateLimiter(options.requestsPerSecond);
  }

  async resolveChannel(input: string): Promise<ChannelInfo> {
    const body = await this.get<{ id: string; name: string; handle?: string; description?: string; thumbnail?: string }>(
      "/youtube/channel",
      { id: input },
    );
    return {
      youtubeId: body.id,
      title: body.name,
      handle: body.handle,
      description: body.description,
      thumbnailUrl: body.thumbnail,
    };
  }

  async listVideos(channelId: string, options: ListVideosOptions): Promise<VideoRef[]> {
    const body = await this.get<{ videoIds?: string[]; shortIds?: string[]; liveIds?: string[] }>(
      "/youtube/channel/videos",
      { id: channelId, type: "all", limit: String(options.limit) },
      120_000,
    );
    const refs: VideoRef[] = (body.videoIds ?? []).map((id) => ({ id, kind: "video" as const }));
    if (options.includeLive) refs.push(...(body.liveIds ?? []).map((id) => ({ id, kind: "live" as const })));
    if (options.includeShorts) refs.push(...(body.shortIds ?? []).map((id) => ({ id, kind: "short" as const })));
    return refs;
  }

  async getVideoMetadata(ids: string[]): Promise<VideoMetadata[]> {
    const out: VideoMetadata[] = [];
    for (const id of ids) {
      let body;
      try {
        body = await this.get<{
          id: string;
          title?: string;
          description?: string;
          duration?: number;
          thumbnail?: string;
          uploadDate?: string;
        }>("/youtube/video", { id });
      } catch (err) {
        // One private/deleted video must not stop the rest; account-level errors still propagate.
        if (err instanceof ProviderError && !err.retryable) continue;
        throw err;
      }
      out.push({
        id,
        title: body.title,
        description: body.description,
        durationSeconds: body.duration,
        thumbnailUrl: body.thumbnail,
        publishedAt: body.uploadDate,
      });
    }
    return out;
  }

  async requestTranscript(videoId: string): Promise<TranscriptResult | TranscriptPending> {
    const params: Record<string, string> = {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      mode: this.options.mode,
    };
    if (this.options.lang) params.lang = this.options.lang;
    const { status, body } = await this.request<SupadataTranscript & { jobId?: string }>("/transcript", params, 180_000);
    if (status === 202 || body.jobId) {
      if (!body.jobId) throw new ProviderError("Provider accepted the job but returned no job id", "bad-response", true);
      return { jobId: body.jobId };
    }
    return toResult(body);
  }

  async pollTranscript(jobId: string): Promise<TranscriptResult | null> {
    const body = await this.get<SupadataJob>(`/transcript/${encodeURIComponent(jobId)}`, {});
    switch (body.status) {
      case "queued":
      case "active":
        return null;
      case "completed": {
        const transcript = body.result ?? (body.content !== undefined ? (body as SupadataTranscript) : null);
        if (!transcript) throw new ProviderError("Job completed without a transcript", "bad-response", true);
        return toResult(transcript);
      }
      case "failed":
      default:
        throw errorFromBody(body.error ?? { error: "internal-error", message: "Transcription job failed" }, 500);
    }
  }

  private async get<T>(path: string, params: Record<string, string>, timeoutMs?: number): Promise<T> {
    return (await this.request<T>(path, params, timeoutMs)).body;
  }

  private async request<T>(path: string, params: Record<string, string>, timeoutMs?: number) {
    const url = new URL(this.options.baseUrl.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await getJson<T & SupadataErrorBody>(url.toString(), {
      headers: { "x-api-key": this.options.apiKey },
      limiter: this.limiter,
      timeoutMs,
    });
    // Supadata reports "no transcript" with a non-2xx code or an `error` field.
    if (response.status >= 300 || (response.body && typeof response.body === "object" && "error" in response.body && response.body.error)) {
      throw errorFromBody(response.body ?? {}, response.status);
    }
    return response as { status: number; body: T };
  }
}

function toResult(body: SupadataTranscript): TranscriptResult {
  const segments =
    typeof body.content === "string"
      ? [{ start: 0, duration: 0, text: body.content }]
      : (body.content ?? []).map((chunk) => ({
          start: chunk.offset / 1000,
          duration: chunk.duration / 1000,
          text: chunk.text,
        }));
  return { language: body.lang, availableLanguages: body.availableLangs, segments };
}

function errorFromBody(body: SupadataErrorBody, status: number): ProviderError {
  const code = body.error ?? `http-${status}`;
  const message = [body.message, body.details].filter(Boolean).join(" — ") || `Supadata returned HTTP ${status}`;
  switch (code) {
    case "transcript-unavailable":
    case "not-found":
    case "invalid-request":
      return new ProviderError(message, code, false);
    case "unauthorized":
      return new ProviderError(`Supadata rejected the API key: ${message}`, code, true, 10 * 60_000);
    case "upgrade-required":
      return new ProviderError(`Supadata plan does not allow this request: ${message}`, code, true, 60 * 60_000);
    case "limit-exceeded":
      return new ProviderError(`Supadata quota/rate limit reached: ${message}`, code, true, 60_000);
    default:
      return new ProviderError(message, code, status >= 500 || status === 0 || status === 408);
  }
}
