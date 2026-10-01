import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Channel } from "../api";
import { ProgressBar } from "../components/ProgressBar";
import { formatNumber, timeAgo, usePolling } from "../util";

export function HomePage() {
  const { data: channels, error, reload } = usePolling(api.channels, []);

  return (
    <>
      <AddChannelForm onAdded={reload} />
      <section>
        <h2 className="section-title">Your channels</h2>
        {error && <p className="error">{error}</p>}
        {channels && channels.length === 0 && (
          <p className="empty">No channels yet. Paste a channel URL above to transcribe all of its videos.</p>
        )}
        <div className="channel-grid">
          {channels?.map((channel) => <ChannelCard key={channel.id} channel={channel} />)}
        </div>
      </section>
    </>
  );
}

function AddChannelForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [includeShorts, setIncludeShorts] = useState(false);
  const [includeLive, setIncludeLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const channel = await api.addChannel(url, includeShorts, includeLive);
      setUrl("");
      onAdded();
      navigate(`/channels/${channel.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-form card" onSubmit={submit}>
      <h1>Transcribe a YouTube channel</h1>
      <p className="muted">
        Paste a channel link. Every video is discovered, queued and transcribed in the background; new uploads are picked
        up automatically.
      </p>
      <div className="add-row">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/@channel"
          aria-label="YouTube channel URL"
          required
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !url.trim()}>
          {busy ? "Adding…" : "Add channel"}
        </button>
      </div>
      <div className="options">
        <label>
          <input type="checkbox" checked={includeLive} onChange={(e) => setIncludeLive(e.target.checked)} /> Include past
          live streams
        </label>
        <label>
          <input type="checkbox" checked={includeShorts} onChange={(e) => setIncludeShorts(e.target.checked)} /> Include
          Shorts
        </label>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  const { stats } = channel;
  const done = stats.completed + stats.unavailable;
  return (
    <Link to={`/channels/${channel.id}`} className="channel-card card">
      <div className="channel-card-head">
        <Avatar channel={channel} />
        <div className="min0">
          <div className="channel-title">{channel.title}</div>
          <div className="muted small">{channel.handle ?? channel.youtubeId}</div>
        </div>
      </div>
      <ProgressBar stats={stats} />
      <div className="channel-card-foot small">
        <span>
          <strong>{formatNumber(stats.completed)}</strong> / {formatNumber(stats.total)} transcribed
        </span>
        <SyncBadge channel={channel} />
      </div>
      {stats.total > 0 && done < stats.total && (
        <div className="muted small">{formatNumber(stats.total - done)} remaining</div>
      )}
    </Link>
  );
}

export function Avatar({ channel, size = 44 }: { channel: Channel; size?: number }) {
  if (channel.thumbnailUrl) {
    return <img className="avatar" src={channel.thumbnailUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" />;
  }
  return (
    <div className="avatar avatar-fallback" style={{ width: size, height: size }}>
      {channel.title.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function SyncBadge({ channel }: { channel: Channel }) {
  if (channel.syncStatus === "syncing") return <span className="badge badge-blue">Syncing…</span>;
  if (channel.syncStatus === "error")
    return (
      <span className="badge badge-red" title={channel.syncError ?? ""}>
        Sync error
      </span>
    );
  return <span className="muted">Synced {timeAgo(channel.lastSyncedAt)}</span>;
}
