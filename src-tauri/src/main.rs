// Prevent an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// REACT EEG — Tauri v2 desktop backend.
//
// Implements exactly the command surface the frontend's `tauriBridge` (src/App.jsx) calls
// when `window.__TAURI__` is present. In the browser these fall back to IndexedDB; here they
// persist to plain files under `Documents/REACT EEG/`, so a desktop install has real,
// user-visible, backup-able storage with no 5 MB browser cap.
//
// Layout under the data dir:
//   library.json                  — the record index (array)
//   config.json                   — app config blob
//   baselines.json                — baseline-comparison map
//   collections.json              — collection list
//   notes/<edf-filename>.txt       — per-recording clinical notes
//   annotations/<edf-filename>.json — per-recording annotation array
//
// NOTE: raw EDF blobs are still persisted by the frontend in the WebView's IndexedDB (the
// bridge has no EDF command). That works on desktop too; moving EDFs onto the filesystem is
// a follow-up that also needs a frontend bridge command.

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
    ensure_dir(&dir.join("notes"))?;
    ensure_dir(&dir.join("annotations"))?;
    ensure_dir(&dir.join("edf"))?;
    Ok(format!("Desktop mode — filesystem persistence at {}", dir.display()))
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
    let p = data_path(&["annotations", &format!("{filename}.json")])?;
    write_string(&p, &annotations_json)
}

#[tauri::command]
fn load_annotations(filename: String) -> String {
    let p = data_dir().join("annotations").join(format!("{filename}.json"));
    let s = read_string(&p);
    if s.is_empty() { "[]".to_string() } else { s }
}

// ── Clinical notes (per recording) ───────────────────────────────────────────

#[tauri::command]
fn save_clinical_notes(filename: String, notes_text: String) -> Result<(), String> {
    let p = data_path(&["notes", &format!("{filename}.txt")])?;
    write_string(&p, &notes_text)
}

#[tauri::command]
fn load_clinical_notes(filename: String) -> String {
    let p = data_dir().join("notes").join(format!("{filename}.txt"));
    read_string(&p)
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
    let p = data_path(&["edf", &filename])?;
    fs::write(&p, &bytes).map_err(|e| format!("write {:?}: {e}", p))
}

#[tauri::command]
fn load_edf(filename: String) -> String {
    let p = data_dir().join("edf").join(&filename);
    match fs::read(&p) {
        Ok(bytes) => STANDARD.encode(bytes),
        Err(_) => String::new(),
    }
}

#[tauri::command]
fn list_edfs() -> String {
    let dir = data_dir().join("edf");
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    names.push(name.to_string());
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
    // Reveal the EDF file on disk if present; otherwise open the data directory.
    let edf = data_dir().join("edf").join(&filename);
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
    // Remove the on-disk sidecars + EDF for a deleted record. The record itself is dropped
    // from library.json by the next save_library_index.
    let notes = data_dir().join("notes").join(format!("{filename}.txt"));
    let anns = data_dir().join("annotations").join(format!("{filename}.json"));
    let edf = data_dir().join("edf").join(&filename);
    for p in [notes, anns, edf] {
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            initialize_app,
            get_data_directory,
            load_config,
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
            show_in_explorer,
            delete_record_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running REACT EEG");
}
