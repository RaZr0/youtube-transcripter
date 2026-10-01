import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captionLanguages, parseCaptions, pickCaptionTrack, type CaptionChoice } from "./captions.js";
import { runProcess, type Runner } from "./process.js";
import { ProviderError, type TranscriptPending, type TranscriptProvider, type TranscriptResult } from "./types.js";
import { infoToMetadata, type YtDlp, type YtDlpInfo } from "./ytdlp.js";

// scripts/ sits at the project root: two levels up from server/providers, three from dist/server/providers.
const here = path.dirname(fileURLToPath(import.meta.url));
const WHISPER_SCRIPT =
  ["../../scripts", "../../../scripts"].map((dir) => path.resolve(here, dir, "whisper_transcribe.py")).find((p) => existsSync(p)) ??
  path.resolve(here, "../../scripts/whisper_transcribe.py");

/** Runs one Whisper job at a time: two at once would just fight over the same CPU/GPU. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface LocalStatus {
  ytdlpVersion: string | null;
  ytdlpError: string | null;
  whisperEnabled: boolean;
  whisperAvailable: boolean;
  whisperError: string | null;
}

/**
 * Free transcription on this machine:
 *   1. YouTube's own captions (human-made, else automatic) downloaded via yt-dlp — instant;
 *   2. otherwise the audio is downloaded and transcribed locally with Whisper (faster-whisper).
 */
export class LocalTranscriber implements TranscriptProvider {
  readonly name = "local";
  private readonly whisperLock = new Mutex();
  private whisperChecked: Promise<string | null> | null = null;

  constructor(
    private readonly ytdlp: YtDlp,
    private readonly preferredLang: string | undefined,
    private readonly runner: Runner = runProcess,
  ) {}

  async requestTranscript(videoId: string): Promise<TranscriptResult | TranscriptPending> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await this.ytdlp.json(["--skip-download", "--no-playlist", url]);

    if (info.live_status === "is_live" || info.live_status === "is_upcoming") {
      throw new ProviderError("Live stream has not finished yet", "not-ready", true, 12 * 60 * 60_000);
    }
    const metadata = infoToMetadata(info);
    const availableLanguages = captionLanguages(info);

    const track = pickCaptionTrack(info, this.preferredLang);
    if (track) {
      const segments = await this.downloadCaptions(url, track);
      if (segments.length > 0) {
        return {
          language: track.lang,
          availableLanguages,
          segments,
          source: track.auto ? "youtube-auto-captions" : "youtube-captions",
          metadata,
        };
      }
    }

    const whisper = this.ytdlp.config;
    if (!whisper.whisperEnabled) {
      throw new ProviderError("This video has no captions, and Whisper is disabled (WHISPER_ENABLED=false)", "transcript-unavailable", false);
    }
    const whisperError = await this.checkWhisper();
    if (whisperError) {
      throw new ProviderError(`This video has no captions and Whisper is not available: ${whisperError}`, "transcript-unavailable", false);
    }
    const result = await this.transcribeWithWhisper(url, info);
    return { ...result, availableLanguages, metadata };
  }

  async pollTranscript(): Promise<TranscriptResult | null> {
    throw new ProviderError("The local provider does not use async jobs", "invalid-request", false);
  }

  /** Reports whether yt-dlp and Whisper are installed, for the status page. */
  async status(): Promise<LocalStatus> {
    let ytdlpVersion: string | null = null;
    let ytdlpError: string | null = null;
    try {
      ytdlpVersion = await this.ytdlp.version();
    } catch (err) {
      ytdlpError = (err as Error).message;
    }
    const whisperError = this.ytdlp.config.whisperEnabled ? await this.checkWhisper() : null;
    return {
      ytdlpVersion,
      ytdlpError,
      whisperEnabled: this.ytdlp.config.whisperEnabled,
      whisperAvailable: this.ytdlp.config.whisperEnabled && !whisperError,
      whisperError,
    };
  }

  private async downloadCaptions(url: string, track: CaptionChoice) {
    // Fast path: fetch the caption file directly (one small request, no second page load).
    try {
      const response = await fetch(track.format.url, { signal: AbortSignal.timeout(60_000) });
      if (response.status === 429) throw new Error("429");
      if (response.ok) {
        const body = await response.text();
        if (body.trim()) return parseCaptions(body, track.format.ext);
      }
    } catch {
      // fall through to yt-dlp, which knows how to deal with tokens/throttling
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcripter-subs-"));
    try {
      await this.ytdlp.run([
        "--skip-download",
        "--no-playlist",
        track.auto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs",
        track.key,
        "--sub-format",
        `${track.format.ext}/vtt/best`,
        "-o",
        path.join(dir, "subs.%(ext)s"),
        url,
      ]);
      const file = (await fs.readdir(dir)).find((f) => f.endsWith(".json3") || f.endsWith(".vtt"));
      if (!file) return [];
      return parseCaptions(await fs.readFile(path.join(dir, file), "utf8"), file.endsWith(".json3") ? "json3" : "vtt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async transcribeWithWhisper(url: string, info: YtDlpInfo): Promise<TranscriptResult> {
    const config = this.ytdlp.config;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcripter-audio-"));
    try {
      // Audio only — a fraction of the video's size. faster-whisper decodes it itself (no ffmpeg needed).
      await this.ytdlp.run(
        ["-f", "bestaudio[ext=m4a]/bestaudio/best", "--no-playlist", "-o", path.join(dir, "audio.%(ext)s"), url],
        { timeoutMs: 60 * 60_000 },
      );
      const audio = (await fs.readdir(dir)).find((f) => f.startsWith("audio.") && !f.endsWith(".part"));
      if (!audio) throw new ProviderError("yt-dlp finished but no audio file was written", "ytdlp-error", true);

      return await this.whisperLock.run(async () => {
        const args = [
          WHISPER_SCRIPT,
          path.join(dir, audio),
          "--model",
          config.whisperModel,
          "--device",
          config.whisperDevice,
          "--model-dir",
          config.modelDir,
        ];
        const language = this.preferredLang ?? info.language ?? undefined;
        if (language) args.push("--language", language);
        const started = Date.now();
        const result = await this.runner(config.pythonPath, args, { timeoutMs: 12 * 60 * 60_000 });
        if (result.code !== 0) {
          const lastLine = result.stderr.trim().split("\n").at(-1) ?? "unknown error";
          throw new ProviderError(`Whisper failed: ${lastLine}`, "whisper-error", true);
        }
        const output = JSON.parse(result.stdout) as {
          language: string;
          model: string;
          segments: { start: number; end: number; text: string }[];
        };
        console.log(
          `[whisper] ${info.id}: ${Math.round(info.duration ?? 0)}s of audio in ${Math.round((Date.now() - started) / 1000)}s (${output.model})`,
        );
        return {
          language: output.language,
          source: `whisper-${output.model}`,
          segments: output.segments
            .map((s) => ({ start: s.start, duration: Math.max(0, s.end - s.start), text: s.text.trim() }))
            .filter((s) => s.text),
        };
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Returns null when faster-whisper can be imported, otherwise an explanation. Cached. */
  private checkWhisper(): Promise<string | null> {
    this.whisperChecked ??= this.runner(this.ytdlp.config.pythonPath, ["-c", "import faster_whisper"], { timeoutMs: 60_000 })
      .then((r) =>
        r.code === 0 ? null : `faster-whisper is not installed for ${this.ytdlp.config.pythonPath} (pip install faster-whisper)`,
      )
      .catch(() => `Python was not found ("${this.ytdlp.config.pythonPath}"); set WHISPER_PYTHON`);
    return this.whisperChecked;
  }
}
