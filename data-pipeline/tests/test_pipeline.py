import gzip
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parents[1]))
import pipeline


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.fixture_dir = Path(__file__).parents[1] / "fixtures"
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output = Path(self.temp_dir.name) / "dictionary.sqlite"
        self.word_list = Path(self.temp_dir.name) / "words.txt"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_fixture_build_merges_sources_and_deduplicates(self):
        pipeline.build(
            self.fixture_dir / "wiktextract.jsonl",
            self.fixture_dir / "data.noun",
            self.output,
            self.word_list,
        )

        with sqlite3.connect(self.output) as connection:
            dawn_id = connection.execute(
                "SELECT id FROM words WHERE word = ? AND pos = ?", ("dawn", "noun")
            ).fetchone()[0]
            definitions = connection.execute(
                "SELECT definition FROM definitions WHERE word_id = ? ORDER BY sort_order",
                (dawn_id,),
            ).fetchall()
            synonyms = connection.execute(
                "SELECT synonym FROM synonyms WHERE word_id = ?", (dawn_id,)
            ).fetchall()
            self.assertEqual(len(definitions), 2)
            self.assertEqual(synonyms, [("daybreak",)])
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM pipeline_metadata").fetchone()[0], 5)

        self.assertEqual(self.word_list.read_text(encoding="utf-8").splitlines(), ["dawn", "daybreak", "ocean", "sea"])

    def test_gzipped_wiktextract_is_supported(self):
        source = Path(self.temp_dir.name) / "source.jsonl.gz"
        record = {"word": "Lantern", "pos": "noun", "senses": [{"glosses": ["A portable light."], "examples": []}]}
        with gzip.open(source, "wt", encoding="utf-8") as compressed:
            compressed.write(json.dumps(record) + "\n")

        entries = pipeline.parse_wiktextract(source)
        self.assertEqual(entries[("lantern", "noun")]["definitions"], ["A portable light."])

    def test_normalization_matches_rust_runtime_rule(self):
        self.assertEqual(pipeline.normalize_word("  Dawn!  "), "dawn")
        self.assertEqual(pipeline.normalize_word("co-op"), "coop")
        self.assertEqual(pipeline.normalize_word(""), "")

    def test_kaikki_wiktextract_schema_is_accepted(self):
        source = Path(self.temp_dir.name) / "kaikki.jsonl"
        record = {
            "word": "dawn",
            "lang": "English",
            "lang_code": "en",
            "pos": "noun",
            "senses": [
                {
                    "glosses": ["The first appearance of light in the morning."],
                    "examples": [{"text": "At dawn, the valley changed from silver to gold."}],
                }
            ],
        }
        with source.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

        entries = pipeline.parse_wiktextract(source)
        self.assertIn(("dawn", "noun"), entries)
        self.assertEqual(entries[("dawn", "noun")]["definitions"], ["The first appearance of light in the morning."])
        self.assertEqual(entries[("dawn", "noun")]["examples"], ["At dawn, the valley changed from silver to gold."])


if __name__ == "__main__":
    unittest.main()
