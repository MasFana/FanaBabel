# FanaBabel App

This desktop app is a local-first vocabulary lookup tool built with Tauri, React, and Rust. It stores a read-only dictionary bundle in the app resource directory and keeps user search history under the OS app-data directory so the database remains writable without modifying the bundled dictionary.

## Local development

1. Install dependencies:
   - `pnpm install`
2. Start the app in development mode:
   - `pnpm dev:desktop`
3. Or run the frontend only:
   - `pnpm dev`

## Production build

1. Run:
   - `pnpm build`
2. Package the desktop app:
   - `cargo tauri build`

## Packaging model

- Dictionary resource: `src-tauri/resources/dictionary.sqlite`
- History database: OS app-data directory, e.g. `%APPDATA%/com.advan.fanababel/history.sqlite`
- The resource file is declared in `src-tauri/tauri.conf.json` under `bundle.resources` so it is bundled for packaged builds and resolved from the Tauri resource path at runtime.

## Verification

- `cargo test --quiet` checks the Rust backend and fixture dictionary behavior.
- `pnpm build` verifies the Vite/React frontend compiles successfully.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
