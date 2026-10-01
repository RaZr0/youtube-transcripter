import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SearchHit } from "../api";
import { formatDate, formatNumber } from "../util";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [input, setInput] = useState(q);
  const [results, setResults] = useState<{ total: number; items: SearchHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(q);
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    api
      .search(q)
      .then((r) => !cancelled && (setResults(r), setError(null)))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [q]);

  async function loadMore() {
    if (!results) return;
    const more = await api.search(q, results.items.length);
    setResults({ total: more.total, items: [...results.items, ...more.items] });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setParams(input.trim() ? { q: input.trim() } : {});
  }

  return (
    <>
      <form className="card add-form" onSubmit={submit}>
        <h1>Search all transcripts</h1>
        <div className="add-row">
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Words or "an exact phrase"'
            aria-label="Search transcripts"
            autoFocus
          />
          <button className="primary" type="submit">
            Search
          </button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}
      {results && (
        <p className="muted small">
          {formatNumber(results.total)} video{results.total === 1 ? "" : "s"} mention “{q}”
        </p>
      )}
      <ul className="search-results">
        {results?.items.map((hit) => (
          <li key={hit.id} className="card">
            <Link to={`/videos/${hit.id}`} className="video-title">
              {hit.title ?? hit.id}
            </Link>
            <div className="muted small">
              <Link to={`/channels/${hit.channel_id}`}>{hit.channel_title}</Link> · {formatDate(hit.published_at)}
            </div>
            <p className="snippet">
              <Snippet text={hit.snippet} />
            </p>
          </li>
        ))}
      </ul>
      {results && results.items.length < results.total && (
        <div className="pager">
          <button onClick={loadMore}>Load more</button>
        </div>
      )}
    </>
  );
}

/** The server marks matches with [[ ]]; render them as <mark> without using innerHTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}
