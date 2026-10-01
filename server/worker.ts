import type { Config } from "./config.js";
import { isPending, ProviderError, type TranscriptProvider, type TranscriptResult } from "./providers/types.js";
import type { Repo, VideoRow } from "./repo.js";

/** Errors about the account/configuration rather than a single video: pause the queue, don't burn attempts. */
const ACCOUNT_LEVEL = new Set(["not-configured", "unauthorized", "rate-limited", "limit-exceeded", "upgrade-required"]);


export interface WorkerStatus {
  running: boolean;
  active: number;
  concurrency: number;
  pausedUntil: string | null;
  pauseReason: string | null;
}

/**
 * Background transcription queue. The queue itself lives in the database (videos.status), so
 * nothing is lost on restart: interrupted videos are re-queued and pending async jobs resume
 * polling with their saved job id instead of being paid for twice.
 */
export class TranscriptionWorker {
  private running = false;
  private active = 0;
  private pausedUntil = 0;
  private pauseReason: string | null = null;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly repo: Repo,
    private readonly provider: TranscriptProvider,
    private readonly config: Pick<Config, "workerConcurrency" | "maxAttempts">,
    private readonly timing: { idleDelayMs: number; jobPollIntervalMs: number } = { idleDelayMs: 2_000, jobPollIntervalMs: 5_000 },
  ) {}

  start(): void {
    if (this.running) return;
    const recovered = this.repo.recoverInterrupted();
    if (recovered) console.log(`[worker] re-queued ${recovered} video(s) interrupted by the last shutdown`);
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.notify();
    await this.loopPromise;
    await Promise.allSettled([...this.inFlight]);
  }

  /** Call after adding work so the worker doesn't wait for its idle timer. */
  notify(): void {
    this.wake?.();
  }

  /** Clears an account-level pause (e.g. after the user fixed their API key). */
  resume(): void {
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.notify();
  }

  status(): WorkerStatus {
    const paused = this.pausedUntil > Date.now();
    return {
      running: this.running,
      active: this.active,
      concurrency: this.config.workerConcurrency,
      pausedUntil: paused ? new Date(this.pausedUntil).toISOString() : null,
      pauseReason: paused ? this.pauseReason : null,
    };
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const pauseLeft = this.pausedUntil - Date.now();
      let claimed: VideoRow[] = [];
      if (pauseLeft <= 0) {
        const free = this.config.workerConcurrency - this.active;
        if (free > 0) claimed = this.repo.claimNext(free, this.config.maxAttempts);
      }
      for (const video of claimed) {
        this.active++;
        const task = this.process(video).finally(() => {
          this.active--;
          this.inFlight.delete(task);
          this.notify();
        });
        this.inFlight.add(task);
      }
      if (claimed.length === 0 || this.active >= this.config.workerConcurrency) {
        await this.sleep(pauseLeft > 0 ? Math.min(pauseLeft, 60_000) : this.timing.idleDelayMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  private async process(video: VideoRow): Promise<void> {
    try {
      if (video.provider_job_id) {
        const result = await this.provider.pollTranscript(video.provider_job_id);
        if (!result) {
          this.repo.requeue(video.id, this.timing.jobPollIntervalMs);
          return;
        }
        this.save(video.id, result);
        return;
      }

      const response = await this.provider.requestTranscript(video.id);
      if (isPending(response)) {
        this.repo.setJobId(video.id, response.jobId);
        this.repo.requeue(video.id, this.timing.jobPollIntervalMs);
        return;
      }
      this.save(video.id, response);
    } catch (err) {
      this.handleError(video, err);
    }
  }

  private save(videoId: string, result: TranscriptResult): void {
    if (result.metadata) this.repo.saveMetadata([{ ...result.metadata, id: videoId }]);
    this.repo.saveTranscript(videoId, result.source ? `${this.provider.name}:${result.source}` : this.provider.name, result);
  }

  private handleError(video: VideoRow, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    if (!this.running) {
      // Interrupted by shutdown: not the video's fault, try again on next start.
      this.repo.requeue(video.id, 0);
      return;
    }

    if (err instanceof ProviderError && ACCOUNT_LEVEL.has(err.code)) {
      const delay = err.retryAfterMs ?? 60_000;
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
      this.pauseReason = message;
      this.repo.requeue(video.id, delay, message); // keeps the job id, so an async job resumes later
      console.warn(`[worker] pausing for ${Math.round(delay / 1000)}s: ${message}`);
      return;
    }

    if (err instanceof ProviderError && !err.retryable) {
      this.repo.markFailed(video.id, message, { permanent: true });
      return;
    }

    // A network blip while polling should not throw away a paid-for async job.
    const keepJob = err instanceof ProviderError && err.code === "network";
    const attempt = video.attempts + 1;
    if (attempt >= this.config.maxAttempts) {
      this.repo.markFailed(video.id, message, { keepJob });
    } else {
      const backoff = Math.min(30_000 * 2 ** (attempt - 1), 6 * 60 * 60_000);
      const retryInMs = err instanceof ProviderError && err.retryAfterMs !== undefined ? err.retryAfterMs : backoff;
      this.repo.markFailed(video.id, message, { retryInMs, keepJob });
    }
    console.warn(`[worker] ${video.id} attempt ${attempt} failed: ${message}`);
  }
}
