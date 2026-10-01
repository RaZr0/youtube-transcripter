import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Channel, type VideoStatus } from "../api";
import { ProgressBar, StatusPill } from "../components/ProgressBar";
import { formatDate, formatNumber, formatTime, usePolling } from "../util";
import { Avatar, SyncBadge } from "./HomePage";

const PAGE_SIZE = 50;
const FILTERS: { value: VideoStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "completed", label: "Done" },
  { value: "pending", label: "Queued" },
  { value: "failed", label: "Failed" },
  { value: "unavailable", label: "No transcript" },
];

export function ChannelPage() {
  const id = Number(useParams().id);
  const { data: channel, error, reload } = usePolling(() => api.channel(id), [id]);

  if (error && !channel) return <p className="error">{error}</p>;
  if (!channel) return <p className="muted">Loading…</p>;

  return (
    <>
      <ChannelHeader channel={channel} onChange={reload} />
      <VideoList channel={channel} />
    </>
  );
}

function ChannelHeader({ channel, onChange }: { channel: Channel; onChange: () => void }) {
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const { stats } = channel;

  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      if (done) setMessage(done);
      onChange();
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function remove() {
    const answer = prompt(
      `This permanently deletes "${channel.title}" and all ${stats.completed} of its transcripts.\n\nType the channel id ${channel.youtubeId} to confirm:`,
    );
    if (answer?.trim() !== channel.youtubeId) return;
    await api.deleteChannel(channel.id, channel.youtubeId);
    navigate("/");
  }

  return (
    <section className="card channel-header">
      <div className="channel-header-top">
        <Avatar channel={channel} size={64} />
        <div className="min0 grow">
          <h1>{channel.title}</h1>
          <div className="muted small">
            <a href={channel.url} target="_blank" rel="noreferrer">
              {channel.handle ?? channel.url}
            </a>{" "}
            · <SyncBadge channel={channel} />
          </div>
        </div>
        <div className="actions">
          <button onClick={() => run(() => api.syncChannel(channel.id), "Checking for new videos…")}>Sync now</button>
          {stats.failed > 0 && (
            <button onClick={() => run(() => api.retryChannel(channel.id).then((r) => setMessage(`${r.requeued} video(s) re-queued`)))}>
              Retry failed
            </button>
          )}
          <a className="button" href={`/api/channels/${channel.id}/export`} download>
            Export JSON
          </a>
        </div>
      </div>

      <ProgressBar stats={stats} />
      <div className="stat-row">
        <Stat label="Videos" value={stats.total} />
        <Stat label="Transcribed" value={stats.completed} tone="green" />
        <Stat label="Queued" value={stats.pending + stats.processing} tone="blue" />
        <Stat label="Failed" value={stats.failed} tone="red" />
        <Stat label="No transcript" value={stats.unavailable} />
      </div>

      {channel.syncError && channel.syncStatus === "error" && <p className="error">Last sync failed: {channel.syncError}</p>}
      {message && <p className="muted small">{message}</p>}

      <details className="settings">
        <summary>Channel settings</summary>
        <div className="options">
          <label>
            <input
              type="checkbox"
              checked={channel.includeLive}
              onChange={(e) => run(() => api.updateChannel(channel.id, { includeLive: e.target.checked }))}
            />{" "}
            Include past live streams
          </label>
          <label>
            <input
              type="checkbox"
              checked={channel.includeShorts}
              onChange={(e) => run(() => api.updateChannel(channel.id, { includeShorts: e.target.checked }))}
            />{" "}
            Include Shorts
          </label>
          {stats.unavailable > 0 && (
            <button
              className="small-button"
              onClick={() =>
                run(() => api.retryChannel(channel.id, true).then((r) => setMessage(`${r.requeued} video(s) re-queued`)))
              }
            >
              Retry videos without transcript
            </button>
          )}
        </div>
        <p className="muted small">
          Turning an option off stops new videos of that type from being added; existing transcripts are kept.
        </p>
        <button className="danger" onClick={remove}>
          Delete channel and transcripts…
        </button>
      </details>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ? `tone-${tone}` : ""}`}>{formatNumber(value)}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function VideoList({ channel }: { channel: Channel }) {
  const [status, setStatus] = useState<VideoStatus | "">("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => setPage(0), [status, debounced]);

  const { data } = usePolling(
    () => api.videos(channel.id, { status: status || undefined, q: debounced || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [channel.id, status, debounced, page],
    5000,
  );
  const pages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <section>
      <div className="toolbar">
        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f.value} className={status === f.value ? "tab active" : "tab"} onClick={() => setStatus(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        <input type="search" placeholder="Filter by title…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {data && data.items.length === 0 && (
        <p className="empty">
          {channel.syncStatus === "syncing" && channel.stats.total === 0 ? "Discovering videos…" : "No videos match."}
        </p>
      )}

      <ul className="video-list">
        {data?.items.map((video) => (
          <li key={video.id}>
            <Link to={`/videos/${video.id}`} className="video-row">
              <div className="thumb">
                <img src={video.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                {video.durationSeconds ? <span className="duration">{formatTime(video.durationSeconds)}</span> : null}
              </div>
              <div className="min0 grow">
                <div className="video-title">{video.title ?? <span className="muted">Video {video.id}</span>}</div>
                <div className="muted small">
                  {formatDate(video.publishedAt)}
                  {video.kind !== "video" && <> · {video.kind === "short" ? "Short" : "Live"}</>}
                  {video.wordCount ? <> · {formatNumber(video.wordCount)} words</> : null}
                </div>
                {video.lastError && video.status !== "completed" && (
                  <div className="small error-text" title={video.lastError}>
                    {video.lastError}
                  </div>
                )}
              </div>
              <StatusPill status={video.status} inProgress={video.inProgress} />
            </Link>
          </li>
        ))}
      </ul>

      {pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            ← Newer
          </button>
          <span className="muted small">
            Page {page + 1} of {pages}
          </span>
          <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Older →
          </button>
        </div>
      )}
    </section>
  );
}
