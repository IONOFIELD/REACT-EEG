# Releasing the desktop app & shipping auto-updates

REACT EEG desktop uses Tauri's updater. Installed apps check a GitHub Release feed on launch
and self-update. This is **not** "push a commit and the exe changes" — you cut a *versioned
release*; installed apps then pull it. The GitHub Actions workflow (`.github/workflows/release.yml`)
makes that one command: **push a version tag → CI builds, signs, and publishes.**

## One-time setup

1. **Signing key.** An updater keypair was generated at `~/.tauri/react-eeg-updater.key`
   (private — keep it secret, **back it up somewhere safe**; if it's lost, existing installs
   can never be updated again). Its public key is already committed in
   `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

2. **Add two GitHub Actions secrets** (repo → Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `~/.tauri/react-eeg-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key's password (empty string, since it was
     generated without one)

   `GITHUB_TOKEN` is provided automatically; the workflow already requests `contents: write`.

## Cutting a release

1. **Bump the version** (the app version drives the update comparison). Update `version` in
   `package.json` (this is the single source the desktop app reads via
   `tauri.conf.json: "version": "../package.json"`), keep `package-lock.json` in sync, and
   prepend a `CHANGELOG` entry per the checklist in `src/version.js`. Optionally match
   `src-tauri/Cargo.toml`'s `version` (cosmetic — the crate version, not the update version).

2. **Tag and push:**
   ```bash
   git commit -am "Release v19.1.0"
   git tag v19.1.0
   git push origin main --tags
   ```

3. CI builds the Windows installer, signs it, and publishes a **GitHub Release** `v19.1.0`
   containing `REACT EEG_19.1.0_x64-setup.exe`, its `.sig`, and `latest.json`.

## How the update reaches users

- The app's configured endpoint is
  `https://github.com/IONOFIELD/REACT-EEG/releases/latest/download/latest.json`.
- On launch (a few seconds in), the app fetches `latest.json`, compares its version to the
  running one, and if newer prompts: *"REACT EEG X.Y.Z is available. Install now?"* On yes it
  downloads, verifies the signature against the embedded public key, installs, and relaunches.
- **Bootstrap:** the *first* release just establishes the feed. Updates flow from the *second*
  release onward (an install of vX only auto-updates once a v>X release exists).

## Local signed build (no CI)

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/react-eeg-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
cargo tauri build     # → installer + .sig under src-tauri/target/release/bundle/nsis/
```

## Not yet configured

**Code signing (Authenticode).** Separate from the updater key above. Without it, Windows
SmartScreen shows an "unknown publisher" prompt on first install (click *More info → Run
anyway*). To remove it, buy a code-signing certificate and set
`bundle.windows.certificateThumbprint` in `tauri.conf.json`.
