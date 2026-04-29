import type { SessionThreadSummary } from "@aliceloop/runtime-core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface ThreadSearchPanelProps {
  open: boolean;
  daemonBaseUrl: string | null;
  activeSessionId: string;
  onClose: () => void;
  onSelectThread: (thread: SessionThreadSummary) => void;
}

const searchDebounceMs = 180;
const searchLimit = 12;

function getThreadPreview(thread: SessionThreadSummary) {
  return thread.matchedPreview ?? thread.latestMessagePreview ?? "还没有消息。";
}

function formatMatchCount(value: number | null | undefined) {
  const count = Math.max(0, Math.round(value ?? 0));
  if (count <= 0) {
    return "";
  }

  return `${count} ${count === 1 ? "match" : "matches"}`;
}

export function ThreadSearchPanel({
  open,
  daemonBaseUrl,
  activeSessionId,
  onClose,
  onSelectThread,
}: ThreadSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!daemonBaseUrl || !trimmedQuery) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        q: trimmedQuery,
        limit: String(searchLimit),
      });

      void fetch(`${daemonBaseUrl}/api/threads/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`搜索失败 (${response.status})`);
          }
          return (await response.json()) as SessionThreadSummary[];
        })
        .then((items) => {
          setResults(items.filter((thread) => !thread.isChildAgent));
          setActiveIndex(0);
        })
        .catch((searchError) => {
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setError(searchError instanceof Error ? searchError.message : "搜索失败");
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, searchDebounceMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [daemonBaseUrl, open, trimmedQuery]);

  if (!open) {
    return null;
  }

  function selectActiveResult() {
    const thread = results[activeIndex];
    if (thread) {
      onSelectThread(thread);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length === 0) {
        return;
      }
      setActiveIndex((current) => Math.min(results.length - 1, current + 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) {
        return;
      }
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      selectActiveResult();
    }
  }

  return (
    <div className="thread-search-overlay" onClick={onClose}>
      <section className="thread-search-panel" onClick={(event) => event.stopPropagation()}>
        <label className="thread-search-panel__input-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.75" cy="10.75" r="6.75" />
            <path d="m16 16 4.25 4.25" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search threads"
            aria-label="搜索线程"
            spellCheck={false}
          />
        </label>

        <div className="thread-search-panel__body">
          <div className="thread-search-panel__section-label">Threads</div>

          {error ? <div className="thread-search-panel__status thread-search-panel__status--error">{error}</div> : null}
          {loading ? <div className="thread-search-panel__status">Searching...</div> : null}
          {!loading && trimmedQuery && results.length === 0 && !error ? (
            <div className="thread-search-panel__status">No matching threads</div>
          ) : null}

          {results.length > 0 ? (
            <div className="thread-search-panel__results">
              {results.map((thread, index) => {
                const matchCount = formatMatchCount(thread.matchCount);
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-search-panel__result${
                      index === activeIndex ? " thread-search-panel__result--active" : ""
                    }${thread.id === activeSessionId ? " thread-search-panel__result--current" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onSelectThread(thread)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4.5 5.5h15v10.25h-8.4l-5.35 3.2v-3.2H4.5V5.5Z" />
                    </svg>
                    <span className="thread-search-panel__result-copy">
                      <strong>{thread.title}</strong>
                      <span>{getThreadPreview(thread)}</span>
                    </span>
                    {matchCount ? <span className="thread-search-panel__matches">{matchCount}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
