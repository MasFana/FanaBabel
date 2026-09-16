import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./App.css";

type WordEntry = {
  word: string;
  pos: string[];
  definitions: string[];
  synonyms: string[];
  examples: string[];
};

type HistoryEntry = {
  id: number;
  word: string;
  searched_at: string;
  pos: string[];
  definition: string | null;
  example: string | null;
};

const PREVIEW_MIN_HEIGHT = 220;
const FEED_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_SUGGESTION_CACHE_ENTRIES = 100;

function App() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [entry, setEntry] = useState<WordEntry | null>(null);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isLoadingEntry, setIsLoadingEntry] = useState(false);
  const [isShowingSuggestions, setIsShowingSuggestions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const optimisticHistoryIdRef = useRef(-1);
  const historyLoadingRef = useRef(false);
  const lookupLockRef = useRef(false);
  const searchRequestRef = useRef(0);
  const isTypingRef = useRef(false);
  const previewTimerRef = useRef<number | null>(null);
  // Dictionary data is static for the session, so a resolved word never needs to be re-fetched.
  const entryCacheRef = useRef<Map<string, WordEntry>>(new Map());
  const entryRequestCacheRef = useRef<Map<string, Promise<WordEntry | null>>>(new Map());
  const suggestionCacheRef = useRef<Map<string, string[]>>(new Map());
  const suggestionRequestCacheRef = useRef<Map<string, Promise<string[]>>>(new Map());

  const historyVirtualizer = useVirtualizer({
    count: recentHistory.length,
    getScrollElement: () => historyPanelRef.current,
    getItemKey: (index) => recentHistory[index]?.id ?? index,
    estimateSize: () => 180,
    overscan: 5,
  });

  const trimmedQuery = query.trim();
  const hasSearchText = trimmedQuery.length > 0;

  const normalizeCacheKey = (word: string) => word.trim().toLowerCase();

  const cacheEntry = (data: WordEntry) => {
    entryCacheRef.current.set(normalizeCacheKey(data.word), data);
  };

  const getCachedEntry = (word: string) => entryCacheRef.current.get(normalizeCacheKey(word));

  const searchSuggestions = async (searchTerm: string): Promise<string[]> => {
    const cacheKey = normalizeCacheKey(searchTerm);
    const cached = suggestionCacheRef.current.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = suggestionRequestCacheRef.current.get(cacheKey);
    if (pending) {
      return pending;
    }

    const request = (async () => {
      const autocompleteResults = (await invoke<string[]>("autocomplete", {
        prefix: searchTerm,
        limit: 8,
      })) as string[];
      const results = autocompleteResults.length > 0
        ? autocompleteResults
        : ((await invoke<string[]>("fuzzy_search", {
          query: searchTerm,
          limit: 5,
        })) as string[]);
      if (suggestionCacheRef.current.size >= MAX_SUGGESTION_CACHE_ENTRIES) {
        const oldestKey = suggestionCacheRef.current.keys().next().value;
        if (oldestKey) {
          suggestionCacheRef.current.delete(oldestKey);
        }
      }
      suggestionCacheRef.current.set(cacheKey, results);
      return results;
    })();
    suggestionRequestCacheRef.current.set(cacheKey, request);

    try {
      return await request;
    } finally {
      if (suggestionRequestCacheRef.current.get(cacheKey) === request) {
        suggestionRequestCacheRef.current.delete(cacheKey);
      }
    }
  };

  const resolveEntry = async (word: string): Promise<WordEntry | null> => {
    const cached = getCachedEntry(word);
    if (cached) {
      return cached;
    }

    const cacheKey = normalizeCacheKey(word);
    const pending = entryRequestCacheRef.current.get(cacheKey);
    if (pending) {
      return pending;
    }

    const request = (async () => {
      const fetched = (await invoke<WordEntry | null>("get_entry", { word })) as WordEntry | null;
      if (fetched) {
        cacheEntry(fetched);
      }
      return fetched;
    })();
    entryRequestCacheRef.current.set(cacheKey, request);

    try {
      return await request;
    } finally {
      if (entryRequestCacheRef.current.get(cacheKey) === request) {
        entryRequestCacheRef.current.delete(cacheKey);
      }
    }
  };

  const loadPreview = async (word: string, requestId: number) => {
    const cached = getCachedEntry(word);
    if (cached) {
      if (requestId === searchRequestRef.current) {
        setEntry(cached);
        setIsLoadingEntry(false);
      }
      return cached;
    }

    if (requestId === searchRequestRef.current) {
      setIsLoadingEntry(true);
    }

    try {
      const resolved = await resolveEntry(word);
      if (requestId === searchRequestRef.current) {
        setEntry(resolved);
        setIsLoadingEntry(false);
      }
      return resolved;
    } catch (err) {
      if (requestId === searchRequestRef.current) {
        setError(err instanceof Error ? err.message : "Unable to load that entry.");
        setIsLoadingEntry(false);
      }
      return null;
    }
  };

  const highlightedSuggestion = useMemo(() => {
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      return suggestions[selectedIndex];
    }
    if (suggestions[0]) {
      return suggestions[0];
    }
    return "";
  }, [selectedIndex, suggestions]);

  const loadHistory = async (reset = false) => {
    if (historyLoadingRef.current || (!reset && !hasMoreHistory)) {
      return;
    }

    historyLoadingRef.current = true;
    setIsLoadingHistory(true);
    try {
      const beforeId = reset ? undefined : recentHistory[recentHistory.length - 1]?.id;
      const results = (await invoke<HistoryEntry[]>("get_history", {
        limit: FEED_LIMIT,
        beforeId,
      })) as HistoryEntry[];
      setRecentHistory((current) => {
        if (reset) {
          return results;
        }
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...results.filter((item) => !existingIds.has(item.id))];
      });
      setHasMoreHistory(results.length === FEED_LIMIT);
      // get_history already returns full entry data, so seed the cache for free.
      for (const item of results) {
        cacheEntry({
          word: item.word,
          pos: item.pos,
          definitions: item.definition ? [item.definition] : [],
          synonyms: [],
          examples: item.example ? [item.example] : [],
        });
      }
      setHistoryError(null);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Unable to load recent searches.",
      );
    } finally {
      historyLoadingRef.current = false;
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    void loadHistory(true);
  }, []);

  useEffect(() => {
    const sentinel = historySentinelRef.current;
    const panel = historyPanelRef.current;
    if (!sentinel || !panel) {
      return;
    }

    const observer = new IntersectionObserver(
      ([intersection]) => {
        if (intersection.isIntersecting) {
          void loadHistory();
        }
      },
      { root: panel, rootMargin: "240px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [recentHistory.length, hasMoreHistory, isLoadingHistory]);

  useEffect(() => {
    const selectedSuggestion = suggestionRefs.current[selectedIndex];
    if (selectedSuggestion && isShowingSuggestions) {
      selectedSuggestion.scrollIntoView({ block: "nearest" });
    }
  }, [isShowingSuggestions, selectedIndex, suggestions]);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;

    // Suggestions are a typing affordance only. Selection, history, and submit
    // handlers own their data flow and should not trigger another search pass.
    if (!isTypingRef.current) {
      return;
    }

    if (!hasSearchText) {
      setSuggestions([]);
      setSelectedIndex(-1);
      setIsShowingSuggestions(false);
      setError(null);
      setIsLoadingSuggestions(false);
      setIsLoadingEntry(false);
      // Keep the last resolved entry visible on the right instead of blanking it out.
      return;
    }

    setIsLoadingSuggestions(true);
    setIsLoadingEntry(true);
    setError(null);

    const timer = window.setTimeout(async () => {
      try {
        const results = await searchSuggestions(trimmedQuery);

        if (requestId !== searchRequestRef.current) {
          return;
        }

        setSuggestions(results);
        setSelectedIndex(results.length > 0 ? 0 : -1);
        setIsShowingSuggestions(isTypingRef.current && results.length > 0);

        if (results.length > 0) {
          await loadPreview(results[0], requestId);
        } else if (requestId === searchRequestRef.current) {
          await loadPreview(trimmedQuery, requestId);
        }
      } catch (err) {
        if (requestId !== searchRequestRef.current) {
          return;
        }
        setSuggestions([]);
        setEntry(null);
        setError(err instanceof Error ? err.message : "Unable to search right now.");
      } finally {
        if (requestId === searchRequestRef.current) {
          setIsLoadingSuggestions(false);
          setIsLoadingEntry(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [trimmedQuery, hasSearchText]);

  const fetchEntry = async (word: string) => {
    const requestId = ++searchRequestRef.current;
    setError(null);
    return loadPreview(word, requestId);
  };

  const previewSuggestion = (word: string) => {
    const requestId = ++searchRequestRef.current;
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
    }
    setIsLoadingEntry(true);
    setError(null);
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      void loadPreview(word, requestId);
    }, 60);
  };

  const handleSuggestionSelect = async (word: string) => {
    isTypingRef.current = false;
    setQuery(word);
    setSuggestions([]);
    setIsShowingSuggestions(false);
    setSelectedIndex(-1);
    await fetchEntry(word);
  };

  const handleClearSearch = () => {
    isTypingRef.current = false;
    searchRequestRef.current += 1;
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    setQuery("");
    setSuggestions([]);
    setSelectedIndex(-1);
    setIsShowingSuggestions(false);
    setIsLoadingSuggestions(false);
    setIsLoadingEntry(false);
    setError(null);
    inputRef.current?.focus();
  };

  const handleHistorySelect = (item: HistoryEntry) => {
    // History entries already carry the full preview data, so switch instantly with no fetch/skeleton.
    isTypingRef.current = false;
    searchRequestRef.current += 1;
    setQuery(item.word);
    setSuggestions([]);
    setSelectedIndex(-1);
    setIsShowingSuggestions(false);
    setError(null);
    setEntry({
      word: item.word,
      pos: item.pos,
      definitions: item.definition ? [item.definition] : [],
      synonyms: [],
      examples: item.example ? [item.example] : [],
    });
  };

  const addOptimisticHistory = (lookedUp: WordEntry) => {
    const optimisticEntry: HistoryEntry = {
      id: optimisticHistoryIdRef.current--,
      word: lookedUp.word,
      searched_at: new Date().toISOString(),
      pos: lookedUp.pos,
      definition: lookedUp.definitions[0] ?? null,
      example: lookedUp.examples[0] ?? null,
    };
    setHistoryError(null);
    setRecentHistory((current) => [
      optimisticEntry,
      ...current.filter((item) => item.word !== optimisticEntry.word),
    ]);
    return () => {
      setRecentHistory((current) => current.filter((item) => item.id !== optimisticEntry.id));
    };
  };

  const persistHistory = async (lookedUp: WordEntry) => {
    const rollback = addOptimisticHistory(lookedUp);
    try {
      await invoke("log_history", { word: lookedUp.word });
    } catch (err) {
      rollback();
      setHistoryError(err instanceof Error ? err.message : "Unable to save recent search.");
      return;
    }
    await loadHistory(true);
  };

  const performLookup = async (word: string) => {
    const normalizedWord = word.trim();
    if (!normalizedWord || lookupLockRef.current) {
      return;
    }

    lookupLockRef.current = true;
    isTypingRef.current = false;
    searchRequestRef.current += 1;
    setSuggestions([]);
    setSelectedIndex(-1);
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
              await persistHistory(fallbackEntry);
            }
            return;
          }
        } catch {
          // Best-effort only. A direct lookup failure is already displayed to the user.
        }
        return;
      }

      await persistHistory(lookedUp);
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
      setIsShowingSuggestions(true);
      const next = selectedIndex < suggestions.length - 1 ? selectedIndex + 1 : 0;
      setSelectedIndex(next);
      previewSuggestion(suggestions[next]);
      return;
    }

    if (event.key === "ArrowUp") {
      if (!suggestions.length) {
        return;
      }

      event.preventDefault();
      setIsShowingSuggestions(true);
      const next = selectedIndex > 0 ? selectedIndex - 1 : suggestions.length - 1;
      setSelectedIndex(next);
      previewSuggestion(suggestions[next]);
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
            <span>{currentStatus}</span>
          </div>
        </header>

        <div className="hud-rule" />

        <div className="hud-body">
          <section className="search-column">
            <form className="search-form" autoComplete="off" onSubmit={handleSubmit}>
              <div className="search-box">
                <label className="sr-only" htmlFor="word-search">
                  Search a word
                </label>
                <input
                  ref={inputRef}
                  id="word-search"
                  value={query}
                  onChange={(event) => {
                    isTypingRef.current = true;
                    setQuery(event.target.value);
                    setSelectedIndex(-1);
                    setIsShowingSuggestions(true);
                  }}
                  onFocus={() => {
                    isTypingRef.current = true;
                    if (suggestions.length > 0) {
                      setIsShowingSuggestions(true);
                    }
                  }}
                  onBlur={() => {
                    isTypingRef.current = false;
                    setIsShowingSuggestions(false);
                  }}
                  onKeyDown={handleKeyDown}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="type a word..."
                  aria-expanded={isShowingSuggestions && suggestions.length > 0}
                  aria-controls="suggestions-list"
                />
                {query && (
                  <button
                    type="button"
                    className="clear-button"
                    aria-label="Clear search"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={handleClearSearch}
                  >
                    x
                  </button>
                )}
                <button type="submit" className="lookup-button">
                  RUN
                </button>
              </div>

              {isShowingSuggestions && suggestions.length > 0 && (
                <ul id="suggestions-list" className="suggestions" role="listbox" aria-label="Word suggestions">
                  {suggestions.map((word, index) => (
                    <li key={word}>
                      <button
                        ref={(element) => {
                          suggestionRefs.current[index] = element;
                        }}
                        id={`suggestion-${index}`}
                        type="button"
                        className={index === selectedIndex ? "suggestion active" : "suggestion"}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          void handleSuggestionSelect(word);
                        }}
                        onMouseEnter={() => {
                          setSelectedIndex(index);
                          previewSuggestion(word);
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

            <div className="module-header narrow feed-header">
              <span className="module-tag">RECENT</span>
              <button type="button" className="mini-button" onClick={() => void loadHistory(true)}>
                refresh
              </button>
            </div>

            <div
              ref={historyPanelRef}
              className="feed-panel"
              style={{ minHeight: PREVIEW_MIN_HEIGHT }}
            >
              {historyError ? (
                <div className="state-card error compact">{historyError}</div>
              ) : recentHistory.length > 0 ? (
                <ul
                  className="feed-list virtualized"
                  aria-label="Search history feed"
                  style={{ height: `${historyVirtualizer.getTotalSize()}px` }}
                >
                  {historyVirtualizer.getVirtualItems().map((virtualRow) => {
                    const item = recentHistory[virtualRow.index];
                    return (
                      <li
                        key={item.id}
                        data-index={virtualRow.index}
                        ref={(element) => historyVirtualizer.measureElement(element)}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <button
                          type="button"
                          className={entry && entry.word === item.word ? "feed-card active" : "feed-card"}
                          onClick={() => handleHistorySelect(item)}
                        >
                          <div className="entry-header">
                            <h2>{item.word}</h2>
                            <div className="pos-list">
                              {item.pos.map((part) => (
                                <span key={`${item.word}-${part}`} className="pos-tag">
                                  {part}
                                </span>
                              ))}
                            </div>
                          </div>

                          <p className="top-definition">{item.definition ?? "definition unavailable"}</p>

                          {item.example && (
                            <blockquote className="example">“{item.example}”</blockquote>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="state-card muted">no recent lookups yet</div>
              )}
              <div ref={historySentinelRef} className="history-sentinel" aria-hidden="true" />
              {isLoadingHistory && <div className="history-status">loading more...</div>}
              {!isLoadingHistory && !hasMoreHistory && recentHistory.length > 0 && (
                <div className="history-status">end of history</div>
              )}
            </div>
          </section>

          <aside className="detail-column">
            <div className="module-header narrow detail-header">
              <span className="module-tag">DETAILS</span>
              <span className="module-value">
                {entry ? entry.word : "--"}
                {isLoadingEntry && <span className="loading-dot" aria-hidden="true" />}
              </span>
            </div>

            {error ? (
              <div className="state-card error">{error}</div>
            ) : isLoadingEntry ? (
              <div className="detail-skeleton" aria-hidden="true">
                <div className="skeleton-line skeleton-title" />
                <div className="skeleton-line skeleton-tag" />
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
              </div>
            ) : !entry ? (
              hasSearchText ? (
                <div className="state-card">no matches for {trimmedQuery}</div>
              ) : (
                <div className="empty-detail">
                  <span className="bracket">[</span> awaiting query <span className="bracket">]</span>
                </div>
              )
            ) : (
              <>
                <div className="detail-preview top">
                  <article className="feed-card static">
                    <div className="entry-header">
                      <h2>{entry.word}</h2>
                      <div className="pos-list">
                        {entry.pos.map((part) => (
                          <span key={`${entry.word}-preview-${part}`} className="pos-tag">
                            {part}
                          </span>
                        ))}
                      </div>
                    </div>

                    <p className="top-definition">{entry.definitions[0] ?? "definition unavailable"}</p>

                    {entry.examples.length > 0 && (
                      <blockquote className="example">“{entry.examples[0]}”</blockquote>
                    )}
                  </article>
                </div>

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
              </>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

export default App;
