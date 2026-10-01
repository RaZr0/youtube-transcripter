import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../server/config.js";
import { parseJson3, parseVtt, pickCaptionTrack } from "../server/providers/captions.js";
import { LocalTranscriber } from "../server/providers/local.js";
import type { RunResult, Runner } from "../server/providers/process.js";
import { ProviderError } from "../server/providers/types.js";
import { classifyYtDlpError, YtDlp, YtDlpChannelSource } from "../server/providers/ytdlp.js";

const config = { ...loadConfig({ TRANSCRIPT_PROVIDER: "local" }).local, requestDelayMs: 0 };
const ok = (stdout: unknown): RunResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

afterEach(() => vi.unstubAllGlobals());

describe("caption parsing", () => {
  it("parses json3, skipping empty events and collapsing whitespace", () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1000 }, // no segs
        { tStartMs: 1200, dDurationMs: 2300, segs: [{ utf8: "hello" }, { utf8: " world\n" }] },
        { tStartMs: 3500, dDurationMs: 10, segs: [{ utf8: "\n" }] },
      ],
    });
    expect(parseJson3(body)).toEqual([{ start: 1.2, duration: 2.3, text: "hello world" }]);
  });

  it("parses VTT, strips tags and drops rolling duplicate lines", () => {
    const vtt = `WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000 align:start position:0%
hello<00:00:01.500><c> world</c>

00:00:03.000 --> 00:00:05.500
hello world
this &amp; that

01:00:00.000 --> 01:00:02.000
the end`;
    expect(parseVtt(vtt)).toEqual([
      { start: 1, duration: 2, text: "hello world" },
      { start: 3, duration: 2.5, text: "this & that" },
      { start: 3600, duration: 2, text: "the end" },
    ]);
  });
});

describe("pickCaptionTrack", () => {
  const fmt = (ext: string) => ({ ext, url: `https://x/${ext}` });
  it("prefers human captions in the original language", () => {
    const choice = pickCaptionTrack({
      language: "en",
      subtitles: { de: [fmt("vtt")], en: [fmt("vtt"), fmt("json3")], live_chat: [fmt("json")] },
      automatic_captions: { "en-orig": [fmt("json3")] },
    });
    expect(choice).toMatchObject({ key: "en", auto: false, format: { ext: "json3" } });
  });

  it("uses the original automatic track, not a translation", () => {
    const choice = pickCaptionTrack({
      language: "es",
      subtitles: {},
      automatic_captions: { en: [fmt("json3")], "es-orig": [fmt("json3")], es: [fmt("json3")] },
    });
    expect(choice).toMatchObject({ key: "es-orig", lang: "es", auto: true });
  });

  it("honours a preferred language", () => {
    const choice = pickCaptionTrack(
      { language: "en", subtitles: { en: [fmt("vtt")], fr: [fmt("vtt")] }, automatic_captions: {} },
      "fr",
    );
    expect(choice?.key).toBe("fr");
  });

  it("returns null when there are no usable captions", () => {
    expect(pickCaptionTrack({ language: "en", subtitles: { live_chat: [fmt("json")] }, automatic_captions: {} })).toBeNull();
    expect(pickCaptionTrack({ subtitles: { en: [fmt("ttml")] } })).toBeNull();
  });
});

describe("classifyYtDlpError", () => {
  it.each([
    ["ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies", "rate-limited", true],
    ["ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests", "rate-limited", true],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "not-found", false],
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "not-found", false],
    ["ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", "age-restricted", false],
    ["ERROR: [youtube:tab] UCx: This channel does not have a shorts tab", "no-tab", false],
    ["ERROR: [youtube] abc: This live event will begin in 3 hours.", "not-ready", true],
    ["ERROR: Unable to download API page: <urlopen error [Errno -3] Temporary failure in name resolution>", "network", true],
    ["ERROR: something new and unexpected", "ytdlp-error", true],
  ])("%s", (stderr, code, retryable) => {
    const err = classifyYtDlpError(stderr, 3_600_000);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
  });

  it("pauses for the configured time when blocked", () => {
    expect(classifyYtDlpError("HTTP Error 429", 1234).retryAfterMs).toBe(1234);
  });
});

describe("YtDlp", () => {
  it("passes pacing, JS runtime and cookie options", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_cmd, args) => (calls.push(args), ok("2026.01.01\n"));
    await new YtDlp({ ...config, cookiesFile: "/c.txt" }, runner).version();
    expect(calls[0]).toEqual(expect.arrayContaining(["--sleep-requests", "--js-runtimes", "--cookies", "/c.txt", "--version"]));
  });

  it("explains how to install yt-dlp when it is missing", async () => {
    const runner: Runner = async () => {
      throw Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
    };
    const err = await new YtDlp(config, runner).version().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("not-configured");
    expect(err.message).toMatch(/pip install/);
  });
});

describe("YtDlpChannelSource", () => {
  it("resolves a channel from its handle", async () => {
    const runner: Runner = async (_c, args) => {
      expect(args.at(-1)).toBe("https://www.youtube.com/@coach/videos");
      return ok({
        id: "UCabcdefghijklmnopqrstuv",
        channel_id: "UCabcdefghijklmnopqrstuv",
        channel: "Coach",
        uploader_id: "@coach",
        thumbnails: [{ id: "banner", url: "b" }, { id: "avatar_uncropped", url: "a" }],
        entries: [],
      });
    };
    const info = await new YtDlpChannelSource(new YtDlp(config, runner)).resolveChannel("https://youtube.com/@coach?si=xyz");
    expect(info).toMatchObject({ youtubeId: "UCabcdefghijklmnopqrstuv", title: "Coach", handle: "@coach", thumbnailUrl: "a" });
  });

  it("lists tabs with metadata, skipping missing tabs and upcoming streams", async () => {
    const runner: Runner = async (_c, args) => {
      const url = args.at(-1)!;
      if (url.endsWith("/videos"))
        return ok({ entries: [{ id: "v1", title: "One", duration: 61.5, upload_date: "20240102" }, { id: "v2", title: "Two" }] });
      if (url.endsWith("/streams"))
        return ok({ entries: [{ id: "l1", title: "Live", live_status: "was_live" }, { id: "l2", live_status: "is_upcoming" }] });
      return fail("ERROR: [youtube:tab] UCx: This channel does not have a shorts tab");
    };
    const refs = await new YtDlpChannelSource(new YtDlp(config, runner)).listVideos("UCx", {
      includeShorts: true,
      includeLive: true,
      limit: 100,
    });
    expect(refs.map((r) => `${r.kind}:${r.id}`)).toEqual(["video:v1", "video:v2", "live:l1"]);
    expect(refs[0].metadata).toMatchObject({ title: "One", durationSeconds: 62, publishedAt: "2024-01-02T00:00:00.000Z" });
  });
});

describe("LocalTranscriber", () => {
  const info = {
    id: "vid00000001",
    title: "A video",
    duration: 5,
    timestamp: 1700000000,
    language: "en",
    subtitles: {},
    automatic_captions: { "en-orig": [{ ext: "json3", url: "https://captions.test/en" }] },
  };

  it("uses YouTube captions when available", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hi" }] }] })));
    const runner: Runner = async () => ok(info);
    const result = await new LocalTranscriber(new YtDlp(config, runner), undefined, runner).requestTranscript("vid00000001");
    expect(result).toMatchObject({
      language: "en",
      source: "youtube-auto-captions",
      segments: [{ start: 0, duration: 1, text: "hi" }],
      metadata: { title: "A video", publishedAt: "2023-11-14T22:13:20.000Z" },
    });
  });

  it("falls back to yt-dlp when fetching captions directly fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
    const runner: Runner = async (_c, args) => {
      if (args.includes("--write-auto-subs")) {
        const out = args[args.indexOf("-o") + 1];
        fs.writeFileSync(out.replace("%(ext)s", "en-orig.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfrom yt-dlp\n");
        return ok("");
      }
      return ok(info);
    };
    const result = await new LocalTranscriber(new YtDlp(config, runner), undefined, runner).requestTranscript("vid00000001");
    expect("segments" in result && result.segments[0].text).toBe("from yt-dlp");
  });

  it("downloads audio and runs Whisper when there are no captions", async () => {
    const calls: string[] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push(cmd);
      if (cmd === config.ytdlpPath && args.includes("-f")) {
        const out = args[args.indexOf("-o") + 1];
        fs.writeFileSync(out.replace("%(ext)s", "m4a"), "fake audio");
        return ok("");
      }
      if (cmd === config.ytdlpPath) return ok({ ...info, automatic_captions: {} });
      if (args[0] === "-c") return ok(""); // faster_whisper import check
      expect(args).toEqual(expect.arrayContaining(["--model", "auto", "--language", "en"]));
      expect(fs.existsSync(args[1])).toBe(true);
      return ok({ language: "en", model: "small", segments: [{ start: 0, end: 2, text: " Spoken words " }] });
    };
    const result = await new LocalTranscriber(new YtDlp(config, runner), undefined, runner).requestTranscript("vid00000001");
    expect(result).toMatchObject({ source: "whisper-small", segments: [{ start: 0, duration: 2, text: "Spoken words" }] });
  });

  it("marks videos without captions as unavailable when Whisper is not installed", async () => {
    const runner: Runner = async (cmd, args) =>
      cmd === config.ytdlpPath ? ok({ ...info, automatic_captions: {} }) : args[0] === "-c" ? fail("ModuleNotFoundError") : ok("");
    const err = await new LocalTranscriber(new YtDlp(config, runner), undefined, runner).requestTranscript("vid00000001").catch((e) => e);
    expect(err.code).toBe("transcript-unavailable");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/faster-whisper/);
  });

  it("refuses live streams that have not ended yet", async () => {
    const runner: Runner = async () => ok({ ...info, live_status: "is_live" });
    const err = await new LocalTranscriber(new YtDlp(config, runner), undefined, runner).requestTranscript("vid00000001").catch((e) => e);
    expect(err.code).toBe("not-ready");
  });
});

describe("whisper_transcribe.py", () => {
  it("prints segments as JSON", () => {
    const script = path.resolve("scripts/whisper_transcribe.py");
    const out = execFileSync("python3", [script, "audio.m4a", "--model", "auto", "--device", "cpu"], {
      env: { ...process.env, PYTHONPATH: path.resolve("tests/fixtures/fake_whisper") },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    expect(JSON.parse(out)).toEqual({
      language: "en",
      model: "small",
      duration: 5,
      segments: [
        { start: 0, end: 2.5, text: "Hello there." },
        { start: 2.5, end: 5, text: "Second line." },
      ],
    });
  });
});
