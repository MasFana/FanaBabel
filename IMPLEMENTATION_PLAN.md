# FanaBabel Implementation Plan

## 1. Project Status and Assumptions

This repository currently contains a Tauri + React + TypeScript starter app, not a working FanaBabel implementation.

Current state:

- [FanaBabel/app/src/App.tsx](FanaBabel/app/src/App.tsx) is the default greeting demo and uses `greet()`.
- [FanaBabel/app/src/App.css](FanaBabel/app/src/App.css) is the default starter styling.
- [FanaBabel/app/src-tauri/src/lib.rs](FanaBabel/app/src-tauri/src/lib.rs) registers only a single `greet` command.
- [FanaBabel/app/src-tauri/Cargo.toml](FanaBabel/app/src-tauri/Cargo.toml) has only the default Tauri dependencies.
- No dictionary data, SQLite schema, history store, trie/FST resource, data pipeline, or tests exist yet.
- The root-level C++ and HTML files are unrelated exercises and should remain out of scope.

The authoritative product definition is [FanaBabel/PROJECT.md](FanaBabel/PROJECT.md), which describes an offline vocabulary lookup app for a literature reader. The plan below follows that design and keeps the existing Tauri stack intact.

---

## 2. Target Architecture

### 2.1 Runtime architecture

FanaBabel should use:

- Tauri 2 for the desktop shell
- React + TypeScript for the frontend
- Rust for the backend
- SQLite for the bundled dictionary data and local history database
- An in-memory trie or FST for autocomplete
- A fuzzy fallback only on the no-results path

### 2.2 Separation of concerns

The system must separate:

- bundled read-only dictionary content from
- writable user history state

This is required because:

- the dictionary is shipped with the app and should not be modified at runtime
- the history should persist under the OS app-data directory and survive updates/reinstalls

### 2.3 Core modules

Planned backend ownership:

- `db`: dictionary queries and row-to-model mapping
- `history`: history database setup and recent lookup queries
- `trie` or `fst`: prefix autocomplete and bounded suggestion retrieval
- `commands`: Tauri IPC handlers
- `models`: shared typed payloads for frontend/backend communication

---

## 3. Implementation Plan

### Phase 1: Define the contract and fixture data

Goal: create a stable backend contract before UI work begins.

Tasks:

1. Define typed models for:
   - `WordEntry`
   - `HistoryItem`
   - autocomplete results
   - error states if needed
2. Define normalized lookup behavior for input sanitization and consistent case handling.
3. Create a minimal SQLite schema matching the design in [FanaBabel/PROJECT.md](FanaBabel/PROJECT.md):
   - `words`
   - `definitions`
   - `examples`
   - `synonyms`
   - `history`
4. Add a deterministic fixture dictionary with a handful of known words and representative entries.
5. Add tests for:
   - normalization
   - exact entry lookup
   - row mapping
   - history ordering/limits
   - empty and missing results

Acceptance criteria:

- The backend can query fixture entries offline.
- The contract is stable before frontend integration.
- The app can be developed without downloading large licensed dictionaries.

---

### Phase 2: Build the backend vertical slice

Goal: make the Rust side service the app offline through Tauri commands.

Tasks:

1. Add dependencies in [FanaBabel/app/src-tauri/Cargo.toml](FanaBabel/app/src-tauri/Cargo.toml):
   - `rusqlite`
   - `fst` or a trie implementation
   - `strsim` or equivalent fuzzy matcher
   - `serde` support already in place
2. Implement startup initialization in [FanaBabel/app/src-tauri/src/lib.rs](FanaBabel/app/src-tauri/src/lib.rs):
   - load trie/FST once at startup
   - open the bundled dictionary database read-only
   - open or create a writable history database in Tauri app-data
3. Expose these IPC commands:
   - `autocomplete(prefix, limit)`
   - `get_entry(word)`
   - `log_history(word)`
   - `get_history(limit)`
   - `fuzzy_search(query, limit)`
4. Keep all input validation bounded and parameterized so no query strings are built by hand.
5. Ensure fuzzy search is not called on every keystroke; it only runs on the no-results path.

Acceptance criteria:

- A fixture search returns suggestions and entries correctly.
- The app works with no internet connection.
- Autocomplete is served from memory and not SQLite.
- History persists outside the bundled resource directory.

---

### Phase 3: Replace the frontend starter UI

Goal: convert the current demo into the actual search-and-preview experience.

Tasks:

1. Replace the dummy greeting UI in [FanaBabel/app/src/App.tsx](FanaBabel/app/src/App.tsx).
2. Build the product flow:
   - user types into the search box
   - a debounced call to `autocomplete()` fires
   - suggestions appear in a dropdown
   - selected suggestion drives a preview card
   - Enter/click confirms lookup and loads full details
3. Add keyboard behavior:
   - ArrowUp / ArrowDown selection
   - Enter to confirm
   - Escape to dismiss suggestions
4. Add layout states:
   - empty state
   - loading state
   - error state
   - no-result state
5. Add preview area that keeps stable vertical space so the layout does not jump as the user types.
6. Replace starter styling in [FanaBabel/app/src/App.css](FanaBabel/app/src/App.css) with a clean reading-focused layout.

Acceptance criteria:

- A user can type a word, see suggestions, preview it, and inspect details.
- The UI is keyboard-friendly and visually stable.
- The Tauri “greet” demo is fully removed.

---

### Phase 4: History and persistence UX

Goal: deliver a local lookup history mechanism that matches the product description.

Tasks:

1. Query and display recent searches on startup.
2. Refresh history after a confirmed lookup.
3. Let users click a past word to re-load it.
4. Keep the history database in the OS app-data directory instead of bundled resources.
5. Add empty-history and database-error handling.

Acceptance criteria:

- Searches persist across app restarts.
- History is distinct from the read-only dictionary.
- History can be re-used as a lookup shortcut.

---

### Phase 5: Fuzzy fallback and interaction polish

Goal: handle spelling mistakes and edge cases gracefully.

Tasks:

1. Add a fuzzy lookup stage triggered only after prefix lookup returns zero results.
2. Use Levenshtein-based or similar nearest-match search over a bounded word list.
3. Keep fuzzy fallback limited to a small number of results and a bounded search set.
4. Normalize input before matching to prevent avoidable misses.
5. Fine-tune keyboard interaction, suggestions, and empty states.

Acceptance criteria:

- Rare typos still produce useful suggestions.
- User interface does not degrade under repeated keystrokes.
- Fuzzy match logic remains off the main autocomplete path.

---

### Phase 6: Data pipeline and licensing work

Goal: build the dictionary source pipeline in a reproducible, reviewable way.

Tasks:

1. Create a build-time pipeline under `FanaBabel/data-pipeline`.
2. Source data:
   - Open English WordNet
   - Kaikki.org Wiktextract raw dump
3. Parse and merge the sources into a single dictionary dataset.
4. Normalize fields:
   - word
   - POS
   - definition
   - synonym
   - example
   - duplicate handling
5. Generate:
   - `dictionary.sqlite`
   - a sorted word list or FST input
6. Document:
   - source URLs
   - licensing terms
   - attribution requirements
   - transformation steps
   - bundle-size considerations

Acceptance criteria:

- The generated dictionary can be reproduced from documented inputs.
- The app’s dictionary is built from a clear and auditable process.
- Large generated data is not committed without explicit policy review.

---

### Phase 7: Packaging and verification

Goal: confirm the app is actually buildable and behaves correctly in a packaged desktop setup.

Tasks:

1. Add resource declarations in [FanaBabel/app/src-tauri/tauri.conf.json](FanaBabel/app/src-tauri/tauri.conf.json) for bundled dictionary assets.
2. Verify resource lookup works in dev and packaged Windows builds.
3. Run front-end checks and Rust tests.
4. Verify offline startup.
5. Verify history path and persistence behavior.
6. Measure startup time, suggestion latency, preview latency, and memory usage.
7. Update [FanaBabel/app/README.md](FanaBabel/app/README.md) with setup and build instructions.

Acceptance criteria:

- The packaged app starts without network access.
- Dictionary resources are bundled correctly.
- History persists under app-data storage.
- Benchmarks match or explain deviations from the target budgets.

---

## 4. Recommended Delivery Order

This is the safest sequence:

1. Domain models and fixture schema
2. Rust data layer and tests
3. Tauri command layer and startup state
4. Frontend search and preview
5. History database and history UI
6. Fuzzy fallback and interaction polish
7. Data pipeline and source licensing documentation
8. Resource packaging and performance verification

This order keeps the project buildable and reduces risk from the largest unknowns: dictionary generation and resource bundling.

---

## 5. Testing Strategy

Use small deterministic tests during early implementation:

- normalization tests
- database schema tests
- exact lookup tests
- fallback / no-match tests
- history ordering tests
- IPC validation tests

Use a small fixture dictionary before introducing the full licensed data set.

---

## 6. Performance Strategy

The project specification expects the following rough targets:

- keystroke to suggestions under 20 ms
- selection to preview under 20 ms
- cold start roughly 1-2 seconds

Implementation rule:

- do not claim these targets are met without measuring them
- treat FST/trie preloading and bounded result sets as the main optimization path
- keep fuzzy matching out of the hot path

---

## 7. Key Risks

1. Dictionary bundle size and licensing risk

   - The data source decisions must be clear before large generated files are added.

2. Tauri resource path differences

   - A dev build and a packaged build often resolve resources differently.

3. UI/backend contract drift

   - The frontend and Rust payload shapes must be pinned early.

4. Fuzzy search blocking responsiveness

   - A full-dictionary scan should never run on every keystroke.

5. Writable history being placed in the wrong directory
   - History must live under app data, not in the bundled dictionary directory.

---

## 8. Cheapest Next Step

The minimum sensible next step is:

- define the SQLite schema and fixture data
- implement Rust tests around that schema
- wire the first basic command contract for lookup and autocomplete

That is the quickest path to a real product checkpoint without prematurely committing to the full dictionary data pipeline.
