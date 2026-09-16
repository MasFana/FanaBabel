#!/usr/bin/env python3
"""Build FanaBabel's offline dictionary from Wiktextract and WordNet inputs."""

from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import sqlite3
import tempfile
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Iterator

POS_MAP = {
    "n": "noun",
    "v": "verb",
    "a": "adj",
    "s": "adj",
    "r": "adv",
    "noun": "noun",
    "verb": "verb",
    "adj": "adj",
    "adjective": "adj",
    "adv": "adv",
    "adverb": "adv",
}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE words (
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    pos TEXT,
    UNIQUE(word, pos)
);
CREATE INDEX idx_words_word ON words(word);
CREATE TABLE definitions (
    id INTEGER PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    definition TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_definitions_word_id ON definitions(word_id, sort_order);
CREATE TABLE examples (
    id INTEGER PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    example TEXT NOT NULL
);
CREATE INDEX idx_examples_word_id ON examples(word_id, id);
CREATE TABLE synonyms (
    id INTEGER PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    synonym TEXT NOT NULL
);
CREATE INDEX idx_synonyms_word_id ON synonyms(word_id, id);
CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    word TEXT NOT NULL,
    searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_history_searched_at ON history(searched_at DESC);
CREATE TABLE pipeline_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def normalize_word(value: str) -> str:
    return "".join(character.lower() for character in value.strip() if character.isascii() and character.isalnum())


def normalize_pos(value: str | None) -> str:
    return POS_MAP.get((value or "").lower(), (value or "").lower())


def clean_text(value: str) -> str:
    return re.sub(r"\\s+", " ", value).strip()


def add_unique(items: list[str], value: str) -> None:
    value = clean_text(value)
    if value and value not in items:
        items.append(value)


def open_text(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def parse_wiktextract(path: Path) -> dict[tuple[str, str], dict[str, list[str]]]:
    entries: dict[tuple[str, str], dict[str, list[str]]] = {}
    with open_text(path) as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON on line {line_number} of {path}: {error}") from error

            if not isinstance(record, dict):
                continue

            if record.get("lang_code") not in (None, "en") and record.get("lang") not in (None, "English"):
                continue

            word = normalize_word(str(record.get("word", "")))
            if not word:
                continue

            pos = normalize_pos(record.get("pos"))
            if not pos:
                continue

            key = (word, pos)
            entry = entries.setdefault(key, {"definitions": [], "examples": [], "synonyms": []})
            for sense in record.get("senses", []):
                if not isinstance(sense, dict):
                    continue
                for definition in sense.get("glosses", []):
                    if isinstance(definition, str):
                        add_unique(entry["definitions"], definition)
                for example in sense.get("examples", []):
                    if isinstance(example, str):
                        add_unique(entry["examples"], example)
                    elif isinstance(example, dict):
                        text = example.get("text") or example.get("example")
                        if isinstance(text, str):
                            add_unique(entry["examples"], text)
    return entries


def wordnet_files(path: Path) -> Iterator[Path]:
    if path.is_file():
        yield path
        return
    for filename in ("data.noun", "data.verb", "data.adj", "data.adv"):
        candidate = path / filename
        if candidate.exists():
            yield candidate


def parse_wordnet(path: Path) -> dict[tuple[str, str], set[str]]:
    synonyms: dict[tuple[str, str], set[str]] = defaultdict(set)
    for source_path in wordnet_files(path):
        with source_path.open("r", encoding="utf-8") as source:
            for line in source:
                line = line.strip()
                if not line or line.startswith(" ") or line.startswith("#"):
                    continue
                data, _, _gloss = line.partition(" | ")
                fields = data.split()
                if len(fields) < 5 or fields[2] not in POS_MAP:
                    continue
                pos = normalize_pos(fields[2])
                try:
                    lemma_count = int(fields[3], 16)
                except ValueError:
                    continue
                lemmas = [normalize_word(fields[4 + index * 2].replace("_", " ")) for index in range(lemma_count)]
                lemmas = [lemma for lemma in lemmas if lemma]
                for lemma in lemmas:
                    synonyms[(lemma, pos)].update(other for other in lemmas if other != lemma)
    return synonyms


def merge_sources(wiktionary: dict, wordnet: dict | None) -> dict[tuple[str, str], dict[str, list[str]]]:
    merged = {key: {field: list(values) for field, values in value.items()} for key, value in wiktionary.items()}
    for key, values in (wordnet or {}).items():
        entry = merged.setdefault(key, {"definitions": [], "examples": [], "synonyms": []})
        for synonym in sorted(values):
            add_unique(entry["synonyms"], synonym)
    return merged


def download_file(url: str, destination: Path, timeout: float = 15) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=timeout) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def prepare_wiktextract_source(url: str | None, local_path: Path | None) -> Path:
    if local_path is not None:
        return local_path
    if not url:
        raise ValueError("A Wiktextract source path or URL is required")

    temp_dir = Path(tempfile.mkdtemp(prefix="fanababel-wiktextract-"))
    destination = temp_dir / "wiktextract.jsonl.gz"
    download_file(url, destination)
    return destination


def write_database(entries: dict, output: Path, word_list: Path, metadata: dict[str, str]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    word_list.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    with sqlite3.connect(output) as connection:
        connection.executescript(SCHEMA)
        for (word, pos), entry in sorted(entries.items()):
            cursor = connection.execute("INSERT INTO words (word, pos) VALUES (?, ?)", (word, pos or None))
            word_id = cursor.lastrowid
            connection.executemany(
                "INSERT INTO definitions (word_id, definition, sort_order) VALUES (?, ?, ?)",
                ((word_id, definition, index) for index, definition in enumerate(entry["definitions"])),
            )
            connection.executemany("INSERT INTO examples (word_id, example) VALUES (?, ?)", ((word_id, example) for example in entry["examples"]))
            connection.executemany("INSERT INTO synonyms (word_id, synonym) VALUES (?, ?)", ((word_id, synonym) for synonym in entry["synonyms"]))
        connection.executemany("INSERT INTO pipeline_metadata (key, value) VALUES (?, ?)", sorted(metadata.items()))
    word_list.write_text("".join(f"{word}\n" for word in sorted({word for word, _ in entries})), encoding="utf-8")


def build(wiktionary: Path, wordnet: Path | None, output: Path, word_list: Path) -> None:
    wiktionary_entries = parse_wiktextract(wiktionary)
    wordnet_entries = parse_wordnet(wordnet) if wordnet else {}
    entries = merge_sources(wiktionary_entries, wordnet_entries if wordnet else None)
    metadata = {
        "pipeline_version": "2",
        "source_kind": "wiktextract-jsonl",
        "wiktextract_source": str(wiktionary),
        "wordnet_source": str(wordnet) if wordnet else "unused",
        "entry_count": str(len(entries)),
        "word_count": str(len({word for word, _ in entries})),
    }
    write_database(entries, output, word_list, metadata)
    print(f"Built {output} with {len(entries)} word/POS entries and {metadata['word_count']} words")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiktionary", type=Path, help="Kaikki Wiktextract JSONL or JSONL.GZ input")
    parser.add_argument("--wiktionary-url", help="Remote Kaikki Wiktextract JSONL.GZ URL used when --wiktionary is absent")
    parser.add_argument("--wordnet", type=Path, help="Deprecated; ignored. This project uses Wiktextract only.")
    parser.add_argument("--wordnet-url", help="Deprecated; ignored. This project uses Wiktextract only.")
    parser.add_argument("--output", type=Path, required=True, help="Output dictionary.sqlite")
    parser.add_argument("--word-list", type=Path, required=True, help="Output sorted words.txt")
    args = parser.parse_args()

    wiktionary_path = args.wiktionary
    if wiktionary_path is None:
        wiktionary_path = prepare_wiktextract_source(args.wiktionary_url, None)

    build(wiktionary_path, None, args.output, args.word_list)


if __name__ == "__main__":
    main()
