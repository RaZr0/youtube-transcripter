import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDatabase } from "../server/db.js";
import { MockProvider } from "../server/providers/mock.js";
import { Repo } from "../server/repo.js";
import { ChannelSync } from "../server/sync.js";
import { TranscriptionWorker } from "../server/worker.js";

let worker: TranscriptionWorker | undefined;
afterEach(async () => worker?.stop());

function setup() {
  const config = loadConfig({ TRANSCRIPT_PROVIDER: "mock" });
  const repo = new Repo(openDatabase(":memory:"));
  const mock = new MockProvider(1);
  worker = new TranscriptionWorker(repo, mock, { workerConcurrency: 4, maxAttempts: 3 }, { idleDelayMs: 5, jobPollIntervalMs: 0 });
  const sync = new ChannelSync(repo, mock, worker, config);
  const app = createApp({ repo, sync, worker, config, providerName: "mock", channelSourceName: "mock" });
  return { app, repo };
}

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("API", () => {
  it("adds a channel, transcribes its videos and serves them", async () => {
    const { app } = setup();
    worker!.start();

    const created = await request(app).post("/api/channels").send({ url: "https://www.youtube.com/@demo/videos" });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Adding the same channel again does not duplicate it.
    const again = await request(app).post("/api/channels").send({ url: "@demo" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    expect((await request(app).get("/api/channels")).body).toHaveLength(1);

    await waitFor(async () => {
      const { stats } = (await request(app).get(`/api/channels/${id}`)).body;
      return stats.total > 0 && stats.completed + stats.unavailable === stats.total;
    });

    const videos = (await request(app).get(`/api/channels/${id}/videos?status=completed`)).body;
    expect(videos.items.length).toBeGreaterThan(0);
    const videoId = videos.items[0].id;

    const video = (await request(app).get(`/api/videos/${videoId}`)).body;
    expect(video.transcript.segments.length).toBeGreaterThan(0);
    expect(video.channel.id).toBe(id);

    const txt = await request(app).get(`/api/videos/${videoId}/transcript.txt`);
    expect(txt.headers["content-type"]).toMatch(/text\/plain/);
    expect(txt.text).toMatch(/^\S.*\nhttps:\/\/www\.youtube\.com\/watch\?v=/);

    const exported = (await request(app).get(`/api/channels/${id}/export`)).body;
    expect(exported.videos.length).toBe(videos.total);

    const word = video.transcript.segments[0].text.split(" ")[0];
    const search = (await request(app).get(`/api/search`).query({ q: word })).body;
    expect(search.total).toBeGreaterThan(0);
    expect(search.items[0].snippet).toContain("[[");
  });

  it("rejects invalid channel URLs with a helpful message", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/channels").send({ url: "https://www.youtube.com/watch?v=abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channel URL/);
  });

  it("requires explicit confirmation to delete a channel", async () => {
    const { app } = setup();
    const created = (await request(app).post("/api/channels").send({ url: "@demo" })).body;
    expect((await request(app).delete(`/api/channels/${created.id}`)).status).toBe(400);
    expect((await request(app).delete(`/api/channels/${created.id}?confirm=${created.youtubeId}`)).status).toBe(204);
    expect((await request(app).get(`/api/channels/${created.id}`)).status).toBe(404);
  });

  it("returns JSON 404s for unknown API routes", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
