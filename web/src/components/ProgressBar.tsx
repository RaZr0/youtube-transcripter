import type { Stats } from "../api";

export function ProgressBar({ stats }: { stats: Stats }) {
  const total = Math.max(stats.total, 1);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={stats.total}
      aria-valuenow={stats.completed}
      title={`${stats.completed} completed · ${stats.pending + stats.processing} queued · ${stats.failed} failed · ${stats.unavailable} unavailable`}
    >
      <div className="progress-seg seg-done" style={{ width: pct(stats.completed) }} />
      <div className="progress-seg seg-unavailable" style={{ width: pct(stats.unavailable) }} />
      <div className="progress-seg seg-failed" style={{ width: pct(stats.failed) }} />
    </div>
  );
}

export function StatusPill({ status, inProgress }: { status: string; inProgress?: boolean }) {
  const label = inProgress
    ? "Transcribing"
    : { pending: "Queued", processing: "Transcribing", completed: "Done", failed: "Failed", unavailable: "No transcript" }[
        status
      ] ?? status;
  const tone = inProgress ? "blue" : { completed: "green", failed: "red", unavailable: "gray", pending: "neutral" }[status] ?? "blue";
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
