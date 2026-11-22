// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// REACT EEG — Tauri v2 desktop backend.
//
// Implements exactly the command surface the frontend's `tauriBridge` (src/App.jsx) calls
// when `window.__TAURI__` is present. In the browser these fall back to IndexedDB; here they
// persist to plain files under `Documents/REACT EEG/`, so a desktop install has real,
// user-visible, backup-able storage with no 5 MB browser cap.
//
// Layout under the data dir — ONE FOLDER PER RECORDING:
//   library.json                         — the record index (array)
//   config.json                          — app config blob
//   baselines.json                       — baseline-comparison map
//   collections.json                     — collection list
//   recordings/<stem>/<stem>.edf         — the EDF itself
//   recordings/<stem>/annotations.json   — per-recording annotation array
//   recordings/<stem>/notes.txt          — per-recording clinical notes
// where <stem> is the EDF filename without its .edf extension.
//
// Legacy layout (edf/, notes/, annotations/ as sibling folders) is migrated into
// recordings/<stem>/ on startup by `initialize_app`; loads also fall back to the legacy path.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::PathBuf;

/// Root data directory: `<Documents>/REACT EEG` (created on demand).
fn data_dir() -> PathBuf {
    let base = dirs::document_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    base.join("REACT EEG")
}

fn ensure_dir(p: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("create_dir_all {:?}: {e}", p))
}

/// Resolve a file inside the data dir, creating parent directories as needed.
fn data_path(parts: &[&str]) -> Result<PathBuf, String> {
    let mut p = data_dir();
    for (i, part) in parts.iter().enumerate() {
        // Only the final component is a file; earlier ones are directories to ensure.
        if i + 1 < parts.len() {
            p = p.join(part);
        }
    }
    ensure_dir(&p)?;
    Ok(p.join(parts[parts.len() - 1]))
}

fn read_string(path: &PathBuf) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

// ── Per-recording folder ─────────────────────────────────────────────────────

/// Folder name for a recording: the EDF filename minus its .edf extension.
fn record_stem(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".edf") { filename[..filename.len() - 4].to_string() } else { filename.to_string() }
}

/// Reject anything that could escape the data dir (path separators, `..`, empty).
fn check_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("invalid recording filename: {filename:?}"));
    }
    Ok(())
}

/// `recordings/<stem>/` for a recording (not created).
fn record_dir(filename: &str) -> PathBuf {
    data_dir().join("recordings").join(record_stem(filename))
}

fn record_edf_path(filename: &str) -> PathBuf { record_dir(filename).join(filename) }
fn record_annotations_path(filename: &str) -> PathBuf { record_dir(filename).join("annotations.json") }
fn record_notes_path(filename: &str) -> PathBuf { record_dir(filename).join("notes.txt") }

// Legacy (pre-v20.2) split-folder paths — read-only fallback + migration source.
fn legacy_edf_path(filename: &str) -> PathBuf { data_dir().join("edf").join(filename) }
fn legacy_annotations_path(filename: &str) -> PathBuf { data_dir().join("annotations").join(format!("{filename}.json")) }
fn legacy_notes_path(filename: &str) -> PathBuf { data_dir().join("notes").join(format!("{filename}.txt")) }

/// First path that exists, else the first (new-layout) path.
fn existing_or_first(paths: [PathBuf; 2]) -> PathBuf {
    if !paths[0].exists() && paths[1].exists() { paths[1].clone() } else { paths[0].clone() }
}

/// Move one legacy file into its recording folder. Never overwrites a file already there.
fn migrate_one(from: &PathBuf, to: &PathBuf) -> Result<(), String> {
    if !from.exists() || to.exists() { return Ok(()); }
    if let Some(parent) = to.parent() { ensure_dir(&parent.to_path_buf())?; }
    if fs::rename(from, to).is_err() {
        // rename can fail across volumes — copy, then remove the source.
        fs::copy(from, to).map_err(|e| format!("copy {:?} -> {:?}: {e}", from, to))?;
        fs::remove_file(from).map_err(|e| format!("remove {:?}: {e}", from))?;
    }
    Ok(())
}

/// Fold edf/, notes/, annotations/ into recordings/<stem>/. Idempotent; removes the legacy
/// folders only when they end up empty.
fn migrate_legacy_layout() -> Result<u32, String> {
    let dir = data_dir();
    let mut moved = 0u32;
    // EDFs
    if let Ok(entries) = fs::read_dir(dir.join("edf")) {
        for e in entries.flatten() {
            if !e.path().is_file() { continue; }
            if let Some(name) = e.file_name().to_str() {
                if check_filename(name).is_err() { continue; }
                let to = record_edf_path(name);
                if !to.exists() { migrate_one(&e.path(), &to)?; moved += 1; }
            }
        }
    }
    // Sidecars: notes/<file>.txt, annotations/<file>.json
    for (sub, ext, is_notes) in [("notes", ".txt", true), ("annotations", ".json", false)] {
        if let Ok(entries) = fs::read_dir(dir.join(sub)) {
            for e in entries.flatten() {
                if !e.path().is_file() { continue; }
                let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else { continue };
                let Some(filename) = name.strip_suffix(ext) else { continue };
                if check_filename(filename).is_err() { continue; }
                let to = if is_notes { record_notes_path(filename) } else { record_annotations_path(filename) };
                if !to.exists() { migrate_one(&e.path(), &to)?; moved += 1; }
            }
        }
    }
    for sub in ["edf", "notes", "annotations"] {
        let _ = fs::remove_dir(dir.join(sub)); // only succeeds if empty
    }
    Ok(moved)
}

fn write_string(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent {:?}: {e}", parent))?;
    }
    fs::write(path, contents).map_err(|e| format!("write {:?}: {e}", path))
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

#[tauri::command]
fn initialize_app() -> Result<String, String> {
    let dir = data_dir();
    ensure_dir(&dir)?;
    ensure_dir(&dir.join("recordings"))?;
    let note = match migrate_legacy_layout() {
        Ok(0) => String::new(),
        Ok(n) => format!(" (migrated {n} legacy file(s) into per-recording folders)"),
        Err(e) => format!(" (legacy migration incomplete: {e})"),
    };
    Ok(format!("Desktop mode — filesystem persistence at {}{note}", dir.display()))
}

#[tauri::command]
fn get_data_directory() -> String {
    data_dir().display().to_string()
}

#[tauri::command]
fn load_config() -> String {
    let p = data_dir().join("config.json");
    let s = read_string(&p);
    if s.is_empty() { "{}".to_string() } else { s }
}

// ── Hardened-demo token ──────────────────────────────────────────────────────
// The shared secret for the Pi's wss demo endpoint. Read at RUNTIME from an external file
// (`<Documents>/REACT EEG/demo_token`) so it is NEVER baked into the app bundle, never logged,
// never placed in a URL. Returns "" if absent — the frontend then surfaces a clear error and the
// server closes the socket 4401. The operator drops the token file there once (see docs).

#[tauri::command]
fn load_demo_token() -> String {
    read_string(&data_dir().join("demo_token")).trim().to_string()
}

// ── Library index ────────────────────────────────────────────────────────────

#[tauri::command]
fn load_library_index() -> String {
    let p = data_dir().join("library.json");
    let s = read_string(&p);
    if s.is_empty() { "[]".to_string() } else { s }
}

#[tauri::command]
fn save_library_index(records_json: String) -> Result<(), String> {
    let p = data_path(&["library.json"])?;
    write_string(&p, &records_json)
}

// ── Annotations (per recording) ──────────────────────────────────────────────

#[tauri::command]
fn save_annotations(filename: String, annotations_json: String) -> Result<(), String> {
    check_filename(&filename)?;
    write_string(&record_annotations_path(&filename), &annotations_json)
}

#[tauri::command]
fn load_annotations(filename: String) -> String {
    if check_filename(&filename).is_err() { return "[]".to_string(); }
    let p = existing_or_first([record_annotations_path(&filename), legacy_annotations_path(&filename)]);
    let s = read_string(&p);
    if s.is_empty() { "[]".to_string() } else { s }
}

// ── Clinical notes (per recording) ───────────────────────────────────────────

#[tauri::command]
fn save_clinical_notes(filename: String, notes_text: String) -> Result<(), String> {
    check_filename(&filename)?;
    write_string(&record_notes_path(&filename), &notes_text)
}

#[tauri::command]
fn load_clinical_notes(filename: String) -> String {
    if check_filename(&filename).is_err() { return String::new(); }
    read_string(&existing_or_first([record_notes_path(&filename), legacy_notes_path(&filename)]))
}

// ── Baseline map ─────────────────────────────────────────────────────────────

#[tauri::command]
fn save_baseline_map(map_json: String) -> Result<(), String> {
    let p = data_path(&["baselines.json"])?;
    write_string(&p, &map_json)
}

#[tauri::command]
fn load_baseline_map() -> String {
    let p = data_dir().join("baselines.json");
    let s = read_string(&p);
    if s.is_empty() { "{}".to_string() } else { s }
}

// ── Collections ──────────────────────────────────────────────────────────────

#[tauri::command]
fn save_collections(collections_json: String) -> Result<(), String> {
    let p = data_path(&["collections.json"])?;
    write_string(&p, &collections_json)
}

#[tauri::command]
fn load_collections() -> String {
    let p = data_dir().join("collections.json");
    let s = read_string(&p);
    if s.is_empty() { "[]".to_string() } else { s }
}

// ── Raw EDF blobs (per recording) ────────────────────────────────────────────
// Transported as base64 over the invoke boundary (matches the frontend's existing
// arrayBufferToBase64/base64ToArrayBuffer helpers). The frontend already header-scrubs the
// bytes (HIPAA Safe Harbor) before calling save_edf, so what lands on disk is PHI-free.

#[tauri::command]
fn save_edf(filename: String, edf_base64: String) -> Result<(), String> {
    let bytes = STANDARD.decode(edf_base64.as_bytes()).map_err(|e| format!("base64 decode: {e}"))?;
    check_filename(&filename)?;
    let p = record_edf_path(&filename);
    if let Some(parent) = p.parent() { ensure_dir(&parent.to_path_buf())?; }
    fs::write(&p, &bytes).map_err(|e| format!("write {:?}: {e}", p))
}

#[tauri::command]
fn load_edf(filename: String) -> String {
    if check_filename(&filename).is_err() { return String::new(); }
    let p = existing_or_first([record_edf_path(&filename), legacy_edf_path(&filename)]);
    match fs::read(&p) {
        Ok(bytes) => STANDARD.encode(bytes),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn list_edfs() -> String {
    // Every *.edf inside recordings/<stem>/, plus any stragglers left in legacy edf/.
    let mut names: Vec<String> = Vec::new();
    if let Ok(folders) = fs::read_dir(data_dir().join("recordings")) {
        for folder in folders.flatten() {
            if !folder.path().is_dir() { continue; }
            if let Ok(files) = fs::read_dir(folder.path()) {
                for f in files.flatten() {
                    if !f.path().is_file() { continue; }
                    if let Some(name) = f.file_name().to_str() {
                        if name.to_ascii_lowercase().ends_with(".edf") && !names.iter().any(|n| n == name) {
                            names.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(data_dir().join("edf")) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if !names.iter().any(|n| n == name) { names.push(name.to_string()); }
                }
            }
        }
    }
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

// ── OS integration ───────────────────────────────────────────────────────────

#[tauri::command]
fn open_data_directory() -> Result<(), String> {
    let dir = data_dir();
    ensure_dir(&dir)?;
    open_in_file_manager(&dir)
}

#[tauri::command]
fn show_in_explorer(_study_type: String, filename: String) -> Result<(), String> {
    // Reveal the EDF inside its recording folder if present; otherwise open the data directory.
    let edf = if check_filename(&filename).is_ok() {
        existing_or_first([record_edf_path(&filename), legacy_edf_path(&filename)])
    } else { data_dir().join("__invalid__") };
    if edf.exists() {
        #[cfg(target_os = "windows")]
        {
            return std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&edf)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("reveal {:?}: {e}", edf));
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(parent) = edf.parent() {
            return open_in_file_manager(&parent.to_path_buf());
        }
    }
    let dir = data_dir();
    ensure_dir(&dir)?;
    open_in_file_manager(&dir)
}

#[tauri::command]
fn delete_record_files(_study_type: String, filename: String) -> Result<(), String> {
    // Remove the recording's folder (EDF + annotations + notes) and any legacy leftovers.
    // The record itself is dropped from library.json by the next save_library_index.
    check_filename(&filename)?;
    let folder = record_dir(&filename);
    if folder.exists() {
        fs::remove_dir_all(&folder).map_err(|e| format!("remove {:?}: {e}", folder))?;
    }
    for p in [legacy_notes_path(&filename), legacy_annotations_path(&filename), legacy_edf_path(&filename)] {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("remove {:?}: {e}", p))?;
        }
    }
    Ok(())
}

/// Open a directory in the OS file manager (Explorer / Finder / xdg-open).
fn open_in_file_manager(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();

    result.map(|_| ()).map_err(|e| format!("open {:?}: {e}", path))
}

/// Open a web page in the user's default browser (the Dataset Browser's official-access links —
/// the webview itself can't navigate away). Only plain `https://` URLs are accepted: no other
/// schemes, whitespace, quotes or control characters. The URL is passed as a single argument with
/// no shell involved, so it can't be turned into a command.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://")
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '<' | '>' | '`'));
    if !ok {
        return Err("only plain https:// links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();

    result.map(|_| ()).map_err(|e| format!("open url: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            initialize_app,
            get_data_directory,
            load_config,
            load_demo_token,
            load_library_index,
            save_library_index,
            save_annotations,
            load_annotations,
            save_clinical_notes,
            load_clinical_notes,
            save_baseline_map,
            load_baseline_map,
            save_collections,
            load_collections,
            save_edf,
            load_edf,
            list_edfs,
            open_data_directory,
            open_external_url,
            show_in_explorer,
            delete_record_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running REACT EEG");
}
