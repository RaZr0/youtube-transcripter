import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Segment } from "../api";
import { StatusPill } from "../components/ProgressBar";
import { formatDate, formatNumber, formatTime, usePolling } from "../util";

export function VideoPage() {
  const id = useParams().id!;
  const { data: video, error, reload } = usePolling(() => api.video(id), [id], 5000);
  const player = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"timestamps" | "text">("timestamps");
  const [find, setFind] = useState("");
  const [copied, setCopied] = useState(false);

  function seek(seconds: number) {
    // YouTube's iframe API accepts commands via postMessage when enablejsapi=1.
    const send = (func: string, args: unknown[]) =>
      player.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
    send("seekTo", [seconds, true]);
    send("playVideo", []);
    player.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function copy() {
    if (!video?.transcript) return;
    await navigator.clipboard.writeText(video.transcript.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (error && !video) return <p className="error">{error}</p>;
  if (!video) return <p className="muted">Loading…</p>;
  const transcript = video.transcript;

  return (
    <div className="video-page">
      <div className="breadcrumbs small">
        <Link to={`/channels/${video.channel.id}`}>← {video.channel.title}</Link>
      </div>
      <h1>{video.title ?? `Video ${video.id}`}</h1>
      <div className="muted small meta">
        {formatDate(video.publishedAt)}
        {video.durationSeconds ? <> · {formatTime(video.durationSeconds)}</> : null}
        {transcript && (
          <>
            {" "}
            · {formatNumber(transcript.wordCount)} words · language: {transcript.language ?? "unknown"} · source:{" "}
            {describeSource(transcript.provider)}
          </>
        )}{" "}
        · <a href={video.url} target="_blank" rel="noreferrer">Open on YouTube</a>{" "}
        <StatusPill status={video.status} inProgress={video.inProgress} />
      </div>

      <div className="video-layout">
        <div className="player-col">
          <div className="player">
            <iframe
              ref={player}
              src={`https://www.youtube-nocookie.com/embed/${video.id}?enablejsapi=1&rel=0`}
              title={video.title ?? video.id}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>

        <div className="transcript-col card">
          {transcript ? (
            <>
              <div className="transcript-toolbar">
                <div className="tabs">
                  <button className={view === "timestamps" ? "tab active" : "tab"} onClick={() => setView("timestamps")}>
                    Timestamps
                  </button>
                  <button className={view === "text" ? "tab active" : "tab"} onClick={() => setView("text")}>
                    Plain text
                  </button>
                </div>
                <input type="search" placeholder="Find in transcript…" value={find} onChange={(e) => setFind(e.target.value)} />
                <button onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
                <a className="button" href={`/api/videos/${video.id}/transcript.txt?timestamps=${view === "timestamps"}`}>
                  Download .txt
                </a>
              </div>
              {view === "timestamps" ? (
                <SegmentList segments={transcript.segments} find={find} onSeek={seek} />
              ) : (
                <div className="transcript-text">
                  <Highlight text={transcript.text} find={find} />
                </div>
              )}
            </>
          ) : (
            <NoTranscript video={video} onRetry={() => api.retryVideo(video.id).then(reload)} />
          )}
        </div>
      </div>
    </div>
  );
}

function describeSource(provider: string): string {
  if (provider.endsWith("youtube-captions")) return "YouTube captions";
  if (provider.endsWith("youtube-auto-captions")) return "YouTube automatic captions";
  const whisper = /whisper-(.+)$/.exec(provider);
  if (whisper) return `Whisper (${whisper[1]}, on this computer)`;
  return provider;
}

function SegmentList({ segments, find, onSeek }: { segments: Segment[]; find: string; onSeek: (t: number) => void }) {
  const needle = find.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? segments.filter((s) => s.text.toLowerCase().includes(needle)) : segments),
    [segments, needle],
  );
  return (
    <div className="segments">
      {needle && <div className="muted small">{visible.length} matching line(s)</div>}
      {visible.map((segment, i) => (
        <div key={`${segment.start}-${i}`} className="segment">
          <button className="timestamp" onClick={() => onSeek(segment.start)} title="Play from here">
            {formatTime(segment.start)}
          </button>
          <span>
            <Highlight text={segment.text} find={find} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Highlight({ text, find }: { text: string; find: string }) {
  const needle = find.trim();
  if (!needle) return <>{text}</>;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

function NoTranscript({ video, onRetry }: { video: { status: string; inProgress: boolean; lastError: string | null; attempts: number; nextAttemptAt: string | null }; onRetry: () => void }) {
  if (video.status === "pending" || video.status === "processing") {
    return (
      <div className="empty">
        <p>{video.inProgress ? "Transcription in progress…" : "Waiting in the queue…"}</p>
        {video.lastError && <p className="muted small">{video.lastError}</p>}
        <p className="muted small">This page refreshes automatically.</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <p>{video.status === "unavailable" ? "No transcript could be produced for this video." : "Transcription failed."}</p>
      {video.lastError && <p className="error-text small">{video.lastError}</p>}
      {video.status === "failed" && video.nextAttemptAt && (
        <p className="muted small">
          Attempt {video.attempts}; next automatic retry at {new Date(video.nextAttemptAt).toLocaleString()}.
        </p>
      )}
      <button onClick={onRetry}>Retry now</button>
    </div>
  );
}
