---
name: fanababel-rust-tauri
description: "Use when building, debugging, or extending the FanaBabel Rust/Tauri desktop app: backend commands, SQLite dictionary/history design, Tauri IPC contracts, offline lookup flow, React frontend integration, and validation for performance and architecture constraints."
---

# FanaBabel Rust + Tauri Workflow

## When to use this skill

Use this skill for work in the FanaBabel app when the task involves:

- Rust backend code in the Tauri app
- Tauri command definitions and IPC payloads
- SQLite dictionary or history design
- offline lookup architecture and startup initialization
- autocomplete, preview, and history flows between React and Rust
- performance constraints for low-latency typed search
- bug fixes or implementation work that must respect the project’s architecture

## Core principles

1. Keep the product definition authoritative: this app is an offline vocabulary lookup tool, not a generic demo.
2. Separate read-only bundled dictionary data from writable user history state.
3. Put autocomplete on the fast path: prefix matching from memory, not SQLite.
4. Keep IPC contracts explicit and stable before UI work starts.
5. Validate with the smallest Rust and app build checks that prove the behavior.
6. Preserve the offline, local-first design even when debugging or adding features.

## Workflow

### 1. Confirm the exact product constraint

Before changing code, confirm which layer is affected:

- dictionary data layer
- history persistence layer
- Tauri command layer
- frontend search UX
- performance path for keystroke autocomplete

If the request touches search latency or local-only behavior, verify the design still matches the project architecture in the product document.

### 2. Define the contract first

For new or changed functionality, define the typed contract before implementing UI logic:

- request and response shapes for Rust/Tauri commands
- normalization rules for case and input sanitization
- result ordering and empty-state behavior
- acceptance criteria for autocomplete, entry lookup, and history actions

For this project, the expected contract includes:

- `autocomplete(prefix, limit)`
- `get_entry(word)`
- `log_history(word)`
- `get_history(limit)`
- `fuzzy_search(query, limit)`

Prefer strongly typed payloads and parameterized queries over string-building or ad hoc SQL.

### 3. Build the backend structure around the data model

Implement the app in layers, keeping responsibilities separated:

- `db` for dictionary queries and row mapping
- `history` for app-data history setup and persistence
- `trie` or `fst` for in-memory prefix matching
- `commands` for Tauri IPC handlers
- `models` for shared request and response payloads

Important project-specific decisions:

- the dictionary database is bundled/read-only
- the history database is writable and stored in OS app-data
- trie/FST should be loaded once at startup instead of rebuilt per keystroke
- fuzzy matching should only be used on the no-results path

### 4. Implement startup and initialization carefully

When adding backend setup:

- open the bundled dictionary database read-only
- open or create the writable history database under the OS app-data location
- initialize the in-memory autocomplete structure once at startup
- keep all file access bounded and explicit

Do not mix writable runtime history with the bundled dictionary directory.

### 5. Add the minimal tests that prove the contract

Before or alongside UI work, add focused tests for:

- normalization and input handling
- exact word lookup
- row mapping from SQLite to Rust models
- ordering and limits for history entries
- empty and missing-result behavior

A good test is one that proves a real contract, not a mock-only behavior.

### 6. Integrate with the frontend after the backend contract is stable

Once the backend is in place, wire the React UI to the Tauri commands:

- type into the search bar
- debounced `autocomplete()` call
- render suggestions from the prefix results
- preview selected word details
- enter/click to confirm and log history
- refresh history view after confirmed lookup

Keep the UI behavior aligned with project requirements:

- arrow-key selection
- escape to dismiss suggestions
- stable preview area so layout does not jump
- empty/loading/error/no-result states

### 7. Keep the performance profile honest

For this project, avoid designs that silently violate the core goals:

- never query SQLite for every keystroke
- never store history in bundled resources
- avoid large full-table scans on the main path
- keep fuzzy matching off the hot path unless prefix lookup fails

If a solution adds latency or complexity, it should be justified by a clear product benefit.

### 8. Validate before claiming the task is done

Use the smallest real verification that checks the changed behavior:

- `cargo test --quiet` for Rust logic and backend contract checks
- `pnpm run build` or the equivalent frontend build check for TypeScript/Vite integration
- manual app validation for the actual offline lookup and history flow when needed

A task is only complete when the contract, architecture, and UI remain consistent with the product definition.

## Completion checklist

Use this before finishing any Rust/Tauri task in this project:

- [ ] Product constraint is still consistent with offline lookup and local-first behavior
- [ ] Dictionary and history storage are separated correctly
- [ ] Autocomplete remains memory-first and not SQLite-driven
- [ ] Tauri commands and payloads are explicit and stable
- [ ] Empty, error, and no-result states are handled
- [ ] History persists outside the bundled app resources
- [ ] Relevant Rust tests/build checks pass
- [ ] Frontend integration is consistent with the intended product flow

## Example prompts to invoke this skill

- “Add a Rust Tauri command for history persistence in FanaBabel and keep it separate from the dictionary DB.”
- “Implement the backend contract for autocomplete and entry lookup in the offline dictionary app.”
- “Debug why the search UX is slow and ensure the typing path does not hit SQLite.”
- “Wire the React UI to the Tauri backend while keeping the app offline-first and keyboard-friendly.”
- “Add the minimal SQLite schema and test cases for the FanaBabel dictionary/history data model.”

## Related customizations to create next

- A more specific skill for the FanaBabel data pipeline and dictionary generation work
- A frontend integration skill focused on React + Tauri IPC and UX polish
- A testing skill for Rust/Tauri backend verification and validation steps
- An instruction file for repository-wide architecture rules in the Tauri app
