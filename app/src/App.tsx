import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type WordEntry = {
  word: string;
  pos: string[];
  definitions: string[];
  synonyms: string[];
  examples: string[];
};

type HistoryItem = {
  word: string;
  searched_at: string;
};

const PREVIEW_MIN_HEIGHT = 220;

function App() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [selectedWord, setSelectedWord] = useState("");
  const [entry, setEntry] = useState<WordEntry | null>(null);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isLoadingEntry, setIsLoadingEntry] = useState(false);
  const [isShowingSuggestions, setIsShowingSuggestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentHistory, setRecentHistory] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lookupLockRef = useRef(false);

  const trimmedQuery = query.trim();
  const hasSearchText = trimmedQuery.length > 0;

  const highlightedSuggestion = useMemo(() => {
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      return suggestions[selectedIndex];
    }
    if (suggestions[0]) {
      return suggestions[0];
    }
    return "";
  }, [selectedIndex, suggestions]);

  const refreshHistory = async () => {
    try {
      const results = (await invoke<HistoryItem[]>("get_history", {
        limit: 8,
      })) as HistoryItem[];
      setRecentHistory(results);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Unable to load recent searches.",
      );
    }
  };

  useEffect(() => {
    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!hasSearchText) {
      setSuggestions([]);
      setSelectedIndex(-1);
      setIsShowingSuggestions(false);
      setError(null);
      setEntry(null);
      setSelectedWord("");
      return;
    }

    setIsLoadingSuggestions(true);
    setError(null);

    const timer = window.setTimeout(async () => {
      try {
        const results = (await invoke<string[]>("autocomplete", {
          prefix: trimmedQuery,
          limit: 8,
        })) as string[];

        if (results.length > 0) {
          setSuggestions(results);
          setSelectedIndex(0);
          setIsShowingSuggestions(true);

          const firstWord = results[0];
          setSelectedWord(firstWord);
          const preview = (await invoke<WordEntry | null>("get_entry", {
            word: firstWord,
          })) as WordEntry | null;
          setEntry(preview);
          return;
        }

        const fuzzyResults = (await invoke<string[]>("fuzzy_search", {
          query: trimmedQuery,
          limit: 5,
        })) as string[];

        setSuggestions(fuzzyResults);
        setSelectedIndex(fuzzyResults.length > 0 ? 0 : -1);
        setIsShowingSuggestions(fuzzyResults.length > 0);

        if (fuzzyResults.length > 0) {
          const firstWord = fuzzyResults[0];
          setSelectedWord(firstWord);
          const preview = (await invoke<WordEntry | null>("get_entry", {
            word: firstWord,
          })) as WordEntry | null;
          setEntry(preview);
        } else {
          setEntry(null);
          setSelectedWord("");
        }
      } catch (err) {
        setSuggestions([]);
        setEntry(null);
        setSelectedWord("");
        setError(err instanceof Error ? err.message : "Unable to search right now.");
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 50);

    return () => window.clearTimeout(timer);
  }, [trimmedQuery, hasSearchText]);

  const fetchEntry = async (word: string) => {
    setIsLoadingEntry(true);
    setError(null);

    try {
      const fetched = (await invoke<WordEntry | null>("get_entry", {
        word,
      })) as WordEntry | null;
      setEntry(fetched);
      setSelectedWord(word);
      return fetched;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load that entry.");
      setEntry(null);
      return null;
    } finally {
      setIsLoadingEntry(false);
    }
  };

  const handleSuggestionSelect = async (word: string) => {
    setQuery(word);
    setSuggestions([]);
    setIsShowingSuggestions(false);
    setSelectedIndex(-1);
    await fetchEntry(word);
  };

  const handleHistorySelect = async (word: string) => {
    setQuery(word);
    setSuggestions([]);
    setSelectedIndex(-1);
    setIsShowingSuggestions(false);
    await fetchEntry(word);
  };

  const performLookup = async (word: string) => {
    const normalizedWord = word.trim();
    if (!normalizedWord || lookupLockRef.current) {
      return;
    }

    lookupLockRef.current = true;
    setIsShowingSuggestions(false);

    try {
      const lookedUp = await fetchEntry(normalizedWord);

      if (!lookedUp) {
        try {
          const fuzzyResults = (await invoke<string[]>("fuzzy_search", {
            query: normalizedWord,
            limit: 3,
          })) as string[];

          if (fuzzyResults.length > 0) {
            const fallbackWord = fuzzyResults[0];
            setQuery(fallbackWord);
            const fallbackEntry = await fetchEntry(fallbackWord);
            if (fallbackEntry) {
              await invoke("log_history", { word: fallbackEntry.word });
              await refreshHistory();
            }
            return;
          }
        } catch {
          // Best-effort only. A direct lookup failure is already displayed to the user.
        }
        return;
      }

      try {
        await invoke("log_history", { word: lookedUp.word });
        await refreshHistory();
      } catch {
        // Best-effort only. The query still succeeds without history persistence.
      }
    } finally {
      lookupLockRef.current = false;
    }
  };

  const handleSubmit = async (event?: FormEvent) => {
    if (event) {
      event.preventDefault();
    }

    const wordToLookup = highlightedSuggestion || trimmedQuery;
    if (!wordToLookup) {
      return;
    }

    await performLookup(wordToLookup);
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      if (!suggestions.length) {
        return;
      }

      event.preventDefault();
      setSelectedIndex((current) => {
        const next = current < suggestions.length - 1 ? current + 1 : 0;
        return next;
      });
      return;
    }

    if (event.key === "ArrowUp") {
      if (!suggestions.length) {
        return;
      }

      event.preventDefault();
      setSelectedIndex((current) => {
        const next = current > 0 ? current - 1 : suggestions.length - 1;
        return next;
      });
      return;
    }

    if (event.key === "Escape") {
      setIsShowingSuggestions(false);
      setSelectedIndex(-1);
      inputRef.current?.blur();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();

      if (suggestions.length > 0) {
        const indexToUse = selectedIndex >= 0 ? selectedIndex : 0;
        const word = suggestions[indexToUse] ?? trimmedQuery;
        if (word) {
          setQuery(word);
          await performLookup(word);
        }
        return;
      }

      if (trimmedQuery) {
        await performLookup(trimmedQuery);
      }
    }
  };

  const renderSuggestionLabel = (word: string) => {
    const normalized = trimmedQuery.toLowerCase();
    const candidate = word.toLowerCase();
    const start = candidate.indexOf(normalized);

    if (!normalized || start < 0) {
      return word;
    }

    return (
      <>
        {word.slice(0, start)}
        <span className="match">{word.slice(start, start + normalized.length)}</span>
        {word.slice(start + normalized.length)}
      </>
    );
  };

  const currentStatus = error
    ? "ERROR"
    : isLoadingSuggestions && !entry
      ? "SCANNING"
      : hasSearchText && entry
        ? "LIVE"
        : hasSearchText
          ? "NO MATCH"
          : "IDLE";

  const activeSelection =
    selectedIndex >= 0 && suggestions[selectedIndex] ? suggestions[selectedIndex] : highlightedSuggestion;

  const historyList = recentHistory.length > 0 ? recentHistory : [];

  return (
    <main className="hud-shell">
      <div className="hud-window">
        <header className="hud-header">
          <div className="brand-block">
            <span className="brand-mark">[F]</span>
            <div>
              <div className="eyebrow">FANABABEL // COMPACT LEXICON</div>
              <h1>Reader's dictionary</h1>
            </div>
          </div>

          <div className="meta-block">
            <span>DATE 2026-09-16</span>
            <span>MODE DARK</span>
            <span>STATUS {currentStatus}</span>
          </div>
        </header>

        <div className="hud-rule" />

        <div className="hud-body">
          <section className="search-column">
            <div className="module-header">
              <span className="module-tag">QUERY</span>
              <span className="module-value">{query || "0000"}</span>
            </div>

            <div className="search-status-row">
              <span>ACTIVE</span>
              <strong>{activeSelection || "--"}</strong>
            </div>

            <form className="search-form" onSubmit={handleSubmit}>
              <div className="search-box">
                <label className="sr-only" htmlFor="word-search">
                  Search a word
                </label>
                <input
                  ref={inputRef}
                  id="word-search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedIndex(-1);
                    setIsShowingSuggestions(true);
                  }}
                  onFocus={() => setIsShowingSuggestions(true)}
                  onBlur={() => {
                    window.setTimeout(() => setIsShowingSuggestions(false), 120);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="type a word..."
                  aria-expanded={isShowingSuggestions && suggestions.length > 0}
                  aria-controls="suggestions-list"
                />
                <button type="submit" className="lookup-button">
                  RUN
                </button>
              </div>

              {isShowingSuggestions && suggestions.length > 0 && (
                <ul id="suggestions-list" className="suggestions" role="listbox" aria-label="Word suggestions">
                  {suggestions.map((word, index) => (
                    <li key={word}>
                      <button
                        id={`suggestion-${index}`}
                        type="button"
                        className={index === selectedIndex ? "suggestion active" : "suggestion"}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void handleSuggestionSelect(word);
                        }}
                        onMouseEnter={() => {
                          setSelectedIndex(index);
                          void fetchEntry(word);
                        }}
                        aria-selected={index === selectedIndex}
                      >
                        {renderSuggestionLabel(word)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </form>

            <div className="preview-panel" style={{ minHeight: PREVIEW_MIN_HEIGHT }}>
              {isLoadingSuggestions && !entry ? (
                <div className="state-card">scanning lexicon...</div>
              ) : error ? (
                <div className="state-card error">{error}</div>
              ) : isLoadingEntry ? (
                <div className="state-card">loading {selectedWord || trimmedQuery}...</div>
              ) : entry ? (
                <article className="definition-card">
                  <div className="entry-header">
                    <h2>{entry.word}</h2>
                    <div className="pos-list">
                      {entry.pos.map((part) => (
                        <span key={`${entry.word}-${part}`} className="pos-tag">
                          {part}
                        </span>
                      ))}
                    </div>
                  </div>

                  <p className="top-definition">{entry.definitions[0] ?? "definition unavailable"}</p>

                  {entry.synonyms.length > 0 && (
                    <div className="chip-group">
                      {entry.synonyms.slice(0, 6).map((synonym) => (
                        <span key={`${entry.word}-${synonym}`} className="chip">
                          {synonym}
                        </span>
                      ))}
                    </div>
                  )}

                  {entry.examples.length > 0 && (
                    <blockquote className="example">“{entry.examples[0]}”</blockquote>
                  )}
                </article>
              ) : hasSearchText ? (
                <div className="state-card">no matches for {trimmedQuery}</div>
              ) : (
                <div className="state-card muted">type a word to inspect meaning, usage, and synonyms</div>
              )}
            </div>
          </section>

          <aside className="detail-column">
            <div className="module-header narrow">
              <span className="module-tag">RECENT</span>
              <button type="button" className="mini-button" onClick={() => void refreshHistory()}>
                refresh
              </button>
            </div>

            <div className="history-panel">
              {historyError ? (
                <div className="state-card error compact">{historyError}</div>
              ) : historyList.length > 0 ? (
                <ul className="history-list" aria-label="Recent word history">
                  {historyList.map((item, index) => (
                    <li key={`${item.word}-${item.searched_at}-${index}`}>
                      <button type="button" className="history-entry" onClick={() => void handleHistorySelect(item.word)}>
                        <span>{item.word}</span>
                        <small>{new Date(item.searched_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-history">no recent lookups yet</div>
              )}
            </div>

            <div className="module-header narrow detail-header">
              <span className="module-tag">DETAILS</span>
              <span className="module-value">{entry ? entry.word : "--"}</span>
            </div>

            {!entry ? (
              <div className="empty-detail">
                <span className="bracket">[</span> awaiting query <span className="bracket">]</span>
              </div>
            ) : (
              <div className="detail-stack">
                <div className="definitions-block">
                  <h3>DEFINITIONS</h3>
                  <ol>
                    {entry.definitions.map((definition, index) => (
                      <li key={`${entry.word}-definition-${index}`}>{definition}</li>
                    ))}
                  </ol>
                </div>

                {entry.synonyms.length > 0 && (
                  <div className="definitions-block">
                    <h3>SYNONYMS</h3>
                    <ul className="synonym-list">
                      {entry.synonyms.map((synonym, index) => (
                        <li key={`${entry.word}-synonym-${index}`}>{synonym}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {entry.examples.length > 0 && (
                  <div className="definitions-block">
                    <h3>EXAMPLES</h3>
                    <ul className="example-list">
                      {entry.examples.map((example, index) => (
                        <li key={`${entry.word}-example-${index}`}>{example}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

export default App;
