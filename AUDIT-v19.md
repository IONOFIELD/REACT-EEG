# REACT EEG v19.0 — Production-Readiness Audit

**Source:** `src/App.jsx` (11,637 lines) + 13 extracted `src/*.js` modules (dsp, edf, edf-signals, deid, annotations, interrater, live-stream, live-metrics, manifests, sidecar, version) + `test/` (10 suites, 175 tests)
**Auditor:** Architecture review for v19 ship-readiness (successor to AUDIT-v13.md)
**Date:** 2026-07-05
**Scope:** Phase 1 only — read-only, no code modified. `npm test` executed (results below); builds not run.

> ✅ **REMEDIATION UPDATE (2026-07-05) — M-1 FIXED (post-audit).** After this read-only audit,
> baseline pinning was kept (not deleted) and made lossless: `buildReegbBundle`
> (`src/manifests.js`) now accepts and writes the record's real `baselineFilename` (was hardcoded
> `null`), and `handleSaveBundle` passes `baselineMap[filename]`. The `.reegb` import reader
> already restored `bundle.baselineFilename`, so the round-trip is now lossless. **No
> `SCHEMA_VERSION` bump** — the field lives on the bundle envelope, not the record, and never
> passes through `migrateRecord`. Covered by `test/manifests.test.js` (`buildReegbBundle` block,
> +2 cases). Full suite 205/205; production build clean. Still open: **H-1** (11.8k-line
> monolith), **H-2/H-3** (O(N²) DFT / whole-recording filtfilt).

---

## Executive Summary

Between v13 and v19 the codebase made real, verifiable progress on the issues v13 flagged as blockers. Every **CRITICAL** finding from v13 is now resolved or materially mitigated, and the change is provable in code rather than asserted:

- **BDF is handled safely** — a `0xFF` magic byte is now explicitly rejected with a structured error (`App.jsx:1512`), instead of the old silent 16-bit misread. README no longer over-claims BDF support.
- **EDF magic-byte validation** exists (`App.jsx:1517`) alongside size and header-sanity checks.
- **Anti-aliasing** is applied before every downsample across all three resample paths (`App.jsx:1672, 1703, 1729`).
- **Record schema versioning** exists end-to-end: `SCHEMA_VERSION` is a documented source of truth (`version.js`), `migrateRecord()` implements the full v13→v14.0→v14.1→v15.0→v16.0 ladder (`App.jsx:552`), and records are stamped on write.
- **ICA whitening is now correct** — real PCA whitening via Jacobi eigendecomposition (`App.jsx:1806, 1827`), replacing the diagonal-std-only pseudo-whitening. It is also **trained once and applied per-epoch** (`trainICA`/`applyTrainedICA`), fixing v13's per-epoch-recompute performance blocker.
- **Focus outline restored** — `:focus-visible` now paints a visible 2px cyan ring (`App.jsx:11446`), reversing the v13 accessibility regression. Modals now carry `role="dialog"` + `aria-modal="true"` broadly.
- **Version drift eliminated** — `version.js` is the single source of truth, a documented 4-part release checklist is machine-enforced by `test/versioning.test.js`, and all four locations (version.js / package.json / package-lock ×2 / CHANGELOG) agree on v19.0.

**Test status:** `npm test` → **10 files / 175 tests, all passing** (631 ms).

The **remaining** concerns are dominated by one durable structural issue and a handful of localized items:

1. **`App.jsx` is still an 11,637-line monolith.** The file split was *partial and testability-driven*: pure DSP/EDF-writer/deid/annotation kernels were extracted so they could be unit-tested, but the **EDF parser, all 40 React components, `migrateRecord`, `trainICA`, `computeBands`, and app state still live in App.jsx** — and it grew 3,900 lines since v13. This remains the single biggest ship risk.
2. **Internal inconsistency around baseline pinning** — `manifests.js` declares it "removed in v16.4" and writes `baselineFilename: null`, yet `baselineMap` is a fully live, IDB-persisted feature with a still-active import reader. One-directional dead path / potential data loss on bundle round-trip.
3. **Naive O(N²) DFT in `computeBands`** (`dsp.js:313`) and **whole-recording zero-phase filtfilt** (`getEDFFullResampled`, `App.jsx:1722`) are correctness-safe but scale poorly on long/high-density recordings.

### Counts by severity
| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 5 |

### v13-blocker resolution
All 5 v13 CRITICALs and the two headline HIGH/accessibility items are **resolved**. The lone structural CRITICAL from v13 (single-file architecture) is **partially resolved** — extraction happened for testable kernels, but the monolith persists.

Severity levels: **CRITICAL** broken/data-loss · **HIGH** significant debt/risk · **MEDIUM** cleanup/minor bug · **LOW** polish.

---

## v13-Blocker Status Table

| # | v13 Finding (severity) | v19 Status | Evidence |
|---|---|---|---|
| 1 | Single 7,744-line `App.jsx` (CRITICAL) | **PARTIAL** — pure kernels extracted to 13 tested modules; parser + 40 components + state still inline; file now **11,637 lines** | `App.jsx` wc; imports `App.jsx:3-35`; parser still at `App.jsx:1503` |
| 2 | 18–25 props on ReviewTab / WaveformCanvas (CRITICAL) | **RESOLVED** — `AppStoreContext` added; `WaveformCanvas({ eeg, … })` = 4 props; `ReviewTab` = 8 props (rest via `useAppStore()`) | `App.jsx:258, 2770, 8780, 8784` |
| 3 | `useEEGState` 28 `useState`, interdependent visibility quartet (HIGH) | **PARTIAL** — visibility quartet consolidated into `visibilityReducer` (removes the exhaustive-deps disable); file-wide `useState` count rose 125→142 | `App.jsx:610, 6401` |
| 4 | No record schema versioning (CRITICAL) | **RESOLVED** — `SCHEMA_VERSION="v16.0"`; `migrateRecord()` full ladder; stamped on every write | `version.js:42`; `App.jsx:552-595, 7435, 7968, 10725` |
| 5 | EDF parser mishandles BDF; no anti-aliasing (CRITICAL) | **RESOLVED** — BDF `0xFF` rejected; anti-alias LPF before all downsamples | `App.jsx:1512, 1672-1675, 1703, 1729` |
| 6 | Focus outline globally removed (HIGH/a11y) | **RESOLVED** — `:focus-visible` paints 2px cyan outline | `App.jsx:11446-11448` |
| 7 | Constants scattered across 13+ locations (HIGH) | **PARTIAL** — `STORAGE_KEYS`, ICA constants, DEBUG centralized; many domain constants still inline | `App.jsx:75, 296-300`; ICA consts referenced `App.jsx:1854, 1921` |
| 8 | Version label drift (LOW) | **RESOLVED** — `version.js` single source; enforced by test | `version.js:34-42`; `test/versioning.test.js:32-51` |
| — | HPF causal / LPF zero-phase asymmetry (HIGH) | **RESOLVED** — `applyHighPass` now zero-phase filtfilt, matching LPF | `dsp.js:99-107` |
| — | ICA whitening incomplete (MEDIUM) | **RESOLVED** — real PCA whitening (Jacobi eigendecomp) | `App.jsx:1749, 1806, 1827-1851` |
| — | ICA re-runs every epoch (perf HIGH) | **RESOLVED** — train-once / apply-per-epoch split | `App.jsx:1806 (trainICA), 1952 (applyTrainedICA)` |
| — | Wavelet periodic boundary (MEDIUM) | **RESOLVED** — symmetric mirror padding | `dsp.js:216-232` |
| — | Wavelet inverse used reversed filters (latent bug) | **RESOLVED** — transpose synthesis with same h/g | `dsp.js:210-214, 289` |
| — | StrictMode double-init (MEDIUM) | **RESOLVED** — `didInitRef` guard | `App.jsx:11048, 11127-11128` |
| — | Notes-debounce timer not cleared on unmount (MEDIUM) | **RESOLVED** — cleanup returns `clearTimeout` | `App.jsx:11256` |
| — | Duplicated per-panel drag-handle code (HIGH) | **RESOLVED** — `useDraggablePanel` + `FloatingPanel` | `App.jsx:2390, 2429` |
| — | localStorage 5 MB limit for library/notes/baselines (HIGH) | **RESOLVED** — moved to IDB via `tauriBridge`; localStorage only legacy migration | `App.jsx:299, 438, 11217, 11224` |
| — | Ungated `console.log` debug output (cleanup) | **RESOLVED** — `DEBUG` flag + `debugLog`; remaining calls are error-path `console.warn` only | `App.jsx:75-76`; warns at 421-489, 11133-11153 |
| — | Dead `MONTAGES` object; `cache-bust` comment (MEDIUM/LOW) | **RESOLVED** — both gone (grep: 0 hits) | grep `const MONTAGES` / `cache-bust` |
| — | Export manifest lacks pipeline/schema version (HIGH) | **RESOLVED** — all envelopes stamp app/pipeline/schema; enforced by test | `manifests.js:15-84`; `test/versioning.test.js:58-89` |

---

## Findings by Severity

### HIGH

#### H-1 — `App.jsx` remains an 11,637-line monolith
- **Location:** entire `src/App.jsx`.
- **Detail:** The v13 recommendation to split was only partially followed. Pure, side-effect-free kernels were extracted into 13 tested modules (`dsp.js`, `edf.js`, `edf-signals.js`, `deid.js`, `annotations.js`, `interrater.js`, `live-stream.js`, `live-metrics.js`, `manifests.js`, `sidecar.js`, `version.js`) — a genuine win for testability (175 passing tests). But the **EDF parser (`parseEDFFile`, `App.jsx:1503`)**, `migrateRecord` (`552`), `trainICA`/`applyTrainedICA` (`1806`/`1952`), and all **40 React components** still live in one file, which has *grown* ~3,900 lines since v13.
- **Risk:** Every UI/state change still risks unrelated regressions; the file is beyond what most editors and reviewers can hold in context. Note the parser was NOT moved even though `edf.js` (the *writer*) was — an odd split that leaves the higher-risk read path un-isolated and only indirectly tested.
- **Recommend:** Continue the extraction — move `parseEDFFile` + `getEDFEpochData`/`getEDFEpochWindow`/`getEDFFullResampled` into `src/edf-parser.js` (directly unit-testable against real `.edf` fixtures), then peel components into `src/components/`.

#### H-2 — `computeBands` uses a naive O(N²) DFT
- **Location:** `dsp.js:313-338` (double loop over k×n, up to 512×512 ≈ 262k ops per channel per call).
- **Detail:** Same issue v13 flagged, now in the extracted module. Called across all channels in `QuantAnalysisPanel` / topographic / Data Sheet paths (`App.jsx:4099, 4231, 4263`). For a 40-channel high-density montage this is ~10M ops per refresh, on the main thread.
- **Recommend:** Replace with a radix-2 FFT (or bin only the needed band edges). Correctness is fine today; this is a perf/scalability item that will bite the multi-channel Data Sheet.

#### H-3 — `getEDFFullResampled` runs a whole-recording zero-phase filtfilt
- **Location:** `App.jsx:1722-1738`; anti-alias LPF at `1729` calls `applyLowPass` (forward-backward, `dsp.js:70-97`) over the *entire* channel array.
- **Detail:** `applyButterworthFilter` allocates reflect-padding of `min(3·cycleLen, N/2)` and does two full passes plus reversals over the whole recording. For a 20-minute 500 Hz recording (600k samples/channel × up to 64 channels) this is a large synchronous allocation + compute at file-open. It is cached once per file (good), but the first-open latency and peak memory are unbounded in recording length.
- **Recommend:** Chunk the whole-file anti-alias pass, or downsample via a polyphase decimator; cap or stream for long files.

### MEDIUM

#### M-1 — Baseline-pinning: "removed" in exports but still a live feature (inconsistency / potential data loss)
- **Location:** `manifests.js:82` (`baselineFilename: null, // per-file baseline pinning removed in v16.4`) vs. live `baselineMap` state (`App.jsx:11037`), IDB persistence (`11224`), context wiring (`11580`), and an import reader still consuming it (`App.jsx:8391-8392`).
- **Detail:** `buildReegbBundle` unconditionally writes `baselineFilename: null`, so a `.reegb` bundle exported by v19 can never round-trip a pinned baseline — yet the import path still reads `bundle.baselineFilename`, and the in-app baseline map is fully alive and persisted. Either the feature was removed (then the live map + reader are dead code) or it wasn't (then dropping it from the bundle is silent data loss on export/re-import).
- **Recommend:** Decide one way. If kept, have `buildReegbBundle` accept and stamp `baselineFilename`. If removed, delete `baselineMap` + reader.

#### M-2 — `useState` sprawl increased despite the reducer refactor
- **Location:** file-wide — 142 `useState` (v13: 125), 58 `useEffect` (v13: 46), only 2 `useReducer`.
- **Detail:** The `visibilityReducer` consolidation (`App.jsx:610, 6401`) fixed the specific interdependent quartet v13 called out, but overall hook density rose with new features (Repository, Collections, Timeline, live Acquire). This is a symptom of H-1, not independent — but it confirms the state layer is still fragmented.
- **Recommend:** As components are extracted (H-1), colocate their state; consider reducers for the annotation and filter groups v13 named.

#### M-3 — Bipolar derivation still silently falls back to a single electrode
- **Location:** waveform derivation in `useEEGState`/Review path (behavior unchanged from v13 §4; the montage fallback logic still resolves a missing second electrode to the single available lead without a user-visible flag).
- **Detail:** v13 flagged this; no `partial` flag / visual tint was added. A derivation rendered from one electrode looks identical to a true bipolar trace, which is clinically misleading for a concussion-slowing read.
- **Recommend:** Emit a `partial` flag and tint/suffix the channel label.

#### M-4 — EDF sample-rate is integer-rounded; fractional record durations lose precision
- **Location:** `App.jsx:1575` — `Math.round(s.numSamples / recordDuration)`.
- **Detail:** Unchanged from v13. For non-integer `numSamples/recordDuration`, the stored/display SR is rounded and the true ratio is discarded, so downstream time math (Data Sheet, annotation timestamps) can drift on unusual exporters.
- **Recommend:** Retain the unrounded ratio in per-signal metadata and use it for time conversion.

#### M-5 — EDF+ annotation start-of-record filtering is heuristic
- **Location:** `App.jsx:1593-1600` — TALs are parsed (a v13 gap now closed), but the first empty-text TAL per record is dropped by an empty-text test rather than by strict TAL positional parsing.
- **Detail:** Mostly correct, but a legitimately empty-text event (rare) would be dropped, and a malformed record-offset TAL with text would be admitted. Low probability, but it is a silent-correctness edge.
- **Recommend:** Track the record-start TAL by position (first TAL of each data record) rather than by empty text.

#### M-6 — Anti-alias cutoff `targetSr/2.5` is a fixed heuristic with no order/ripple documentation
- **Location:** `App.jsx:1673, 1703, 1729` — 4th-order Butterworth LPF at `targetSr/2.5`.
- **Detail:** Correct in spirit (leaves margin below target Nyquist), but the 2.5 divisor and order 4 are magic numbers with no golden-vector test asserting the stopband attenuation at `targetSr/2`. Given the concussion use-case depends on faithful frontotemporal slowing, the resampler deserves a characterization test.
- **Recommend:** Add a `dsp.golden` test that downsamples a known multi-tone and asserts alias suppression; extract the divisor/order to named constants.

### LOW

#### L-1 — `EEGControls` still takes ~17 positional props
- **Location:** `App.jsx:3720-3721`. Unlike `WaveformCanvas`/`ReviewTab`, this component was not migrated to `useAppStore`/`eeg`-consolidation. Cosmetic coupling; low risk.

#### L-2 — `ReviewTab` is still ~810 lines
- **Location:** `App.jsx:8780`. Prop count dropped (good) but the component body grew vs. v13's 690. Sub-extract per-section panels.

#### L-3 — Legacy dashed storage key retained
- **Location:** `App.jsx:299` — `BASELINE_MAP_LEGACY: "react-eeg-baselineMap"` with a "drop after one release" comment that has survived multiple releases. Harmless but stale.

#### L-4 — Fonts still `@import`ed from within the app `<style>` block
- **Location:** `App.jsx:11440` (Google Fonts `@import`). v13 L note; also a self-contained/offline concern for a clinical-adjacent desktop app that may run air-gapped. Prefer bundling or `index.html`.

#### L-5 — ICA sign/permutation indeterminacy not normalized
- **Location:** `trainICA` (`App.jsx:1855-1892`) initializes `W` with `Math.random()` and does not fix component sign or ordering. Output is correct for artifact *removal* (the projection is sign-invariant), and the module comment acknowledges non-determinism, but any future per-component display/logging (`componentLog`, `App.jsx:1923`) will be non-reproducible run-to-run. Note for when ICA components become user-visible.

---

## Signal-Correctness Verification Notes (positive confirmations)

- **Filter symmetry:** HPF and LPF are both zero-phase filtfilt (`dsp.js:99-111`), resolving v13's phase-distortion asymmetry. Streaming (causal, stateful) variants for live acquisition are a separate, correctly-documented path with a golden-vector equivalence guarantee (`dsp.js:122-202`).
- **Wavelet:** Db4 with symmetric mirror padding and correct transpose synthesis (`dsp.js:205-310`); the reversed-filter reconstruction bug noted in the source comment is fixed.
- **ICA:** Genuine PCA whitening (Jacobi eigendecomposition, eigenvalue floor at `1e-8·maxEv`, `App.jsx:1827-1842`), tanh-contrast FastICA with Gram–Schmidt deflation, artifact ICs flagged by |Pearson r| to EOG/EKG aux channels, back-projection precomputed in channel space for cheap per-epoch application. This is a correct, well-structured implementation.
- **Artifact handling:** `interpolateArtifacts` replaces flagged samples with boundary-respecting linear interpolation instead of zeroing (`dsp.js:347-368`), avoiding broadband spectral leakage into band-power — a real correctness improvement over naive zeroing.
- **EDF writer round-trip:** `edf.js` rounds physical range outward to the stored 0.1 µV header precision so encoder/decoder scales agree (`edf.js:55-74`), and stamps provenance in the reserved field that survives de-id scrubbing — round-trip is unit-tested (`test/edf.test.js`, 6 tests passing).
- **Versioning/stamping:** Every export envelope is built by a pure function in `manifests.js`/`sidecar.js` and stamped with app/pipeline/schema versions; `test/versioning.test.js` source-scans App.jsx to forbid inline envelopes and hardcoded stamps, and asserts the 4-part release checklist stays in sync. Robust.

---

## `npm test` Result

```
Test Files  10 passed (10)
     Tests  175 passed (175)
  Duration  631 ms
```
Suites: live-stream (30), deid (25), annotations.migration (15), manifests (11), live-metrics (16), interrater (9), edf-signals (16), versioning (20), edf (6), dsp.golden (27). No failures, no skips.

---

## Bottom Line

v19 is in materially better shape than v13. The DSP is correct and now unit-tested with golden vectors; the previously-silent BDF and anti-aliasing hazards are closed; schema versioning and the release checklist are documented and machine-enforced; the accessibility regression is reversed. **There are no open CRITICALs.** The dominant remaining risk is structural: `App.jsx` is still a single 11,637-line file whose EDF *parser* and entire component tree resist isolated review. Prioritize (1) extracting the parser + view-model to testable modules, (2) resolving the baseline-pinning contradiction (M-1) before it causes a silent bundle-round-trip data loss, and (3) the two scalability items (H-2, H-3) before high-density Data Sheet output is relied upon clinically.

**End of audit — Phase 1 read-only. No source modified.**
