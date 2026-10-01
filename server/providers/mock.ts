import { parseChannelInput } from "../youtube-url.js";
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
 * Offline stand-in for the real APIs (TRANSCRIPT_PROVIDER=mock). Generates a deterministic fake
 * channel per URL so the whole app — sync, queue, async jobs, failures, UI — can be tried
 * without an API key. Never use it for real data.
 */

const WORDS =
  "today we are going to look at how this works and why it matters for anyone building things the first step is to understand the basics then we will try a few examples and see what happens when we push it further".split(
    " ",
  );

function hash(input: string): number {
  let h = 2166136261;
  for (const ch of input) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export class MockProvider implements ChannelSource, TranscriptProvider {
  readonly name = "mock";
  private readonly jobs = new Map<string, { videoId: string; readyAt: number }>();

  constructor(private readonly delayMs = 300) {}

  async resolveChannel(input: string): Promise<ChannelInfo> {
    const ref = parseChannelInput(input);
    const id = `UC${hash(ref.value).toString(36).padStart(22, "0").slice(0, 22)}`;
    return {
      youtubeId: id,
      title: `${ref.value} (demo)`,
      handle: `@${ref.value.toLowerCase()}`,
      description: "A generated demo channel — set TRANSCRIPT_PROVIDER=supadata for real data.",
    };
  }

  async listVideos(channelId: string, options: ListVideosOptions): Promise<VideoRef[]> {
    const count = 6 + (hash(channelId) % 8);
    const refs: VideoRef[] = [];
    for (let i = 0; i < Math.min(count, options.limit); i++) refs.push({ id: this.videoId(channelId, i), kind: "video" });
    if (options.includeShorts) refs.push({ id: this.videoId(channelId, 100), kind: "short" });
    return refs;
  }

  async getVideoMetadata(ids: string[]): Promise<VideoMetadata[]> {
    return ids.map((id) => {
      const h = hash(id);
      return {
        id,
        title: `Episode ${(h % 900) + 100}: ${WORDS[h % WORDS.length]} ${WORDS[(h >>> 3) % WORDS.length]}`,
        description: "Demo video",
        publishedAt: new Date(Date.UTC(2024, 0, 1) + (h % 600) * 86_400_000).toISOString(),
        durationSeconds: 120 + (h % 1800),
      };
    });
  }

  async requestTranscript(videoId: string): Promise<TranscriptResult | TranscriptPending> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const h = hash(videoId);
    if (h % 11 === 0) throw new ProviderError("No captions and speech-to-text found no speech", "transcript-unavailable", false);
    if (h % 3 === 0) {
      const jobId = `job_${videoId}`;
      this.jobs.set(jobId, { videoId, readyAt: Date.now() + this.delayMs * 3 });
      return { jobId };
    }
    return this.fakeTranscript(videoId);
  }

  async pollTranscript(jobId: string): Promise<TranscriptResult | null> {
    const job = this.jobs.get(jobId);
    // Jobs are in-memory, so after a restart pretend they finished.
    if (!job) return this.fakeTranscript(jobId.replace(/^job_/, ""));
    if (Date.now() < job.readyAt) return null;
    this.jobs.delete(jobId);
    return this.fakeTranscript(job.videoId);
  }

  private videoId(channelId: string, index: number): string {
    return hash(`${channelId}:${index}`).toString(36).padStart(11, "x").slice(0, 11);
  }

  private fakeTranscript(videoId: string): TranscriptResult {
    let seed = hash(videoId);
    const segments = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      const words = [];
      for (let w = 0; w < 8; w++) {
        seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
        words.push(WORDS[seed % WORDS.length]);
      }
      const duration = 3 + (seed % 4);
      segments.push({ start: t, duration, text: words.join(" ") });
      t += duration;
    }
    return { language: "en", availableLanguages: ["en"], segments };
  }
}
