// Build the REACT EEG desktop app (Tauri → standalone exe + Windows NSIS installer).
//
// Beyond a plain `tauri build`, this handles two things:
//   1. Keeps the SECRET demo token out of the bundle. The desktop app reads the token at RUNTIME
//      from <Documents>/REACT EEG/demo_token (the `load_demo_token` Rust command), so it must never
//      be compiled in. `vite build --mode tauri` would otherwise copy public/pieeg-demo-token into
//      dist-tauri, so we move it aside for the build and restore it afterward.
//   2. Disables updater-artifact signing — a local build has no signing key.
//
// Prereqs: Rust MSVC toolchain (rustup), MSVC C++ build tools (Visual Studio), WebView2 runtime.
// Output:  src-tauri/target/release/react-eeg.exe
//          src-tauri/target/release/bundle/nsis/REACT EEG_<version>_x64-setup.exe
import { execSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "public/pieeg-demo-token";
const BAK = join(tmpdir(), "pieeg-demo-token.bak");
const CFG = join(tmpdir(), "tauri-local-build.json");
writeFileSync(CFG, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));

const moved = existsSync(TOKEN);
if (moved) renameSync(TOKEN, BAK); // exclude the secret from the bundle
try {
  execSync(`tauri build --config "${CFG}"`, { stdio: "inherit" });
} finally {
  if (moved && existsSync(BAK)) renameSync(BAK, TOKEN); // restore for the browser/dev flow
}
