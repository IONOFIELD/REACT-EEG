# REACT EEG — Desktop (Tauri v2) shell

Wraps the existing web app as a native Windows/macOS/Linux desktop application. The
frontend is unchanged; the Rust backend in `src/main.rs` implements exactly the command
surface the app's `tauriBridge` (`../src/App.jsx`) calls, persisting to plain files under
`Documents/REACT EEG/` instead of the browser's IndexedDB.

## Status

Scaffold + backend are written but **not yet compiled** — the build machine had no MSVC C++
toolchain. Rust itself is installed; the remaining prerequisite is the Visual Studio C++
Build Tools (see below). Everything Rust-side (`cargo build`, even `cargo check`) is blocked
until that lands. The **frontend** Tauri build (`npm run build:tauri` → `dist-tauri/`) is
verified working (relative asset base for `tauri://localhost`).

## Prerequisites

| Dependency | Status | Install |
|---|---|---|
| Rust (stable-msvc) | ✅ installed | `winget install Rustlang.Rustup` |
| WebView2 runtime | ✅ present (Win11) | preinstalled |
| **MSVC C++ Build Tools + Windows SDK** | ❌ **required** | **run in an ADMIN terminal** (below) |
| `@tauri-apps/cli` | in devDeps | `npm install` |

Install the MSVC build tools (needs administrator elevation — a normal `winget` from a
non-elevated/automation shell fails with exit 1602):

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Verify: open a new terminal and confirm `where cl.exe` resolves and
`rustc --version` works, then a trivial `cargo new t && cd t && cargo build` succeeds.

## First build

```bash
# 1. one-time: generate the icon set the bundler needs from the placeholder source
npm install                       # fetches @tauri-apps/cli
npm run tauri icon src-tauri/icons/icon-source.png

# 2. run in dev (hot-reload frontend + native window)
npm run tauri dev

# 3. produce an unsigned desktop build
npm run tauri build               # → src-tauri/target/release/ (+ NSIS installer under bundle/)
#   or, without the npm CLI:
#   npm run build:tauri && (cd src-tauri && cargo build --release)
```

## Data location

`Documents/REACT EEG/` — `library.json`, `config.json`, `baselines.json`,
`collections.json`, `notes/<file>.txt`, `annotations/<file>.json`.

**Known follow-up:** raw EDF blobs are still stored by the frontend in the WebView's
IndexedDB (the bridge has no EDF command), so they aren't yet on the filesystem. Moving them
into the data dir needs a new bridge command (`save_edf`/`load_edf`) on both sides.

## Signing + auto-update (phase 4, later)

Not configured yet. Windows code signing needs a certificate (the `bundle > windows >
certificateThumbprint` field); auto-update needs the `updater` plugin + a hosted update
feed + a signing keypair. Deferred until the unsigned build is validated.
