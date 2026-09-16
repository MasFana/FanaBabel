# FanaBabel data pipeline

This build-time tool creates the offline dictionary resources consumed by the Tauri app. It is intentionally dependency-free and is not shipped in the application bundle.

## Inputs

- **Wiktextract JSONL/JSONL.GZ**: `word`, `pos`, and `senses[].glosses` / `senses[].examples`.
- **WordNet data files**: the standard `data.noun`, `data.verb`, `data.adj`, and `data.adv` files. WordNet contributes synonym rings by normalized word and part of speech.

The planned production sources are the [Kaikki Wiktextract dump](https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz) and [Global WordNet English WordNet](https://github.com/globalwordnet/english-wordnet). Download them manually and record their versions or checksums in release build notes. Do not commit source dumps or generated dictionary databases to this repository.

## Build

From this directory:

```powershell
python pipeline.py `
  --wiktionary path\to\raw-wiktextract-data.jsonl.gz `
  --wordnet path\to\wordnet\dict `
  --output ..\app\src-tauri\resources\dictionary.sqlite `
  --word-list ..\app\src-tauri\resources\words.txt
```

The generated SQLite file contains the schema in `PROJECT.md`, plus `pipeline_metadata` with input paths and counts. The word list is sorted and deduplicated for the runtime autocomplete structure.

## Test with the fixture

```powershell
python -m unittest discover -s tests -v
```

The fixture is deliberately tiny and contains no external dictionary content. It checks normalization, source merging, stable ordering, deduplication, and SQLite output.

## Licensing and attribution

WordNet is distributed under its [CC BY 4.0 license](https://wordnet.princeton.edu/license-and-commercial-use). Wiktextract output is derived from Wiktionary and must retain the applicable Wiktionary attribution and share-alike/GFDL notices. Before shipping a generated database, include both source notices, exact source URLs, retrieval dates, versions or checksums, and the transformation command in release documentation. This pipeline does not make a legal determination about a particular source snapshot.
