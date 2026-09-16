use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn write_embedded_binding(project_root: &Path) {
    let binding_path = project_root.join("src").join("generated_dictionary.rs");
    fs::write(
        binding_path,
        "pub const DICTIONARY_SQLITE: &[u8] = include_bytes!(\"../resources/dictionary.sqlite\");\n",
    )
    .expect("should write the embedded dictionary binding");
}

fn build_dictionary_from_source(
    python: &str,
    pipeline_dir: &Path,
    source: &Path,
    output: &Path,
    word_list: &Path,
) {
    let status = Command::new(python)
        .current_dir(pipeline_dir)
        .args([
            "pipeline.py",
            "--wiktionary",
            source
                .to_str()
                .expect("wiktionary path must be valid UTF-8"),
            "--output",
            output.to_str().expect("output path must be valid UTF-8"),
            "--word-list",
            word_list
                .to_str()
                .expect("word list path must be valid UTF-8"),
        ])
        .status()
        .expect("Wiktextract pipeline should run");

    if !status.success() {
        panic!("Wiktextract dictionary build failed");
    }
}

fn main() {
    println!("cargo:rerun-if-changed=../data-pipeline");
    println!("cargo:rerun-if-changed=../data-pipeline/fixtures");

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
    let project_root = manifest_dir
        .parent()
        .and_then(|parent| parent.parent())
        .expect("FanaBabel project root should exist");
    let resource_dir = manifest_dir.join("resources");
    fs::create_dir_all(&resource_dir).expect("should create the resource folder");

    let output = resource_dir.join("dictionary.sqlite");
    let word_list = resource_dir.join("words.txt");
    let python = env::var("PYTHON").unwrap_or_else(|_| "python".to_string());
    let pipeline_dir = project_root.join("data-pipeline");
    let fixture_wiktionary = pipeline_dir.join("fixtures").join("wiktextract.jsonl");
    let remote_url = "https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz";

    let remote_status = Command::new(&python)
        .current_dir(&pipeline_dir)
        .args([
            project_root
                .join("data-pipeline")
                .join("pipeline.py")
                .to_str()
                .expect("pipeline path must be valid UTF-8"),
            "--wiktionary-url",
            remote_url,
            "--output",
            output.to_str().expect("output path must be valid UTF-8"),
            "--word-list",
            word_list
                .to_str()
                .expect("word list path must be valid UTF-8"),
        ])
        .status();

    match remote_status {
        Ok(status) if status.success() => {
            write_embedded_binding(&manifest_dir);
            tauri_build::build();
            return;
        }
        Ok(status) => {
            println!("cargo:warning=Remote Wiktextract fetch failed with exit status {}. Falling back to the local fixture source.", status);
        }
        Err(err) => {
            println!("cargo:warning=Remote Wiktextract fetch failed to launch: {}. Falling back to the local fixture source.", err);
        }
    }

    build_dictionary_from_source(
        &python,
        &pipeline_dir,
        &fixture_wiktionary,
        &output,
        &word_list,
    );
    write_embedded_binding(&manifest_dir);
    tauri_build::build();
}
