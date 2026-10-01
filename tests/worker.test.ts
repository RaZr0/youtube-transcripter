import { describe, expect, it } from "vitest";
import { openDatabase } from "../server/db.js";
import { ProviderError, type TranscriptPending, type TranscriptProvider, type TranscriptResult } from "../server/providers/types.js";
import { Repo } from "../server/repo.js";
import { TranscriptionWorker } from "../server/worker.js";

const transcript: TranscriptResult = { language: "en", segments: [{ start: 0, duration: 2, text: "hello  world" }] };

function setup(provider: TranscriptProvider, maxAttempts = 3) {
  const repo = new Repo(openDatabase(":memory:"));
  const channel = repo.createChannel({ youtubeId: "UC1", title: "Chan" }, "https://www.youtube.com/@chan", {
    includeShorts: false,
    includeLive: true,
  });
  const worker = new TranscriptionWorker(repo, provider, { workerConcurrency: 2, maxAttempts }, { idleDelayMs: 10, jobPollIntervalMs: 0 });
  return { repo, channel, worker };
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

class FakeProvider implements TranscriptProvider {
  name = "fake";
  requests: string[] = [];
  polls = 0;
  constructor(private readonly behaviour: (id: string) => TranscriptResult | TranscriptPending | Error) {}
  async requestTranscript(id: string) {
    this.requests.push(id);
    const r = this.behaviour(id);
    if (r instanceof Error) throw r;
    return r;
  }
  async pollTranscript() {
    return ++this.polls >= 2 ? transcript : null;
  }
}

describe("TranscriptionWorker", () => {
  it("transcribes queued videos and indexes them for search", async () => {
    const { repo, channel, worker } = setup(new FakeProvider(() => transcript));
    repo.addVideos(channel.id, [
      { id: "v1", kind: "video" },
      { id: "v2", kind: "video" },
    ]);
    repo.saveMetadata([{ id: "v1", title: "First video" }]);
    worker.start();
    await until(() => repo.channelStats(channel.id).completed === 2);
    await worker.stop();

    const t = repo.getTranscript("v1")!;
    expect(t.full_text).toBe("hello world");
    expect(t.word_count).toBe(2);
    expect(repo.search("hello", { limit: 10, offset: 0 }).total).toBe(2);
    expect(repo.search("first", { limit: 10, offset: 0 }).total).toBe(1); // titles are searchable too
  });

  it("polls async jobs instead of requesting again", async () => {
    const provider = new FakeProvider(() => ({ jobId: "job" }));
    const { repo, channel, worker } = setup(provider);
    repo.addVideos(channel.id, [{ id: "v1", kind: "video" }]);
    worker.start();
    await until(() => repo.getVideo("v1")!.status === "completed");
    await worker.stop();
    expect(provider.requests).toEqual(["v1"]);
    expect(provider.polls).toBe(2);
  });

  it("marks videos without captions as unavailable without retrying", async () => {
    const provider = new FakeProvider(() => new ProviderError("none", "transcript-unavailable", false));
    const { repo, channel, worker } = setup(provider);
    repo.addVideos(channel.id, [{ id: "v1", kind: "video" }]);
    worker.start();
    await until(() => repo.getVideo("v1")!.status === "unavailable");
    await worker.stop();
    expect(provider.requests).toHaveLength(1);
  });

  it("retries transient failures with backoff and gives up after max attempts", async () => {
    const provider = new FakeProvider(() => new ProviderError("boom", "internal-error", true, 0));
    const { repo, channel, worker } = setup(provider, 3);
    repo.addVideos(channel.id, [{ id: "v1", kind: "video" }]);
    worker.start();
    await until(() => repo.getVideo("v1")!.attempts === 3);
    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(provider.requests).toHaveLength(3);
    expect(repo.getVideo("v1")!.status).toBe("failed");

    expect(repo.retryVideos({ channelId: channel.id })).toBe(1);
    expect(repo.getVideo("v1")!.status).toBe("pending");
  });

  it("pauses the whole queue on account-level errors without using up attempts", async () => {
    const provider = new FakeProvider(() => new ProviderError("bad key", "unauthorized", true, 60_000));
    const { repo, channel, worker } = setup(provider);
    repo.addVideos(channel.id, [
      { id: "v1", kind: "video" },
      { id: "v2", kind: "video" },
      { id: "v3", kind: "video" },
    ]);
    worker.start();
    await until(() => worker.status().pausedUntil !== null);
    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(provider.requests.length).toBeLessThanOrEqual(2); // only the first batch hit the API
    expect(worker.status().pauseReason).toBe("bad key");
    expect(repo.getVideo("v1")!.attempts).toBe(0);
    expect(repo.getVideo("v1")!.status).toBe("pending");
  });

  it("recovers videos interrupted mid-processing after a restart", () => {
    const { repo, channel } = setup(new FakeProvider(() => transcript));
    repo.addVideos(channel.id, [{ id: "v1", kind: "video" }]);
    expect(repo.claimNext(5, 3).map((v) => v.id)).toEqual(["v1"]);
    expect(repo.claimNext(5, 3)).toHaveLength(0); // already claimed
    expect(repo.recoverInterrupted()).toBe(1);
    expect(repo.claimNext(5, 3)).toHaveLength(1);
  });

  it("never overwrites existing videos when a channel is re-synced", () => {
    const { repo, channel } = setup(new FakeProvider(() => transcript));
    repo.addVideos(channel.id, [{ id: "v1", kind: "video" }]);
    repo.saveTranscript("v1", "fake", transcript);
    expect(repo.addVideos(channel.id, [{ id: "v1", kind: "video" }, { id: "v2", kind: "video" }])).toBe(1);
    expect(repo.getVideo("v1")!.status).toBe("completed");
    expect(repo.getTranscript("v1")).toBeDefined();
  });
});
