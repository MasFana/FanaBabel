# FanaBabel — Offline Vocabulary Lookup App
### Design Document 

---

## 1. Purpose & Goals

A desktop app for a non-native English reader working through English literature. When an unfamiliar word appears, the reader should be able to look it up almost instantly, see its meaning, synonyms, part of speech and an example sentence, and build up a personal search history over time — **entirely offline**.

**Core goals**
- Autocomplete as fast as a browser search bar (sub-50ms perceived latency, ideally sub-10ms).
- Works with zero internet connection after initial setup.
- Shows a compact definition + synonym summary directly under the search bar — no extra click needed for the common case.
- Keeps a searchable history of past lookups.

**Non-goals (v1)**
- No spaced-repetition/flashcard system (can be a v2 feature).
- No handwriting/OCR input from scanned book pages.
- No cloud sync between devices.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Tauri Application                     │
│                                                            │
│   ┌────────────────────┐        ┌────────────────────┐   │
│   │   Frontend (WebView) │◄─────►│   Rust Backend Core  │   │
│   │  React/Svelte + CSS │  IPC  │                      │   │
│   │  - Search bar        │       │  - Trie (in-memory)  │   │
│   │  - Suggestion list    │       │  - SQLite (rusqlite) │   │
│   │  - Preview card       │       │  - History writer     │   │
│   │  - History panel      │       │  - Fuzzy fallback     │   │
│   └────────────────────┘        └──────────┬─────────┘   │
│                                              │             │
│                                    ┌─────────▼─────────┐   │
│                                    │  dictionary.sqlite │   │
│                                    │  (bundled, ~150-   │   │
│                                    │   300MB read-only) │   │
│                                    └────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**Why Tauri specifically:**
- Rust backend gives you a real in-memory Trie with predictable, fast performance — no V8/Node overhead sitting between keystrokes and the data structure.
- Small binary size and low idle memory compared to Electron — matters since you're also bundling a sizeable dictionary file.
- The WebView frontend still lets you build the UI in React/Svelte/plain HTML, so UI iteration stays fast.

---

## 3. Data Pipeline (build-time, not runtime)

This runs **once**, before you ship the app, to produce the offline database. It is not part of the running app.

### 3.1 Sources
| Source | Role | License |
|---|---|---|
| Open English WordNet (`github.com/globalwordnet/english-wordnet`) | Synonym rings (synsets), POS, short glosses | CC-BY 4.0 |
| Kaikki.org Wiktextract raw dump (`kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz`) | Full definitions, usage examples, rare/literary/archaic words | CC-BY-SA / GFDL (Wiktionary) |

### 3.2 Pipeline steps
1. Download both sources.
2. Parse Wiktextract JSONL (one JSON object per line) — pull `word`, `pos`, `senses[].glosses`, `senses[].examples`.
3. Parse WordNet dump — pull `synset -> lemma members` to build a synonym lookup per (word, pos).
4. Merge on `(word, pos)`: attach WordNet synonyms to the corresponding Wiktionary entry; where a word exists only in one source, keep what's available.
5. Write everything into a single SQLite file, `dictionary.sqlite` (schema in section 4).
6. Also export a flat sorted word list (`words.txt`) used to build the Trie at first run (or pre-serialize the Trie itself — see 5.3).
7. Run this pipeline as a Python or Rust script; it's a one-time/occasional (re-run on dictionary updates) offline job, not shipped as source in the app bundle — only its output (`dictionary.sqlite`) is bundled.

---

## 4. Database Schema (SQLite)

```sql
CREATE TABLE words (
    id          INTEGER PRIMARY KEY,
    word        TEXT NOT NULL,
    pos         TEXT,                 -- 'noun', 'verb', 'adj', etc.
    UNIQUE(word, pos)
);
CREATE INDEX idx_words_word ON words(word);

CREATE TABLE definitions (
    id          INTEGER PRIMARY KEY,
    word_id     INTEGER NOT NULL REFERENCES words(id),
    definition  TEXT NOT NULL,
    sort_order  INTEGER DEFAULT 0
);
CREATE INDEX idx_definitions_word_id ON definitions(word_id);

CREATE TABLE examples (
    id          INTEGER PRIMARY KEY,
    word_id     INTEGER NOT NULL REFERENCES words(id),
    example     TEXT NOT NULL
);
CREATE INDEX idx_examples_word_id ON examples(word_id);

CREATE TABLE synonyms (
    id          INTEGER PRIMARY KEY,
    word_id     INTEGER NOT NULL REFERENCES words(id),
    synonym     TEXT NOT NULL
);
CREATE INDEX idx_synonyms_word_id ON synonyms(word_id);

CREATE TABLE history (
    id           INTEGER PRIMARY KEY,
    word         TEXT NOT NULL,
    searched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_history_searched_at ON history(searched_at DESC);
```

`words`/`definitions`/`examples`/`synonyms` are shipped read-only inside the app bundle. `history` is the only table the running app writes to, stored in the app's local data directory (not inside the bundled read-only file — see 5.4).

---

## 5. Backend Design (Rust / Tauri core)

### 5.1 Two-layer lookup strategy

| Layer | Data structure | Used for | Latency target |
|---|---|---|---|
| Autocomplete | In-memory **Trie** (or `fst` crate for a compressed sorted-set) | Prefix matching as the user types | < 5ms |
| Full entry | SQLite indexed query | Fetching definitions/synonyms/examples once a word is selected | < 15ms |

Keystrokes never touch SQLite directly — only the Trie. SQLite is only queried once per confirmed selection, which is cheap because `word` is indexed.

### 5.2 Trie implementation options
- `fst` crate (Rust) — builds a minimal finite-state transducer over a sorted word list; extremely memory-efficient (a few MB for 300k+ words) and supports fast prefix range queries. Recommended.
- Hand-rolled `Trie<char, Vec<WordId>>` — simpler to reason about, fine at this scale (~200-500k words), slightly more memory.

Either is loaded once at app startup from `words.txt`/`words.fst` bundled alongside `dictionary.sqlite`.

### 5.3 Startup sequence
1. App launches → Rust backend loads the pre-built Trie/FST into memory (from a small bundled file, not rebuilt from SQLite every launch).
2. Opens a read-only connection to the bundled `dictionary.sqlite`.
3. Opens/creates the writable `history.sqlite` in the OS app-data directory.
4. Frontend requests are now servable.

### 5.4 File locations
- `dictionary.sqlite`, `words.fst` → bundled inside the app resources (read-only, reinstall-safe).
- `history.sqlite` → `~/.local/share/worddive/` (Linux), `%APPDATA%\WordDive\` (Windows), `~/Library/Application Support/WordDive/` (macOS) — via Tauri's `app_data_dir()` API. Kept separate so uninstall/reinstall doesn't wipe history, and updates to the dictionary don't touch it.

### 5.5 Tauri commands (IPC surface)

```rust
#[tauri::command]
fn autocomplete(prefix: String, limit: usize) -> Vec<String>

#[tauri::command]
fn get_entry(word: String) -> Option<WordEntry>   // definitions, synonyms, examples, pos

#[tauri::command]
fn log_history(word: String) -> ()

#[tauri::command]
fn get_history(limit: usize) -> Vec<HistoryItem>

#[tauri::command]
fn fuzzy_search(query: String, limit: usize) -> Vec<String>  // fallback for typos, edit-distance based
```

`WordEntry`:
```rust
struct WordEntry {
    word: String,
    pos: Vec<String>,
    definitions: Vec<String>,
    synonyms: Vec<String>,
    examples: Vec<String>,
}
```

### 5.6 Fuzzy fallback
If the Trie returns zero prefix matches (likely typo, since literary text sometimes has unusual spellings), fall back to a Levenshtein-distance search (`strsim` crate) over the word list, returning the closest 5 matches. This runs only on the "no results" path, so it doesn't need to be as fast as the Trie.

---

## 6. Frontend Design

### 6.1 Component tree
```
<App>
 ├── <SearchBar>            -- input, debounced onChange → autocomplete()
 │     └── <SuggestionList>  -- dropdown, arrow-key navigable
 ├── <PreviewCard>           -- live preview of highlighted/selected suggestion
 │     ├── word + pos tag
 │     ├── top definition (1 line)
 │     ├── synonym chips (max ~6, "show more" if truncated)
 │     └── example sentence
 ├── <DetailView>            -- optional expanded view: all definitions, all synonyms, all examples
 └── <HistoryPanel>          -- recent searches, click to re-look-up
```

### 6.2 Interaction flow
1. User types in `<SearchBar>`. On each keystroke (debounced ~30-50ms, mostly to avoid redundant IPC calls on very fast typing, since the Trie itself is near-instant), call `autocomplete(prefix)`.
2. `<SuggestionList>` renders up to ~8 results.
3. As the user arrows through suggestions (or the top suggestion is implicitly highlighted), call `get_entry(word)` and render `<PreviewCard>` live underneath the bar — this is the "brief summary at the bottom of the search bar" you asked for.
4. On Enter / click: `log_history(word)` fires, and `<DetailView>` can expand with the full entry if the user wants more than the preview.
5. `<HistoryPanel>` calls `get_history()` on app load and after each `log_history` call.

### 6.3 UI notes
- Keep the preview card always reserving its vertical space (even when empty) so the layout doesn't jump as you type — important for a "feels like Google" experience.
- Debounce is small and mostly protective; the real speed comes from the Trie, not from throttling.
- Highlight the matched prefix portion of each suggestion (bold the typed letters) — small touch, big perceived-speed effect.

---

## 7. Performance Budget

| Action | Target | Why achievable |
|---|---|---|
| Keystroke → suggestions rendered | < 20ms | In-memory Trie/FST lookup + minimal IPC serialization of ≤8 short strings |
| Suggestion highlighted → preview shown | < 20ms | Single indexed SQLite `SELECT ... WHERE word = ?` |
| Cold app start → ready to search | < 1-2s | One-time Trie/FST deserialization (a few MB) + opening two SQLite connections |

---

## 8. Project Structure

```
worddive/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── trie.rs           (or fst wrapper)
│   │   ├── db.rs              (rusqlite queries)
│   │   ├── history.rs
│   │   └── commands.rs        (#[tauri::command] handlers)
│   ├── resources/
│   │   ├── dictionary.sqlite
│   │   └── words.fst
│   └── tauri.conf.json
├── src/                        (frontend: React/Svelte)
│   ├── components/
│   │   ├── SearchBar.tsx
│   │   ├── SuggestionList.tsx
│   │   ├── PreviewCard.tsx
│   │   ├── DetailView.tsx
│   │   └── HistoryPanel.tsx
│   └── App.tsx
├── data-pipeline/              (build-time only, not shipped)
│   ├── fetch_sources.py
│   ├── merge_wordnet_wiktionary.py
│   └── build_sqlite.py
└── README.md
```

---

## 9. Build & Ship Considerations

- **Bundle size**: the merged dictionary can be trimmed — you likely don't need every inflected form or every ultra-rare Wiktionary sense for "reading literature" use. Consider filtering to a curated word-frequency threshold plus anything tagged `literary`/`archaic`/`dated` in Wiktionary (useful for older novels), which keeps the file leaner without losing the words you actually need.
- **Updates**: since the dictionary is static and bundled, updating vocabulary data means shipping a new `dictionary.sqlite`/`words.fst` with an app update — history stays intact because it lives in a separate file (5.4).
- **Cross-platform**: Tauri handles Windows/macOS/Linux bundling; `rusqlite` and `fst` are pure-Rust/portable, so no platform-specific build headaches expected.

---

## 10. Suggested Build Order

1. Data pipeline: download sources → merge → produce `dictionary.sqlite` + `words.fst`. Verify with a few dozen known words.
2. Rust backend: load Trie, wire up `autocomplete` and `get_entry` commands, test via `tauri dev` console before touching UI.
3. Minimal frontend: search bar + suggestion list + preview card, wired to the two commands above.
4. Add history logging + history panel.
5. Add fuzzy fallback for no-match cases.
6. Polish: keyboard navigation, prefix highlighting, empty-state layout stability.