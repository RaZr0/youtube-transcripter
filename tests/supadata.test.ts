import { afterEach, describe, expect, it, vi } from "vitest";
import { SupadataClient } from "../server/providers/supadata.js";
import { ProviderError } from "../server/providers/types.js";

function client() {
  return new SupadataClient({ apiKey: "key", baseUrl: "https://api.test/v1", mode: "auto", requestsPerSecond: 1000 });
}

function mockFetch(...responses: { status: number; body: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("SupadataClient", () => {
  it("requests a transcript and converts milliseconds to seconds", async () => {
    const calls = mockFetch({
      status: 200,
      body: { content: [{ text: "hello", offset: 1500, duration: 2000, lang: "en" }], lang: "en", availableLangs: ["en", "de"] },
    });
    const result = await client().requestTranscript("abc123def45");
    expect(result).toEqual({ language: "en", availableLanguages: ["en", "de"], segments: [{ start: 1.5, duration: 2, text: "hello" }] });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/transcript");
    expect(url.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=abc123def45");
    expect(url.searchParams.get("mode")).toBe("auto");
    expect(calls[0].headers["x-api-key"]).toBe("key");
  });

  it("returns a job id for async transcripts and polls it", async () => {
    mockFetch(
      { status: 202, body: { jobId: "job-1" } },
      { status: 200, body: { status: "active" } },
      { status: 200, body: { status: "completed", result: { content: [{ text: "hi", offset: 0, duration: 1000 }], lang: "en" } } },
    );
    const c = client();
    expect(await c.requestTranscript("v")).toEqual({ jobId: "job-1" });
    expect(await c.pollTranscript("job-1")).toBeNull();
    expect((await c.pollTranscript("job-1"))?.segments).toEqual([{ start: 0, duration: 1, text: "hi" }]);
  });

  it("accepts completed jobs that put the transcript at the top level", async () => {
    mockFetch({ status: 200, body: { status: "completed", content: [{ text: "x", offset: 0, duration: 0 }], lang: "fr" } });
    expect((await client().pollTranscript("j"))?.language).toBe("fr");
  });

  it("maps 'transcript-unavailable' to a permanent error", async () => {
    mockFetch({ status: 206, body: { error: "transcript-unavailable", message: "No transcript" } });
    const err = await client().requestTranscript("v").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  it("maps 429 to a retryable rate-limit error", async () => {
    mockFetch({ status: 429, body: { error: "limit-exceeded" } });
    const err = await client().requestTranscript("v").catch((e) => e);
    expect(err.code).toBe("rate-limited");
    expect(err.retryable).toBe(true);
  });

  it("lists channel videos honoring shorts/live options", async () => {
    mockFetch({ status: 200, body: { videoIds: ["a", "b"], shortIds: ["s"], liveIds: ["l"] } });
    const refs = await client().listVideos("UCx", { includeShorts: false, includeLive: true, limit: 100 });
    expect(refs).toEqual([
      { id: "a", kind: "video" },
      { id: "b", kind: "video" },
      { id: "l", kind: "live" },
    ]);
  });
});
