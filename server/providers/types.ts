export type VideoKind = "video" | "short" | "live";

export interface ChannelInfo {
  youtubeId: string;
  title: string;
  handle?: string;
  description?: string;
  thumbnailUrl?: string;
}

export interface VideoRef {
  id: string;
  kind: VideoKind;
  /** Some sources return titles etc. while listing, saving a request per video later. */
  metadata?: VideoMetadata;
}

export interface VideoMetadata {
  id: string;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  publishedAt?: string;
  durationSeconds?: number;
}

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  /** Seconds. */
  duration: number;
  text: string;
}

export interface TranscriptResult {
  language?: string;
  availableLanguages?: string[];
  segments: TranscriptSegment[];
  /** Where the text came from, e.g. "captions", "auto-captions", "whisper:small". */
  source?: string;
  /** Exact metadata learned while transcribing (replaces approximate listing data). */
  metadata?: VideoMetadata;
}

/** The transcript is not ready yet; poll again later with this job id. */
export interface TranscriptPending {
  jobId: string;
}

export interface ListVideosOptions {
  includeShorts: boolean;
  includeLive: boolean;
  limit: number;
}

/** Finds channels and their videos. */
export interface ChannelSource {
  readonly name: string;
  resolveChannel(input: string): Promise<ChannelInfo>;
  listVideos(channelId: string, options: ListVideosOptions): Promise<VideoRef[]>;
  /** Returns metadata for as many of the ids as possible (missing ids are simply omitted). */
  getVideoMetadata(ids: string[]): Promise<VideoMetadata[]>;
}

/** Turns a video into a transcript, via a third-party API. */
export interface TranscriptProvider {
  readonly name: string;
  /** Starts (or completes) a transcription. Returns either the transcript or a job id to poll. */
  requestTranscript(videoId: string): Promise<TranscriptResult | TranscriptPending>;
  /** Polls a pending job. Returns null while it is still running. */
  pollTranscript(jobId: string): Promise<TranscriptResult | null>;
}

/**
 * An error from a provider. `retryable` tells the worker whether trying again later can help
 * (rate limits, timeouts) or whether the video simply has no transcript.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isPending(value: TranscriptResult | TranscriptPending): value is TranscriptPending {
  return "jobId" in value;
}
