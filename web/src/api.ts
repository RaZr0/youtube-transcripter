export type VideoStatus = "pending" | "processing" | "completed" | "failed" | "unavailable";

export interface Stats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  unavailable: number;
}

export interface Channel {
  id: number;
  youtubeId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  url: string;
  includeShorts: boolean;
  includeLive: boolean;
  syncStatus: "idle" | "syncing" | "error";
  syncError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  stats: Stats;
}

export interface Video {
  id: string;
  channelId: number;
  kind: "video" | "short" | "live";
  title: string | null;
  description: string | null;
  thumbnailUrl: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  status: VideoStatus;
  inProgress: boolean;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  url: string;
  wordCount?: number | null;
}

export interface Segment {
  start: number;
  duration: number;
  text: string;
}

export interface Transcript {
  language: string | null;
  availableLanguages: string[];
  segments: Segment[];
  text: string;
  wordCount: number;
  provider: string;
  createdAt: string;
}

export interface VideoDetail extends Video {
  channel: { id: number; title: string };
  transcript: Transcript | null;
}

export interface AppStatus {
  provider: string;
  channelSource: string;
  transcriptMode: string;
  configurationError: string | null;
  local: {
    ytdlpVersion: string | null;
    ytdlpError: string | null;
    whisperEnabled: boolean;
    whisperAvailable: boolean;
    whisperError: string | null;
  } | null;
  worker: { running: boolean; active: number; concurrency: number; pausedUntil: string | null; pauseReason: string | null };
  queue: Stats;
}

export interface SearchHit {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  channel_id: number;
  channel_title: string;
  snippet: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  status: () => request<AppStatus>("/status"),
  resumeWorker: () => request("/worker/resume", { method: "POST" }),
  channels: () => request<Channel[]>("/channels"),
  channel: (id: number) => request<Channel>(`/channels/${id}`),
  addChannel: (url: string, includeShorts: boolean, includeLive: boolean) =>
    request<Channel & { created: boolean }>("/channels", {
      method: "POST",
      body: JSON.stringify({ url, includeShorts, includeLive }),
    }),
  updateChannel: (id: number, options: { includeShorts?: boolean; includeLive?: boolean }) =>
    request<Channel>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify(options) }),
  syncChannel: (id: number) => request(`/channels/${id}/sync`, { method: "POST" }),
  retryChannel: (id: number, includeUnavailable = false) =>
    request<{ requeued: number }>(`/channels/${id}/retry?includeUnavailable=${includeUnavailable}`, { method: "POST" }),
  deleteChannel: (id: number, youtubeId: string) =>
    request(`/channels/${id}?confirm=${encodeURIComponent(youtubeId)}`, { method: "DELETE" }),
  videos: (channelId: number, params: { status?: string; q?: string; limit: number; offset: number }) => {
    const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    return request<{ total: number; items: Video[] }>(`/channels/${channelId}/videos?${qs}`);
  },
  video: (id: string) => request<VideoDetail>(`/videos/${encodeURIComponent(id)}`),
  retryVideo: (id: string) => request(`/videos/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  search: (q: string, offset = 0, channelId?: number) => {
    const qs = new URLSearchParams({ q, offset: String(offset), limit: "20" });
    if (channelId) qs.set("channelId", String(channelId));
    return request<{ total: number; items: SearchHit[] }>(`/search?${qs}`);
  },
};
