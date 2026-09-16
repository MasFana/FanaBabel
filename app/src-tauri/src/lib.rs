mod generated_dictionary;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordEntry {
    pub word: String,
    pub pos: Vec<String>,
    pub definitions: Vec<String>,
    pub synonyms: Vec<String>,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryItem {
    pub word: String,
    pub searched_at: String,
}

pub fn normalize_word(input: &str) -> String {
    let mut buffer = String::new();
    for ch in input.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            buffer.push(ch.to_ascii_lowercase());
        }
    }
    buffer
}

pub struct DictionaryDb {
    conn: Connection,
}

impl DictionaryDb {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            conn: Connection::open(path)?,
        })
    }

    pub fn new_in_memory() -> Result<Self> {
        Ok(Self {
            conn: Connection::open_in_memory()?,
        })
    }

    pub fn table_exists(&self, table_name: &str) -> Result<bool> {
        let query = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1";
        Ok(self
            .conn
            .query_row(query, [table_name], |row| row.get::<_, i32>(0))
            .optional()?
            .is_some())
    }

    pub fn initialize_fixture_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS words (
                id INTEGER PRIMARY KEY,
                word TEXT NOT NULL,
                pos TEXT,
                UNIQUE(word, pos)
            );

            CREATE TABLE IF NOT EXISTS definitions (
                id INTEGER PRIMARY KEY,
                word_id INTEGER NOT NULL,
                definition TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS examples (
                id INTEGER PRIMARY KEY,
                word_id INTEGER NOT NULL,
                example TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS synonyms (
                id INTEGER PRIMARY KEY,
                word_id INTEGER NOT NULL,
                synonym TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY,
                word TEXT NOT NULL,
                searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        self.seed_fixture_data()
    }

    fn seed_fixture_data(&self) -> Result<()> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM words", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(());
        }

        self.conn.execute(
            "INSERT INTO words (word, pos) VALUES (?, ?)",
            ["dawn", "noun"],
        )?;
        self.conn.execute(
            "INSERT INTO words (word, pos) VALUES (?, ?)",
            ["ocean", "noun"],
        )?;
        self.conn.execute(
            "INSERT INTO words (word, pos) VALUES (?, ?)",
            ["lantern", "noun"],
        )?;

        let dawn_id: i64 = self.conn.query_row(
            "SELECT id FROM words WHERE word = ? AND pos = ?",
            ["dawn", "noun"],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
            (dawn_id, "The first appearance of light in the morning.", 0),
        )?;
        self.conn.execute(
            "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
            (dawn_id, "A beginning or early stage.", 1),
        )?;
        self.conn.execute(
            "INSERT INTO synonyms (word_id, synonym) VALUES (?, ?)",
            (dawn_id, "daybreak"),
        )?;
        self.conn.execute(
            "INSERT INTO examples (word_id, example) VALUES (?, ?)",
            (dawn_id, "At dawn, the valley changed from silver to gold."),
        )?;

        let ocean_id: i64 = self.conn.query_row(
            "SELECT id FROM words WHERE word = ? AND pos = ?",
            ["ocean", "noun"],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
            (
                ocean_id,
                "A vast body of salt water covering most of Earth.",
                0,
            ),
        )?;
        self.conn.execute(
            "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
            (ocean_id, "A metaphor for an immense expanse or depth.", 1),
        )?;
        self.conn.execute(
            "INSERT INTO synonyms (word_id, synonym) VALUES (?, ?)",
            (ocean_id, "sea"),
        )?;
        self.conn.execute(
            "INSERT INTO examples (word_id, example) VALUES (?, ?)",
            (ocean_id, "The ocean reflected the moonlit horizon."),
        )?;
        self.conn.execute(
            "INSERT INTO examples (word_id, example) VALUES (?, ?)",
            (
                ocean_id,
                "A feeling of quiet rose like an ocean in her chest.",
            ),
        )?;

        let lantern_id: i64 = self.conn.query_row(
            "SELECT id FROM words WHERE word = ? AND pos = ?",
            ["lantern", "noun"],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
            (lantern_id, "A portable light carried in the hand.", 0),
        )?;
        self.conn.execute(
            "INSERT INTO synonyms (word_id, synonym) VALUES (?, ?)",
            (lantern_id, "lamp"),
        )?;
        self.conn.execute(
            "INSERT INTO examples (word_id, example) VALUES (?, ?)",
            (lantern_id, "The lantern glowed by the gate in the storm."),
        )?;

        Ok(())
    }

    pub fn lookup_word(&self, word: &str) -> Result<Option<WordEntry>> {
        let normalized = normalize_word(word);
        let mut stmt = self.conn.prepare(
            "SELECT w.word, w.pos, d.definition, s.synonym, e.example FROM words w LEFT JOIN definitions d ON d.word_id = w.id LEFT JOIN synonyms s ON s.word_id = w.id LEFT JOIN examples e ON e.word_id = w.id WHERE lower(w.word) = ? ORDER BY w.id, d.sort_order, s.id, e.id",
        )?;

        let rows = stmt.query_map([normalized.clone()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;

        let mut collected = WordEntry {
            word: normalized.clone(),
            pos: Vec::new(),
            definitions: Vec::new(),
            synonyms: Vec::new(),
            examples: Vec::new(),
        };
        let mut found = false;

        for row in rows {
            let (_word_in_db, pos, definition, synonym, example) = row?;
            found = true;
            if let Some(pos) = pos {
                if !collected.pos.contains(&pos) {
                    collected.pos.push(pos);
                }
            }
            if let Some(definition) = definition {
                if !collected.definitions.contains(&definition) {
                    collected.definitions.push(definition);
                }
            }
            if let Some(synonym) = synonym {
                if !collected.synonyms.contains(&synonym) {
                    collected.synonyms.push(synonym);
                }
            }
            if let Some(example) = example {
                if !collected.examples.contains(&example) {
                    collected.examples.push(example);
                }
            }
        }

        if !found {
            return Ok(None);
        }

        Ok(Some(collected))
    }

    pub fn get_all_words(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT word FROM words ORDER BY word")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut words = Vec::new();
        for row in rows {
            words.push(row?);
        }
        Ok(words)
    }

    pub fn log_history(&self, word: &str) -> Result<()> {
        let normalized = normalize_word(word);
        if normalized.is_empty() {
            return Ok(());
        }

        self.conn
            .execute("DELETE FROM history WHERE word = ?", [normalized.as_str()])?;
        self.conn
            .execute("INSERT INTO history (word) VALUES (?)", [normalized])?;
        Ok(())
    }

    pub fn get_history(&self, limit: usize) -> Result<Vec<HistoryItem>> {
        let sql = format!(
            "SELECT word, searched_at FROM history ORDER BY id DESC LIMIT {}",
            limit
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(HistoryItem {
                word: row.get(0)?,
                searched_at: row.get(1)?,
            })
        })?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    pub fn autocomplete(&self, prefix: &str, limit: usize) -> Result<Vec<String>> {
        let normalized = normalize_word(prefix);
        if normalized.is_empty() {
            return Ok(Vec::new());
        }

        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT word FROM words WHERE lower(word) LIKE ?1 ORDER BY word LIMIT ?2",
        )?;

        let pattern = format!("{}%", normalized);
        let rows = stmt.query_map((pattern, limit as i64), |row| row.get(0))?;
        let mut result = Vec::new();
        for entry in rows {
            result.push(entry?);
        }
        Ok(result)
    }

    pub fn fuzzy_search(&self, query: &str, limit: usize) -> Result<Vec<String>> {
        let normalized = normalize_word(query);
        if normalized.is_empty() {
            return Ok(Vec::new());
        }

        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT word FROM words WHERE lower(word) LIKE ?1 ORDER BY word LIMIT ?2",
        )?;

        let pattern = format!("%{}%", normalized);
        let rows = stmt.query_map((pattern, limit as i64), |row| row.get(0))?;
        let mut result = Vec::new();
        for entry in rows {
            result.push(entry?);
        }
        Ok(result)
    }
}

pub struct AppState {
    dictionary: Arc<Mutex<DictionaryDb>>,
    history: Arc<Mutex<Connection>>,
    trie_words: Vec<String>,
}

impl AppState {
    pub fn new(app_data_dir: &Path) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let resource_dir = app_data_dir.join("resources");
        Self::new_with_paths(app_data_dir, &resource_dir)
    }

    pub fn new_with_paths(
        app_data_dir: &Path,
        resource_dir: &Path,
    ) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(app_data_dir)?;
        fs::create_dir_all(resource_dir)?;

        let dictionary_path = resource_dir.join("dictionary.sqlite");
        if !dictionary_path.exists() {
            fs::write(&dictionary_path, generated_dictionary::DICTIONARY_SQLITE)?;
        }

        let dictionary = DictionaryDb::open(&dictionary_path)?;
        if !dictionary.table_exists("words")? {
            dictionary.initialize_fixture_schema()?;
        }

        let history_path = app_data_dir.join("history.sqlite");
        let history = Connection::open(&history_path)?;
        history.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY,
                word TEXT NOT NULL,
                searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        let trie_words = dictionary.get_all_words()?;

        Ok(Self {
            dictionary: Arc::new(Mutex::new(dictionary)),
            history: Arc::new(Mutex::new(history)),
            trie_words,
        })
    }

    pub fn get_entry(&self, word: &str) -> Result<Option<WordEntry>> {
        let dictionary = self.dictionary.lock().unwrap();
        dictionary.lookup_word(word)
    }

    pub fn autocomplete(&self, prefix: &str, limit: usize) -> Result<Vec<String>> {
        let normalized = normalize_word(prefix);
        if normalized.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let mut matches = Vec::new();
        for word in &self.trie_words {
            if word.starts_with(&normalized) {
                matches.push(word.clone());
                if matches.len() >= limit {
                    break;
                }
            }
        }
        Ok(matches)
    }

    pub fn log_history(&self, word: &str) -> Result<()> {
        let normalized = normalize_word(word);
        if normalized.is_empty() {
            return Ok(());
        }

        let history = self.history.lock().unwrap();
        history.execute("DELETE FROM history WHERE word = ?", [normalized.as_str()])?;
        history.execute("INSERT INTO history (word) VALUES (?)", [normalized])?;
        Ok(())
    }

    pub fn get_history(&self, limit: usize) -> Result<Vec<HistoryItem>> {
        let history = self.history.lock().unwrap();
        let sql = format!(
            "SELECT word, searched_at FROM history ORDER BY id DESC LIMIT {}",
            limit
        );
        let mut stmt = history.prepare(&sql)?;
        let rows = stmt.query_map([], |row| {
            Ok(HistoryItem {
                word: row.get(0)?,
                searched_at: row.get(1)?,
            })
        })?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    pub fn fuzzy_search(&self, query: &str, limit: usize) -> Result<Vec<String>> {
        let normalized = normalize_word(query);
        if normalized.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let max_distance = ((normalized.len() as f32 * 0.35).ceil() as usize).max(1);
        let mut scored: Vec<(usize, String)> = self
            .trie_words
            .iter()
            .filter_map(|word| {
                if word == &normalized {
                    return None;
                }

                let distance = strsim::levenshtein(&normalized, word);
                if distance <= max_distance {
                    Some((distance, word.clone()))
                } else {
                    None
                }
            })
            .collect();

        scored.sort_by_key(|(distance, _)| *distance);
        scored.truncate(limit);
        Ok(scored.into_iter().map(|(_, word)| word).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_is_stable_and_case_insensitive() {
        assert_eq!(normalize_word("  Dawn!  "), "dawn");
        assert_eq!(normalize_word("  HALL  "), "hall");
    }

    #[test]
    fn fixture_lookup_returns_exact_entry() {
        let db = DictionaryDb::new_in_memory().unwrap();
        db.initialize_fixture_schema().unwrap();

        let entry = db.lookup_word("Dawn").unwrap().unwrap();
        assert_eq!(entry.word, "dawn");
        assert!(entry
            .definitions
            .iter()
            .any(|d| d.contains("first appearance")));
        assert!(entry.synonyms.contains(&"daybreak".to_string()));
    }

    #[test]
    fn row_mapping_collects_multiple_definitions_examples_and_synonyms() {
        let db = DictionaryDb::new_in_memory().unwrap();
        db.initialize_fixture_schema().unwrap();

        let entry = db.lookup_word("ocean").unwrap().unwrap();
        assert_eq!(entry.pos, vec!["noun".to_string()]);
        assert_eq!(entry.definitions.len(), 2);
        assert_eq!(entry.examples.len(), 2);
        assert!(entry.synonyms.contains(&"sea".to_string()));
    }

    #[test]
    fn history_is_ordered_newest_first_and_limited() {
        let db = DictionaryDb::new_in_memory().unwrap();
        db.initialize_fixture_schema().unwrap();

        db.log_history("dawn").unwrap();
        db.log_history("ocean").unwrap();
        db.log_history("lantern").unwrap();

        let history = db.get_history(2).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].word, "lantern");
        assert_eq!(history[1].word, "ocean");
    }

    #[test]
    fn history_deduplicates_repeated_words_by_latest_lookup() {
        let db = DictionaryDb::new_in_memory().unwrap();
        db.initialize_fixture_schema().unwrap();

        db.log_history("dawn").unwrap();
        db.log_history("ocean").unwrap();
        db.log_history("dawn").unwrap();

        let history = db.get_history(10).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].word, "dawn");
        assert_eq!(history[1].word, "ocean");
    }

    #[test]
    fn missing_word_and_empty_history_are_handled_cleanly() {
        let db = DictionaryDb::new_in_memory().unwrap();
        db.initialize_fixture_schema().unwrap();

        assert!(db.lookup_word("missing").unwrap().is_none());
        let empty = db.get_history(10).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn fuzzy_search_tracks_only_close_spelling_matches() {
        let temp_dir =
            std::env::temp_dir().join(format!("fanababel-fuzzy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let app_state = AppState::new(&temp_dir).unwrap();
        let nearby = app_state.fuzzy_search("dawnn", 3).unwrap();
        assert!(!nearby.is_empty());
        assert!(nearby.contains(&"dawn".to_string()));

        let off_target = app_state.fuzzy_search("zzzzzzzz", 3).unwrap();
        assert!(off_target.is_empty());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn app_state_keeps_dictionary_and_history_separate() {
        let temp_dir =
            std::env::temp_dir().join(format!("fanababel-state-test-{}", std::process::id()));
        let resource_dir = temp_dir.join("resources");
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&resource_dir).unwrap();

        let fixture_path = resource_dir.join("dictionary.sqlite");
        let source_path = temp_dir.join("source-dictionary.sqlite");
        let db = DictionaryDb::open(&source_path).unwrap();
        db.initialize_fixture_schema().unwrap();
        std::fs::copy(&source_path, &fixture_path).unwrap();

        let app_state = AppState::new_with_paths(&temp_dir, &resource_dir).unwrap();
        app_state.log_history("dawn").unwrap();
        app_state.log_history("ocean").unwrap();

        assert!(app_state.get_entry("Dawn").unwrap().is_some());
        let history = app_state.get_history(10).unwrap();
        assert_eq!(history.len(), 2);
        assert!(std::fs::metadata(temp_dir.join("history.sqlite")).is_ok());
        assert!(std::fs::metadata(resource_dir.join("dictionary.sqlite")).is_ok());
        assert!(!std::fs::metadata(temp_dir.join("dictionary.sqlite")).is_ok());

        let reloaded = AppState::new_with_paths(&temp_dir, &resource_dir).unwrap();
        assert_eq!(reloaded.get_history(10).unwrap().len(), 2);
        assert!(reloaded.get_entry("ocean").unwrap().is_some());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

#[tauri::command]
fn autocomplete(
    prefix: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .autocomplete(&prefix, limit)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn get_entry(word: String, state: State<'_, AppState>) -> Result<Option<WordEntry>, String> {
    state.get_entry(&word).map_err(|err| err.to_string())
}

#[tauri::command]
fn log_history(word: String, state: State<'_, AppState>) -> Result<(), String> {
    state.log_history(&word).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_history(limit: usize, state: State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    state.get_history(limit).map_err(|err| err.to_string())
}

#[tauri::command]
fn fuzzy_search(
    query: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    state
        .fuzzy_search(&query, limit)
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
            let resource_path = app
                .path()
                .resolve("dictionary.sqlite", tauri::path::BaseDirectory::Resource)
                .unwrap_or_else(|_| app_data_dir.join("resources").join("dictionary.sqlite"));
            let resource_dir = resource_path
                .parent()
                .unwrap_or(app_data_dir.as_path())
                .to_path_buf();
            let state = AppState::new_with_paths(&app_data_dir, &resource_dir)
                .map_err(|err| err.to_string())?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            autocomplete,
            get_entry,
            log_history,
            get_history,
            fuzzy_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
