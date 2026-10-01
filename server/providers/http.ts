import { ProviderError } from "./types.js";

/** Spaces out calls so that at most `perSecond` start every second. */
export class RateLimiter {
  private next = 0;
  private readonly interval: number;

  constructor(perSecond: number) {
    this.interval = 1000 / perSecond;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.interval;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  /** Pushes every caller back, e.g. after the API answered 429. */
  pause(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export interface JsonResponse<T> {
  status: number;
  body: T;
}

export async function getJson<T>(
  url: string,
  init: { headers?: Record<string, string>; limiter?: RateLimiter; timeoutMs?: number } = {},
): Promise<JsonResponse<T>> {
  await init.limiter?.wait();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new ProviderError(`Network error calling ${new URL(url).host}: ${(err as Error).message}`, "network", true);
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  }

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? 30_000;
    init.limiter?.pause(retryAfterMs);
    throw new ProviderError("Rate limited by provider", "rate-limited", true, retryAfterMs);
  }
  return { status: response.status, body: body as T };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
