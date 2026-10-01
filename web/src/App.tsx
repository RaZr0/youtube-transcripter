import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { ChannelPage } from "./pages/ChannelPage";
import { HomePage } from "./pages/HomePage";
import { SearchPage } from "./pages/SearchPage";
import { VideoPage } from "./pages/VideoPage";
import { formatNumber, usePolling } from "./util";

export function App() {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            <span className="brand-mark" aria-hidden>
              ▶
            </span>
            Transcripter
          </NavLink>
          <nav>
            <NavLink to="/" end>
              Channels
            </NavLink>
            <NavLink to="/search">Search</NavLink>
          </nav>
          <QueueIndicator />
        </div>
      </header>
      <StatusBanner />
      <main className="container">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/channels/:id" element={<ChannelPage />} />
          <Route path="/videos/:id" element={<VideoPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="*" element={<p className="empty">Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}

function QueueIndicator() {
  const { data } = usePolling(api.status, [], 5000);
  if (!data) return null;
  const left = data.queue.pending + data.queue.processing;
  return (
    <div className="queue-indicator" title="Videos waiting to be transcribed">
      {left > 0 ? (
        <>
          <span className="pulse" /> {formatNumber(left)} in queue
        </>
      ) : (
        <>{formatNumber(data.queue.completed)} transcripts</>
      )}
    </div>
  );
}

function StatusBanner() {
  const { data, reload } = usePolling(api.status, [], 5000);
  if (!data) return null;
  if (data.configurationError) {
    return <div className="banner banner-error">{data.configurationError}</div>;
  }
  if (data.worker.pausedUntil) {
    return (
      <div className="banner banner-warn">
        Transcription paused until {new Date(data.worker.pausedUntil).toLocaleTimeString()}: {data.worker.pauseReason}{" "}
        <button className="link" onClick={() => api.resumeWorker().then(reload)}>
          Resume now
        </button>
      </div>
    );
  }
  if (data.local?.whisperEnabled && !data.local.whisperAvailable) {
    return (
      <div className="banner banner-warn">
        Whisper is not available ({data.local.whisperError}). Videos with YouTube captions are still transcribed; videos
        without captions are skipped until it is installed.
      </div>
    );
  }
  if (data.provider === "mock") {
    return <div className="banner banner-info">Demo mode: transcripts are generated fake data (TRANSCRIPT_PROVIDER=mock).</div>;
  }
  return null;
}
