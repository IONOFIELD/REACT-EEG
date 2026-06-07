import { useState, useEffect, useRef, useCallback, useMemo, useReducer, createContext, useContext } from "react";
import JSZip from "jszip";
import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "./version.js";
import { buildAnnotationSidecar } from "./sidecar.js";
// ACNS/ILAE annotation taxonomy + migration (ANNOTATION_TYPES aliased to the long-standing
// ANNOTATION_COLORS name so existing call sites are unchanged).
import { ANNOTATION_TYPES as ANNOTATION_COLORS, migrateAnnotations } from "./annotations.js";
// Inter-rater / provenance: pseudonymous (hashed) annotator id + concordant/discordant indicator.
import { hashAnnotator, agreementByAnnotation } from "./interrater.js";
// EDF channel signal-presence (σ-based; ignores DC offset). Unit-tested in test/edf-signals.test.js.
import { signalStats, channelHasSignal } from "./edf-signals.js";
// Pure DSP kernel (extracted, behaviour-identical, unit-tested in test/dsp.golden.test.js)
import {
  butterworthCoeffs, applyBiquadCascade, applyButterworthFilter,
  applyHighPass, applyLowPass, applyNotch, applyWaveletDenoise, computeBands,
} from "./dsp.js";

// ══════════════════════════════════════════════════════════════
// REACT EEG — Unified Platform
// LIBRARY | REVIEW | REPOSITORY | RECORD
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// ── CONFIGURATION ──
// All hardcoded thresholds, palettes, defaults, study types, electrode
// positions, and other tunable values live in this block. Single edit
// point for tuning app behavior without touching component code.
// Block ends at "── END CONFIGURATION ──" marker further down.
// ══════════════════════════════════════════════════════════════

// ── App identity / versioning ── (APP_VERSION / PIPELINE_VERSION / SCHEMA_VERSION now
// imported from ./version.js so App.jsx and dsp.js share one source of truth.)
const DEBUG = false;
const debugLog = (...args) => { if (DEBUG) console.log(...args); };

// ── Patch log shown on the splash screen ──
// Concise list of recent changes. Newest first; each session the user dismisses
// it via the ENTER button on the splash. Keep entries to ~1 short line each.
const CHANGELOG = [
  { version: "v17.7", items: [
    "FIXED a persistent high-frequency artifact pinned to the left (and right) edge of every epoch — filters were applied to each epoch's isolated slice, which forced the first/last sample of every trace to the channel baseline. Each epoch is now filtered with a guard band of real neighbouring signal and then cropped, so the visible window is transient-free (only the true file start, where no prior data exists, can still reflect)",
    "Adaptive Double-Banana now orders its chains clinically — by band, alternating left/right with midline last (L-temporal → R-temporal → L-parasagittal → R-parasagittal → … → midline), like a standard HD longitudinal display",
    "The most appropriate montage is auto-selected when a file opens (Adaptive Double-Banana for high-density files, classic Double Banana for 10-20) instead of always defaulting to the 10-20 banana",
    "↑ / ↓ arrow keys now raise / lower the waveform sensitivity (matching the on-screen +/- buttons); ←/→ still scroll",
    "Review tab bar can be hidden to reclaim vertical space — when minimized, compact LIBRARY / REPOSITORY buttons flank the SHOW TABS control so you can still jump tabs without expanding",
    "Build Montage button no longer stays lit — it now highlights only while the builder panel is open, like the other toolbar buttons",
    "Collections sidebar show/hide is now a fixed-size folder icon; added a grey floor line + larger bottom buffer under the lowest trace; clearer active-tab highlight",
  ]},
  { version: "v17.6", items: [
    "Two new file-derived montages (in the montage dropdown's 'From file' group): Adaptive Double-Banana builds a longitudinal-bipolar montage from the electrodes actually present — collapsing to the classic banana on a 10-20 file and filling in the intermediate chains on high-density recordings; As Recorded shows the file's own signals one trace each, honoring a pre-montaged EDF whose labels already contain derivations (e.g. Fp1-F3)",
    "Electrode system is now auto-detected from the EDF (counting the scalp electrodes actually present) instead of defaulting to 10-20 — so high-density recordings are correctly labeled 10-10/HD in the Library, the EEG-system options are no longer wrongly greyed out, and existing records are corrected when opened in Review",
  ]},
  { version: "v17.5", items: [
    "Signal-presence check fixed — a channel now counts as having data only if it actually varies (mean-removed σ), not just a nonzero DC baseline; flat/empty channels correctly show no green dot in the Raw EDF list and montage builder. The Raw EDF column now reads σ (µV)",
    "Moved the Raw EDF button up to the header, beside the green EDF indicator next to the filename",
    "Toolbar reorganized into two rows: waveform management (Build Montage, Channels, Denoise, ICA Clean, Pattern Table) on top, analysis & review tools below",
  ]},
  { version: "v17.4", items: [
    "Collections sidebar open/close is now one consistent control — the same thin bar on the right edge in both states, only the chevron flips (‹ minimize / › expand)",
  ]},
  { version: "v17.3", items: [
    "Collections sidebar can be minimized to a vertical rail of one-letter collection icons (click a letter to filter; the state is remembered)",
    "Compliance criteria readout reworked so each rule's name and threshold stack cleanly (no more overlap in the narrow bar), and the criteria list now also appears in the Library sidebar, not just Repository",
  ]},
  { version: "v17.2", items: [
    "NEW Raw EDF inspector (Review toolbar) — a read-only inventory of every signal in the .edf: label, mapped electrode, type, sample rate, units and an RMS-based 'has signal' dot, so you can see exactly what data is available before reading",
    "Full 10-10 electrode recognition — high-density recordings (Fc3, Fcz, Cp4, …) are now read correctly instead of showing half their channels as 'Other'; the montage builder lists only real EEG leads and a green dot means that electrode actually carries data",
  ]},
  { version: "v17.1", items: [
    "Montage: the Build button moved into the Review toolbar (in front of Channels) and resized to match the other controls; the electrode pickers list 10-10 leads ordered anatomically (circumferential front→back, then parasagittal), data-bearing leads first",
    "Added a small bottom buffer so the lowest waveform trace isn't clipped at the screen edge",
    "Bottom navigator spectrogram has much higher colour contrast (robust normalization) so eye blinks and strong artifacts are easy to spot at a glance",
  ]},
  { version: "v17.0", items: [
    "Inter-rater support — more than one annotator can mark the same segment; each annotation records an opaque (hashed) annotator id, a UTC timestamp, optional confidence and the schema version that wrote it, and segments marked by two or more annotators show a concordant / discordant badge. Annotator labels are pseudonymous and never leave your machine; all fields are optional and backward-compatible",
    "Annotation taxonomy now aligns to the ACNS/ILAE standard — added Seizure, LPD, GPD, LRDA and GRDA as first-class descriptive terms (marked ✦) alongside REACT's spike/sharp/sleep markups; each annotation carries a stable code, and older annotation files migrate automatically with no data loss (schema v15.0). REACT remains non-diagnostic — these are technologist markups, not interpretations",
    "DSP pipeline is now unit-tested — the core filters and band-power maths run against golden reference vectors so the signal path can't silently regress",
    "NEW Montage Builder — build a custom bipolar montage from ANY two leads (A − B) right in Review; saved montages persist and are reusable across recordings, and appear at the bottom of the montage dropdown",
    "Topographic map overhaul — clear metric title + units, a labelled colour bar (min/mid/max), a min·mean·max readout, hover-an-electrode values, left↔right asymmetry plus θ/β and slow/fast ratios, and a Relative-% ↔ Absolute-power toggle",
    "Floating panels can now be dragged from anywhere on the box, not just the title bar (buttons, inputs, canvases and links still work normally)",
    "Larger, more legible band-power text in the cross-file Comparison panel",
    "Impedance is no longer entered at import (it's a dynamic value, not a single number) — it's read from the EDF when present and shown via a new Impedance button in Review; compliance keeps the ≤ 5 kΩ cutoff and reports “Unknown” (non-failing) when a file has none",
    "Repository now shows a permanent COMPLIANCE CRITERIA checklist in the left bar so the promotion requirements are always visible",
    "Groundwork for live piEEG acquisition — piEEG (Pi HAT) added to the device list with a real WebSocket-bridge streaming path (samples + impedance) that records straight to EDF",
  ]},
  { version: "v16.6", items: [
    "Removed the eyes-state field — over any awake recording the eyes are effectively always mixed (people blink and look around even on an eyes-closed task), so a single file-level label wasn't meaningful. Dropped from the Library column, the import form, the data sheet, and the compliance checks",
  ]},
  { version: "v16.5", items: [
    "Filenames now lead with just the source acronym (e.g. PHY) instead of the full subject ID — the 6-character hash already uniquely identifies the subject, so the per-subject number was redundant. The Library SUBJECT column shows the source, with the change explained in its hover tooltip and the file-naming key",
    "Library spacing: columns are evenly spread and centered (no longer crowded on the right), with the filename column pulled in snug beside the REVIEW button",
  ]},
  { version: "v16.4", items: [
    "Library rows are now a single line — channel count, duration and size moved to the filename's hover tooltip — and the filename columns are reordered to Subject · Seq · Sex/Age · Date (the full subject ID always shown in totality); the redundant Hash column was dropped",
    "Differential comparison is now one guided button: pick a baseline, then the file to compare — any two recordings, automatically ordered before → after so the change never reads backwards. The clunky toolbar 'pin baseline' control and the separate Diff button are gone",
  ]},
  { version: "v16.3", items: [
    "When a channel's bipolar reference electrode is missing from the EDF, the trace now re-references to the common average (electrode minus the mean of all scalp electrodes) instead of showing it unreferenced — cancels shared artifact while preserving local activity. Shown in cyan as e.g. \"Fp1·avg\"; the Average-Reference montage now computes a true common average too",
    "Library table: a two-tier header groups the filename-decoded columns (Subject, Sex/Age, Type, Hash, Date, Seq) under a \"DECODED FROM FILENAME\" banner, with wider column spacing and the date/sequence now shown as their own columns",
  ]},
  { version: "v16.2", items: [
    "Accessibility: decorative toolbar/icon glyphs are now hidden from screen readers (aria-hidden) so navigation announces the button labels, not the icons",
    "Band-power (qEEG) analysis now uses full-precision 2π in its frequency transform — removes a tiny phase error that was largest in the high-frequency gamma band; validated against analytic reference signals",
  ]},
  { version: "v16.1", items: [
    "Clinical notes panel now opens anchored beneath the Notes button (even on auto-open), not on the left",
    "Per-channel popup has a close (×) button next to the hide toggle",
    "Bottom spectrogram: finer delta–beta frequency resolution (0.5 Hz bins) on a slightly taller strip",
    "Library rows span the full page width, with less-pertinent columns auto-hiding as the window narrows",
  ]},
  { version: "v16.0", items: [
    "Unrecorded sex now shows \"—\" (not \"X\") — sex/age are de-identified research covariates, kept for cohort/sex-stratified work, not PHI",
    "More Library columns: SYSTEM (electrode placement) and EYES (eyes state) alongside SEX/AGE and sample rate",
  ]},
  { version: "v15.9", items: [
    "Library filename-convention key is now a centered, muted background note (was a bright color-coded strip)",
    "Wider Library table with SEX/AGE and sample-RATE columns for more ancillary data at a glance",
  ]},
  { version: "v15.8", items: [
    "DSP correctness pass: wavelet denoiser is now perfect-reconstruction (the inverse transform was distorting clean signal) with symmetric edge handling",
    "High-pass filter is now zero-phase like the low-pass, so HP/LP no longer apply inconsistent phase shift to waveform morphology",
    "ICA artifact removal now uses true PCA whitening (eigendecomposition) instead of per-channel std only — markedly better artifact separation",
  ]},
  { version: "v15.7", items: [
    "New dedicated navigator bar at the bottom of Review — a whole-file spectrogram minimap with annotation/note tick markers, current-view window and live playback head; click or drag to jump anywhere",
    "Moved scrubbing out of the cramped toolbar into that dedicated bar",
  ]},
  { version: "v15.6", items: [
    "Differential analysis: added a CLEAR button to unpin the baseline, and only Baseline (BL) recordings can now be pinned",
    "Library remembers the open collection when you switch to Review and back",
    "Review tab bar has a + button to quick-load another recording into a new tab",
  ]},
  { version: "v15.5", items: [
    "Library now shows an always-visible filename-convention key (SUBJECT-SEX/AGE-TYPE-HASH-DATE-SEQ.edf) with color-coded, hover-explained segments",
  ]},
  { version: "v15.4", items: [
    "Tutorial mode now covers the Library tab — toolbar (import/package/export, search, filters, views), every row column, and the collections sidebar",
    "Tutorial mode now covers the Repository tab — search/filter, file rows, and the Review/Bundle/License/Demote actions",
  ]},
  { version: "v15.3", items: [
    "Tutorial mode now covers the full Review toolbar — montage, EEG system, LFF/HFF/notch filters, epoch length and sensitivity all have hover descriptions",
    "Tutorial help boxes rewritten as fuller \"Name: what it does\" cards with the name bolded",
  ]},
  { version: "v15.2", items: [
    "Tutorial mode — click the REACT EEG brain icon (top-left) to toggle; when lit, hover any control for a help box that follows your cursor",
    "Clinical Notes panel now opens anchored directly beneath the Notes button",
  ]},
  { version: "v15.1", items: [
    "Clearer time axis — brighter labels with tick marks and a readable backing strip, plus stronger per-second gridlines",
    "Epoch length now shown at the bottom-left of the trace (e.g. \"10s/pg\"), not just on the toolbar",
  ]},
  { version: "v15.0", items: [
    "EDF+ event markers (e.g. PhysioNet T0/T1/T2) now appear as muted slate 'EDF events' with their real labels — no longer mislabeled as green user notes",
    "Channel list shows a data-availability dot per channel (green = signal present in the EDF, hollow = absent)",
  ]},
  { version: "v14.9", items: [
    "Smoother epoch scrolling — hold arrow keys to glide continuously at a steady speed (was a choppy 1-second-jump every 180ms)",
    "Consolidated to a single playback engine — fixes spacebar firing two competing loops",
    "Arrow scroll and Enter-to-annotate now pause playback cleanly",
  ]},
  { version: "v14.8", items: [
    "Real-time playback: spacebar or PLAY button scrolls a cursor in absolute file time; manual nav doesn't reset it",
    "Click any channel → compact per-channel menu (sensitivity, LFF, HFF override)",
    "Close any Review tab — the × is now on every tab including the last one",
    "5 seeded PhysioNet recordings (S001 R01+R02 for Subject Timeline demo, plus S004, S007, S010)",
    "Filter range extended to research grade: LFF 0.01–10 Hz, HFF 15–200 Hz",
    "Header waveforms: faster baseline + intermittent spikes/muscle/slow-wave artifacts on ~15% of lines",
    "Waveforms confined to the top half of the header so tabs are never obscured",
  ]},
  { version: "v14.7", items: [
    "Splash now shows the patch log and waits for ENTER (lets the library finish loading)",
    "Toast notification system — replaces blocking alert() dialogs (6 sites)",
  ]},
  { version: "v14.6", items: [
    "EDF+ TAL annotations now imported from source files",
    "Topographic map ~10× faster (single ImageData blit, 1px resolution)",
  ]},
  { version: "v14.5", items: [
    "Library table: SUBJECT + COLLECTIONS columns, tighter uniform spacing",
    "Decorative EEG traces behind the title bar (regenerated each session)",
    "Modal focus traps + ARIA labels (keyboard accessibility baseline)",
    "Single-file HTML demo build via vite-plugin-singlefile",
  ]},
  { version: "v14.0", items: [
    "v14 baseline — compliance checker, Collections, Repository tab",
    "Subject Timeline, printable Data Sheet, patient-package .zip bundles",
  ]},
];

// ── App-global data store (Context) ──
// The library/EDF/annotation/notes/baseline/collection state and the record-lifecycle
// callbacks are app-global and were previously prop-drilled into all four tabs. They now
// live in one context, provided once in ReactEEGApp and consumed via useAppStore() in each
// tab. Tab-specific state (open Review record, tab bar, collection selection) stays as props.
const AppStoreContext = createContext(null);
const useAppStore = () => useContext(AppStoreContext);

// ── Persistence: IndexedDB ──
const EDF_DB_NAME = "ReactEEG_EdfStore";
const EDF_DB_VERSION = 3; // v1 = edfFiles only; v2 = + library/notes/baselines; v3 = + collections
const EDF_DB_STORE = "edfFiles";          // raw EDF binary blobs (kept for back-compat)
const STORE_LIBRARY = "library";          // record metadata array
const STORE_NOTES = "notes";              // per-filename clinical notes
const STORE_BASELINES = "baselines";      // baseline-comparison map
const STORE_COLLECTIONS = "collections";  // collection metadata + filename lists

// ── Default collections seeded on first launch (v14.1) ──
// Start empty — "All Recordings" is implicit; users create and delete collections themselves.
const DEFAULT_COLLECTION_DEFS = [];

// ── Protocol-compliance thresholds (Phase 2 task #4) ──
const COMPLIANCE_MIN_DURATION_SEC = 5 * 60;       // 5 minutes
const COMPLIANCE_MIN_CHANNELS = 19;
const COMPLIANCE_MAX_IMPEDANCE_KOHM = 5;
// PHI red-flag patterns scanned in EDF patient/recording header fields
const COMPLIANCE_PHI_PATTERNS = [
  { name: "SSN-like", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "MRN-like", re: /\b(MRN|mrn)[:\s#]*\d{4,}\b/ },
  { name: "Email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "Phone", re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
];

// Single source of truth for the repository-compliance criteria. checkProtocolCompliance()
// emits one check per id below (labels mirror these), and the Repository sidebar renders this
// list verbatim so users always see exactly what compliance requires.
const COMPLIANCE_CRITERIA = [
  { id: "duration",        label: "Duration ≥ 5 min",                 threshold: "≥ 5 min",              desc: "Minimum recording length for a valid study." },
  { id: "channels",        label: "Channel count ≥ 19",               threshold: "≥ 19 channels",        desc: "Full 10-20 electrode coverage." },
  { id: "impedances",      label: "Impedances ≤ 5 kΩ",                threshold: "≤ 5 kΩ",               desc: "Per-electrode contact quality. Dynamic value — “Unknown” when the EDF doesn’t store it." },
  { id: "activations",     label: "Activation procedures documented", threshold: "documented",           desc: "Hyperventilation / photic / sleep noted (or explicitly “none”)." },
  { id: "conditions",      label: "Recording conditions documented",  threshold: "posture + environment", desc: "Patient posture and environment recorded." },
  { id: "hardware",        label: "Hardware tag present",             threshold: "make + model",         desc: "Acquisition device manufacturer and model identified." },
  { id: "deidentification",label: "De-identification verified",       threshold: "no PHI in header",     desc: "No SSN / MRN / email / phone patterns in the EDF header." },
];

// ── Persistence: legacy localStorage keys (migrated to IDB on first load) ──
const STORAGE_KEYS = {
  LIBRARY: "react_eeg_library",
  NOTES_PREFIX: "react_eeg_notes_",
  BASELINE_MAP: "react_eeg_baseline_map",        // canonical
  BASELINE_MAP_LEGACY: "react-eeg-baselineMap",  // pre-v14, dashed (drop after one release)
  CUSTOM_MONTAGES: "react_eeg_custom_montages",  // user-built bipolar montages [{id,name,pairs}]
  ANNOTATOR: "react_eeg_annotator_label",        // current annotator pseudonym (local only; never exported)
  COLLECTIONS_COLLAPSED: "react_eeg_collections_collapsed", // collections sidebar minimized to an icon rail
  TABS_MINIMIZED: "react_eeg_tabs_minimized",   // top tab bar compacted to reclaim vertical space
};

// Current annotator's pseudonymous label (local convenience) and its opaque hashed id.
// Only the HASH is ever written onto annotations or exported — never the label.
function getAnnotatorLabel() {
  try { return localStorage.getItem(STORAGE_KEYS.ANNOTATOR) || ""; } catch { return ""; }
}
function setAnnotatorLabel(label) {
  try { localStorage.setItem(STORAGE_KEYS.ANNOTATOR, label || ""); } catch {}
}
function currentAnnotatorId() {
  return hashAnnotator(getAnnotatorLabel());
}
// Optional, backward-compatible provenance stamped onto each newly created annotation.
// annotatorId/confidence are omitted when absent so older readers and old files are unaffected.
function annotationProvenance(confidence) {
  const id = currentAnnotatorId();
  return {
    ...(id ? { annotatorId: id } : {}),
    createdAtUtc: new Date().toISOString(),
    ...(confidence ? { confidence } : {}),
    schemaVersion: SCHEMA_VERSION,
  };
}

// Custom montage keys are stored on the `montage` state as "cm:<id>" so they never collide
// with the preset MONTAGE_DEFS keys.
const CUSTOM_MONTAGE_PREFIX = "cm:";
function loadCustomMontages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_MONTAGES);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(m => m && m.id && Array.isArray(m.pairs)) : [];
  } catch { return []; }
}
function saveCustomMontages(list) {
  try { localStorage.setItem(STORAGE_KEYS.CUSTOM_MONTAGES, JSON.stringify(list)); } catch {}
}

// ── DSP defaults ──
// Filter cutoff options offered in the UI dropdowns. Extended in v14.8 to support
// research-grade EEG analysis:
//   • LFF (high-pass) down to 0.01 Hz — captures slow-wave / DC-coupled research recordings.
//     Anything below 1 Hz needs hardware that actually preserves those frequencies AND
//     epoch lengths long enough for the causal-filter transient to settle (~16 s @ 0.01 Hz).
//   • HFF (low-pass) up to 200 Hz — supports high-gamma research at 500 Hz sample rates.
//     Values ≥ Nyquist (sr/2) are silently dropped by butterworthCoeffs, so picking 200 Hz
//     on a 250 Hz file is a no-op (the filter just stops attenuating).
// 0 means "Off" in both arrays.
const LFF_OPTIONS = [0, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 1.6, 5, 10];
const HFF_OPTIONS = [15, 30, 35, 40, 50, 70, 100, 150, 200, 0];

const NOTCH_Q_DEFAULT = 30;
const WAVELET_LEVELS_DEFAULT = 4;
const WAVELET_PADDING_CYCLES = 3;
const ARTIFACT_Z_THRESHOLD = 4.0;
const ICA_ARTIFACT_CORR_THRESHOLD = 0.35;
const ICA_MAX_COMPONENTS = 8;
const ICA_CONVERGENCE_TOL = 1e-6;
const ICA_MAX_ITERATIONS = 50;

// ── UI defaults ──
const SENSITIVITY_MIN = 1;
const SENSITIVITY_MAX = 30;
const SENSITIVITY_BASE = 73.5;     // mm/μV scaling factor (IFCN-style)
// Seconds of REAL neighbouring signal fetched on each side of the visible epoch so the
// HP/LP/notch/wavelet filters settle on actual data before the window we display. Without it,
// filtering each epoch's isolated slice forces the first/last filtered sample to the channel
// baseline (the zero-phase odd reflect-pad), painting a fixed high-frequency comb at the left
// (and right) edge of every epoch. Cropped off after filtering. 3 s covers the 1 Hz default
// HP time constant with margin; only the true file start (no prior data) can still reflect.
const FILTER_GUARD_SEC = 3;
const CHAIN_BREAK_GAP_PX = 8;
const SPLASH_DURATION_MS = 2800;
const NOTES_DEBOUNCE_MS = 1000;
const MULTI_TAB_CAP = 5;
const RECORDING_TIMER_MS = 1000;

// (Record-tab simulation timing constants removed — live signal generation is gone.
// Record is now a passive shell until real BrainFlow / LSL hardware integration lands.)

function openEdfDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EDF_DB_NAME, EDF_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion || 0;
      // v0 → v1: original EDF blob store
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains(EDF_DB_STORE)) db.createObjectStore(EDF_DB_STORE);
      }
      // v1 → v2: add library / notes / baselines stores (replaces localStorage usage)
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(STORE_LIBRARY)) db.createObjectStore(STORE_LIBRARY);
        if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES);
        if (!db.objectStoreNames.contains(STORE_BASELINES)) db.createObjectStore(STORE_BASELINES);
      }
      // v2 → v3: add collections store
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) db.createObjectStore(STORE_COLLECTIONS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Generic IDB key-value helpers (used for library / notes / baselines stores) ──
async function idbGet(storeName, key) {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { console.warn(`IDB get ${storeName}/${key} failed:`, e); return null; }
}

async function idbPut(storeName, key, value) {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) { console.warn(`IDB put ${storeName}/${key} failed:`, e); }
}

/**
 * One-time migration from pre-v14 localStorage keys into the v2 IDB stores.
 * Runs idempotently on every browser launch — only does work if legacy keys exist,
 * removes them after a successful copy. No-op in Tauri mode (Rust handles persistence).
 */
async function migrateLocalStorageToIdb() {
  if (typeof window === "undefined" || window.__TAURI__) return;
  try {
    // Library
    const libraryRaw = localStorage.getItem(STORAGE_KEYS.LIBRARY);
    if (libraryRaw) {
      try {
        const records = JSON.parse(libraryRaw);
        if (Array.isArray(records)) await idbPut(STORE_LIBRARY, "records", records);
      } catch { /* malformed; drop */ }
      localStorage.removeItem(STORAGE_KEYS.LIBRARY);
    }
    // Baseline map (canonical + legacy dashed key)
    for (const key of [STORAGE_KEYS.BASELINE_MAP, STORAGE_KEYS.BASELINE_MAP_LEGACY]) {
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          const map = JSON.parse(raw);
          if (map && typeof map === "object") await idbPut(STORE_BASELINES, "map", map);
        } catch {}
        localStorage.removeItem(key);
      }
    }
    // Per-file clinical notes
    const notesPrefix = STORAGE_KEYS.NOTES_PREFIX;
    const notesKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(notesPrefix)) notesKeys.push(k);
    }
    for (const k of notesKeys) {
      const filename = k.substring(notesPrefix.length);
      const text = localStorage.getItem(k);
      if (text) await idbPut(STORE_NOTES, filename, text);
      localStorage.removeItem(k);
    }
  } catch (e) { console.warn("localStorage→IDB migration failed:", e); }
}

async function saveEdfToDB(filename, arrayBuffer) {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(EDF_DB_STORE, "readwrite");
    tx.objectStore(EDF_DB_STORE).put(arrayBuffer, filename);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("Failed to save EDF to IndexedDB:", e); }
}

async function getEdfRawFromDB(filename) {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(EDF_DB_STORE, "readonly");
    const req = tx.objectStore(EDF_DB_STORE).get(filename);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadAllEdfsFromDB() {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(EDF_DB_STORE, "readonly");
    const store = tx.objectStore(EDF_DB_STORE);
    return new Promise((resolve) => {
      const results = {};
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const parsed = parseEDFFile(cursor.value);
          if (parsed && !parsed.error) results[cursor.key] = parsed;
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => resolve({});
    });
  } catch (e) { return {}; }
}

// ── Record schema migration ──
// Apply on every load. Each case is a forward-only step from the previous version.
// Add a new case whenever SCHEMA_VERSION is bumped and the record shape changes.
/**
 * Migrate a stored library record up to the current SCHEMA_VERSION.
 * @param {object} record — record as loaded from storage (any prior schemaVersion)
 * @returns {object} record stamped with current SCHEMA_VERSION
 */
function migrateRecord(record) {
  if (!record || typeof record !== "object") return record;
  let r = { ...record };
  // Pre-v14 records have no schemaVersion field.
  if (!r.schemaVersion) {
    // Treat as v13 baseline. No structural changes yet — just stamp.
    r.schemaVersion = "v13";
  }
  // v13 → v14: no breaking field changes; just version bump (placeholder for future).
  if (r.schemaVersion === "v13") {
    r.schemaVersion = "v14.0";
  }
  // v14.0 → v14.1: add Repository / Collections / Compliance fields with safe defaults.
  // Existing records become "library" status (not promoted), unassigned to collections,
  // and have no cached compliance result (will be computed on first display).
  if (r.schemaVersion === "v14.0") {
    if (r.repositoryStatus === undefined) r.repositoryStatus = "library";
    if (!Array.isArray(r.collectionIds)) r.collectionIds = [];
    // Drop any stale references to the now-removed default "col-unassigned" collection
    r.collectionIds = r.collectionIds.filter(id => id !== "col-unassigned");
    if (r.complianceResult === undefined) r.complianceResult = null;
    r.schemaVersion = "v14.1";
  }
  // v14.1 → v15.0: annotation taxonomy gained stable ACNS codes. Annotations live in
  // annotationsMap (migrated by migrateAnnotations at each load site), not on the record,
  // so there is no record-field change here — just re-stamp the schema version.
  if (r.schemaVersion === "v14.1") {
    r.schemaVersion = "v15.0";
  }
  return r;
}

// ── Visibility state reducer ──
// Consolidates the previously-fragmented hiddenChannels / userForcedVisible /
// userForcedHidden / cycleState quartet so the auto-hide effect no longer needs
// `eslint-disable-next-line react-hooks/exhaustive-deps`. All transitions are
// pure functions of (state, action) — components dispatch actions instead of
// chaining setState calls.
const VISIBILITY_INITIAL = {
  hidden: new Set(),         // channel names currently hidden
  forcedVisible: new Set(),  // channels the user explicitly chose to show — override auto-hide
  forcedHidden: new Set(),   // channels the user explicitly chose to hide
  cycleState: 0,             // 0=default, 1=EEG only (eyes+EKG hidden), 2=all
};

function visibilityReducer(state, action) {
  switch (action.type) {
    case 'TOGGLE_CHANNEL': {
      const ch = action.ch;
      const willShow = state.hidden.has(ch);
      const hidden = new Set(state.hidden);
      const forcedVisible = new Set(state.forcedVisible);
      const forcedHidden = new Set(state.forcedHidden);
      if (willShow) { hidden.delete(ch); forcedVisible.add(ch); forcedHidden.delete(ch); }
      else          { hidden.add(ch);    forcedHidden.add(ch);  forcedVisible.delete(ch); }
      return { hidden, forcedVisible, forcedHidden, cycleState: 0 };
    }
    case 'CYCLE': {
      const { allChannels } = action;
      const forcedVisible = new Set();
      const forcedHidden = new Set();
      let hidden, cycleState;
      if (state.cycleState === 0) {
        // → State 1: Show all EEG, hide eyes + EKG
        hidden = new Set(allChannels.filter(ch => EYE_CHANNELS.has(ch) || ch === 'EKG'));
        cycleState = 1;
      } else if (state.cycleState === 1) {
        // → State 2: Show eyes too (only EKG hidden)
        hidden = new Set(allChannels.filter(ch => ch === 'EKG'));
        cycleState = 2;
      } else {
        // → State 0: Hide ALL
        hidden = new Set(allChannels);
        cycleState = 0;
      }
      return { hidden, forcedVisible, forcedHidden, cycleState };
    }
    case 'AUTO_HIDE_BY_DATA': {
      const { channelsWithData, allChannels } = action;
      // No EDF data — show all (flat lines)
      if (channelsWithData.size === 0) {
        return { ...state, hidden: new Set() };
      }
      // Real EDF — auto-hide channels not in EDF, respecting user-forced overrides
      const hidden = new Set();
      allChannels.forEach(ch => {
        if (state.forcedHidden.has(ch)) { hidden.add(ch); return; }
        if (state.forcedVisible.has(ch)) return;
        if (!channelsWithData.has(ch)) hidden.add(ch);
      });
      return { ...state, hidden };
    }
    case 'SET_AVAILABLE_ELECTRODES': {
      const { electrodeSet, allChannels } = action;
      if (!electrodeSet) return state;
      const hwSet = new Set([...electrodeSet].map(e => e.toUpperCase()));
      const hidden = new Set();
      allChannels.forEach(ch => {
        if (state.forcedVisible.has(ch)) return;
        if (state.forcedHidden.has(ch)) { hidden.add(ch); return; }
        if (AUX_CHANNELS.has(ch)) { hidden.add(ch); return; }
        if (ch.includes('-')) {
          const parts = ch.split('-');
          const hasFirst = hwSet.has(parts[0].toUpperCase());
          const ref = parts[parts.length - 1];
          const hasSecond = ref === 'Avg' || ref === 'Cz' || hwSet.has(ref.toUpperCase());
          if (!hasFirst || !hasSecond) hidden.add(ch);
        } else {
          if (!hwSet.has(ch.toUpperCase())) hidden.add(ch);
        }
      });
      return { ...state, hidden };
    }
    default: return state;
  }
}

/**
 * Build a per-patient bundle (.zip) from a subject's promoted recordings.
 * Output structure:
 *   manifest.json                       — version metadata + per-file index
 *   data/<filename>.edf                 — raw EDF binaries
 *   annotations/<filename>_annotations.json — annotation sidecars (when present)
 *   notes/<filename>_notes.txt          — clinical notes (when present)
 *
 * Returns a Blob suitable for download, or null if no records have EDF data.
 */
async function buildPatientPackageZip({ subjectHash, records, annotationsMap, clinicalNotesMap }) {
  const subjectRecords = records.filter(r => r.subjectHash === subjectHash && r.repositoryStatus === "promoted");
  if (subjectRecords.length === 0) return { error: "No promoted recordings for this subject." };

  const zip = new JSZip();
  const dataFolder = zip.folder("data");
  const annotFolder = zip.folder("annotations");
  const notesFolder = zip.folder("notes");
  const fileEntries = [];

  for (const r of subjectRecords) {
    const rawEdf = await getEdfRawFromDB(r.filename);
    if (!rawEdf) continue; // skip records without persisted EDF binary
    dataFolder.file(r.filename, rawEdf);

    const base = r.filename.replace(/\.edf$/i, "");
    const anns = annotationsMap?.[r.filename] || [];
    if (anns.length > 0) {
      annotFolder.file(`${base}_annotations.json`, JSON.stringify(buildAnnotationSidecar(anns, r.filename), null, 2));
    }
    const notes = clinicalNotesMap?.[r.filename];
    if (notes) notesFolder.file(`${base}_notes.txt`, notes);

    fileEntries.push({
      filename: r.filename, studyType: r.studyType, date: r.date,
      channels: r.channels, sampleRate: r.sampleRate, duration: r.duration,
      durationSec: r.durationSec || null, fileSize: r.fileSize, sex: r.sex || null, age: r.age ?? null,
      pipelineVersion: r.pipelineVersion, schemaVersion: r.schemaVersion,
      complianceCompliant: r.complianceResult?.compliant ?? null,
      collectionIds: r.collectionIds || [],
    });
  }

  if (fileEntries.length === 0) return { error: "No EDF binaries available for this subject's promoted recordings." };

  const manifest = {
    kind: "react-eeg-patient-package",
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    subjectHash,
    bundledAt: new Date().toISOString(),
    fileCount: fileEntries.length,
    files: fileEntries,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { blob, manifest };
}

/**
 * Parse a patient-package .zip back into importable records.
 * Returns { manifest, imports: [{ filename, edfArrayBuffer, annotations, notes, metadata }] }
 * or { error: "..." } on failure.
 */
async function parsePatientPackageZip(file) {
  let zip;
  try { zip = await JSZip.loadAsync(file); }
  catch (e) { return { error: "File is not a valid .zip archive." }; }

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) return { error: "Not a REACT EEG patient package — manifest.json is missing." };
  let manifest;
  try { manifest = JSON.parse(await manifestFile.async("text")); }
  catch (e) { return { error: "manifest.json is malformed." }; }
  if (manifest.kind !== "react-eeg-patient-package") {
    return { error: `Unrecognized package kind: ${manifest.kind || "unknown"}` };
  }

  const dataFolder = zip.folder("data");
  const annotFolder = zip.folder("annotations");
  const notesFolder = zip.folder("notes");
  const imports = [];

  for (const entry of (manifest.files || [])) {
    const edfFile = dataFolder?.file(entry.filename);
    if (!edfFile) continue;
    const edfArrayBuffer = await edfFile.async("arraybuffer");
    const base = entry.filename.replace(/\.edf$/i, "");

    let annotations = [];
    const annotFile = annotFolder?.file(`${base}_annotations.json`);
    if (annotFile) {
      try {
        const parsed = JSON.parse(await annotFile.async("text"));
        annotations = migrateAnnotations(Array.isArray(parsed) ? parsed : (parsed.annotations || []));
      } catch (e) { /* malformed annotations — skip */ }
    }

    let notes = "";
    const notesFile = notesFolder?.file(`${base}_notes.txt`);
    if (notesFile) notes = await notesFile.async("text");

    imports.push({ filename: entry.filename, edfArrayBuffer, annotations, notes, metadata: entry });
  }

  return { manifest, imports };
}

/**
 * Build a printable single-page HTML Data Sheet for one recording (Phase 2 #5).
 * Returns a complete self-contained HTML string with inlined styles and SVG.
 * Recipient opens it in any browser and prints; no JavaScript required.
 *
 * @param {object} record — library record (must include compliance + hardware fields)
 * @param {object|null} edfData — parsed EDF for spectral / topographic content
 * @returns {string} HTML document
 */
function generateDataSheetHTML(record, edfData) {
  const safe = (s) => String(s ?? "—").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const compliance = record?.complianceResult || checkProtocolCompliance(record, edfData || null);
  const metrics = edfData ? computeRecordMetrics(edfData) : { peakAlphaFreq: null, thetaBetaRatio: null, slowingIndex: null, asymmetry: null, slowingByElectrode: {}, alphaByElectrode: {} };
  const sr = edfData?.sampleRate || record?.sampleRate || 256;

  // Global band power (averaged across all data channels)
  const globalBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
  let chCount = 0;
  if (edfData?.channelData) {
    edfData.channelLabels.forEach((label, idx) => {
      const elec = extractElectrodeName(label);
      if (!elec) return;
      const data = edfData.channelData[idx];
      if (!data || data.length < 64) return;
      const b = computeBands(data.subarray(0, Math.min(2048, data.length)), sr);
      if (b.total <= 0) return;
      globalBands.delta += b.delta / b.total;
      globalBands.theta += b.theta / b.total;
      globalBands.alpha += b.alpha / b.total;
      globalBands.beta  += b.beta  / b.total;
      globalBands.gamma += b.gamma / b.total;
      chCount++;
    });
    if (chCount > 0) {
      ["delta","theta","alpha","beta","gamma"].forEach(k => { globalBands[k] = globalBands[k] / chCount * 100; });
      globalBands.total = globalBands.delta + globalBands.theta + globalBands.alpha + globalBands.beta + globalBands.gamma;
    }
  }

  // Per-channel band table rows
  const perChannelRows = [];
  if (edfData?.channelData) {
    edfData.channelLabels.forEach((label, idx) => {
      const elec = extractElectrodeName(label);
      if (!elec) return;
      const data = edfData.channelData[idx];
      if (!data || data.length < 64) return;
      const b = computeBands(data.subarray(0, Math.min(2048, data.length)), sr);
      if (b.total <= 0) return;
      const pct = (k) => ((b[k] / b.total) * 100).toFixed(1);
      perChannelRows.push({
        elec, delta: +pct("delta"), theta: +pct("theta"),
        alpha: +pct("alpha"), beta: +pct("beta"), gamma: +pct("gamma"),
      });
    });
  }

  // Topographic alpha map as SVG (IDW-rasterized into 32x32 grid for compact inline embed)
  const topoSize = 200, gridStep = 4;
  let topoCells = "";
  const alphaVals = Object.values(metrics.alphaByElectrode || {});
  if (alphaVals.length > 0) {
    const vMin = Math.min(...alphaVals), vMax = Math.max(...alphaVals);
    const cx = topoSize/2, cy = topoSize/2, radius = topoSize*0.44;
    for (let py = 0; py < topoSize; py += gridStep) {
      for (let px = 0; px < topoSize; px += gridStep) {
        const dx = px - cx, dy = py - cy;
        if (Math.sqrt(dx*dx + dy*dy) > radius) continue;
        const nx = 0.5 + (dx/radius) * 0.47;
        const ny = 0.5 + (dy/radius) * 0.47;
        const val = interpolateIDW(nx, ny, metrics.alphaByElectrode, 2.5);
        topoCells += `<rect x="${px}" y="${py}" width="${gridStep}" height="${gridStep}" fill="${valueToColor(val, vMin, vMax, "heat")}"/>`;
      }
    }
    topoCells += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#444" stroke-width="1.5"/>`;
  }

  // Stacked-bar helper (returns SVG for one stacked horizontal bar)
  const stackedBar = (bands, width = 240, height = 14) => {
    const colors = { delta: "#3b82f6", theta: "#10b981", alpha: "#facc15", beta: "#f59e0b", gamma: "#ef4444" };
    const sum = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;
    if (sum <= 0) return `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#eee"/></svg>`;
    let x = 0; let segments = "";
    ["delta","theta","alpha","beta","gamma"].forEach(k => {
      const w = (bands[k] / sum) * width;
      segments += `<rect x="${x}" y="0" width="${w}" height="${height}" fill="${colors[k]}"><title>${k}: ${bands[k].toFixed(1)}%</title></rect>`;
      x += w;
    });
    return `<svg width="${width}" height="${height}" style="display:block">${segments}</svg>`;
  };

  // Normative-range pill helper for quantitative indices
  const normPill = (label, value, units, lo, hi, fmt = (v) => v?.toFixed(1)) => {
    if (value == null) return `<div class="qi"><div class="qi-label">${label}</div><div class="qi-value">—</div><div class="qi-norm">norm: ${lo}–${hi} ${units}</div></div>`;
    const inRange = value >= lo && value <= hi;
    const color = inRange ? "#0a6e3a" : "#9a1f1f";
    return `<div class="qi"><div class="qi-label">${label}</div><div class="qi-value" style="color:${color}">${fmt(value)} ${units}</div><div class="qi-norm">norm: ${lo}–${hi} ${units}</div></div>`;
  };

  // Compliance verdict
  const verdict = compliance.compliant ? "COMPLIANT" : "NON-COMPLIANT";
  const verdictColor = compliance.compliant ? "#0a6e3a" : "#9a1f1f";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>REACT EEG Data Sheet — ${safe(record.filename)}</title>
<style>
  @page { size: letter; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; background: #fff; margin: 0; padding: 16px 20px; font-size: 11px; line-height: 1.4; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 700; letter-spacing: 0.04em; }
  h2 { font-size: 11px; margin: 14px 0 6px; font-weight: 700; letter-spacing: 0.1em; color: #555; text-transform: uppercase; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 12px; }
  .header-left h1 { color: #1a4a54; }
  .header-meta { font-size: 10px; color: #555; line-height: 1.6; }
  .header-meta b { color: #111; font-weight: 600; }
  .header-right { text-align: right; font-size: 10px; color: #555; line-height: 1.5; }
  .header-right .verdict { display: inline-block; padding: 4px 10px; color: #fff; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; margin-top: 4px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .info-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 10px; border-bottom: 1px dotted #ddd; }
  .info-row b { color: #555; font-weight: 600; }
  .check { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 10px; }
  .check-pass { color: #0a6e3a; }
  .check-warn { color: #b67d00; }
  .check-fail { color: #9a1f1f; }
  .check-unknown { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; }
  th, td { padding: 3px 6px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f4f4f4; font-weight: 700; font-size: 9px; color: #555; }
  td.num { text-align: right; font-family: 'JetBrains Mono', monospace; }
  .qi { background: #f8f8f8; padding: 8px 10px; border-left: 3px solid #1a4a54; }
  .qi-label { font-size: 9px; color: #666; letter-spacing: 0.08em; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
  .qi-value { font-size: 16px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
  .qi-norm { font-size: 9px; color: #888; margin-top: 2px; }
  .legend { display: flex; gap: 12px; font-size: 9px; color: #555; margin-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend i { display: inline-block; width: 10px; height: 10px; }
  .disclaimer { margin-top: 18px; padding: 10px 12px; background: #fff8e1; border-left: 3px solid #b67d00; font-size: 9px; color: #5a3e00; line-height: 1.5; }
  .footer { margin-top: 14px; font-size: 8px; color: #888; text-align: center; border-top: 1px solid #ccc; padding-top: 6px; }
</style></head><body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <h1>REACT EEG — Data Sheet</h1>
    <div class="header-meta">
      <div><b>Filename:</b> ${safe(record.filename)}</div>
      <div><b>Subject hash:</b> ${safe(record.subjectHash)} &nbsp; <b>Study type:</b> ${safe(STUDY_TYPES[record.studyType]?.label || record.studyType)}</div>
      <div><b>Date:</b> ${safe(record.date)} &nbsp; <b>Sex:</b> ${safe(record.sex)} &nbsp; <b>Age:</b> ${safe(record.age)}</div>
      <div><b>Channels:</b> ${safe(record.channels)} &nbsp; <b>Sample rate:</b> ${safe(record.sampleRate)} Hz &nbsp; <b>Duration:</b> ${safe(record.durationSec ? `${(record.durationSec/60).toFixed(1)} min` : `${record.duration} min`)}</div>
    </div>
  </div>
  <div class="header-right">
    Generated ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}<br/>
    pipeline ${PIPELINE_VERSION} · schema ${SCHEMA_VERSION}<br/>
    <span class="verdict" style="background:${verdictColor}">${verdict}</span>
  </div>
</div>

<!-- 1. Quality summary -->
<h2>1. Protocol-Compliance Summary</h2>
<div class="grid-3">
  <div class="qi"><div class="qi-label">Pass</div><div class="qi-value" style="color:#0a6e3a">${compliance.passCount}</div></div>
  <div class="qi"><div class="qi-label">Warn</div><div class="qi-value" style="color:#b67d00">${compliance.warnCount}</div></div>
  <div class="qi"><div class="qi-label">Fail</div><div class="qi-value" style="color:#9a1f1f">${compliance.failCount}</div></div>
</div>
<div style="margin-top:8px">
  ${compliance.checks.map(c => {
    const cls = `check-${c.status}`;
    const glyph = { pass: "✓", warn: "!", fail: "✗", unknown: "?" }[c.status] || "·";
    return `<div class="check ${cls}"><b>${glyph}</b> <span>${safe(c.name)}</span> <span style="color:#888;margin-left:auto">${safe(c.message)}</span></div>`;
  }).join("")}
</div>

<!-- 2. Recording conditions + hardware -->
<h2>2. Recording Conditions &amp; Hardware</h2>
<div class="grid-2">
  <div>
    <div class="info-row"><b>Consciousness</b><span>${safe(record.consciousnessLevel)}</span></div>
    <div class="info-row"><b>Posture</b><span>${safe(record.posture)}</span></div>
    <div class="info-row"><b>Environment</b><span>${safe(record.environmentNoise)}</span></div>
    <div class="info-row"><b>Activation procedures</b><span>${safe((record.activationProcedures || []).join(", "))}</span></div>
  </div>
  <div>
    <div class="info-row"><b>Manufacturer</b><span>${safe(record.hardware?.manufacturer)}</span></div>
    <div class="info-row"><b>Model</b><span>${safe(record.hardware?.model)}</span></div>
    <div class="info-row"><b>ADC resolution</b><span>${safe(record.hardware?.adcResolution)} bit</span></div>
    <div class="info-row"><b>Electrode type</b><span>${safe(record.hardware?.electrodeType)}</span></div>
    <div class="info-row"><b>FDA cleared</b><span>${record.hardware?.fdaCleared ? "Yes" : "No"}</span></div>
  </div>
</div>

<!-- 3. Global band power -->
<h2>3. Global Band Power Distribution</h2>
${stackedBar(globalBands, 540, 22)}
<div class="legend">
  <span><i style="background:#3b82f6"></i>Delta (${globalBands.delta.toFixed(1)}%)</span>
  <span><i style="background:#10b981"></i>Theta (${globalBands.theta.toFixed(1)}%)</span>
  <span><i style="background:#facc15"></i>Alpha (${globalBands.alpha.toFixed(1)}%)</span>
  <span><i style="background:#f59e0b"></i>Beta (${globalBands.beta.toFixed(1)}%)</span>
  <span><i style="background:#ef4444"></i>Gamma (${globalBands.gamma.toFixed(1)}%)</span>
</div>

<!-- 4. Per-channel spectral table -->
<h2>4. Per-Channel Spectral Distribution</h2>
<table>
  <thead><tr><th>Electrode</th><th>Δ %</th><th>θ %</th><th>α %</th><th>β %</th><th>γ %</th><th style="width:140px">Distribution</th></tr></thead>
  <tbody>
    ${perChannelRows.map(r => `<tr>
      <td><b>${safe(r.elec)}</b></td>
      <td class="num">${r.delta.toFixed(1)}</td>
      <td class="num">${r.theta.toFixed(1)}</td>
      <td class="num">${r.alpha.toFixed(1)}</td>
      <td class="num">${r.beta.toFixed(1)}</td>
      <td class="num">${r.gamma.toFixed(1)}</td>
      <td>${stackedBar(r, 140, 10)}</td>
    </tr>`).join("")}
  </tbody>
</table>

<!-- 5. Topographic alpha map -->
<h2>5. Topographic Alpha Distribution</h2>
<div style="display:flex;gap:20px;align-items:center">
  <svg width="${topoSize}" height="${topoSize}" style="background:#fafafa;border:1px solid #ddd">${topoCells}</svg>
  <div style="font-size:10px;color:#555;line-height:1.6">
    Relative alpha-band power (8–13 Hz) projected to scalp topography via inverse-distance-weighted interpolation (p = 2.5).
    Warmer colors indicate proportionally higher alpha power at that scalp location.
    A normal awake eyes-closed recording shows posterior-dominant alpha (red/orange in the occipital region).
  </div>
</div>

<!-- 6. Quantitative indices -->
<h2>6. Quantitative Indices</h2>
<div class="grid-3">
  ${normPill("Peak alpha frequency", metrics.peakAlphaFreq, "Hz", 8.5, 12.0, v => v?.toFixed(2))}
  ${normPill("Theta / beta ratio",   metrics.thetaBetaRatio, "",   0.5, 2.5,  v => v?.toFixed(2))}
  ${normPill("Slowing index (Δ+θ)",  metrics.slowingIndex,   "%",  20,  60,   v => v?.toFixed(1))}
</div>
<div style="margin-top:10px">
  ${normPill("Hemispheric asymmetry (alpha L−R)", metrics.asymmetry, "%", -10, 10, v => (v >= 0 ? "+" : "") + v?.toFixed(1))}
</div>

<!-- 7. Disclaimer -->
<div class="disclaimer">
  <b>Disclaimer.</b> This Data Sheet is a quantitative summary of digitally recorded EEG. It is <b>not</b> a clinical
  interpretation, diagnosis, or recommendation. All findings should be reviewed by a qualified electroencephalographer
  before any clinical decision is made. Normative ranges shown are illustrative; consult published normative datasets
  appropriate to the subject's age, recording conditions, and reference montage before drawing conclusions.
</div>

<div class="footer">
  REACT EEG · ${APP_VERSION} · pipeline ${PIPELINE_VERSION} · schema ${SCHEMA_VERSION} · generated ${new Date().toISOString()}
</div>

</body></html>`;
}

/**
 * Materialize the default seed collections defined in DEFAULT_COLLECTION_DEFS.
 * Called from App init the first time `loadCollections()` returns an empty list.
 * Each seeded collection gets a creation timestamp + the current schema version.
 * @returns {Array} array of fully-formed Collection objects, ready for IDB save
 */
function seedDefaultCollections() {
  const now = new Date().toISOString();
  return DEFAULT_COLLECTION_DEFS.map(def => ({
    ...def,
    dateRange: { start: null, end: null },
    filenames: [],
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    isSeed: true,
  }));
}

/**
 * Run protocol-compliance checks on a record (with optional parsed EDF data
 * for header inspection). Pure function — same input always returns same output.
 * The eight checks correspond to Phase 2 task #4.
 *
 * @param {object} record — library record (post-migration; expects v14.1 schema)
 * @param {object|null} edfData — parsed EDF data, used to scan header for PHI
 * @returns {{ compliant: boolean, passCount: number, warnCount: number, failCount: number, unknownCount: number, checks: Array }}
 */
function checkProtocolCompliance(record, edfData = null) {
  const checks = [];
  const push = (id, name, status, value, threshold, message) =>
    checks.push({ id, name, status, value, threshold, message });

  // 1. Duration ≥ 5 minutes
  const durSec = record?.durationSec ?? (typeof record?.duration === "number" ? record.duration * 60 : null);
  if (durSec == null) push("duration", "Duration ≥ 5 min", "unknown", null, COMPLIANCE_MIN_DURATION_SEC, "No duration recorded.");
  else if (durSec >= COMPLIANCE_MIN_DURATION_SEC) push("duration", "Duration ≥ 5 min", "pass", durSec, COMPLIANCE_MIN_DURATION_SEC, `${(durSec/60).toFixed(1)} min recorded.`);
  else push("duration", "Duration ≥ 5 min", "fail", durSec, COMPLIANCE_MIN_DURATION_SEC, `Only ${(durSec/60).toFixed(1)} min — threshold is 5 min.`);

  // 2. Channel count ≥ 19 (10-20 minimum)
  const chCount = record?.channels ?? null;
  if (chCount == null) push("channels", "Channel count ≥ 19", "unknown", null, COMPLIANCE_MIN_CHANNELS, "No channel count recorded.");
  else if (chCount >= COMPLIANCE_MIN_CHANNELS) push("channels", "Channel count ≥ 19", "pass", chCount, COMPLIANCE_MIN_CHANNELS, `${chCount} channels.`);
  else push("channels", "Channel count ≥ 19", "fail", chCount, COMPLIANCE_MIN_CHANNELS, `Only ${chCount} channels — minimum is 19.`);

  // 3. Impedances ≤ 5 kΩ. Impedance is a dynamic, per-electrode value — it is read from
  // the EDF when the recording stored it, otherwise from an acquired record. Standard EDF
  // rarely carries impedance, so "unknown" (below) is the common, non-failing outcome.
  const imps = edfData?.impedances || record?.impedances || record?.acquiredImpedances || null;
  if (!imps || (Array.isArray(imps) && imps.length === 0)) {
    push("impedances", "Impedances ≤ 5 kΩ", "unknown", null, COMPLIANCE_MAX_IMPEDANCE_KOHM, "Impedance data not stored with this record.");
  } else {
    const values = Array.isArray(imps) ? imps.map(x => x?.value ?? x).filter(v => typeof v === "number") : Object.values(imps);
    const maxImp = values.length ? Math.max(...values) : null;
    if (maxImp == null) push("impedances", "Impedances ≤ 5 kΩ", "unknown", null, COMPLIANCE_MAX_IMPEDANCE_KOHM, "Impedance data malformed.");
    else if (maxImp <= COMPLIANCE_MAX_IMPEDANCE_KOHM) push("impedances", "Impedances ≤ 5 kΩ", "pass", maxImp, COMPLIANCE_MAX_IMPEDANCE_KOHM, `Max impedance ${maxImp.toFixed(1)} kΩ.`);
    else push("impedances", "Impedances ≤ 5 kΩ", "fail", maxImp, COMPLIANCE_MAX_IMPEDANCE_KOHM, `Max impedance ${maxImp.toFixed(1)} kΩ — threshold is 5 kΩ.`);
  }

  // 4. Activation procedures documented (allow ["none"] as documented)
  const acts = record?.activationProcedures;
  if (!Array.isArray(acts) || acts.length === 0) push("activations", "Activation procedures documented", "fail", null, "array", "Field is empty.");
  else push("activations", "Activation procedures documented", "pass", acts.join(", "), "array", `Procedures: ${acts.join(", ")}.`);

  // 6. Recording conditions documented (posture + environment)
  const conds = [record?.posture, record?.environmentNoise].filter(Boolean);
  if (conds.length < 2) push("conditions", "Recording conditions documented", conds.length === 0 ? "fail" : "warn", conds.join(", ") || null, "posture+environment", `Missing ${2 - conds.length} of 2 condition fields.`);
  else push("conditions", "Recording conditions documented", "pass", conds.join(", "), "posture+environment", "Posture and environment both documented.");

  // 7. Hardware tag present
  const hw = record?.hardware;
  if (!hw || !hw.manufacturer || !hw.model) push("hardware", "Hardware tag present", "fail", null, "manufacturer+model", "Hardware manufacturer or model missing.");
  else push("hardware", "Hardware tag present", "pass", `${hw.manufacturer} ${hw.model}`, "manufacturer+model", `Recorded with ${hw.manufacturer} ${hw.model}.`);

  // 8. De-identification: scan EDF patient/recording ID fields for PHI patterns
  const phiTargets = [edfData?.patientId, edfData?.recordingId, record?.subjectId].filter(Boolean).join(" | ");
  if (!phiTargets) {
    push("deidentification", "De-identification verified", "unknown", null, "no PHI patterns", "No EDF header data available to scan.");
  } else {
    const hits = COMPLIANCE_PHI_PATTERNS.filter(p => p.re.test(phiTargets));
    if (hits.length === 0) push("deidentification", "De-identification verified", "pass", null, "no PHI patterns", "No SSN / MRN / email / phone patterns detected in EDF header.");
    else push("deidentification", "De-identification verified", "fail", hits.map(h => h.name).join(", "), "no PHI patterns", `Possible PHI detected: ${hits.map(h => h.name).join(", ")}.`);
  }

  let passCount = 0, warnCount = 0, failCount = 0, unknownCount = 0;
  for (const c of checks) {
    if (c.status === "pass") passCount++;
    else if (c.status === "warn") warnCount++;
    else if (c.status === "fail") failCount++;
    else unknownCount++;
  }
  // Compliant = no failures (warnings + unknowns are acceptable for promotion)
  const compliant = failCount === 0;
  return { compliant, passCount, warnCount, failCount, unknownCount, checks, computedAt: new Date().toISOString(), pipelineVersion: PIPELINE_VERSION };
}

// ── Utility: deterministic hash for de-identification ──
// Uses cyrb53 (well-distributed 53-bit hash, public domain — bryc/code) instead of
// the original djb2 variant, which collided badly on short similar inputs like
// "PHY-S001" / "PHY-S004" / ... (the high-order hex digits stayed nearly identical).
function hashSubjectId(id, salt = "REACT-EEG-2026") {
  const str = salt + id;
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).toUpperCase().padStart(6, "0").slice(-6);
}

// ── Study type codes ──
const STUDY_TYPES = {
  BL: { label: "Baseline", color: "#3B82F6" },
  PI: { label: "Post-Injury", color: "#EF4444" },
  FU: { label: "Follow-Up", color: "#10B981" },
  RT: { label: "Routine EEG", color: "#8B5CF6" },
  LT: { label: "Long-Term", color: "#6366F1" },
};

function generateFilename(subjectId, studyType, date, sex = "", age = "", seq = 1) {
  // The 6-char hash is derived from the FULL subject ID and is what uniquely + deterministically
  // identifies the subject (same subject → same hash). So the visible leading segment only needs
  // the SOURCE acronym (e.g. "PHY-S001" → "PHY") for provenance — the per-subject number is
  // redundant and is dropped, keeping filenames shorter.
  const hash = hashSubjectId(subjectId);
  const cleanId = subjectId.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase();
  const source = cleanId.split("-")[0] || cleanId;
  const d = date.replace(/-/g, "");
  const demo = (sex || age) ? `-${(sex || "").toUpperCase()}${age}` : "";
  return `${source}${demo}-${studyType}-${hash}-${d}-${String(seq).padStart(3, "0")}.edf`;
}

// Decode a REACT-convention filename (SUBJECT[-SEX/AGE]-TYPE-HASH-DATE-SEQ.edf) into the segments
// that aren't stored as standalone record fields — the subject ID (first token) and sequence
// number (last token); DATE (second-to-last) is reformatted YYYYMMDD → YYYY-MM-DD. Falls back to
// "—" for non-conforming filenames. Sex/Age, Type and Hash come straight from the record fields.
function decodeReactFilename(r) {
  const out = { subjectId: "—", source: "—", seq: "—", date: r.date || "—" };
  const base = (r.filename || "").replace(/\.edf$/i, "");
  const parts = base.split("-");
  // Parse from the END — the trailing four segments are always TYPE-HASH-DATE-SEQ. The subject ID
  // may itself contain hyphens (e.g. PHY-S010), so reconstruct it from all the leading segments
  // rather than assuming parts[0]. Need ≥5 segments (≥1 subject + the 4 fixed tail).
  if (parts.length >= 5) {
    out.seq = parts[parts.length - 1] || "—";
    const dateTok = parts[parts.length - 2];
    if (/^\d{8}$/.test(dateTok)) out.date = `${dateTok.slice(0,4)}-${dateTok.slice(4,6)}-${dateTok.slice(6,8)}`;
    // Leading segments = subject ID (+ optional "-SEXAGE" suffix). Strip the suffix using the
    // record's sex/age fields so a hyphenated subject ID survives intact.
    let subjectPart = parts.slice(0, parts.length - 4).join("-");
    const demo = `${(r.sex || "").toUpperCase()}${r.age != null ? r.age : ""}`;
    if (demo && subjectPart.toUpperCase().endsWith("-" + demo)) {
      subjectPart = subjectPart.slice(0, subjectPart.length - demo.length - 1);
    }
    out.subjectId = subjectPart || "—";
    // Source acronym = the leading token of the subject part (e.g. "PHY-S001" → "PHY", and a
    // new-convention "PHY" → "PHY"). This is what the Library shows; the hash identifies the subject.
    out.source = (subjectPart.split("-")[0] || subjectPart) || "—";
  }
  return out;
}

// Parse EDF+ patient field: "subjectcode sex birthdate name"
function parseEdfPatientField(field) {
  if (!field || !field.trim()) return { sex: null, age: null };
  const parts = field.trim().split(/\s+/);
  let sex = null, age = null;
  if (parts.length >= 2 && /^[MFX]$/i.test(parts[1])) sex = parts[1].toUpperCase();
  if (parts.length >= 3 && /^\d{2}-[A-Z]{3}-\d{4}$/i.test(parts[2])) {
    const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    const [dd, mmm, yyyy] = parts[2].split("-");
    const mo = months[mmm.toUpperCase()];
    if (mo !== undefined) {
      const bd = new Date(parseInt(yyyy), mo, parseInt(dd));
      const now = new Date();
      age = Math.floor((now - bd) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 0 || age > 120) age = null;
    }
  }
  return { sex, age };
}

// Extract the subject ID and patient hash from filename
// e.g. "FB001-M32-BL-42C1-20260301-001.edf" or "FB001-BL-42C1-20260301-001.edf"
function extractPatientHash(filename) {
  const m = filename?.match(/^(.+?)(?:-[MFX]\d{0,3})?-\w{2,4}-([A-F0-9]{4})-\d{8}-/i);
  return m ? m[2].toUpperCase() : null;
}
function extractSubjectId(filename) {
  const m = filename?.match(/^(.+?)(?:-[MFX]\d{0,3})?-\w{2,4}-[A-F0-9]{4}-\d{8}-/i);
  return m ? m[1] : null;
}

// ── Electrode sets per EEG system ──
const ELECTRODE_SETS = {
  "10-20": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"],
  "hd-40": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","FT9","FT10","TP9","TP10","AF3","AF4","PO3","PO4","POz","Oz","Iz"],
  "10-10": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","FT9","FT10","TP9","TP10","AF3","AF4","AF7","AF8","PO3","PO4","POz","Oz","Iz",
    "F1","F2","F5","F6","C1","C2","C5","C6","P1","P2","P5","P6","CPz","FCz","FPz","TP7","TP8","PO7","PO8","P9","P10",
    "F9","F10","FT7","FT8","CP3","CP4","T9","T10","P7","P8","O9","O10"],
  "custom": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"],
};

// ── OpenBCI hardware channel-to-electrode mappings ──
const OPENBCI_CHANNEL_MAP = {
  "openbci-cyton-8":  ["Fp1","Fp2","C3","C4","P3","P4","O1","O2"],
  "openbci-cyton-16": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6"],
};

// ── Montage definitions per EEG system ──
const MONTAGE_DEFS = {
  "bipolar-longitudinal": {
    label: "Bipolar Longitudinal (Double Banana)",
    "10-20": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-FC1","FC1-CP1","CP1-PO3","AF4-FC2","FC2-CP2","CP2-PO4","FC5-CP5","FC6-CP6","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-F1","F1-FC1","FC1-C1","C1-CP1","CP1-P1","AF4-F2","F2-FC2","FC2-C2","C2-CP2","CP2-P2",
      "AF7-F5","F5-FC5","FC5-C5","C5-CP5","AF8-F6","F6-FC6","FC6-C6","C6-CP6","POz-Oz","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  "bipolar-transverse": {
    label: "Bipolar Transverse",
    "10-20": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "FC5-FC1","FC1-FC2","FC2-FC6","CP5-CP1","CP1-CP2","CP2-CP6","PO3-POz","POz-PO4","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "AF7-AF3","AF3-AF4","AF4-AF8","F5-F1","F1-F2","F2-F6","FC5-FC1","FC1-FCz","FCz-FC2","FC2-FC6",
      "C5-C1","C1-C2","C2-C6","CP5-CP1","CP1-CPz","CPz-CP2","CP2-CP6","P5-P1","P1-P2","P2-P6","PO3-POz","POz-PO4","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  referential: {
    label: "Referential (Cz Ref)",
    "10-20": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "F1-Cz","F2-Cz","F5-Cz","F6-Cz","FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","C1-Cz","C2-Cz","C5-Cz","C6-Cz",
      "CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","P1-Cz","P2-Cz","P5-Cz","P6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  "average-reference": {
    label: "Average Reference",
    "10-20": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "FC1-Avg","FC2-Avg","FC5-Avg","FC6-Avg","CP1-Avg","CP2-Avg","CP5-Avg","CP6-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "F1-Avg","F2-Avg","FC1-Avg","FC2-Avg","C1-Avg","C2-Avg","CP1-Avg","CP2-Avg","P1-Avg","P2-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
};

// Detect the hemisphere/group of a channel from its name.
// Returns "L" (odd-numbered electrodes), "R" (even), "M" (midline z), or "A" (aux/eye/EKG).
function getChannelHemisphere(chName) {
  if (!chName) return "?";
  // Aux channels — separate group. Match prefix optionally followed by 1-2 digits
  // so LOC1, LOC2, ROC1, ROC2 all collapse to a single "A" group instead of being
  // split L/R by trailing-digit parity (which is the EEG rule, not the EOG rule).
  if (/^(EKG|EOG|EMG|LOC|ROC|PG)\d{0,2}(?![A-Za-z])/i.test(chName)) return "A";
  if (/^E[12]\b/i.test(chName)) return "A";
  // Use the FIRST electrode in a bipolar derivation (e.g. "Fp1-F3" → "Fp1", "Fp1-Cz" → "Fp1")
  // For referential "Fp1-Cz" or "Fp1-Avg", the first electrode determines hemisphere.
  // For transverse "F7-Fp1", the first is F7 (L). Within each transverse row, hemisphere transitions
  // (L→M→R) are what we want to mark.
  const first = chName.split(/[-\s]/)[0].trim();
  // Trailing identifier: number or 'z'
  const m = first.match(/(\d+|z)$/i);
  if (!m) return "M";
  if (m[1].toLowerCase() === "z") return "M";
  return parseInt(m[1]) % 2 === 1 ? "L" : "R";
}

// Chain breaks: insert a separator wherever the hemisphere/group transitions.
// This adapts automatically to any montage (longitudinal, transverse, referential, avg ref).
function getChainBreaks(channelList) {
  // Backward-compat: caller may pass a plain count (number) instead of array
  if (typeof channelList === "number") {
    const breaks = [];
    for (let i = 4; i < channelList; i += 4) breaks.push(i);
    return breaks;
  }
  const breaks = [];
  for (let i = 1; i < channelList.length; i++) {
    if (getChannelHemisphere(channelList[i]) !== getChannelHemisphere(channelList[i-1])) {
      breaks.push(i);
    }
  }
  return breaks;
}

// Compute Y positions with chain spacing for channels
function getChannelYPositions(channels, montage, totalHeight) {
  const breaks = getChainBreaks(channels);
  const gapPx = 8; // pixels of extra space between chains
  // Reserve a blank "buffer lane" at the bottom (≈ 0.8 of a channel, clamped) so the lowest
  // trace clears the canvas edge instead of being obscured by it. The renderer draws a grey
  // floor line in this lane. Shared by drawing + hit-testing so they stay aligned.
  const nGaps = breaks.filter(b => b < channels.length).length;
  const approxCh = totalHeight / Math.max(1, channels.length);
  const bottomPad = Math.min(Math.max(22, approxCh * 0.8), 46);
  const usableHeight = Math.max(1, totalHeight - nGaps * gapPx - bottomPad);
  const chHeight = usableHeight / channels.length;
  const positions = [];
  let cumulativeGap = 0;
  for (let i = 0; i < channels.length; i++) {
    if (breaks.includes(i)) cumulativeGap += gapPx;
    const yTop = chHeight * i + cumulativeGap;
    positions.push({ yTop, yCenter: yTop + chHeight / 2, height: chHeight });
  }
  return { positions, chHeight, bottomPad };
}

// Helper: get channels for a montage + system combination
function getMontageChannels(montage, eegSystem, customElectrodes = null) {
  const def = MONTAGE_DEFS[montage];
  if (!def) return [];
  if (eegSystem === "custom" && customElectrodes) {
    const base = def["10-20"] || [];
    const sel = customElectrodes;
    return base.filter(ch => {
      if (ch === "EKG") return false;
      if (ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2") return sel.has(ch);
      if (ch.includes("-")) {
        const parts = ch.split("-");
        const ref = parts[parts.length - 1];
        if (ref === "Avg" || ref === "Cz") return sel.has(parts[0]);
        return sel.has(parts[0]) && sel.has(ref);
      }
      return sel.has(ch);
    });
  }
  return def[eegSystem] || def["10-20"] || [];
}

// Helper: check if a recording's system can display in a given target system
// A 10-20 recording CAN view in 10-20. It CANNOT view in hd-40 or 10-10.
// An hd-40 recording CAN view in 10-20 and hd-40. It CANNOT view in 10-10.
// A 10-10 recording CAN view in anything.
const SYSTEM_HIERARCHY = { "10-20": 1, "hd-40": 2, "10-10": 3, "custom": 1 };
function canViewInSystem(recordingSystem, viewSystem) {
  return (SYSTEM_HIERARCHY[recordingSystem] || 1) >= (SYSTEM_HIERARCHY[viewSystem] || 1);
}

// ── Annotation types ── now defined in ./annotations.js (ANNOTATION_TYPES, imported above
// as ANNOTATION_COLORS) with stable ACNS/ILAE codes + migration.

// Muted slate used for event markers parsed FROM the EDF+ file itself (TAL records
// like PhysioNet's T0/T1/T2), so they read as recording-embedded events rather than
// user-authored "Note" annotations. These keep their original label text (e.g. "T0").
const EDF_EVENT_COLOR = "#64748b";

// ── EEG system definitions ──
const EEG_SYSTEMS = {
  "10-20": { label: "10-20 (Standard)", electrodes: ELECTRODE_SETS["10-20"].length },
  "hd-40": { label: "HD-40 (High Density)", electrodes: ELECTRODE_SETS["hd-40"].length },
  "10-10": { label: "10-10 (Extended)", electrodes: ELECTRODE_SETS["10-10"].length },
  "custom": { label: "Custom (Select Leads)", electrodes: 0 },
};

// ── Channel groupings (hoisted from useEEGState so they aren't recreated per render) ──
const AUX_CHANNELS = new Set(["LOC1","LOC2","ROC1","ROC2","EKG"]);
const EYE_CHANNELS = new Set(["LOC1","LOC2","ROC1","ROC2"]);
// EDF eye lead aliases: some systems use PG1/PG2 or E1/E2 for EOG channels
const EYE_LEAD_ALIASES = { "PG1":"LOC1", "PG2":"ROC1", "E1":"LOC1", "E2":"ROC1", "EOGL":"LOC1", "EOGR":"ROC1" };

// ── Custom electrode picker regions ──
const ELECTRODE_REGIONS = [
  { label: "Frontal", electrodes: ["Fp1","Fp2","F3","F4","F7","F8","Fz"] },
  { label: "Central", electrodes: ["C3","C4","Cz"] },
  { label: "Parietal", electrodes: ["P3","P4","Pz"] },
  { label: "Occipital", electrodes: ["O1","O2"] },
  { label: "Temporal", electrodes: ["T3","T4","T5","T6"] },
  { label: "Auricular", electrodes: ["A1","A2"] },
];
const EYE_LEAD_DEFS = [
  { ch: "LOC1", ref: "Fp1", label: "LOC1 (ref: Fp1)" },
  { ch: "ROC1", ref: "Fp2", label: "ROC1 (ref: Fp2)" },
  { ch: "LOC2", ref: "F7", label: "LOC2 (ref: F7)" },
  { ch: "ROC2", ref: "F8", label: "ROC2 (ref: F8)" },
];

// ── 2D scalp positions for topographic interpolation ──
const ELECTRODE_2D = {
  Fp1:{x:0.35,y:0.08}, Fp2:{x:0.65,y:0.08},
  F7:{x:0.15,y:0.25}, F3:{x:0.35,y:0.25}, Fz:{x:0.50,y:0.22}, F4:{x:0.65,y:0.25}, F8:{x:0.85,y:0.25},
  T3:{x:0.08,y:0.50}, C3:{x:0.32,y:0.48}, Cz:{x:0.50,y:0.45}, C4:{x:0.68,y:0.48}, T4:{x:0.92,y:0.50},
  T5:{x:0.15,y:0.72}, P3:{x:0.35,y:0.70}, Pz:{x:0.50,y:0.68}, P4:{x:0.65,y:0.70}, T6:{x:0.85,y:0.72},
  O1:{x:0.35,y:0.90}, O2:{x:0.65,y:0.90},
  A1:{x:0.03,y:0.50}, A2:{x:0.97,y:0.50},
  AF3:{x:0.38,y:0.15}, AF4:{x:0.62,y:0.15},
  FC1:{x:0.40,y:0.35}, FC2:{x:0.60,y:0.35}, FC5:{x:0.22,y:0.37}, FC6:{x:0.78,y:0.37},
  CP1:{x:0.40,y:0.58}, CP2:{x:0.60,y:0.58}, CP5:{x:0.22,y:0.60}, CP6:{x:0.78,y:0.60},
  PO3:{x:0.40,y:0.80}, PO4:{x:0.60,y:0.80}, POz:{x:0.50,y:0.78},
  Oz:{x:0.50,y:0.92}, Iz:{x:0.50,y:0.97},
  LEOG1:{x:0.20,y:0.05}, LEOG2:{x:0.25,y:0.10},
  REOG1:{x:0.80,y:0.05}, REOG2:{x:0.75,y:0.10},
};

// ── EDF import validation: required electrodes for a 10-20 recording ──
const STANDARD_1020 = new Set(["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"]);

// ── Live device catalog (Record tab) ──
const DEVICE_CATALOG = [
  // OpenBCI hardware (BrainFlow)
  { id: "openbci-cyton-8", name: "OpenBCI Cyton", protocol: "brainflow", channels: 8, maxSr: 250, resolution: "24-bit", wireless: false, boardId: 0, port: "COM3" },
  { id: "openbci-cyton-16", name: "OpenBCI Cyton + Daisy", protocol: "brainflow", channels: 16, maxSr: 125, resolution: "24-bit", wireless: false, boardId: 2, port: "COM3" },
  // piEEG (Raspberry Pi HAT) — streamed to the browser over a local WebSocket bridge.
  { id: "pieeg-8", name: "piEEG (Pi HAT, 8ch)", protocol: "websocket", channels: 8, maxSr: 250, resolution: "24-bit", wireless: false, bridgeUrl: "ws://localhost:8765" },
  { id: "pieeg-16", name: "piEEG-16 (Pi HAT, 16ch)", protocol: "websocket", channels: 16, maxSr: 250, resolution: "24-bit", wireless: false, bridgeUrl: "ws://localhost:8765" },
];

// piEEG default electrode order (matches the bridge's channel ordering).
const PIEEG_CHANNEL_MAP = {
  "pieeg-8":  ["Fp1","Fp2","C3","C4","P3","P4","O1","O2"],
  "pieeg-16": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6"],
};

// ── Connection states ──
const CONN = { disconnected: 0, connecting: 1, connected: 2, impedance: 3, ready: 4, error: -1 };
const CONN_LABELS = {
  [CONN.disconnected]: { text: "Not Connected", color: "#555" },
  [CONN.connecting]: { text: "Connecting...", color: "#F59E0B" },
  [CONN.connected]: { text: "Connected", color: "#7ec8d9" },
  [CONN.impedance]: { text: "Impedance Check", color: "#8B5CF6" },
  [CONN.ready]: { text: "Ready", color: "#7ec8d9" },
  [CONN.error]: { text: "Error", color: "#EF4444" },
};

// ══════════════════════════════════════════════════════════════
// ── END CONFIGURATION ──
// ══════════════════════════════════════════════════════════════


// ── EDF File Parser ──
/**
 * Parse an EDF / EDF+ file from an ArrayBuffer.
 * Returns the parsed structure on success, or { error: { code, stage, message } } on failure.
 * Error codes:
 *   - EDF_TOO_SMALL       — buffer is shorter than the 256-byte main header
 *   - EDF_BAD_MAGIC       — first 8 bytes are not the EDF version string "0       "
 *   - EDF_BDF_UNSUPPORTED — first byte is 0xFF (BDF/Biosemi); 24-bit decode not implemented
 *   - EDF_INVALID_HEADER  — numSignals / numRecords / sample counts out of expected range
 *   - EDF_PARSE_FAILED    — generic exception caught during parse
 */
/**
 * Parse an EDF+ TAL (Time-stamped Annotations List) byte block.
 * TAL format (per EDF+ spec §2.2.4):
 *   onset \x14 [duration]? \x14 text \x14 [text \x14]* \x00 [padding nulls]*
 *   onset starts with '+' or '-' (ASCII)
 *   duration (optional) is preceded by \x15
 *   text fields may be empty (record-start markers have no text)
 * A single annotation signal's per-record data may contain multiple TALs.
 * Returns [{ time, duration, text }, …]; caller filters empty-text record-start markers.
 */
function parseEDFAnnotationBlock(bytes, offset, lengthBytes) {
  const tals = [];
  const end = offset + lengthBytes;
  let pos = offset;
  while (pos < end) {
    // Skip leading null padding between TALs
    if (bytes[pos] === 0) { pos++; continue; }
    // A TAL onset must start with '+' (0x2B) or '-' (0x2D); skip stray bytes otherwise
    if (bytes[pos] !== 0x2B && bytes[pos] !== 0x2D) { pos++; continue; }
    // Read onset (digits, sign, decimal) until \x14 or \x15
    let onsetEnd = pos;
    while (onsetEnd < end && bytes[onsetEnd] !== 0x14 && bytes[onsetEnd] !== 0x15) onsetEnd++;
    if (onsetEnd >= end) break;
    const time = parseFloat(String.fromCharCode(...bytes.slice(pos, onsetEnd)));
    pos = onsetEnd;
    // Optional duration (preceded by \x15, terminated by \x14)
    let duration = 0;
    if (bytes[pos] === 0x15) {
      pos++;
      let durEnd = pos;
      while (durEnd < end && bytes[durEnd] !== 0x14) durEnd++;
      if (durEnd >= end) break;
      duration = parseFloat(String.fromCharCode(...bytes.slice(pos, durEnd)));
      pos = durEnd;
    }
    // Consume the onset-to-text separator \x14
    if (bytes[pos] === 0x14) pos++;
    // Read 0+ text fields, each terminated by \x14, list ends at \x00
    const texts = [];
    while (pos < end && bytes[pos] !== 0) {
      let textEnd = pos;
      while (textEnd < end && bytes[textEnd] !== 0x14 && bytes[textEnd] !== 0) textEnd++;
      if (textEnd > pos) texts.push(String.fromCharCode(...bytes.slice(pos, textEnd)));
      pos = textEnd;
      if (bytes[pos] === 0x14) pos++;
    }
    // Skip terminating \x00 and any padding nulls before the next TAL
    while (pos < end && bytes[pos] === 0) pos++;
    tals.push({
      time: isNaN(time) ? 0 : time,
      duration: isNaN(duration) ? 0 : duration,
      text: texts.join(" | "),
    });
  }
  return tals;
}

function parseEDFFile(arrayBuffer) {
  try {
    if (!arrayBuffer || arrayBuffer.byteLength < 256) {
      return { error: { code: "EDF_TOO_SMALL", stage: "header", message: "File too small to be an EDF (< 256 bytes)." } };
    }
    const bytes = new Uint8Array(arrayBuffer);
    // BDF detection — Biosemi BDF files start with 0xFF then ASCII "BIOSEMI". 24-bit samples
    // are not yet supported (see README); reject explicitly so the recording doesn't get
    // silently corrupted by the 16-bit decoder below.
    if (bytes[0] === 0xFF) {
      return { error: { code: "EDF_BDF_UNSUPPORTED", stage: "magic",
        message: "BDF (24-bit Biosemi) format detected. BDF support is not yet implemented; please re-export as standard 16-bit EDF/EDF+." } };
    }
    // EDF magic: first 8 bytes are ASCII "0       " (version string, EDF spec §1)
    const magic = String.fromCharCode(...bytes.slice(0, 8));
    if (magic !== "0       ") {
      return { error: { code: "EDF_BAD_MAGIC", stage: "magic",
        message: `Not a valid EDF file (version field is ${JSON.stringify(magic)}, expected "0       ").` } };
    }
    const decoder = new TextDecoder("ascii");
    const readStr = (o, l) => decoder.decode(bytes.slice(o, o + l)).trim();
    const readInt = (o, l) => parseInt(readStr(o, l)) || 0;
    const readFloat = (o, l) => parseFloat(readStr(o, l)) || 0;

    const patientId = readStr(8, 80);
    const recordingId = readStr(88, 80);
    const startDate = readStr(168, 8);
    const startTime = readStr(176, 8);
    const headerBytes = readInt(184, 8);
    const numRecords = readInt(236, 8);
    const recordDuration = readFloat(244, 8);
    const numSignals = readInt(252, 4);

    if (numSignals <= 0 || numSignals > 512 || numRecords <= 0) {
      return { error: { code: "EDF_INVALID_HEADER", stage: "header",
        message: `Invalid EDF header (numSignals=${numSignals}, numRecords=${numRecords}).` } };
    }

    const b = 256;
    // Correct per-signal field offsets per EDF spec
    const offLabel   = b;
    const offTrans   = offLabel  + numSignals * 16;
    const offPhysDim = offTrans  + numSignals * 80;
    const offPhysMin = offPhysDim + numSignals * 8;
    const offPhysMax = offPhysMin + numSignals * 8;
    const offDigMin  = offPhysMax + numSignals * 8;
    const offDigMax  = offDigMin  + numSignals * 8;
    const offPrefilt = offDigMax  + numSignals * 8;
    const offNSamp   = offPrefilt + numSignals * 80;

    const sigs = [];
    for (let i = 0; i < numSignals; i++) {
      const label = readStr(offLabel + i * 16, 16);
      // Skip EDF Annotations signal
      const isAnnotation = label.toUpperCase().includes("ANNOTATION");
      sigs.push({
        label,
        isAnnotation,
        physDim: readStr(offPhysDim + i * 8, 8),
        physMin: readFloat(offPhysMin + i * 8, 8),
        physMax: readFloat(offPhysMax + i * 8, 8),
        digMin:  readInt(offDigMin + i * 8, 8),
        digMax:  readInt(offDigMax + i * 8, 8),
        numSamples: readInt(offNSamp + i * 8, 8),
      });
    }

    sigs.forEach(s => {
      const dr = s.digMax - s.digMin;
      const pr = s.physMax - s.physMin;
      s.scale = dr !== 0 ? pr / dr : 1;
      s.offset = s.physMin - s.digMin * s.scale;
      s.sampleRate = recordDuration > 0 ? Math.round(s.numSamples / recordDuration) : 256;
    });

    // Total samples per record across all signals
    const samplesPerRecord = sigs.reduce((sum, s) => sum + s.numSamples, 0);

    // Only decode non-annotation signals as numeric data; annotation signals
    // are parsed separately into EDF+ TAL records.
    const dataSigs = sigs.filter(s => !s.isAnnotation);
    const channelData = dataSigs.map(s => new Float32Array(s.numSamples * numRecords));
    const dv = new DataView(arrayBuffer);
    const edfAnnotations = [];

    for (let rec = 0; rec < numRecords; rec++) {
      let rOff = headerBytes + rec * samplesPerRecord * 2;
      for (let si = 0; si < numSignals; si++) {
        const s = sigs[si];
        const ns = s.numSamples;
        if (s.isAnnotation) {
          // Parse TALs from this annotation signal's bytes in this record.
          // The first TAL of each record is a record-start timestamp with empty
          // text — filter those out (they're per-record offsets, not real events).
          const tals = parseEDFAnnotationBlock(bytes, rOff, ns * 2);
          for (const t of tals) {
            if (t.text && t.text.length > 0) edfAnnotations.push(t);
          }
          rOff += ns * 2;
          continue;
        }
        const dataIdx = dataSigs.indexOf(s);
        const dest = rec * ns;
        for (let n = 0; n < ns; n++) {
          if (rOff + 1 < arrayBuffer.byteLength) {
            channelData[dataIdx][dest + n] = dv.getInt16(rOff, true) * s.scale + s.offset;
          }
          rOff += 2;
        }
      }
    }

    const sampleRate = dataSigs[0]?.sampleRate || 256;
    const totalDuration = numRecords * recordDuration;

    // ── Best-effort impedance extraction ──
    // Standard EDF has no impedance field, but some exporters add dedicated per-electrode
    // impedance signals (label contains "imp"/"impedance", or the physical dimension is
    // ohm/kΩ). When present, surface them as { name, value(kΩ) } so Review can display them
    // and the compliance cutoff can evaluate them. Absent → undefined (the common case).
    const impedances = [];
    dataSigs.forEach((s, di) => {
      const lab = (s.label || "").toLowerCase();
      const dim = (s.physDim || "").toLowerCase();
      const isImp = /imp(edance)?/.test(lab) || /ohm|kohm|kω|\bω\b/.test(dim);
      if (!isImp) return;
      const arr = channelData[di];
      if (!arr || arr.length === 0) return;
      let sum = 0; for (let n = 0; n < arr.length; n++) sum += arr[n];
      let val = sum / arr.length;
      // Normalize plain ohms → kΩ
      if (/ohm/.test(dim) && !/k/.test(dim) && val > 1000) val = val / 1000;
      const cleaned = (s.label || "").replace(/imp(edance)?/ig, "").replace(/[:\-_]/g, " ").trim();
      const elec = extractElectrodeName(cleaned) || cleaned || `Ch${di + 1}`;
      const v = Math.round(val * 10) / 10;
      impedances.push({ name: elec, value: v, status: v <= 5 ? "good" : v <= 10 ? "fair" : "poor" });
    });

    return {
      patientId, recordingId, startDate, startTime,
      numRecords, recordDuration, numSignals: dataSigs.length,
      totalDuration, sampleRate,
      signals: dataSigs.map(s => ({ label: s.label, numSamples: s.numSamples, sampleRate: s.sampleRate, physDim: s.physDim })),
      channelData,
      channelLabels: dataSigs.map(s => s.label),
      edfAnnotations,  // EDF+ TAL annotations parsed from the file (may be empty)
      ...(impedances.length ? { impedances } : {}),
    };
  } catch (e) {
    return { error: { code: "EDF_PARSE_FAILED", stage: "parse", message: e?.message || String(e) } };
  }
}

/**
 * Extract one epoch from a parsed EDF channel, resampling to `targetSr` if needed.
 * When downsampling (sigSr > targetSr), an anti-alias Butterworth low-pass is applied
 * before linear interpolation to suppress aliasing of high-frequency content
 * (line noise, EMG, etc.) into the visible band.
 */
function getEDFEpochData(edfData, channelIndex, epochStart, epochSec, targetSr) {
  if (!edfData?.channelData || channelIndex >= edfData.channelData.length) return null;
  const sigSr = edfData.signals[channelIndex]?.sampleRate || edfData.sampleRate;
  const start = Math.floor(epochStart * sigSr);
  const raw = edfData.channelData[channelIndex];
  if (start >= raw.length) return null;
  let slice = raw.slice(start, Math.min(start + Math.floor(epochSec * sigSr), raw.length));
  if (sigSr !== targetSr && targetSr > 0) {
    // Anti-alias before downsampling: cutoff at targetSr/2.5 leaves a safety margin
    // below the target Nyquist. Skip for upsampling (sigSr < targetSr) — no aliasing risk.
    if (sigSr > targetSr && slice.length >= 8) {
      const cutoff = targetSr / 2.5;
      slice = applyLowPass(slice, cutoff, sigSr, 4);
    }
    const tgt = Math.floor(epochSec * targetSr);
    const out = new Float32Array(tgt);
    const ratio = slice.length / tgt;
    for (let i = 0; i < tgt; i++) { const si = i * ratio; const lo = Math.floor(si); const hi = Math.min(lo+1, slice.length-1); out[i] = slice[lo]*(1-(si-lo)) + slice[hi]*(si-lo); }
    return out;
  }
  return slice;
}

// Like getEDFEpochData, but also returns `guardSec` seconds of REAL neighbouring signal on each
// side of the epoch (clamped at the file edges), so filters can settle on real data. Returns
// { data, lead, len }: `data` is the guard-extended window, the visible epoch is data[lead .. lead+len).
// Filter `data`, then crop to [lead, lead+len) to display a transient-free epoch. Two electrodes
// fetched with identical params share the same lead/len, so bipolar pairs subtract aligned.
function getEDFEpochWindow(edfData, channelIndex, epochStart, epochSec, targetSr, guardSec) {
  if (!edfData?.channelData || channelIndex >= edfData.channelData.length) return null;
  const sigSr = edfData.signals[channelIndex]?.sampleRate || edfData.sampleRate;
  const raw = edfData.channelData[channelIndex];
  const coreStart = Math.floor(epochStart * sigSr);
  if (coreStart >= raw.length) return null;
  const coreLenSrc = Math.floor(epochSec * sigSr);
  const guardSrc = Math.max(0, Math.floor((guardSec || 0) * sigSr));
  const winStart = Math.max(0, coreStart - guardSrc);
  const leadSrc = coreStart - winStart;
  const winEnd = Math.min(raw.length, coreStart + coreLenSrc + guardSrc);
  let win = raw.slice(winStart, winEnd);
  if (sigSr !== targetSr && targetSr > 0) {
    if (sigSr > targetSr && win.length >= 8) win = applyLowPass(win, targetSr / 2.5, sigSr, 4);
    const ratio = sigSr / targetSr;                 // source samples per target sample
    const totalTgt = Math.max(1, Math.round(win.length / ratio));
    const out = new Float32Array(totalTgt);
    for (let i = 0; i < totalTgt; i++) {
      const si = i * ratio, lo = Math.floor(si), hi = Math.min(lo + 1, win.length - 1);
      out[i] = win[lo] * (1 - (si - lo)) + win[hi] * (si - lo);
    }
    const lead = Math.min(Math.round(leadSrc / ratio), totalTgt - 1);
    const len = Math.min(Math.floor(epochSec * targetSr), totalTgt - lead);
    return { data: out, lead, len };
  }
  const len = Math.min(coreLenSrc, win.length - leadSrc);
  return { data: win, lead: leadSrc, len };
}

// ── EDF Writer ──
function buildEDFFile({ channelLabels, channelData, sampleRate, recordDurationSec = 1, patientId = "", recordingId = "" }) {
  const ns = channelLabels.length;
  const totalSamples = channelData[0].length;
  const samplesPerRecord = sampleRate * recordDurationSec;
  const numRecords = Math.ceil(totalSamples / samplesPerRecord);
  const headerBytes = 256 + ns * 256;
  const dataBytes = numRecords * ns * samplesPerRecord * 2;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeStr = (offset, length, str) => {
    const padded = (str || "").padEnd(length).slice(0, length);
    for (let i = 0; i < length; i++) bytes[offset + i] = padded.charCodeAt(i);
  };

  // Main header (256 bytes)
  writeStr(0, 8, "0       ");
  writeStr(8, 80, patientId);
  writeStr(88, 80, recordingId);
  const now = new Date();
  writeStr(168, 8, `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getFullYear()%100).padStart(2,"0")}`);
  writeStr(176, 8, `${String(now.getHours()).padStart(2,"0")}.${String(now.getMinutes()).padStart(2,"0")}.${String(now.getSeconds()).padStart(2,"0")}`);
  writeStr(184, 8, String(headerBytes));
  writeStr(192, 44, "");
  writeStr(236, 8, String(numRecords));
  writeStr(244, 8, String(recordDurationSec));
  writeStr(252, 4, String(ns));

  // Per-signal headers
  const b = 256;
  const physMins = [], physMaxs = [];
  for (let i = 0; i < ns; i++) {
    let min = Infinity, max = -Infinity;
    const d = channelData[i];
    for (let j = 0; j < d.length; j++) { if (d[j] < min) min = d[j]; if (d[j] > max) max = d[j]; }
    if (min === max) { min -= 1; max += 1; }
    physMins.push(min);
    physMaxs.push(max);
  }
  const digMin = -32768, digMax = 32767;

  for (let i = 0; i < ns; i++) writeStr(b + i * 16, 16, channelLabels[i]);          // label
  for (let i = 0; i < ns; i++) writeStr(b + ns*16 + i*80, 80, "");                  // transducer
  for (let i = 0; i < ns; i++) writeStr(b + ns*96 + i*8, 8, "uV");                  // physDim
  for (let i = 0; i < ns; i++) writeStr(b + ns*104 + i*8, 8, physMins[i].toFixed(1));// physMin
  for (let i = 0; i < ns; i++) writeStr(b + ns*112 + i*8, 8, physMaxs[i].toFixed(1));// physMax
  for (let i = 0; i < ns; i++) writeStr(b + ns*120 + i*8, 8, String(digMin));       // digMin
  for (let i = 0; i < ns; i++) writeStr(b + ns*128 + i*8, 8, String(digMax));       // digMax
  for (let i = 0; i < ns; i++) writeStr(b + ns*136 + i*80, 80, "");                 // prefiltering
  for (let i = 0; i < ns; i++) writeStr(b + ns*216 + i*8, 8, String(samplesPerRecord)); // numSamples
  for (let i = 0; i < ns; i++) writeStr(b + ns*224 + i*32, 32, "");                 // reserved

  // Data records — each record: ns channels × samplesPerRecord × Int16LE
  let offset = headerBytes;
  for (let rec = 0; rec < numRecords; rec++) {
    for (let ch = 0; ch < ns; ch++) {
      const scale = (physMaxs[ch] - physMins[ch]) / (digMax - digMin);
      for (let s = 0; s < samplesPerRecord; s++) {
        const si = rec * samplesPerRecord + s;
        const physVal = si < channelData[ch].length ? channelData[ch][si] : 0;
        const digVal = Math.round((physVal - physMins[ch]) / scale + digMin);
        view.setInt16(offset, Math.max(digMin, Math.min(digMax, digVal)), true);
        offset += 2;
      }
    }
  }

  return buffer;
}

// ── Filters ──
// ── Butterworth filter design (cascaded biquad sections) ──
// Compute biquad coefficients for Nth-order Butterworth via bilinear transform
// Butterworth + biquad + HP/LP/notch + wavelet denoise now live in ./dsp.js (imported above).

// ── Simplified FastICA for artifact removal ──
/**
 * Jacobi eigenvalue algorithm for a small symmetric n×n matrix (row-major).
 * Returns { values: Float64Array(n), vectors: Float64Array(n*n) } where the
 * eigenvector for values[k] is column k: vectors[i*n + k]. Used to build the
 * PCA whitening transform for ICA (n = channel count, ~19–40, so this is cheap).
 */
function jacobiEigenSym(A, n, maxSweeps = 80) {
  const a = Float64Array.from(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-20) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        // a := Jᵀ a J  (rotate columns p,q then rows p,q)
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values, vectors: V };
}

/**
 * Train a FastICA model from an EEG segment + reference (aux) channels.
 * Uses true PCA whitening (eigendecomposition of the channel covariance) so the
 * tanh-contrast FastICA operates on genuinely decorrelated, unit-variance inputs
 * — fixing the previous diagonal-std-only "whitening" that left cross-channel
 * correlation intact (AUDIT-v13.md §3). Returns precomputed per-artifact spatial
 * filters + back-projections so {@link applyTrainedICA} is a cheap linear pass.
 * Returns null if the input is too small (< 2 channels or < 16 samples).
 *
 * @param {Float32Array[]} channelData — EEG channels to train on
 * @param {Float32Array[]} auxChannels — EOG/EKG references used to identify artifact ICs
 * @param {number} sr — sample rate (Hz)
 */
function trainICA(channelData, auxChannels, sr) {
  const nCh = channelData.length;
  const N = channelData[0]?.length || 0;
  if (nCh < 2 || N < 16) return null;

  // 1. Center; capture per-channel means for the apply step.
  const channelMeans = channelData.map(ch => { let s = 0; for (let i = 0; i < N; i++) s += ch[i]; return s / N; });
  const centered = channelData.map((ch, ci) => {
    const c = new Float64Array(N);
    for (let i = 0; i < N; i++) c[i] = ch[i] - channelMeans[ci];
    return c;
  });

  // 2. Channel covariance (symmetric nCh×nCh) → eigendecomposition → PCA whitening.
  const cov = new Float64Array(nCh * nCh);
  for (let i = 0; i < nCh; i++) {
    for (let j = i; j < nCh; j++) {
      let s = 0; for (let t = 0; t < N; t++) s += centered[i][t] * centered[j][t];
      const v = s / N; cov[i * nCh + j] = v; cov[j * nCh + i] = v;
    }
  }
  const { values, vectors } = jacobiEigenSym(cov, nCh);
  let maxEv = 0; for (let k = 0; k < nCh; k++) if (values[k] > maxEv) maxEv = values[k];
  const floor = 1e-8 * (maxEv || 1);
  // Whitening Vw (white-dim × channel): z_k = Σ_i Vw[k][i]·centered[i]
  // Un-whitening Vinv (channel × white-dim): channel_i = Σ_k Vinv[i][k]·z_k
  const Vw = new Float64Array(nCh * nCh);
  const Vinv = new Float64Array(nCh * nCh);
  for (let k = 0; k < nCh; k++) {
    const ev = Math.max(values[k], floor);
    const invSqrt = 1 / Math.sqrt(ev), sq = Math.sqrt(ev);
    for (let i = 0; i < nCh; i++) {
      const e = vectors[i * nCh + k];
      Vw[k * nCh + i] = invSqrt * e;
      Vinv[i * nCh + k] = e * sq;
    }
  }
  // Whitened data z (nCh × N): identity covariance, unit variance.
  const z = Array.from({ length: nCh }, () => new Float64Array(N));
  for (let k = 0; k < nCh; k++) {
    const row = Vw, base = k * nCh, zk = z[k];
    for (let t = 0; t < N; t++) {
      let s = 0; for (let i = 0; i < nCh; i++) s += row[base + i] * centered[i][t];
      zk[t] = s;
    }
  }

  // 3. FastICA — tanh (logcosh) contrast, deflation with Gram–Schmidt orthogonalization.
  const nComp = Math.min(nCh, ICA_MAX_COMPONENTS);
  const W = Array.from({ length: nComp }, () => {
    const w = new Float64Array(nCh);
    for (let i = 0; i < nCh; i++) w[i] = Math.random() - 0.5;
    return w;
  });
  const normalize = (w) => {
    let norm = 0;
    for (let i = 0; i < w.length; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < w.length; i++) w[i] /= norm;
  };
  for (let comp = 0; comp < nComp; comp++) {
    const w = W[comp];
    normalize(w);
    for (let iter = 0; iter < ICA_MAX_ITERATIONS; iter++) {
      const wNew = new Float64Array(nCh);
      let gPrimeSum = 0;
      for (let t = 0; t < N; t++) {
        let wx = 0;
        for (let i = 0; i < nCh; i++) wx += w[i] * z[i][t];
        const gx = Math.tanh(wx);
        const gPrime = 1 - gx * gx;
        for (let i = 0; i < nCh; i++) wNew[i] += z[i][t] * gx;
        gPrimeSum += gPrime;
      }
      for (let i = 0; i < nCh; i++) wNew[i] = wNew[i] / N - (gPrimeSum / N) * w[i];
      for (let p = 0; p < comp; p++) {
        let dot = 0;
        for (let i = 0; i < nCh; i++) dot += wNew[i] * W[p][i];
        for (let i = 0; i < nCh; i++) wNew[i] -= dot * W[p][i];
      }
      normalize(wNew);
      let conv = 0;
      for (let i = 0; i < nCh; i++) conv += Math.abs(Math.abs(wNew[i]) - Math.abs(w[i]));
      for (let i = 0; i < nCh; i++) w[i] = wNew[i];
      if (conv < ICA_CONVERGENCE_TOL) break;
    }
  }

  // 4. Sources s_c(t) = Σ_i W[c][i]·z[i][t]
  const S = W.map(w => {
    const ic = new Float32Array(N);
    for (let t = 0; t < N; t++) { let s = 0; for (let i = 0; i < nCh; i++) s += w[i] * z[i][t]; ic[t] = s; }
    return ic;
  });

  // 5. Flag artifact components by |Pearson r| with any aux reference channel.
  const artifactMask = new Array(nComp).fill(false);
  const componentLog = [];
  for (let c = 0; c < nComp; c++) {
    let icVar = 0;
    for (let t = 0; t < N; t++) icVar += S[c][t] * S[c][t];
    icVar /= N;
    let maxCorr = 0, triggered = false;
    for (const aux of auxChannels) {
      if (!aux || aux.length < N) continue;
      let sumIC = 0, sumAux = 0;
      for (let i = 0; i < N; i++) { sumIC += S[c][i]; sumAux += aux[i]; }
      const mIC = sumIC / N, mAux = sumAux / N;
      let num = 0, dIC = 0, dAux = 0;
      for (let i = 0; i < N; i++) {
        const a = S[c][i] - mIC, b = aux[i] - mAux;
        num += a * b; dIC += a * a; dAux += b * b;
      }
      const r = Math.sqrt(dIC * dAux) > 0 ? Math.abs(num / Math.sqrt(dIC * dAux)) : 0;
      if (r > maxCorr) maxCorr = r;
      if (r > ICA_ARTIFACT_CORR_THRESHOLD) { artifactMask[c] = true; triggered = true; break; }
    }
    componentLog.push({ component: c, rejected: triggered, maxCorrelation: +maxCorr.toFixed(4), variance: +icVar.toFixed(4) });
  }

  // 6. Precompute, in CHANNEL space, each artifact's spatial filter + back-projection:
  //    source:   s_c(t)      = Σ_i filter_c[i]·centered[i](t),   filter_c = W[c]·Vw
  //    projection: channel_i -= proj_c[i]·s_c(t),                proj_c[i] = Σ_k Vinv[i][k]·W[c][k]
  const artifacts = [];
  for (let c = 0; c < nComp; c++) {
    if (!artifactMask[c]) continue;
    const filter = new Float64Array(nCh), proj = new Float64Array(nCh);
    for (let i = 0; i < nCh; i++) {
      let f = 0; for (let k = 0; k < nCh; k++) f += W[c][k] * Vw[k * nCh + i];
      let p = 0; for (let k = 0; k < nCh; k++) p += Vinv[i * nCh + k] * W[c][k];
      filter[i] = f; proj[i] = p;
    }
    artifacts.push({ filter, proj });
  }

  return {
    channelMeans, artifacts, nCh,
    log: {
      method: "fastica-pca-whitened", pipelineVersion: PIPELINE_VERSION,
      nComponents: nComp, nChannels: nCh,
      artifactComponentsRemoved: artifacts.length,
      components: componentLog, timestamp: Date.now(),
    }
  };
}

/**
 * Apply a pre-trained FastICA model to a new segment of EEG data. For each
 * flagged artifact component it reconstructs the source from the (centered)
 * channels via the precomputed spatial filter, then subtracts that source's
 * back-projection from every channel. O(nArtifacts · N · nCh), no re-training.
 *
 * @param {Float32Array[]} channelData — EEG channels to clean
 * @param {object} trained — output of {@link trainICA}
 */
function applyTrainedICA(channelData, trained) {
  const { channelMeans, artifacts, nCh } = trained;
  if (channelData.length !== nCh) return channelData; // shape mismatch — bail
  const N = channelData[0]?.length || 0;
  if (N < 1 || !artifacts || artifacts.length === 0) return channelData;

  // Start from a copy of the originals.
  const cleaned = channelData.map((ch) => {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = ch[i];
    return out;
  });
  // Subtract each artifact source's channel-space projection. The source is
  // reconstructed from the ORIGINAL centered channels (linear, so subtracting
  // multiple artifacts sequentially is order-independent).
  for (const { filter, proj } of artifacts) {
    for (let t = 0; t < N; t++) {
      let s = 0;
      for (let i = 0; i < nCh; i++) s += filter[i] * (channelData[i][t] - channelMeans[i]);
      for (let i = 0; i < nCh; i++) cleaned[i][t] -= proj[i] * s;
    }
  }
  return cleaned;
}

/**
 * One-shot ICA convenience wrapper — trains and applies in one call. Kept for any
 * future caller that doesn't want to manage the trained-cache lifecycle itself.
 * Live use in useEEGState goes through trainICA + applyTrainedICA directly so the
 * mixing matrix can be cached across epoch navigation.
 */
function applyICA(channelData, auxChannels, sr) {
  const trained = trainICA(channelData, auxChannels, sr);
  if (!trained) return { data: channelData, log: null };
  return { data: applyTrainedICA(channelData, trained), log: trained.log };
}

// ── Icons ──
const I = {
  Search: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>,
  Upload: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Download: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Brain: (s=20) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9.5 2a3.5 3.5 0 0 0-3.2 4.8A3.5 3.5 0 0 0 4 10.5a3.5 3.5 0 0 0 1 6.8A3.5 3.5 0 0 0 8.5 22h1V2Z"/><path d="M14.5 2a3.5 3.5 0 0 1 3.2 4.8 3.5 3.5 0 0 1 2.3 3.7 3.5 3.5 0 0 1-1 6.8 3.5 3.5 0 0 1-3.5 4.7h-1V2Z"/></svg>,
  Shield: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Check: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  Alert: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Clock: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Filter: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  Grid: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  List: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  X: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Plus: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Database: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Zap: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  ChevLeft: () => <svg width="18" height="18" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
  ChevRight: () => <svg width="18" height="18" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
  ZoomIn: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>,
  ZoomOut: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>,
  Bookmark: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>,
  Trash: (s=12) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Save: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  Record: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>,
  Square: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/></svg>,
  Pause: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>,
  Activity: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  Ohm: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M8 17v-2a4 4 0 1 1 8 0v2"/><line x1="6" y1="17" x2="10" y2="17"/><line x1="14" y1="17" x2="18" y2="17"/></svg>,
  Eye: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="22" y2="22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>,
  EyeDots: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><circle cx="9" cy="4" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="15" cy="4" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="9" cy="20" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="15" cy="20" r="1.2" fill="#F59E0B" stroke="none"/></svg>,
  Radio: (s=16) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>,
  MoreVert: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>,
  Folder: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  Edit: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Package: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m16.5 9.4-9-5.19"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>,
  BarChart: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  Ruler: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 2l20 20"/><path d="M5.5 5.5l3-3"/><path d="M9.5 9.5l3-3"/><path d="M13.5 13.5l3-3"/><path d="M17.5 17.5l3-3"/></svg>,
  GitCompare: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>,
  BrainElectrode: (s=18) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9.5 4a3.5 3.5 0 0 0-3.2 4.8A3.5 3.5 0 0 0 4 12.5a3.5 3.5 0 0 0 1 6.8A3.5 3.5 0 0 0 8.5 24h1V4Z"/><path d="M14.5 4a3.5 3.5 0 0 1 3.2 4.8 3.5 3.5 0 0 1 2.3 3.7 3.5 3.5 0 0 1-1 6.8 3.5 3.5 0 0 1-3.5 4.7h-1V4Z"/><circle cx="12" cy="14" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>,
  Waves: (s=14) => <svg width={s} height={s} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M2 6c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M2 18c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/></svg>,
};


// ── Shared styles ──
const controlBtn = (active = false) => ({
  padding: "4px 10px", background: active ? "#1a2a30" : "#111",
  border: `1px solid ${active ? "#4a9bab" : "#222"}`, borderRadius: 0,
  color: active ? "#7ec8d9" : "#888", fontSize: 11, cursor: "pointer",
  fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, transition: "all 0.1s",
});
const selectStyle = {
  background: "#111", border: "1px solid #222", borderRadius: 0,
  color: "#ccc", fontSize: 11, padding: "4px 6px", outline: "none",
  fontFamily: "'IBM Plex Mono', monospace",
};

/**
 * Load the bundled public-domain EDFs from /public/seed-edfs/ on first launch.
 * Each file is fetched as an ArrayBuffer, parsed, persisted to IDB, and assembled
 * into a library record. Returns [] if the manifest is unreachable (e.g. single-file
 * builds without server access).
 */
async function loadRealSeedEdfs(setEdfFileStore, setAnnotationsMap) {
  const base = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  const manifestUrl = `${base}seed-edfs/manifest.json`.replace(/\/+/g, "/").replace(":/", "://");
  let manifest;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) { console.warn("[REACT] No real-seed manifest (status " + res.status + ")"); return []; }
    manifest = await res.json();
  } catch (e) {
    console.warn("[REACT] Real-seed manifest fetch failed:", e?.message);
    return [];
  }

  const records = [];
  for (const def of (manifest.files || [])) {
    try {
      const edfRes = await fetch(`${base}seed-edfs/${def.path}`.replace(/\/+/g, "/").replace(":/", "://"));
      if (!edfRes.ok) { console.warn(`[REACT] Real-seed fetch ${def.path}: ${edfRes.status}`); continue; }
      const edfBuffer = await edfRes.arrayBuffer();
      const parsed = parseEDFFile(edfBuffer);
      if (!parsed || parsed.error) {
        console.warn(`[REACT] Real-seed parse failed for ${def.path}:`, parsed?.error);
        continue;
      }
      const ageStr = def.age != null ? String(def.age) : "";
      // Sex is genuinely not recorded for these public seeds — leave it unspecified
      // ("") rather than stamping "X" (which means "Other", not "unknown").
      const reactFilename = generateFilename(def.subjectId, def.studyType, def.date, def.sex || "", ageStr, 1);
      await saveEdfToDB(reactFilename, edfBuffer);
      if (setEdfFileStore) setEdfFileStore(prev => ({ ...prev, [reactFilename]: parsed }));
      // Seed EDF+ TAL event markers into annotationsMap if the file carries any.
      // Labeled with their original code (T0/T1/T2…) in muted slate so they read as
      // recording-embedded events, not user "Note" annotations.
      if (parsed.edfAnnotations?.length > 0 && setAnnotationsMap) {
        const converted = parsed.edfAnnotations.map((a, idx) => ({
          id: `EDF-SEED-${Date.now()}-${idx}`, time: a.time, duration: a.duration,
          type: a.text || "EDF Event", color: EDF_EVENT_COLOR, text: a.text, channel: -1, source: "edf",
        }));
        setAnnotationsMap(prev => ({ ...prev, [reactFilename]: converted }));
      }
      const fileSizeMB = Math.round(edfBuffer.byteLength / 1024 / 1024 * 10) / 10;
      records.push({
        id: `SEED-PHY-${Date.now()}-${records.length}`,
        subjectHash: hashSubjectId(def.subjectId),
        subjectId: def.subjectId,
        sport: "", position: "",
        studyType: def.studyType, date: def.date,
        filename: reactFilename,
        channels: parsed.numSignals,
        duration: Math.round((def.durationSec || parsed.totalDuration) / 60 * 10) / 10,
        durationSec: def.durationSec || parsed.totalDuration,
        sampleRate: parsed.sampleRate,
        fileSize: fileSizeMB, sex: def.sex || "", age: def.age,
        montage: detectEdfSystem(parsed) || "10-20", status: "pending",
        isTest: true, fileType: "real-public",
        hasEdfData: true,
        notes: `${def.task || ""} (Source: PhysioNet EEGMMIDB ${def.path})`,
        uploadedAt: new Date().toISOString(),
        pipelineVersion: PIPELINE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        processingLog: [],
        repositoryStatus: "library",
        collectionIds: [],
        complianceResult: null,
        consciousnessLevel: "awake",
        activationProcedures: ["none"], posture: "seated",
        environmentNoise: "quiet",
        hardware: { manufacturer:"BCI2000 / g.tec", model:"g.MOBIlab+", adcResolution:16, fdaCleared:false, electrodeType:"active", applicationMethod:"cap" },
        sourceAttribution: { dataset: manifest.source, url: manifest.sourceUrl, license: manifest.license, originalPath: def.path },
      });
    } catch (e) {
      console.warn(`[REACT] Real-seed exception for ${def.path}:`, e?.message);
    }
  }
  return records;
}
const microLabel = {
  fontSize: 9, color: "#555", fontWeight: 700, letterSpacing: "0.1em",
  textTransform: "uppercase", marginBottom: 2,
};

// ── StatusBadge ──
// ── Global tooltip overlay ──
// Mount once at App root. Listens to document-wide mousemove; whenever the cursor
// is over an element (or ancestor) with a `data-tip` attribute or a `title`
// attribute, renders a small styled box near the cursor with that text. Native
// `title` tooltips still appear after their OS delay — we don't suppress them
// because (a) screen readers rely on them and (b) it's complex to do reliably.
function TooltipOverlay({ tutorialMode = false }) {
  const [tip, setTip] = useState(null); // { text, x, y, tut }
  // Keep the latest tutorialMode in a ref so the (mount-once) listener reads it live.
  const tutRef = useRef(tutorialMode);
  useEffect(() => { tutRef.current = tutorialMode; }, [tutorialMode]);
  useEffect(() => {
    let raf = null;
    let lastTarget = null;
    const onMove = (e) => {
      if (raf) return; // throttle to one update per animation frame
      raf = requestAnimationFrame(() => {
        raf = null;
        let el = e.target;
        if (el === lastTarget) {
          // Same element — just reposition
          if (tip) setTip(t => t ? { ...t, x: e.clientX + 14, y: e.clientY + 18 } : null);
          return;
        }
        lastTarget = el;
        let text = null, isTut = false;
        while (el && el !== document.body) {
          // In tutorial mode, a `data-tut` description takes precedence and renders
          // as a richer help box. Otherwise fall back to the normal data-tip / title.
          if (tutRef.current && el.dataset?.tut) { text = el.dataset.tut; isTut = true; break; }
          const ds = el.dataset?.tip || el.getAttribute?.("title");
          if (ds) { text = ds; break; }
          el = el.parentElement;
        }
        if (text) {
          // Clamp position so the tooltip doesn't overflow the viewport
          const boxW = isTut ? 300 : 320;
          const x = Math.min(e.clientX + 14, window.innerWidth - boxW);
          const y = Math.min(e.clientY + 18, window.innerHeight - (isTut ? 110 : 60));
          setTip({ text, x, y, tut: isTut });
        } else {
          setTip(null);
        }
      });
    };
    const onLeave = () => { setTip(null); lastTarget = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!tip) return null;
  if (tip.tut) {
    // Rich tutorial help box — cyan accent, small header tag. If the text leads
    // with "Name: …", the name is split out and shown bold like a card title.
    const ci = tip.text.indexOf(": ");
    const label = ci > 0 && ci < 28 ? tip.text.slice(0, ci) : null;
    const body = label ? tip.text.slice(ci + 2) : tip.text;
    return (
      <div style={{
        position: "fixed", left: tip.x, top: tip.y, zIndex: 9999,
        background: "#0a1a1f", border: "1px solid #4a9bab",
        padding: "8px 11px", maxWidth: 300, pointerEvents: "none",
        fontFamily: "'IBM Plex Mono', monospace",
        boxShadow: "0 6px 20px rgba(0,0,0,0.6)",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
          <span style={{color:"#7ec8d9"}}>{I.Brain(11)}</span>
          <span style={{fontSize:8,fontWeight:700,letterSpacing:"0.12em",color:"#4a9bab"}}>TUTORIAL</span>
        </div>
        <div style={{fontSize:11,color:"#cfe6ec",lineHeight:1.5,whiteSpace:"pre-wrap"}}>
          {label && <span style={{color:"#7ec8d9",fontWeight:700}}>{label}: </span>}{body}
        </div>
      </div>
    );
  }
  return (
    <div style={{
      position: "fixed", left: tip.x, top: tip.y, zIndex: 9999,
      background: "#0c0c0c", border: "1px solid #2a2a2a",
      padding: "5px 10px", fontSize: 11, color: "#ddd",
      fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.4,
      pointerEvents: "none", maxWidth: 300, whiteSpace: "pre-wrap",
      boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    }}>{tip.text}</div>
  );
}

// ── Module-level notification bus (Wave 7d) ──
// Decoupled from React so non-React code (tauriBridge stubs, async handlers)
// can call notify(message, kind) directly. The NotificationToasts component
// mounted at app root subscribes to incoming entries and renders a stack of
// dismissable toasts in the bottom-right corner.
const notificationBus = {
  _id: 0,
  listeners: new Set(),
  push(message, kind = "info", ttlMs = 6000) {
    const entry = { id: ++this._id, message, kind, ttlMs };
    this.listeners.forEach(l => l(entry));
    return entry.id;
  },
};
const notify = (message, kind = "info", ttlMs = 6000) => notificationBus.push(message, kind, ttlMs);

function NotificationToasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onPush = (entry) => {
      setItems(prev => [...prev, entry]);
      if (entry.ttlMs > 0) {
        setTimeout(() => setItems(prev => prev.filter(x => x.id !== entry.id)), entry.ttlMs);
      }
    };
    notificationBus.listeners.add(onPush);
    return () => notificationBus.listeners.delete(onPush);
  }, []);

  if (items.length === 0) return null;
  const cfgFor = (kind) => ({
    error: { bg: "#2a0a0a", border: "#991b1b", text: "#f87171", icon: I.Alert(13) },
    warn:  { bg: "#1a1a0a", border: "#854d0e", text: "#facc15", icon: I.Alert(13) },
    info:  { bg: "#0a2a30", border: "#1a4a54", text: "#7ec8d9", icon: I.Check(13) },
    ok:    { bg: "#0a2a18", border: "#15532a", text: "#10b981", icon: I.Check(13) },
  }[kind] || { bg: "#0c0c0c", border: "#2a2a2a", text: "#aaa", icon: null });
  return (
    <div aria-live="polite" aria-atomic="false" style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 9999,
      display: "flex", flexDirection: "column", gap: 8, maxWidth: 420,
      pointerEvents: "none",
    }}>
      {items.map(item => {
        const c = cfgFor(item.kind);
        return (
          <div key={item.id} role="status" style={{
            background: c.bg, border: `1px solid ${c.border}`, color: c.text,
            padding: "10px 12px", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
            lineHeight: 1.4, display: "flex", alignItems: "flex-start", gap: 10,
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)", pointerEvents: "auto",
            animation: "toastSlideIn 0.18s ease forwards",
          }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>{c.icon}</span>
            <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.message}</span>
            <button onClick={() => setItems(prev => prev.filter(x => x.id !== item.id))}
              aria-label="Dismiss notification"
              style={{ background: "none", border: "none", color: c.text, opacity: 0.6, cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1, flexShrink: 0 }}>×</button>
          </div>
        );
      })}
      <style>{`@keyframes toastSlideIn { from { transform: translateX(16px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = {
    verified: { icon: I.Check(), bg: "#0a2a30", border: "#1a4a54", text: "#7ec8d9", label: "Verified" },
    pending: { icon: I.Clock(), bg: "#1a1a0a", border: "#854d0e", text: "#facc15", label: "Pending" },
    flagged: { icon: I.Alert(), bg: "#2a0a0a", border: "#991b1b", text: "#f87171", label: "Flagged" },
  }[status] || { icon: null, bg: "#1a1a1a", border: "#333", text: "#999", label: status };
  return (
    <span style={{ display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:0,
      fontSize:11,fontWeight:600,background:cfg.bg,border:`1px solid ${cfg.border}`,color:cfg.text }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ── Compact compliance badge (Library + Repository row cell) ──
function ComplianceBadge({ result, onRecompute }) {
  if (!result) {
    return (
      <button onClick={(e)=>{e.stopPropagation();onRecompute&&onRecompute();}} title="Compliance not yet checked. Click to run."
        style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:0,
          fontSize:10,fontWeight:600,background:"#0a0a0a",border:"1px solid #2a2a2a",color:"#666",cursor:"pointer"}}>
        — check
      </button>
    );
  }
  const ok = result.compliant;
  const cfg = ok
    ? { bg:"#0a2a18", border:"#15532a", text:"#10b981", label:"Compliant" }
    : { bg:"#2a0a0a", border:"#991b1b", text:"#f87171", label:`Fail (${result.failCount})` };
  return (
    <span title={`Pass ${result.passCount} · Warn ${result.warnCount} · Fail ${result.failCount}${result.unknownCount?` · Unknown ${result.unknownCount}`:""}`}
      style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:0,whiteSpace:"nowrap",
        fontSize:10,fontWeight:700,background:cfg.bg,border:`1px solid ${cfg.border}`,color:cfg.text}}>
      {ok ? I.Check(11) : I.Alert(11)} {cfg.label}
    </span>
  );
}

// ── Modal a11y hook (Wave 6a) ──
// Tab/Shift-Tab cycle focus within the modal, focuses the first interactive
// element on mount, restores focus to the prior element on close. Pass an
// `onClose` to wire Escape-to-dismiss. Caller is responsible for adding
// role="dialog" + aria-modal="true" to the container.
// eslint-disable-next-line react-refresh/only-export-components
function useFocusTrap(containerRef, isOpen, onClose) {
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement;
    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      // Skip [autofocus] — if a child already grabbed focus, don't yank it back to the close button
      if (el.contains(document.activeElement) && document.activeElement !== el) return;
      const first = el.querySelector(focusableSelector);
      if (first) first.focus(); else el.focus();
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape" && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const el = containerRef.current;
      if (!el) return;
      const nodes = Array.from(el.querySelectorAll(focusableSelector))
        .filter(n => !n.hasAttribute("disabled") && n.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown);
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === "function") {
        try { prev.focus(); } catch (e) { /* prior element may have unmounted */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
}

// ── Reusable floating-panel scaffolding (Wave 5.2) ──
// useDraggablePanel: shared drag/position logic for all floating panels.
// FloatingPanel: standard chrome (panel box + header bar + close button).
// Both replace ~25 lines of per-panel boilerplate that drifted across 8 panels.
function useDraggablePanel(panelPos, setPanelPos, defaultPos) {
  const [dragging, setDragging] = useState(false);
  const dragOffRef = useRef({ x: 0, y: 0 });
  const panelRef = useRef(null);

  useEffect(() => {
    if (panelPos.x === null && defaultPos) {
      const pos = typeof defaultPos === "function" ? defaultPos() : defaultPos;
      setPanelPos(pos);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMouseDown = (e) => {
    // Allow dragging from anywhere on the panel body, but never hijack interaction
    // with controls, canvases (topo hover/click), scrollables, or links.
    const tag = e.target.tagName;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA"
        || tag === "CANVAS" || tag === "A" || tag === "OPTION") return;
    if (e.target.closest && e.target.closest("button, select, input, textarea, canvas, a, [data-no-drag]")) return;
    const r = panelRef.current?.getBoundingClientRect();
    if (!r) return;
    dragOffRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => setPanelPos({ x: e.clientX - dragOffRef.current.x, y: e.clientY - dragOffRef.current.y });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  return { panelRef, dragging, onMouseDown };
}

function FloatingPanel({
  title, titleNode, onClose, panelPos, setPanelPos, defaultPos,
  width = 360, maxHeight, zIndex = 80,
  background = "#0c0c0c", border = "1px solid #2a2a2a", borderRadius = 0,
  titleColor = "#666", titleSize = 10, titleSpacing = "0.1em",
  headerBg, boxShadow, fontFamily, headerExtra, children,
}) {
  const { panelRef, dragging, onMouseDown } = useDraggablePanel(panelPos, setPanelPos, defaultPos);
  return (
    <div ref={panelRef} onMouseDown={onMouseDown} style={{
      position: "fixed", left: panelPos.x, top: panelPos.y, width, ...(maxHeight ? { maxHeight } : {}),
      background, border, borderRadius,
      display: "flex", flexDirection: "column", zIndex,
      cursor: dragging ? "grabbing" : "move", userSelect: dragging ? "none" : "auto",
      ...(boxShadow ? { boxShadow } : {}),
      ...(fontFamily ? { fontFamily } : {}),
    }}>
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid #1a1a1a", cursor: "grab",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        ...(headerBg ? { background: headerBg } : {}),
      }}>
        {titleNode || (
          <span style={{ fontSize: titleSize, fontWeight: 700, color: titleColor, letterSpacing: titleSpacing }}>{title}</span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {headerExtra}
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", padding: 2 }}>{I.X(14)}</button>
        </div>
      </div>
      {children}
    </div>
  );
}

// ── Floating compliance breakdown panel (Review tab) ──
function CompliancePanel({ result, filename, onClose, onRecompute, panelPos, setPanelPos }) {
  const STATUS_COLORS = {
    pass:    { color:"#10b981", bg:"#0a2a18", border:"#15532a", glyph:"✓" },
    warn:    { color:"#facc15", bg:"#1a1a0a", border:"#854d0e", glyph:"!" },
    fail:    { color:"#f87171", bg:"#2a0a0a", border:"#991b1b", glyph:"✗" },
    unknown: { color:"#888",    bg:"#0a0a0a", border:"#2a2a2a", glyph:"?" },
  };
  return (
    <FloatingPanel
      title="PROTOCOL COMPLIANCE" titleColor="#7ec8d9"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: Math.round(window.innerWidth * 0.5 - 230), y: 80 })}
      width={460} zIndex={90} fontFamily="'IBM Plex Mono', monospace"
      headerExtra={onRecompute ? (
        <button onClick={onRecompute} title="Re-run compliance checks" style={{
          background:"#111",border:"1px solid #222",color:"#888",fontSize:9,padding:"2px 8px",cursor:"pointer",letterSpacing:"0.06em"}}>RECOMPUTE</button>
      ) : null}
    >
      <div style={{padding:"10px 12px",borderBottom:"1px solid #1a1a1a",fontSize:10,color:"#888",display:"flex",alignItems:"center",gap:8}}>
        {result ? <ComplianceBadge result={result}/> : <span style={{color:"#666"}}>Not yet computed</span>}
        {result && (
          <span style={{marginLeft:"auto",color:"#555",fontSize:9}}>
            {result.passCount}P · {result.warnCount}W · {result.failCount}F · {result.unknownCount}?
          </span>
        )}
      </div>
      <div style={{maxHeight:380,overflowY:"auto"}}>
        {result ? result.checks.map(c => {
          const sc = STATUS_COLORS[c.status] || STATUS_COLORS.unknown;
          return (
            <div key={c.id} style={{padding:"8px 12px",borderBottom:"1px solid #111",display:"flex",alignItems:"flex-start",gap:8}}>
              <span style={{flexShrink:0,width:18,height:18,display:"inline-flex",alignItems:"center",justifyContent:"center",
                background:sc.bg,border:`1px solid ${sc.border}`,color:sc.color,fontSize:10,fontWeight:700}}>{sc.glyph}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,color:"#ddd",fontWeight:600}}>{c.name}</div>
                <div style={{fontSize:10,color:sc.color,marginTop:2}}>{c.message}</div>
              </div>
            </div>
          );
        }) : (
          <div style={{padding:"16px 12px",fontSize:11,color:"#666",fontStyle:"italic"}}>Click RECOMPUTE to run compliance checks for this recording.</div>
        )}
      </div>
      <div style={{padding:"8px 12px",borderTop:"1px solid #1a1a1a",fontSize:9,color:"#444"}}>
        {filename} · pipeline {PIPELINE_VERSION}
      </div>
    </FloatingPanel>
  );
}

// ── Tauri bridge — calls Rust backend when available, IDB fallback in browser ──
const tauriBridge = {
  async invoke(cmd, args = {}) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke(cmd, args);
    }
    // Browser fallback for development
    debugLog(`[Tauri stub] ${cmd}`, args);
    if (cmd === "initialize_app") return "Browser Mode — IDB persistence";
    if (cmd === "get_data_directory") return "Documents/REACT EEG (Tauri required)";
    if (cmd === "load_library_index") {
      const records = await idbGet(STORE_LIBRARY, "records");
      return JSON.stringify(records || []);
    }
    if (cmd === "load_config") return "{}";
    return null;
  },
  async showInExplorer(studyType, filename) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("show_in_explorer", { studyType, filename });
    }
    notify(`File location: Documents/REACT EEG/data/${studyType}/${filename}\n(Run as desktop app to open in Explorer)`, "info");
  },
  async deleteFiles(studyType, filename) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("delete_record_files", { studyType, filename });
    }
  },
  async saveLibrary(records) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_library_index", { recordsJson: JSON.stringify(records) });
    }
    await idbPut(STORE_LIBRARY, "records", records);
  },
  async saveAnnotations(filename, annotations) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_annotations", { filename, annotationsJson: JSON.stringify(annotations) });
    }
  },
  async loadAnnotations(filename) {
    if (window.__TAURI__) {
      const json = await window.__TAURI__.invoke("load_annotations", { filename });
      return JSON.parse(json);
    }
    return [];
  },
  async saveClinicalNotes(filename, text) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_clinical_notes", { filename, notesText: text });
    }
    await idbPut(STORE_NOTES, filename, text);
  },
  async loadClinicalNotes(filename) {
    if (window.__TAURI__) {
      return await window.__TAURI__.invoke("load_clinical_notes", { filename }) || "";
    }
    return (await idbGet(STORE_NOTES, filename)) || "";
  },
  async saveBaselineMap(map) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_baseline_map", { mapJson: JSON.stringify(map) });
    }
    await idbPut(STORE_BASELINES, "map", map);
  },
  async loadBaselineMap() {
    if (window.__TAURI__) {
      try {
        const json = await window.__TAURI__.invoke("load_baseline_map");
        return JSON.parse(json || "{}");
      } catch (e) { return {}; }
    }
    return (await idbGet(STORE_BASELINES, "map")) || {};
  },
  async saveCollections(collections) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_collections", { collectionsJson: JSON.stringify(collections) });
    }
    await idbPut(STORE_COLLECTIONS, "list", collections);
  },
  async loadCollections() {
    if (window.__TAURI__) {
      try {
        const json = await window.__TAURI__.invoke("load_collections");
        return JSON.parse(json || "[]");
      } catch (e) { return []; }
    }
    return (await idbGet(STORE_COLLECTIONS, "list")) || [];
  },
  async openDataDirectory() {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("open_data_directory");
    }
    notify("Documents/REACT EEG/\n(Run as desktop app to open folder)", "info");
  },
};

// ── TypeBadge — study type label ──
function TypeBadge({ record }) {
  const st = STUDY_TYPES[record.studyType] || { label: "?", color: "#666" };
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5}}>
      <span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:0,fontSize:10,fontWeight:700,
        whiteSpace:"nowrap",background:st.color+"18",color:st.color,border:`1px solid ${st.color}30`}}>
        {st.label}
      </span>
    </span>
  );
}

// ── RecordActions — edit menu with delete + open location ──
function RecordActions({ record, onDelete, onOpenReview, collections, onToggleCollection, onOpenTimeline }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setConfirmDelete(false); setShowCollections(false); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const menuItem = (icon, label, color, onClick) => (
    <button onClick={(e)=>{e.stopPropagation();onClick();}} style={{
      display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 12px",
      background:"transparent",border:"none",color,fontSize:11,fontWeight:500,
      cursor:"pointer",textAlign:"left",fontFamily:"'IBM Plex Mono', monospace",
      transition:"background 0.1s",
    }}
      onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      {icon} {label}
    </button>
  );

  return (
    <div ref={wrapRef} style={{position:"relative",zIndex:open?30:1}}>
      <button onClick={(e)=>{e.stopPropagation();setOpen(!open);setConfirmDelete(false);}} style={{
        padding:"4px 6px",background:open?"#1a1a1a":"transparent",border:"1px solid transparent",
        borderRadius:0,cursor:"pointer",color:open?"#ccc":"#555",transition:"all 0.15s",
        display:"flex",alignItems:"center",
      }}
        onMouseEnter={e=>{if(!open)e.currentTarget.style.color="#aaa";}}
        onMouseLeave={e=>{if(!open)e.currentTarget.style.color="#555";}}>
        {I.MoreVert(16)}
      </button>

      {open && (
        <div style={{
          position:"absolute",right:0,top:"100%",marginTop:4,
          width:200,background:"#111",border:"1px solid #2a2a2a",borderRadius:0,
          overflow:"hidden",
        }}>
          {!confirmDelete && !showCollections ? (<>
            {menuItem(I.Eye(13), "Open in Review", "#ccc", () => { onOpenReview(record); setOpen(false); })}
            {menuItem(I.Folder(13), "Open File Location", "#ccc", () => {
              tauriBridge.showInExplorer(record.studyType, record.filename);
              setOpen(false);
            })}
            {onOpenTimeline && (
              <>
                <div style={{borderTop:"1px solid #1a1a1a",margin:"2px 0"}}/>
                {menuItem(I.BarChart(13), "View Subject Timeline", "#a78bfa", () => { onOpenTimeline(record.subjectHash); setOpen(false); })}
              </>
            )}
            {collections && onToggleCollection && (
              <>
                <div style={{borderTop:"1px solid #1a1a1a",margin:"2px 0"}}/>
                {menuItem(I.Folder(13), `Collections (${(record.collectionIds || []).length})`, "#7ec8d9", () => setShowCollections(true))}
              </>
            )}
            <div style={{borderTop:"1px solid #1a1a1a",margin:"2px 0"}}/>
            {menuItem(I.Trash(13), "Delete Record", "#f87171", () => setConfirmDelete(true))}
          </>) : showCollections ? (
            <div>
              <div style={{padding:"6px 10px",borderBottom:"1px solid #1a1a1a",fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em"}}>ADD TO COLLECTION</div>
              <div style={{maxHeight:200,overflowY:"auto"}}>
                {(collections || []).map(col => {
                  const inCol = (record.collectionIds || []).includes(col.id);
                  return (
                    <button key={col.id} onClick={(e)=>{e.stopPropagation();onToggleCollection(col.id);}}
                      style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"6px 12px",background:"transparent",border:"none",
                        borderBottom:"1px solid #0a0a0a",color:inCol?"#7ec8d9":"#bbb",fontSize:11,cursor:"pointer",textAlign:"left",
                        fontFamily:"'IBM Plex Mono', monospace"}}
                      onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span style={{width:12,height:12,border:`1px solid ${inCol?"#4a9bab":"#333"}`,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:9,color:inCol?"#7ec8d9":"transparent",flexShrink:0}}>✓</span>
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{col.name}</span>
                    </button>
                  );
                })}
              </div>
              <button onClick={(e)=>{e.stopPropagation();setShowCollections(false);}}
                style={{width:"100%",padding:"6px 10px",background:"#0a0a0a",border:"none",borderTop:"1px solid #1a1a1a",color:"#888",cursor:"pointer",fontSize:10,textAlign:"center"}}>← Back</button>
            </div>
          ) : (
            <div style={{padding:12}}>
              <div style={{fontSize:11,color:"#f87171",fontWeight:600,marginBottom:4}}>Delete this record?</div>
              <div style={{fontSize:10,color:"#555",marginBottom:10,lineHeight:1.4,fontFamily:"'IBM Plex Mono', monospace"}}>
                {record.filename}
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={(e)=>{e.stopPropagation();setConfirmDelete(false);setOpen(false);}} style={{
                  flex:1,padding:"5px 0",background:"#111",border:"1px solid #333",borderRadius:0,
                  color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
                }}>Cancel</button>
                <button onClick={(e)=>{e.stopPropagation();tauriBridge.deleteFiles(record.studyType,record.filename);onDelete(record.id);setOpen(false);setConfirmDelete(false);}} style={{
                  flex:1,padding:"5px 0",background:"#7f1d1d",border:"1px solid #EF444440",borderRadius:0,
                  color:"#f87171",cursor:"pointer",fontSize:10,fontWeight:700,
                }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StatusControl — clickable status setter ──
function StatusControl({ status, onSetStatus, size = "normal" }) {
  const statuses = [
    { key: "pending",  icon: I.Clock(),  color: "#facc15", border: "#854d0e", bg: "#1a1a0a", label: "Pending" },
    { key: "verified", icon: I.Check(),  color: "#7ec8d9", border: "#1a4a54", bg: "#0a2a30", label: "Verified" },
    { key: "flagged",  icon: I.Alert(),  color: "#f87171", border: "#991b1b", bg: "#2a0a0a", label: "Flagged" },
  ];
  const compact = size === "compact";
  return (
    <div style={{display:"flex",gap:compact?3:4,alignItems:"center"}}>
      {statuses.map(s => {
        const active = status === s.key;
        return (
          <button key={s.key} onClick={(e)=>{e.stopPropagation();onSetStatus(s.key);}} title={s.label}
            style={{
              display:"flex",alignItems:"center",gap:compact?3:5,
              padding:compact?"2px 6px":"4px 10px",
              background:active?s.bg:"transparent",
              border:`1px solid ${active?s.border:"#222"}`,
              borderRadius:0,cursor:"pointer",transition:"all 0.15s",
              color:active?s.color:"#555",fontSize:compact?9:10,fontWeight:active?700:500,
            }}
            onMouseEnter={e=>{if(!active){e.currentTarget.style.borderColor=s.border;e.currentTarget.style.color=s.color;}}}
            onMouseLeave={e=>{if(!active){e.currentTarget.style.borderColor="#222";e.currentTarget.style.color="#555";}}}>
            {s.icon}
            {!compact && <span>{s.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// WAVEFORM CANVAS — shared between REVIEW and RECORD
// ══════════════════════════════════════════════════════════════
function WaveformCanvas({ eeg, children, playbackAbsSec = null, isPlaying = false }) {
  // Trace/interaction state is owned by useEEGState — destructure the slice this canvas
  // needs rather than threading ~25 props through each call site. Canvas-handler names
  // are re-aliased to the on* names the body already uses. playbackAbsSec/isPlaying stay
  // explicit props: they're the only ones that differ between call sites (Review passes
  // them for the playback cursor; Acquire omits them). isLiveSimulation/simClipRef are a
  // dormant live-sim feature — undefined here, kept declared so the draw code can read them.
  const {
    channels, waveformData, epochSec, epochStart, epochEnd, sampleRate,
    sensitivity, channelSensitivity = {}, annotations = [], annotationDraft,
    selectedAnnotationType, hoveredTime, isAddingAnnotation, isMeasuring,
    measureSel, measureDragRef, containerRef, canvasRef, montage,
    isLiveSimulation, simClipRef,
    handleCanvasMouseMove: onMouseMove, handleCanvasMouseDown: onMouseDown,
    handleCanvasMouseUp: onMouseUp, handleCanvasClick: onClick,
    handleContextMenu: onContextMenu,
  } = eeg;
  const onMouseLeave = () => eeg.setHoveredTime(null);

  // Wave 5.3 — split rendering into two stacked canvases:
  //   • TRACE: waveforms + grid + persistent annotations + axis. Heavy redraw, narrow deps.
  //   • OVERLAY: hover crosshair + annotation draft + measurement selection. Cheap redraw on interaction.
  // The overlay sits over the trace with pointer-events:none so the container still owns mouse events.
  const overlayCanvasRef = useRef(null);

  const drawTrace = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, W, H);

    const labelWidth = 72, plotW = W - labelWidth - 16, plotX = labelWidth;
    const { positions: chPositions, bottomPad } = getChannelYPositions(channels, montage, H);
    const samplesPerEpoch = sampleRate * epochSec;

    // Grid — one vertical line per second. Slightly brighter than before so the
    // passage of time is easier to follow against the traces.
    ctx.strokeStyle = "#242424"; ctx.lineWidth = 0.5;
    for (let t = 0; t <= epochSec; t++) {
      const x = plotX + (t / epochSec) * plotW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    // Persistent annotations (the in-progress draft is drawn by the overlay layer)
    const epochAnns = annotations.filter(a => a.time >= epochStart && a.time < epochEnd);
    epochAnns.forEach(ann => {
      const x1 = plotX + ((ann.time - epochStart) / epochSec) * plotW;
      const x2 = x1 + (ann.duration / epochSec) * plotW;
      ctx.fillStyle = ann.color + "15"; ctx.fillRect(x1, 0, Math.max(x2-x1, 2), H);
      ctx.strokeStyle = ann.color + "60"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
      ctx.fillStyle = ann.color; ctx.font = "bold 9px 'IBM Plex Mono', monospace";
      ctx.fillText(ann.type, x1 + 3, 12);
    });

    // Channels
    channels.forEach((ch, i) => {
      const yCenter = chPositions[i].yCenter;
      const data = waveformData[i];
      if (!data) return;
      const chSensOffset = channelSensitivity[ch] || 0;
      const isAux = ch === "EKG" || ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2";
      const baseSens = isAux ? 7 : sensitivity; // Global sensitivity only affects EEG channels
      const effSens = Math.max(1, baseSens + chSensOffset); // Per-channel offset still applies
      const ekgDampen = ch === "EKG" ? 3 : 1;
      const chScale = (73.5 / effSens) * ekgDampen; // Higher sensitivity = taller waveforms (mm/µV)
      // Chain break: separator line at L→R, midline, and aux group transitions.
      // breaks[] holds channel indices that START a new chain; the bright separator
      // belongs at the BOTTOM of the previous channel (i.e. between i and i+1) so it
      // aligns with the 8px gap added before channel i+1 in getChannelYPositions.
      const breaks = getChainBreaks(channels);
      const isChainBreak = breaks.includes(i + 1);
      ctx.strokeStyle = isChainBreak ? "#2a2a2a" : "#151515"; ctx.lineWidth = isChainBreak ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(plotX, chPositions[i].yTop + chPositions[i].height); ctx.lineTo(W, chPositions[i].yTop + chPositions[i].height); ctx.stroke();
      // Derivation markers when a bipolar reference electrode was missing in the EDF:
      //  • __avgRef → re-referenced to the common average (a valid derivation): show the first
      //    electrode with a muted "·avg" suffix in cyan, no alarm.
      //  • __partial → truly unreferenced (too few electrodes to average): prefix ⚠ in amber.
      const isPartial = data.__partial === true;
      const isAvgRefCh = data.__avgRef === true;
      ctx.fillStyle = isPartial ? "#F59E0B" : isAvgRefCh ? "#22d3ee" :
        (ch === "EKG" ? "#EC4899" : (ch==="LOC1"||ch==="LOC2"||ch==="ROC1"||ch==="ROC2") ? "#F59E0B" : "#666");
      ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const labelText = isAvgRefCh ? (ch.split("-")[0] + "·avg") : ((isPartial ? "⚠ " : "") + ch);
      ctx.fillText(labelText, labelWidth - 8, yCenter);
      ctx.strokeStyle = ch === "EKG" ? "#FF3333" : (ch==="LOC1"||ch==="LOC2"||ch==="ROC1"||ch==="ROC2") ? "#F59E0B80" : "#1a8fff";
      ctx.lineWidth = ch === "EKG" ? 1.2 : 0.9;
      ctx.beginPath();
      const clipSamples = (isLiveSimulation && simClipRef?.current !== undefined)
        ? Math.min(data.length, Math.floor(simClipRef.current * samplesPerEpoch))
        : data.length;
      const step = Math.max(1, Math.floor(clipSamples / plotW / 2));
      for (let j = 0; j < clipSamples; j += step) {
        const x = plotX + (j / samplesPerEpoch) * plotW;
        const y = yCenter - (data[j] / chScale);
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // Sweep line for live simulation
    if (isLiveSimulation && simClipRef?.current !== undefined && simClipRef.current < 1.0) {
      const sweepX = plotX + simClipRef.current * plotW;
      ctx.strokeStyle = "#7ec8d940";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sweepX, 0);
      ctx.lineTo(sweepX, H);
      ctx.stroke();
    }

    // ── Bottom buffer lane — a grey floor line in the reserved blank space below the last
    // channel, so the lowest trace is clearly separated from the time axis / canvas edge. ──
    if (chPositions.length) {
      const last = chPositions[chPositions.length - 1];
      const lastBottom = last.yTop + last.height;
      const floorY = Math.min(lastBottom + bottomPad * 0.45, H - 16 - 3);
      ctx.strokeStyle = "#3a3a3a"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plotX, floorY + 0.5); ctx.lineTo(W, floorY + 0.5); ctx.stroke();
    }

    // ── Time axis (absolute file time) ──
    // A subtle masking strip keeps the labels readable over trace tails; brighter
    // labels + tick marks make the passage of time easy to follow, and an
    // epoch-length tag in the left gutter shows the page length at a glance — so
    // you don't have to look up at the toolbar to know how long each page is.
    const STRIP_H = 16;
    ctx.fillStyle = "rgba(10,10,10,0.82)";
    ctx.fillRect(0, H - STRIP_H, W, STRIP_H);
    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - STRIP_H + 0.5); ctx.lineTo(W, H - STRIP_H + 0.5); ctx.stroke();

    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = "10px 'IBM Plex Mono', monospace";
    for (let t = 0; t <= epochSec; t++) {
      const x = plotX + (t / epochSec) * plotW;
      const tv = epochStart + t;
      // tick mark hanging off the axis line
      ctx.strokeStyle = "#555"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, H - STRIP_H + 1); ctx.lineTo(x, H - STRIP_H + 4); ctx.stroke();
      // brighter, more legible time label
      ctx.fillStyle = "#8a929c";
      ctx.fillText(`${Math.floor(tv/60)}:${String(Math.floor(tv%60)).padStart(2,"0")}`, x, H - 3);
    }
    // Epoch-length quick reference in the left gutter
    ctx.textAlign = "left";
    ctx.fillStyle = "#7ec8d9"; ctx.font = "bold 9px 'IBM Plex Mono', monospace";
    ctx.fillText(`${epochSec}s/pg`, 6, H - 3);
    ctx.textBaseline = "alphabetic";
  }, [waveformData, channels, epochSec, epochStart, epochEnd, sampleRate, sensitivity, channelSensitivity, annotations, canvasRef, containerRef, isLiveSimulation, simClipRef, montage]);

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const labelWidth = 72, plotW = W - labelWidth - 16, plotX = labelWidth;
    const { positions: chPositions, chHeight } = getChannelYPositions(channels, montage, H);

    // In-progress annotation draft (the click target for placing a new annotation)
    if (annotationDraft) {
      const x = plotX + ((annotationDraft.time - epochStart) / epochSec) * plotW;
      ctx.strokeStyle = ANNOTATION_COLORS[selectedAnnotationType || 0].color + "AA";
      ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Hover crosshair + time readout
    if (hoveredTime !== null) {
      const x = plotX + ((hoveredTime - epochStart) / epochSec) * plotW;
      ctx.strokeStyle = "#ffffff20"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = "#ffffff90"; ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillText(hoveredTime.toFixed(2) + "s", x + 4, H - 6);
    }

    // Real-time playback cursor — a bright white vertical line that scrolls
    // across the epoch when playing, then snaps to the start of the next epoch.
    // Visible while playing AND while paused mid-epoch (preserves the position
    // so resume continues from where the user stopped).
    // Cursor uses absolute file time — render only when it falls inside the
    // currently-visible epoch window. If the user manually navigates elsewhere
    // while playing, the cursor is simply off-screen until playback catches up
    // (or until the user navigates back).
    if (playbackAbsSec != null && playbackAbsSec >= epochStart && playbackAbsSec < epochEnd) {
      const localSec = playbackAbsSec - epochStart;
      if (isPlaying || localSec > 0.01 || playbackAbsSec > 0.01) {
        const x = plotX + (localSec / epochSec) * plotW;
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }

    // Measurement selection rectangle (live drag or completed) + analysis box
    const sel = measureSel || (measureDragRef?.current ? {
      startTime: Math.min(measureDragRef.current.startTime, measureDragRef.current.curTime),
      endTime: Math.max(measureDragRef.current.startTime, measureDragRef.current.curTime),
      startChIdx: Math.min(measureDragRef.current.startChIdx, measureDragRef.current.curChIdx),
      endChIdx: Math.max(measureDragRef.current.startChIdx, measureDragRef.current.curChIdx),
    } : null);
    if (sel && isMeasuring) {
      const x1 = plotX + ((sel.startTime - epochStart) / epochSec) * plotW;
      const x2 = plotX + ((sel.endTime - epochStart) / epochSec) * plotW;
      const y1 = chPositions[sel.startChIdx]?.yTop || 0;
      const y2 = (chPositions[sel.endChIdx]?.yTop || 0) + (chPositions[sel.endChIdx]?.height || chHeight);
      ctx.fillStyle = "rgba(126, 200, 217, 0.08)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeStyle = "#7ec8d9";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);

      // Analysis box \u2014 only for the completed selection, not while dragging
      if (measureSel && !measureDragRef?.current) {
        const dur = sel.endTime - sel.startTime;
        const durMs = (dur * 1000).toFixed(1);
        const nCh = sel.endChIdx - sel.startChIdx + 1;
        let totalPP = 0, ppCount = 0, domFreq = 0, freqCount = 0;
        for (let ci = sel.startChIdx; ci <= sel.endChIdx; ci++) {
          const data = waveformData[ci];
          if (!data) continue;
          const s0 = Math.max(0, Math.floor((sel.startTime - epochStart) / epochSec * data.length));
          const s1 = Math.min(data.length, Math.floor((sel.endTime - epochStart) / epochSec * data.length));
          if (s1 <= s0) continue;
          let mn = Infinity, mx = -Infinity;
          for (let j = s0; j < s1; j++) { if (data[j] < mn) mn = data[j]; if (data[j] > mx) mx = data[j]; }
          totalPP += (mx - mn); ppCount++;
          // Dominant frequency via zero-crossing rate (fast approximation)
          let crossings = 0;
          const slice = data.slice(s0, s1);
          const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
          for (let j = 1; j < slice.length; j++) {
            if ((slice[j] - mean) * (slice[j - 1] - mean) < 0) crossings++;
          }
          const estFreq = (crossings / 2) / dur;
          domFreq += estFreq; freqCount++;
        }
        const avgPP = ppCount > 0 ? (totalPP / ppCount) : 0;
        const avgFreq = freqCount > 0 ? (domFreq / freqCount) : 0;
        const bandName = avgFreq < 4 ? "Delta" : avgFreq < 8 ? "Theta" : avgFreq < 13 ? "Alpha" : avgFreq < 30 ? "Beta" : "Gamma";
        const boxW = 130, boxH = 58;
        let bx = x2 + 6, by = y1;
        if (bx + boxW > plotX + plotW) bx = x1 - boxW - 6;
        if (by + boxH > H) by = H - boxH - 4;
        ctx.fillStyle = "#000000DD";
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = "#7ec8d960";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, boxW, boxH);
        ctx.font = "bold 9px 'IBM Plex Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`${durMs} ms  ${nCh} ch`, bx + 6, by + 13);
        ctx.fillStyle = "#7ec8d9";
        ctx.fillText(`Amp p-p: ${avgPP.toFixed(1)} \u00B5V`, bx + 6, by + 26);
        ctx.fillStyle = "#F59E0B";
        ctx.fillText(`Freq: ${avgFreq.toFixed(1)} Hz`, bx + 6, by + 39);
        ctx.fillStyle = "#888";
        ctx.font = "8px 'IBM Plex Mono', monospace";
        ctx.fillText(`Band: ${bandName}`, bx + 6, by + 51);
      }
    }
  }, [waveformData, channels, epochSec, epochStart, epochEnd, sensitivity, channelSensitivity, annotationDraft, selectedAnnotationType, hoveredTime, measureSel, isMeasuring, measureDragRef, containerRef, montage, playbackAbsSec, isPlaying]);

  // Trace effect: redraws on data/filter/sensitivity/epoch change; rAF only for live-sim
  // because that's the one case the waveform path itself changes per frame.
  useEffect(() => {
    drawTrace();
    const h = () => drawTrace();
    window.addEventListener("resize", h);
    let animFrame;
    if (isLiveSimulation) {
      const animLoop = () => {
        drawTrace();
        animFrame = requestAnimationFrame(animLoop);
      };
      animFrame = requestAnimationFrame(animLoop);
    }
    return () => { window.removeEventListener("resize", h); if (animFrame) cancelAnimationFrame(animFrame); };
  }, [drawTrace, isLiveSimulation]);

  // Overlay effect: cheap redraws on hover/draft changes; rAF while measuring because
  // measureDragRef updates synchronously without triggering React re-renders. Reads
  // canvasRef.__measureDirty (set by the measurement-drag handler in useEEGState).
  useEffect(() => {
    drawOverlay();
    const h = () => drawOverlay();
    window.addEventListener("resize", h);
    let animFrame;
    if (isMeasuring) {
      const animLoop = () => {
        if (canvasRef.current?.__measureDirty) {
          drawOverlay();
          canvasRef.current.__measureDirty = false;
        }
        animFrame = requestAnimationFrame(animLoop);
      };
      animFrame = requestAnimationFrame(animLoop);
    }
    return () => { window.removeEventListener("resize", h); if (animFrame) cancelAnimationFrame(animFrame); };
  }, [drawOverlay, isMeasuring]);

  // Channel hover info — small floating tooltip near cursor showing the hovered
  // channel name (and a partial-derivation warning when the channel had its bipolar
  // reference electrode missing in the source EDF — same condition that draws ⚠).
  const [chTip, setChTip] = useState(null); // { text, partial, x, y } | null
  const handleMouseMove = (e) => {
    onMouseMove?.(e);
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const x = e.clientX - rect.left;
    if (x < 72 || x > rect.width - 16 || y < 0 || y > rect.height) { setChTip(null); return; }
    const { positions } = getChannelYPositions(channels, montage, rect.height);
    let chIdx = -1;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (y >= p.yTop && y < p.yTop + p.height) { chIdx = i; break; }
    }
    if (chIdx < 0) { setChTip(null); return; }
    const chName = channels[chIdx];
    const partial = waveformData[chIdx]?.__partial === true;
    const avgRef = waveformData[chIdx]?.__avgRef === true;
    setChTip({ text: chName, partial, avgRef, x: e.clientX + 14, y: e.clientY + 18 });
  };
  const handleMouseLeaveLocal = (e) => { onMouseLeave?.(e); setChTip(null); };

  return (
    <div ref={containerRef}
      style={{ flex: 1, position: "relative", cursor: isMeasuring ? "crosshair" : isAddingAnnotation ? "crosshair" : "default" }}
      onMouseMove={handleMouseMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp} onMouseLeave={handleMouseLeaveLocal} onClick={onClick} onContextMenu={onContextMenu}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <canvas ref={overlayCanvasRef} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} />
      {children}
      {chTip && (
        <div style={{
          position: "fixed", left: chTip.x, top: chTip.y, zIndex: 9999,
          background: "#0c0c0c", border: `1px solid ${chTip.partial ? "#854d0e" : chTip.avgRef ? "#155e75" : "#2a2a2a"}`,
          padding: "5px 10px", fontSize: 11, color: "#ddd",
          fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.4,
          pointerEvents: "none", maxWidth: 260,
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        }}>
          <span style={{color:"#7ec8d9",fontWeight:700}}>{chTip.text}</span>
          {chTip.partial && (
            <div style={{color:"#facc15",fontSize:10,marginTop:3,lineHeight:1.5}}>
              ⚠ Partial derivation — the reference electrode is missing in the source EDF, so this trace is the unreferenced first electrode only.
            </div>
          )}
          {chTip.avgRef && (
            <div style={{color:"#22d3ee",fontSize:10,marginTop:3,lineHeight:1.5}}>
              Re-referenced to common average — the bipolar reference electrode is absent in the source EDF, so this trace is the first electrode minus the mean of all scalp electrodes.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CUSTOM ELECTRODE PICKER — modal for "Custom" EEG system
// ══════════════════════════════════════════════════════════════
function CustomElectrodePicker({ customElectrodes, setCustomElectrodes, onClose }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);
  const toggle = (el) => setCustomElectrodes(prev => {
    const next = new Set(prev);
    if (next.has(el)) next.delete(el); else next.add(el);
    return next;
  });
  const selectAll = () => setCustomElectrodes(new Set([...ELECTRODE_SETS["10-20"], "LOC1","LOC2","ROC1","ROC2"]));
  const clearAll = () => setCustomElectrodes(new Set());
  const eegCount = ELECTRODE_SETS["10-20"].filter(e => customElectrodes.has(e)).length;
  const eyeCount = EYE_LEAD_DEFS.filter(e => customElectrodes.has(e.ch)).length;

  const cbStyle = (checked) => ({
    display:"flex",alignItems:"center",gap:5,padding:"3px 8px",
    background:checked?"#1a2a30":"#111",border:`1px solid ${checked?"#4a9bab":"#222"}`,
    borderRadius:2,cursor:"pointer",fontSize:10,color:checked?"#7ec8d9":"#555",
    fontWeight:checked?700:400,fontFamily:"'IBM Plex Mono', monospace",transition:"all 0.15s",
    minWidth:52,justifyContent:"center",
  });
  const eyeStyle = (checked) => ({
    ...cbStyle(checked),
    color:checked?"#F59E0B":"#555",border:`1px solid ${checked?"#F59E0B40":"#222"}`,
    background:checked?"#1a1a10":"#111",minWidth:130,justifyContent:"flex-start",
  });

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:9999,
      display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="custom-electrode-title" style={{background:"#0c0c0c",border:"1px solid #222",padding:"20px 24px",
        minWidth:420,maxWidth:520,borderRadius:2}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <span id="custom-electrode-title" style={{fontSize:13,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>
            Custom Electrode Selection
          </span>
          <span style={{fontSize:10,color:"#555"}}>{eegCount} EEG + {eyeCount} Eye = {eegCount+eyeCount} leads</span>
        </div>

        {ELECTRODE_REGIONS.map(region => (
          <div key={region.label} style={{marginBottom:10}}>
            <div style={{fontSize:9,color:"#444",fontWeight:700,marginBottom:4,textTransform:"uppercase",letterSpacing:1}}>
              {region.label}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
              {region.electrodes.map(el => (
                <div key={el} onClick={()=>toggle(el)} style={cbStyle(customElectrodes.has(el))}>
                  <span style={{width:8,height:8,borderRadius:"50%",
                    background:customElectrodes.has(el)?"#7ec8d9":"#333",flexShrink:0}}/>
                  {el}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div style={{marginTop:12,marginBottom:10,borderTop:"1px solid #1a1a1a",paddingTop:12}}>
          <div style={{fontSize:9,color:"#F59E0B",fontWeight:700,marginBottom:4,textTransform:"uppercase",letterSpacing:1}}>
            Eye Leads
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
            {EYE_LEAD_DEFS.map(({ch, label}) => (
              <div key={ch} onClick={()=>toggle(ch)} style={eyeStyle(customElectrodes.has(ch))}>
                <span style={{width:8,height:8,borderRadius:"50%",
                  background:customElectrodes.has(ch)?"#F59E0B":"#333",flexShrink:0}}/>
                {label}
              </div>
            ))}
          </div>
          <div style={{fontSize:9,color:"#444",marginTop:6,fontStyle:"italic"}}>
            LOC1/LOC2 track vertical eye movement via Fp1/Fp2. ROC1/ROC2 track horizontal via F7/F8.
          </div>
        </div>

        <div style={{display:"flex",gap:8,marginTop:16,justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:8}}>
            <button onClick={selectAll} style={{...controlBtn(),fontSize:10}}>Select All</button>
            <button onClick={clearAll} style={{...controlBtn(),fontSize:10}}>Clear</button>
          </div>
          <button onClick={onClose} style={{...controlBtn(),color:"#7ec8d9",border:"1px solid #4a9bab",fontSize:10,padding:"4px 16px"}}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MONTAGE BUILDER — build a custom bipolar montage from any two leads
// ══════════════════════════════════════════════════════════════
// Canonical electrode order for the builder pickers: front → back of the head, the
// circumferential (outer perimeter) chain first, then the parasagittal/central chains —
// the same anatomical sweep a 10-10 longitudinal-bipolar ("double banana") montage follows.
// Alias spellings (T7/T3, T8/T4, P7/T5, P8/T6) are both listed so whichever the EDF uses
// is ranked correctly. Anything not listed sorts to the end, alphabetically.
const ELECTRODE_DISPLAY_ORDER = [
  // ── Circumferential ring, front → back ──
  "Fp1", "Fpz", "Fp2",
  "AF7", "AF8",
  "F9", "F7", "F8", "F10",
  "FT9", "FT7", "FT8", "FT10",
  "T9", "T7", "T3", "T4", "T8", "T10",
  "TP9", "TP7", "TP8", "TP10",
  "P9", "P7", "T5", "T6", "P8", "P10",
  "PO7", "PO8",
  "O1", "Oz", "O2", "Iz",
  // ── Parasagittal + central chains, front → back ──
  "AF3", "AFz", "AF4",
  "F5", "F3", "F1", "Fz", "F2", "F4", "F6",
  "FC5", "FC3", "FC1", "FCz", "FC2", "FC4", "FC6",
  "C5", "C3", "C1", "Cz", "C2", "C4", "C6",
  "CP5", "CP3", "CP1", "CPz", "CP2", "CP4", "CP6",
  "P5", "P3", "P1", "Pz", "P2", "P4", "P6",
  "PO3", "POz", "PO4",
  // ── Reference / ear leads last ──
  "A1", "A2", "M1", "M2",
];
const ELECTRODE_RANK = Object.fromEntries(ELECTRODE_DISPLAY_ORDER.map((e, i) => [e, i]));
const electrodeRank = (name) => (name in ELECTRODE_RANK ? ELECTRODE_RANK[name] : ELECTRODE_DISPLAY_ORDER.length);

// Leads that are NOT scalp EEG (EOG/eye, EKG, EMG) — excluded from the montage builder,
// which only offers 10-10 EEG nomenclature.
const NON_EEG_LEADS = new Set(["LEOG1", "LEOG2", "REOG1", "REOG2", "LOC1", "LOC2", "ROC1", "ROC2", "EKG", "ECG", "EOG", "EMG"]);

// Modern 10-10 ↔ legacy 10-20 temporal aliases (same physical site). Used to dedupe the
// builder list so e.g. T7 (in the file) and T3 (the legacy name) aren't both shown.
const TEMPORAL_ALIAS = { T7: "T3", T8: "T4", P7: "T5", P8: "T6" };
const aliasKey = (n) => TEMPORAL_ALIAS[n] || n;

// Full 10-10 EEG name recognizer. ELECTRODE_2D only carries the ~40 electrodes that have 2D
// scalp positions (for topo), so labels like "Fc3.", "Cz..", "Cp4." were going unrecognized.
// Build the canonical set from the complete 10-10 display order ∪ ELECTRODE_2D keys so every
// standard scalp lead in a high-density EDF is correctly identified as EEG.
const EEG_NAME_TO_CANON = (() => {
  const m = new Map();
  for (const n of [...ELECTRODE_DISPLAY_ORDER, ...Object.keys(ELECTRODE_2D)]) {
    if (NON_EEG_LEADS.has(n)) continue;
    const key = n.toUpperCase();
    if (!m.has(key)) m.set(key, n);
  }
  return m;
})();
// Map an EDF signal label to a canonical 10-10 electrode name, or null if it isn't scalp EEG.
// Handles "EEG " prefixes, trailing dots (PhysioNet "Fc3."), and "-REF"/"-LE" suffixes.
function canonicalElectrode(label) {
  if (!label) return null;
  let s = String(label).trim().replace(/^(EEG|REF)\s+/i, "");
  s = s.split(/[\s\-]/)[0].replace(/\./g, "");   // token before space/dash, drop dots
  return EEG_NAME_TO_CANON.get(s.toUpperCase()) || null;
}

// Special, file-derived montage keys (handled in useEEGState, not in MONTAGE_DEFS).
const MONTAGE_ADAPTIVE = "adaptive-banana";
const MONTAGE_AS_RECORDED = "as-recorded";

// Anterior→posterior 10-10 chains (one per sagittal column) used to build an adaptive
// longitudinal-bipolar ("double banana") montage from whatever electrodes a file actually has.
// Ordered the way clinical longitudinal montages are READ: band by band from the temporal
// (circumferential) perimeter inward to the midline, and within each band LEFT then RIGHT
// (L-temporal, R-temporal, L-parasagittal, R-parasagittal, … midline last). Sparse files
// (10-20) collapse to the classic banana; high-density files fill in the intermediate bands.
const ADAPTIVE_BANANA_COLUMNS = [
  // Temporal / circumferential band
  ["Fp1","AF7","F7","FT7","T7","TP7","P7","PO7","O1"],        // L temporal
  ["Fp2","AF8","F8","FT8","T8","TP8","P8","PO8","O2"],        // R temporal
  // Lateral band (…5/6 line)
  ["F5","FC5","C5","CP5","P5"],                                // L lateral
  ["F6","FC6","C6","CP6","P6"],                                // R lateral
  // Parasagittal band (…3/4 line)
  ["Fp1","AF3","F3","FC3","C3","CP3","P3","PO3","O1"],         // L parasagittal
  ["Fp2","AF4","F4","FC4","C4","CP4","P4","PO4","O2"],         // R parasagittal
  // Paramedian band (…1/2 line)
  ["F1","FC1","C1","CP1","P1"],                                // L paramedian
  ["F2","FC2","C2","CP2","P2"],                                // R paramedian
  // Midline (…z line) — last
  ["Fpz","AFz","Fz","FCz","Cz","CPz","Pz","POz","Oz","Iz"],
];

// Build a longitudinal-bipolar montage (array of "A-B" pairs) from the electrodes present in
// the file. Tolerant of modern↔legacy temporal naming (T7↔T3 etc.) and of missing electrodes
// (it just bridges to the next present one down the column).
function buildAdaptiveBanana(presentElectrodes) {
  const byAlias = new Map();
  for (const e of (presentElectrodes || [])) { const k = aliasKey(e); if (!byAlias.has(k)) byAlias.set(k, e); }
  const resolve = (name) => byAlias.get(aliasKey(name)) || null;
  const out = [];
  for (const col of ADAPTIVE_BANANA_COLUMNS) {
    const chain = col.map(resolve).filter(Boolean);
    for (let i = 0; i + 1 < chain.length; i++) {
      const pair = `${chain[i]}-${chain[i + 1]}`;
      if (!out.includes(pair)) out.push(pair);
    }
  }
  return out;
}

// Clean an EDF signal label to a display channel name: strip "EEG "/"ECG " prefix and trailing
// dots, keep any "-Ref" derivation (so a pre-montaged file's labels are honored verbatim).
function cleanEdfLabel(l) {
  return String(l || "").trim().replace(/^(EEG|ECG|EKG|EOG|EMG)\s+/i, "").replace(/\.+$/, "").trim();
}
// "As recorded" montage = the file's own signals, one trace each, exactly as stored.
function asRecordedChannels(edfData) {
  return (edfData?.channelLabels || []).map(cleanEdfLabel).filter(Boolean);
}

// Classify a recording's electrode system from the EDF by counting the distinct scalp-EEG
// electrodes actually present (recognized 10-10 names), so a high-density file isn't mislabeled
// "10-20" just because that's the import default. Returns "10-20" | "hd-40" | "10-10" | null.
function detectEdfSystem(edfData) {
  const labels = edfData?.channelLabels || [];
  const seen = new Set();
  for (const l of labels) { const e = canonicalElectrode(l); if (e && !NON_EEG_LEADS.has(e)) seen.add(e); }
  const n = seen.size;
  if (n === 0) return null;
  if (n <= 21) return "10-20";
  if (n <= 40) return "hd-40";
  return "10-10";
}
// Does the file ship derivations in its labels (a pre-montaged EDF, e.g. "Fp1-F3")?
function edfHasDerivedLabels(edfData) {
  return (edfData?.channelLabels || []).some(l => {
    const c = cleanEdfLabel(l);
    return /^[A-Za-z]+\d*-[A-Za-z]+\d*$/.test(c); // electrode-electrode, e.g. Fp1-F3
  });
}

// Per-signal analysis of a parsed EDF. Maps each signal to an electrode + type and measures
// whether it actually carries a fluctuating signal — i.e. mean-removed standard deviation
// (AC activity), NOT raw RMS. Raw RMS includes any DC offset, so a flat/constant channel
// (no real EEG, but a nonzero baseline) would falsely read as "has data". Using σ + a
// require-it-varies check means a flat or absent channel correctly shows no data.
// Rolls up the scalp-EEG electrodes that truly have signal. Shared by the montage builder
// (green dots are strictly EEG-with-data) and the Raw EDF inspector. Pure; memoize on edfData.
// Signal-presence math lives in ./edf-signals.js (unit-tested).
function analyzeEdfSignals(edfData) {
  const labels = edfData?.channelLabels || [];
  const cd = edfData?.channelData || [];
  const sigs = edfData?.signals || [];
  const channels = [];
  const presentEeg = []; const seenEeg = new Set(); const withData = new Set();
  labels.forEach((label, idx) => {
    const arr = cd[idx];
    const physDim = sigs[idx]?.physDim;
    const { std } = signalStats(arr);
    // Real signal = varies (σ above the unit-aware floor) AND is not a constant/flat trace.
    const hasSignal = channelHasSignal(arr, physDim);
    const electrode = canonicalElectrode(label);
    const up = (label || "").toUpperCase();
    let type = "Other";
    if (/ECG|EKG/.test(up)) type = "EKG";
    else if (/EOG|EYE|LOC|ROC|PG\d/.test(up) || (electrode && NON_EEG_LEADS.has(electrode))) type = "EOG";
    else if (electrode) type = "EEG";
    const isEeg = type === "EEG";
    channels.push({
      idx, label, electrode: isEeg ? electrode : null, type, std, hasSignal,
      sampleRate: sigs[idx]?.sampleRate ?? null, physDim: sigs[idx]?.physDim || "", numSamples: sigs[idx]?.numSamples ?? null,
    });
    if (isEeg && electrode && !seenEeg.has(electrode)) { seenEeg.add(electrode); presentEeg.push(electrode); }
    if (isEeg && electrode && hasSignal) withData.add(electrode);
  });
  return { channels, presentEeg, withData };
}

// Single-select electrode dropdown for the montage builder. Mirrors the Channels button:
// each row shows a green dot when that electrode has EEG data in the loaded EDF (hollow when
// not). Electrodes with data are listed first; no-data electrodes are deprioritized below a
// divider so the user can see what's available to include.
function ElectrodeSelect({ label, value, onChange, electrodes, dataSet }) {
  const [open, setOpen] = useState(false);
  const withData = electrodes.filter(e => dataSet.has(e));
  const without = electrodes.filter(e => !dataSet.has(e));
  const dot = (has) => ({ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: has ? "#22c55e" : "transparent", border: has ? "none" : "1px solid #444" });
  const row = (e) => {
    const has = dataSet.has(e);
    return (
      <div key={e} onClick={() => { onChange(e); setOpen(false); }} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "3px 10px", cursor: "pointer", fontSize: 11,
        fontFamily: "'IBM Plex Mono', monospace", color: has ? "#ccc" : "#666",
        background: value === e ? "#1a2a30" : "transparent",
      }} onMouseEnter={ev => ev.currentTarget.style.background = "#1a1a1a"}
         onMouseLeave={ev => ev.currentTarget.style.background = value === e ? "#1a2a30" : "transparent"}>
        <span title={has ? "EEG data present in EDF" : "No matching signal in EDF"} style={dot(has)} />
        <span style={{ fontWeight: 600 }}>{e}</span>
      </div>
    );
  };
  return (
    <div style={{ position: "relative" }}>
      <div style={microLabel}>{label}</div>
      <button type="button" onClick={() => setOpen(o => !o)} style={{
        width: 124, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
        background: "#0a0a0a", border: "1px solid #2a2a2a", color: value ? "#ddd" : "#555", fontSize: 12,
        padding: "4px 8px", cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace",
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {value && <span style={dot(dataSet.has(value))} />}{value || "—"}
        </span>
        <span style={{ color: "#555", fontSize: 9 }}>▾</span>
      </button>
      {open && (<>
        <div style={{ position: "fixed", inset: 0, zIndex: 10000 }} onClick={() => setOpen(false)} />
        <div onClick={e => e.stopPropagation()} style={{
          position: "absolute", top: "100%", left: 0, zIndex: 10001, marginTop: 2, background: "#111",
          border: "1px solid #2a2a2a", minWidth: 150, maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.8)",
        }}>
          {withData.map(row)}
          {without.length > 0 && (
            <div style={{ padding: "3px 10px", fontSize: 8, color: "#444", borderTop: "1px solid #1a1a1a", borderBottom: "1px solid #1a1a1a", letterSpacing: "0.08em" }}>NO DATA IN THIS EDF</div>
          )}
          {without.map(row)}
        </div>
      </>)}
    </div>
  );
}

function MontageBuilderPanel({ availableElectrodes, dataElectrodes, customMontages, persistCustomMontages, montage, setMontage, onClose }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);
  const editing = montage.startsWith(CUSTOM_MONTAGE_PREFIX)
    ? customMontages.find(m => CUSTOM_MONTAGE_PREFIX + m.id === montage) : null;
  const [name, setName] = useState(editing?.name || "");
  const [pairs, setPairs] = useState(editing ? editing.pairs.slice() : []);
  const [elA, setElA] = useState("");
  const [elB, setElB] = useState("");
  // Electrodes the user can pick — strictly 10-10 EEG nomenclature (EOG/EKG excluded).
  // `dataSet` = electrodes that actually carry EEG SIGNAL in this EDF (green dot) — a channel
  // that is merely present but flat/empty does NOT get a green dot. The picker universe =
  // all present EEG electrodes ∪ the standard 10-20 set, so common leads are always offered;
  // no-data leads show a hollow dot and are deprioritized to the bottom of each list.
  const present = (availableElectrodes || []).filter(e => !NON_EEG_LEADS.has(e));
  const dataSet = dataElectrodes instanceof Set ? dataElectrodes : new Set(present);
  // Always offer the standard 10-20 leads too, but skip any whose physical site is already
  // represented by a present electrode (e.g. don't add legacy T3 when the file has T7).
  const presentKeys = new Set(present.map(aliasKey));
  const extras = ELECTRODE_SETS["10-20"].filter(e => !NON_EEG_LEADS.has(e) && !presentKeys.has(aliasKey(e)));
  const electrodes = Array.from(new Set([...present, ...extras]))
    .filter(e => !NON_EEG_LEADS.has(e))
    .sort((a, b) => (electrodeRank(a) - electrodeRank(b)) || a.localeCompare(b));

  const addPair = () => {
    if (!elA || !elB || elA === elB) return;
    const p = `${elA}-${elB}`;
    setPairs(prev => prev.includes(p) ? prev : [...prev, p]);
  };
  const removePair = (p) => setPairs(prev => prev.filter(x => x !== p));
  const move = (i, dir) => setPairs(prev => {
    const n = prev.slice(); const j = i + dir;
    if (j < 0 || j >= n.length) return prev;
    [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const save = () => {
    if (!pairs.length) return;
    const nm = name.trim() || `Custom (${pairs.length} ch)`;
    if (editing) {
      persistCustomMontages(customMontages.map(m => m.id === editing.id ? { ...m, name: nm, pairs: pairs.slice() } : m));
      setMontage(CUSTOM_MONTAGE_PREFIX + editing.id);
    } else {
      const id = "u" + Date.now().toString(36);
      persistCustomMontages([...customMontages, { id, name: nm, pairs: pairs.slice() }]);
      setMontage(CUSTOM_MONTAGE_PREFIX + id);
    }
    onClose();
  };
  const deleteMontage = () => {
    if (!editing) return;
    if (!confirm(`Delete custom montage "${editing.name}"?`)) return;
    persistCustomMontages(customMontages.filter(m => m.id !== editing.id));
    setMontage("bipolar-longitudinal");
    onClose();
  };

  const selStyle = { background:"#0a0a0a",border:"1px solid #2a2a2a",color:"#ddd",fontSize:12,padding:"4px 6px",outline:"none",fontFamily:"'IBM Plex Mono', monospace" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="montage-builder-title" style={{background:"#0c0c0c",border:"1px solid #222",padding:"20px 24px",width:480,maxWidth:"92vw",maxHeight:"88vh",overflow:"auto",borderRadius:2}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <span id="montage-builder-title" style={{fontSize:13,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>
            {editing ? "Edit Custom Montage" : "Build Custom Montage"}
          </span>
          <button onClick={onClose} aria-label="Close" style={{background:"none",border:"none",color:"#666",cursor:"pointer"}}>{I.X()}</button>
        </div>
        <div style={{fontSize:10,color:"#555",marginBottom:14,lineHeight:1.4}}>
          Pick any two leads to display the bipolar difference (A − B) between them — any pair, regardless of standard montage.
        </div>

        {/* Pair picker — dotted dropdowns: green = electrode has EEG data in this EDF */}
        <div style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:6}}>
          <ElectrodeSelect label="Electrode A" value={elA} onChange={setElA} electrodes={electrodes} dataSet={dataSet}/>
          <span style={{fontSize:16,color:"#555",paddingBottom:4}}>−</span>
          <ElectrodeSelect label="Electrode B" value={elB} onChange={setElB} electrodes={electrodes} dataSet={dataSet}/>
          <button onClick={addPair} disabled={!elA||!elB||elA===elB} style={{
            padding:"5px 14px",fontSize:11,fontWeight:700,cursor:(!elA||!elB||elA===elB)?"default":"pointer",
            background:(!elA||!elB||elA===elB)?"#111":"#1a4a54",border:`1px solid ${(!elA||!elB||elA===elB)?"#222":"#4a9bab"}`,
            color:(!elA||!elB||elA===elB)?"#444":"#7ec8d9"}}>+ Add</button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#555",marginBottom:14}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:"#22c55e",flexShrink:0}}/>
          <span>has EEG data in this recording</span>
          <span style={{width:7,height:7,borderRadius:"50%",border:"1px solid #444",flexShrink:0,marginLeft:8}}/>
          <span>no signal (listed below, deprioritized)</span>
        </div>

        {/* Current pairs */}
        <div style={{border:"1px solid #1a1a1a",marginBottom:14,maxHeight:200,overflow:"auto"}}>
          {pairs.length === 0 ? (
            <div style={{padding:"16px",textAlign:"center",fontSize:10,color:"#555"}}>No channels yet — add a pair above.</div>
          ) : pairs.map((p, i) => (
            <div key={p} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",borderBottom:"1px solid #111"}}>
              <span style={{fontSize:9,color:"#444",width:20}}>{i+1}</span>
              <span style={{flex:1,fontSize:12,fontFamily:"'IBM Plex Mono', monospace",color:"#9fd3e0"}}>{p}</span>
              <button onClick={()=>move(i,-1)} disabled={i===0} title="Move up" style={{background:"none",border:"none",color:i===0?"#333":"#888",cursor:i===0?"default":"pointer",fontSize:12}}>▲</button>
              <button onClick={()=>move(i,1)} disabled={i===pairs.length-1} title="Move down" style={{background:"none",border:"none",color:i===pairs.length-1?"#333":"#888",cursor:i===pairs.length-1?"default":"pointer",fontSize:12}}>▼</button>
              <button onClick={()=>removePair(p)} title="Remove" style={{background:"none",border:"none",color:"#f87171",cursor:"pointer",fontSize:13,fontWeight:700}}>×</button>
            </div>
          ))}
        </div>

        {/* Name + actions */}
        <div style={{marginBottom:14}}>
          <div style={microLabel}>Montage name</div>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder={`Custom (${pairs.length} ch)`}
            style={{...selStyle,width:"100%"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            {editing && <button onClick={deleteMontage} style={{...controlBtn(),color:"#f87171",border:"1px solid #5a2020",fontSize:10}}>Delete</button>}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onClose} style={{...controlBtn(),fontSize:10}}>Cancel</button>
            <button onClick={save} disabled={!pairs.length} style={{
              padding:"5px 18px",fontSize:11,fontWeight:700,cursor:pairs.length?"pointer":"default",
              background:pairs.length?"#1a4a54":"#111",border:`1px solid ${pairs.length?"#4a9bab":"#222"}`,
              color:pairs.length?"#7ec8d9":"#444"}}>{editing ? "Save Changes" : "Save Montage"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EEG CONTROLS BAR — shared between REVIEW and RECORD
// ══════════════════════════════════════════════════════════════
function EEGControls({ montage, setMontage, eegSystem, setEegSystem, recordingSystem, hpf, setHpf, lpf, setLpf, notch, setNotch,
  epochSec, setEpochSec, sensitivity, setSensitivity, rightContent, onOpenCustomPicker }) {
  return (
    <div style={{ display:"flex",alignItems:"flex-end",gap:16,padding:"8px 16px",
      borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexWrap:"wrap",flexShrink:0 }}>
      {eegSystem !== undefined && setEegSystem && (
        <div><div style={microLabel}>EEG System</div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <select value={eegSystem} onChange={e=>setEegSystem(e.target.value)} style={{...selectStyle,width:eegSystem==="custom"?120:140}}>
            {Object.entries(EEG_SYSTEMS).map(([k,v])=>{
              const disabled = recordingSystem && !canViewInSystem(recordingSystem, k);
              return <option key={k} value={k} disabled={disabled}>{v.label}{disabled?" (insufficient data)":""}</option>;
            })}
          </select>
          {eegSystem === "custom" && onOpenCustomPicker && (
            <button onClick={onOpenCustomPicker} title="Configure custom leads"
              style={{padding:"3px 6px",background:"#111",border:"1px solid #4a9bab",borderRadius:2,
                color:"#7ec8d9",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:3}}>
              {I.Edit(10)}
            </button>
          )}
          </div></div>
      )}
      <div><div style={microLabel}>Montage</div>
        <select value={montage} onChange={e=>setMontage(e.target.value)} style={{...selectStyle,width:220}}>
          {Object.entries(MONTAGE_DEFS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select></div>
      <div><div style={microLabel}>LFF (Hz)</div>
        <select value={hpf} onChange={e=>setHpf(parseFloat(e.target.value))} style={selectStyle}>
          {LFF_OPTIONS.map(v=><option key={v} value={v}>{v===0?"Off":v}</option>)}
        </select></div>
      <div><div style={microLabel}>HFF (Hz)</div>
        <select value={lpf} onChange={e=>setLpf(parseFloat(e.target.value))} style={selectStyle}>
          {HFF_OPTIONS.map(v=><option key={v} value={v}>{v===0?"Off":v}</option>)}
        </select></div>
      <div><div style={microLabel}>Notch</div>
        <select value={notch} onChange={e=>setNotch(parseFloat(e.target.value))} style={selectStyle}>
          <option value={0}>Off</option><option value={50}>50 Hz</option><option value={60}>60 Hz</option>
        </select></div>
      <div><div style={microLabel}>Epoch (sec)</div>
        <select value={epochSec} onChange={e=>setEpochSec(parseInt(e.target.value))} style={selectStyle}>
          {[5,10,15,20,30].map(v=><option key={v} value={v}>{v}s</option>)}
        </select></div>
      <div><div style={microLabel}>Sensitivity (mm/µV)</div>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <button onClick={()=>setSensitivity(p=>Math.max(p-1,1))} style={controlBtn()}>{I.ZoomOut()}</button>
          <span style={{fontSize:11,color:"#888",minWidth:24,textAlign:"center"}}>{sensitivity}</span>
          <button onClick={()=>setSensitivity(p=>Math.min(p+1,30))} style={controlBtn()}>{I.ZoomIn()}</button>
        </div></div>
      <div style={{flex:1}}/>
      {rightContent}
    </div>
  );
}

// Cross-correlation (Pearson coefficient) for eye movement synchronicity analysis
function computeCrossCorrelation(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const N = Math.min(a.length, b.length);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < N; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / N, meanB = sumB / N;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < N; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// Weighted Phase Lag Index (WPLI) — volume-conduction-resistant phase synchrony
// Vinck et al. 2011, NeuroImage. Uses only the imaginary part of cross-spectral
// density, which is zero for volume-conducted (zero-lag) signals.
// Returns value in [0, 1]: 1 = perfectly synchronous, 0 = no consistent phase relationship
function computeWPLI(a, b, sr, fLow = 1, fHigh = 15) {
  if (!a || !b || a.length < 16 || b.length < 16) return null;
  const N = Math.min(a.length, b.length);
  const freqRes = sr / N;
  const kLow = Math.max(1, Math.round(fLow / freqRes));
  const kHigh = Math.min(Math.floor(N / 2), Math.round(fHigh / freqRes));
  if (kHigh <= kLow) return null;

  // Hanning window
  const wA = new Float32Array(N), wB = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
    wA[n] = a[n] * w;
    wB[n] = b[n] * w;
  }

  // Compute CSD imaginary part for each frequency bin in the EOG range
  // CSD[k] = FFT_a[k] * conj(FFT_b[k]), we only need Im(CSD)
  let sumImCSD = 0, sumAbsImCSD = 0;
  for (let k = kLow; k <= kHigh; k++) {
    let reA = 0, imA = 0, reB = 0, imB = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      reA += wA[n] * cos; imA -= wA[n] * sin;
      reB += wB[n] * cos; imB -= wB[n] * sin;
    }
    // CSD = (reA + j*imA) * (reB - j*imB) = (reA*reB + imA*imB) + j*(imA*reB - reA*imB)
    const imCSD = imA * reB - reA * imB;
    sumImCSD += imCSD;
    sumAbsImCSD += Math.abs(imCSD);
  }

  return sumAbsImCSD > 0 ? Math.abs(sumImCSD) / sumAbsImCSD : 0;
}

// Z-score artifact detection — sliding RMS windows, flag |z| > threshold
// Returns { mask: boolean[], artifactPct: number } where mask[i]=true means artifact
function detectArtifacts(data, sr, windowMs = 250, zThreshold = 4.0) {
  if (!data || data.length < 4) return { mask: new Array(data?.length || 0).fill(false), artifactPct: 0 };
  const N = data.length;
  const winSamples = Math.max(4, Math.round((windowMs / 1000) * sr));
  const nWindows = Math.floor(N / winSamples);
  if (nWindows < 3) return { mask: new Array(N).fill(false), artifactPct: 0 };

  // Compute RMS per window
  const rmsVals = new Float32Array(nWindows);
  for (let w = 0; w < nWindows; w++) {
    let sum2 = 0;
    const start = w * winSamples;
    for (let j = 0; j < winSamples; j++) { const v = data[start + j]; sum2 += v * v; }
    rmsVals[w] = Math.sqrt(sum2 / winSamples);
  }

  // Z-score each window
  let mean = 0;
  for (let w = 0; w < nWindows; w++) mean += rmsVals[w];
  mean /= nWindows;
  let variance = 0;
  for (let w = 0; w < nWindows; w++) { const d = rmsVals[w] - mean; variance += d * d; }
  const std = Math.sqrt(variance / nWindows);

  const mask = new Array(N).fill(false);
  let artifactSamples = 0;
  if (std > 0) {
    for (let w = 0; w < nWindows; w++) {
      const z = Math.abs((rmsVals[w] - mean) / std);
      if (z > zThreshold) {
        const start = w * winSamples;
        for (let j = 0; j < winSamples && (start + j) < N; j++) {
          mask[start + j] = true;
          artifactSamples++;
        }
      }
    }
  }
  return { mask, artifactPct: (artifactSamples / N) * 100 };
}

// Spectral interpolation for line noise removal (60 Hz default)
// Replaces magnitude at lineFreq ± bandwidth with average of flanking bins, preserves phase
// Returns cleaned Float32Array — no spectral distortion unlike IIR notch
function removeLineNoiseSpectral(data, sr, lineFreq = 60, bandwidth = 2) {
  if (!data || data.length < 16 || sr < lineFreq * 2) return data;
  const N = data.length;
  const freqRes = sr / N;

  // Full DFT
  const reArr = new Float32Array(N), imArr = new Float32Array(N);
  for (let k = 0; k <= Math.floor(N / 2); k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += data[n] * Math.cos(angle);
      im -= data[n] * Math.sin(angle);
    }
    reArr[k] = re; imArr[k] = im;
    // Mirror for negative frequencies
    if (k > 0 && k < Math.floor(N / 2)) {
      reArr[N - k] = re; imArr[N - k] = -im;
    }
  }

  // Identify bins to interpolate: lineFreq ± bandwidth
  const kCenter = Math.round(lineFreq / freqRes);
  const kBand = Math.ceil(bandwidth / freqRes);
  const kLow = Math.max(1, kCenter - kBand);
  const kHigh = Math.min(Math.floor(N / 2) - 1, kCenter + kBand);

  // Flanking regions for magnitude interpolation
  const flankWidth = Math.max(2, kBand);
  const flankLow = Math.max(1, kLow - flankWidth);
  const flankHigh = Math.min(Math.floor(N / 2), kHigh + flankWidth);

  let flankMagSum = 0, flankCount = 0;
  for (let k = flankLow; k < kLow; k++) {
    flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    flankCount++;
  }
  for (let k = kHigh + 1; k <= flankHigh; k++) {
    flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    flankCount++;
  }
  const avgFlankMag = flankCount > 0 ? flankMagSum / flankCount : 0;

  // Replace target bins: keep phase, set magnitude to flanking average
  for (let k = kLow; k <= kHigh; k++) {
    const mag = Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    if (mag > 0) {
      const scale = avgFlankMag / mag;
      reArr[k] *= scale; imArr[k] *= scale;
      if (k > 0 && k < Math.floor(N / 2)) {
        reArr[N - k] = reArr[k]; imArr[N - k] = -imArr[k];
      }
    }
  }

  // Inverse DFT
  const cleaned = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const angle = (2 * Math.PI * k * n) / N;
      sum += reArr[k] * Math.cos(angle) + imArr[k] * Math.sin(angle);
    }
    cleaned[n] = sum / N;
  }
  return cleaned;
}

// IRASA — Irregular-Resampling Auto-Spectral Analysis (Wen & Liu, 2016)
// Separates aperiodic (1/f) component from oscillatory peaks by resampling at
// irrational ratios. Returns the aperiodic spectral slope (log-log fit, 1-40 Hz).
// Steeper slope (more negative) indicates more pathological slowing.
function computeAperiodicSlope(data, sr) {
  if (!data || data.length < 64) return null;
  const N = data.length;

  // Linear interpolation resampler
  const resample = (signal, ratio) => {
    const outLen = Math.floor(signal.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i / ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, signal.length - 1);
      const frac = srcIdx - lo;
      out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
    }
    return out;
  };

  // Power spectrum via DFT (Hanning windowed)
  const powerSpectrum = (sig) => {
    const M = sig.length;
    const half = Math.floor(M / 2);
    const spec = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < M; n++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (M - 1)));
        const angle = (2 * Math.PI * k * n) / M;
        re += sig[n] * w * Math.cos(angle);
        im -= sig[n] * w * Math.sin(angle);
      }
      spec[k] = (re * re + im * im) / (M * M);
    }
    return spec;
  };

  const ratios = [1.1, 1.3, 1.5, 1.7, 1.9];
  // For each ratio, compute geometric mean of up/down resampled spectra
  // Use the minimum common frequency range (determined by downsampled version)
  const minLen = Math.floor(N / 1.9); // smallest downsampled length
  const minHalf = Math.floor(minLen / 2);
  if (minHalf < 4) return null;

  const aperiodicBins = new Float32Array(minHalf + 1).fill(1); // product for geometric mean
  let nRatios = 0;

  for (const h of ratios) {
    const up = resample(data, h);
    const down = resample(data, 1 / h);
    const specUp = powerSpectrum(up);
    const specDown = powerSpectrum(down);

    // Map both spectra to common frequency grid (original sr, minHalf bins)
    for (let k = 0; k <= minHalf; k++) {
      // Frequency this bin represents in original units
      const f = (k * sr) / N;
      // Corresponding bin in upsampled spectrum (sr stays same, length changes)
      const kUp = Math.min(Math.round((f * up.length) / sr), specUp.length - 1);
      const kDown = Math.min(Math.round((f * down.length) / sr), specDown.length - 1);
      const geoMean = Math.sqrt(Math.max(1e-30, specUp[kUp]) * Math.max(1e-30, specDown[kDown]));
      aperiodicBins[k] *= geoMean;
    }
    nRatios++;
  }

  // Take nth root for geometric mean across ratios
  for (let k = 0; k <= minHalf; k++) {
    aperiodicBins[k] = Math.pow(aperiodicBins[k], 1 / nRatios);
  }

  // Fit log-log line in 1-40 Hz range: log(P) = slope * log(f) + intercept
  const freqRes = sr / N;
  const kLow = Math.max(1, Math.round(1 / freqRes));
  const kHigh = Math.min(minHalf, Math.round(40 / freqRes));
  if (kHigh <= kLow + 2) return null;

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, nPts = 0;
  for (let k = kLow; k <= kHigh; k++) {
    const f = k * freqRes;
    if (f < 0.5 || aperiodicBins[k] <= 0) continue;
    const logF = Math.log10(f);
    const logP = Math.log10(aperiodicBins[k]);
    sumX += logF; sumY += logP; sumXX += logF * logF; sumXY += logF * logP;
    nPts++;
  }
  if (nPts < 3) return null;
  const slope = (nPts * sumXY - sumX * sumY) / (nPts * sumXX - sumX * sumX);
  return Math.round(slope * 100) / 100; // e.g. -1.73
}

// ══════════════════════════════════════════════════════════════
// NOVEL VISUALIZATION HELPERS + COMPONENTS
// ══════════════════════════════════════════════════════════════
function getElectrodeFromChannel(ch) {
  if (ch === "EKG") return null;
  const parts = ch.split("-");
  return parts[0];
}

// Extract a 10-20 electrode name from arbitrary EDF channel labels like
// "EEG Fp1", "Fp1-A1", "EEG Fp1-LE", "EEG Fp1-Ref". Returns null if no match.
function extractElectrodeName(rawLabel) {
  if (!rawLabel) return null;
  // Drop EEG/ECG/EOG prefix tokens, take the first remaining token, then strip trailing -ref
  const cleaned = rawLabel.trim().replace(/^(EEG|ECG|EKG|EOG|EMG)\s+/i, "");
  const firstToken = cleaned.split(/[\s\-]/)[0].replace(/[\.\s]/g, "");
  // Try direct match (case-sensitive against ELECTRODE_2D keys)
  if (ELECTRODE_2D[firstToken]) return firstToken;
  // Try case-insensitive match
  const upper = firstToken.toUpperCase();
  for (const k of Object.keys(ELECTRODE_2D)) {
    if (k.toUpperCase() === upper) return k;
  }
  return null;
}

// computeBands now lives in ./dsp.js (imported above).

/**
 * Compute summary qEEG metrics for one parsed EDF recording. Used by the Subject
 * Timeline and Data Sheet to plot patient trends across visits.
 *
 * @param {object} edfData — parsed EDF (channelData + channelLabels + sampleRate)
 * @returns {{ peakAlphaFreq: number|null, thetaBetaRatio: number|null,
 *             slowingIndex: number|null, asymmetry: number|null,
 *             slowingByElectrode: object, alphaByElectrode: object }}
 */
function computeRecordMetrics(edfData) {
  if (!edfData?.channelData || !edfData.channelLabels) {
    return { peakAlphaFreq: null, thetaBetaRatio: null, slowingIndex: null, asymmetry: null, slowingByElectrode: {}, alphaByElectrode: {} };
  }
  const sr = edfData.sampleRate || 256;
  const occipitalNames = ["O1", "O2", "Oz"];
  const leftNames = ["O1", "P3", "T5", "C3", "F3", "F7", "Fp1"];
  const rightNames = ["O2", "P4", "T6", "C4", "F4", "F8", "Fp2"];

  // Per-electrode bands and slowing (Δ+θ)/total
  const slowingByElectrode = {};
  const alphaByElectrode = {};
  let totalDelta = 0, totalTheta = 0, totalAlpha = 0, totalBeta = 0, totalAll = 0;
  let leftAlpha = 0, rightAlpha = 0;
  let bestAlphaPower = 0, bestAlphaFreq = null;
  const N = Math.min(2048, edfData.channelData[0]?.length || 0); // ~8s at 256 Hz

  edfData.channelLabels.forEach((label, idx) => {
    const elec = extractElectrodeName(label);
    if (!elec) return;
    const data = edfData.channelData[idx];
    if (!data || data.length < 64) return;
    const slice = data.subarray(0, N);
    const bands = computeBands(slice, sr);
    if (bands.total <= 0) return;

    const slowing = ((bands.delta + bands.theta) / bands.total) * 100;
    slowingByElectrode[elec] = slowing;
    alphaByElectrode[elec] = (bands.alpha / bands.total) * 100;

    totalDelta += bands.delta;
    totalTheta += bands.theta;
    totalAlpha += bands.alpha;
    totalBeta  += bands.beta;
    totalAll   += bands.total;

    if (leftNames.includes(elec))  leftAlpha  += bands.alpha;
    if (rightNames.includes(elec)) rightAlpha += bands.alpha;

    // Look for peak alpha frequency in occipital channels via fine DFT scan
    if (occipitalNames.includes(elec)) {
      const M = Math.min(1024, slice.length);
      const fR = sr / M;
      const kLow  = Math.max(1, Math.round(8 / fR));
      const kHigh = Math.min(Math.floor(M / 2), Math.round(13 / fR));
      for (let k = kLow; k <= kHigh; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < M; n++) {
          const angle = (2 * Math.PI * k * n) / M;
          re += slice[n] * Math.cos(angle);
          im -= slice[n] * Math.sin(angle);
        }
        const p = (re * re + im * im) / (M * M);
        if (p > bestAlphaPower) { bestAlphaPower = p; bestAlphaFreq = k * fR; }
      }
    }
  });

  const peakAlphaFreq    = bestAlphaFreq ? +bestAlphaFreq.toFixed(2) : null;
  const thetaBetaRatio   = totalBeta > 0 ? +(totalTheta / totalBeta).toFixed(2) : null;
  const slowingIndex     = totalAll > 0 ? +(((totalDelta + totalTheta) / totalAll) * 100).toFixed(1) : null;
  const asymmetry        = (leftAlpha + rightAlpha) > 0
    ? +(((leftAlpha - rightAlpha) / (leftAlpha + rightAlpha)) * 100).toFixed(1)
    : null;

  return { peakAlphaFreq, thetaBetaRatio, slowingIndex, asymmetry, slowingByElectrode, alphaByElectrode };
}

function interpolateIDW(x, y, electrodeValues, p = 2) {
  let numerator = 0, denominator = 0;
  for (const [name, val] of Object.entries(electrodeValues)) {
    const pos = ELECTRODE_2D[name];
    if (!pos) continue;
    const dx = x - pos.x, dy = y - pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return val;
    const weight = 1 / Math.pow(dist, p);
    numerator += weight * val;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function valueToColor(val, min, max, mode = "voltage") {
  const t = max !== min ? (val - min) / (max - min) : 0.5;
  const clamped = Math.max(0, Math.min(1, t));
  if (mode === "voltage") {
    if (clamped < 0.5) {
      const s = clamped * 2;
      return `rgb(${Math.round(s * 255)}, ${Math.round(s * 255)}, 255)`;
    } else {
      const s = (clamped - 0.5) * 2;
      return `rgb(255, ${Math.round((1 - s) * 255)}, ${Math.round((1 - s) * 255)})`;
    }
  } else if (mode === "diff") {
    if (clamped < 0.4) {
      const s = clamped / 0.4;
      return `rgb(${Math.round(s * 60)}, ${Math.round(100 + s * 80)}, ${Math.round(255 * (1 - s))})`;
    } else if (clamped < 0.6) {
      const s = (clamped - 0.4) / 0.2;
      return `rgb(${Math.round(60 + s * 40)}, ${Math.round(180 + s * 40)}, ${Math.round(s * 40)})`;
    } else if (clamped < 0.8) {
      const s = (clamped - 0.6) / 0.2;
      return `rgb(${Math.round(100 + s * 155)}, ${Math.round(220 - s * 60)}, ${Math.round(40 - s * 30)})`;
    } else {
      const s = (clamped - 0.8) / 0.2;
      return `rgb(255, ${Math.round(160 - s * 160)}, ${Math.round(10 - s * 10)})`;
    }
  }
  const r = Math.round(clamped < 0.5 ? 0 : (clamped - 0.5) * 2 * 255);
  const g = Math.round(clamped < 0.5 ? clamped * 2 * 255 : (1 - clamped) * 2 * 255);
  const b = Math.round(clamped < 0.5 ? (1 - clamped * 2) * 255 : 0);
  return `rgb(${r}, ${g}, ${b})`;
}

// Format a topographic value compactly for labels/readouts.
function fmtTopo(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function TopographicPanel({ waveformData, channels, sampleRate, epochSec, epochStart, onClose, panelPos, setPanelPos }) {
  const [displayMode, setDisplayMode] = useState("voltage");
  const [scaleMode, setScaleMode] = useState("relative"); // relative (%) | absolute (µV²)
  const [hoverElec, setHoverElec] = useState(null);
  const canvasRef = useRef(null);

  const isVoltageMode = displayMode === "voltage";
  const isAbsolute = !isVoltageMode && scaleMode === "absolute";
  const unit = isVoltageMode ? "µV" : isAbsolute ? "µV²" : "%";
  const metricLabel = isVoltageMode
    ? "RMS amplitude"
    : `${displayMode.charAt(0).toUpperCase() + displayMode.slice(1)} ${isAbsolute ? "absolute power" : "relative power"}`;

  const electrodeValues = useMemo(() => {
    if (!waveformData || !channels) return {};
    const vals = {};
    channels.forEach((ch, i) => {
      const elec = getElectrodeFromChannel(ch);
      if (!elec || !ELECTRODE_2D[elec] || ch === "EKG") return;
      const data = waveformData[i];
      if (!data || data.length === 0) return;
      if (isVoltageMode) {
        let sum = 0;
        for (let j = 0; j < data.length; j++) sum += data[j] * data[j];
        vals[elec] = Math.sqrt(sum / data.length);
      } else {
        const bands = computeBands(data, sampleRate);
        const total = bands.total || 1;
        const raw = bands[displayMode] || 0;
        vals[elec] = isAbsolute ? raw : (raw / total) * 100;
      }
    });
    return vals;
  }, [waveformData, channels, sampleRate, displayMode, isVoltageMode, isAbsolute]);

  // Global qEEG ratios + L/R asymmetry summary, independent of the selected map metric.
  const stats = useMemo(() => {
    const vals = Object.values(electrodeValues);
    let min = null, max = null, mean = null;
    if (vals.length) {
      min = Math.min(...vals); max = Math.max(...vals);
      mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    // L vs R asymmetry on the currently-mapped metric: (meanL − meanR) / (meanL + meanR)
    let sumL = 0, nL = 0, sumR = 0, nR = 0;
    Object.entries(electrodeValues).forEach(([name, v]) => {
      const pos = ELECTRODE_2D[name]; if (!pos) return;
      if (pos.x < 0.49) { sumL += v; nL++; } else if (pos.x > 0.51) { sumR += v; nR++; }
    });
    const mL = nL ? sumL / nL : 0, mR = nR ? sumR / nR : 0;
    const asym = (mL + mR) !== 0 ? (mL - mR) / (mL + mR) : null;
    // θ/β and slow/fast from band power summed across all scalp electrodes
    let sd = 0, st = 0, sa = 0, sb = 0;
    if (waveformData && channels) {
      channels.forEach((ch, i) => {
        const elec = getElectrodeFromChannel(ch);
        if (!elec || !ELECTRODE_2D[elec] || ch === "EKG") return;
        const data = waveformData[i]; if (!data || data.length === 0) return;
        const bnd = computeBands(data, sampleRate);
        sd += bnd.delta; st += bnd.theta; sa += bnd.alpha; sb += bnd.beta;
      });
    }
    const thetaBeta = sb > 0 ? st / sb : null;
    const slowFast = (sa + sb) > 0 ? (sd + st) / (sa + sb) : null;
    return { min, max, mean, asym, thetaBeta, slowFast };
  }, [electrodeValues, waveformData, channels, sampleRate]);

  // Map canvas-pixel coordinates to the nearest electrode (for hover readout).
  const pickElectrodeAt = (mx, my) => {
    const size = 280, cx = size / 2, cy = size / 2, radius = size * 0.44;
    let best = null, bestD = 16; // px threshold
    Object.entries(electrodeValues).forEach(([name, val]) => {
      const pos = ELECTRODE_2D[name]; if (!pos) return;
      const ex = cx + (pos.x - 0.5) / 0.47 * radius;
      const ey = cy + (pos.y - 0.5) / 0.47 * radius;
      const d = Math.hypot(mx - ex, my - ey);
      if (d < bestD) { bestD = d; best = { name, value: val }; }
    });
    return best;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || Object.keys(electrodeValues).length === 0) return;
    const size = 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const values = Object.values(electrodeValues);
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    const cx = size / 2, cy = size / 2, radius = size * 0.44;

    // Wave 7b — pixel-by-pixel fillRect was the perf hot path on the topographic
    // map (~19,600 fillRect + string allocations + transform updates per render).
    // Replaced with a single ImageData blit: inline IDW + inline colormap fill
    // the ImageData buffer, then drawImage onto the (DPR-scaled) main canvas.
    const heat = ctx.createImageData(size, size);
    const heatData = heat.data;
    const r2 = radius * radius;
    // Snapshot electrode positions + values once so we don't re-resolve them per pixel
    const eList = [];
    for (const [name, v] of Object.entries(electrodeValues)) {
      const pos = ELECTRODE_2D[name];
      if (pos) eList.push(pos.x, pos.y, v);
    }
    const isVoltage = displayMode === "voltage";
    const range = vMax - vMin || 1;
    for (let py = 0; py < size; py++) {
      const dy = py - cy;
      const dy2 = dy * dy;
      const ny = 0.5 + (dy / radius) * 0.47;
      for (let px = 0; px < size; px++) {
        const dx = px - cx;
        if (dx * dx + dy2 > r2) continue;
        const nx = 0.5 + (dx / radius) * 0.47;
        // Inline IDW with p=2.5 — no function call, no string allocation
        let num = 0, den = 0, exact = NaN;
        for (let i = 0; i < eList.length; i += 3) {
          const ex = eList[i], ey = eList[i + 1], ev = eList[i + 2];
          const ddx = nx - ex, ddy = ny - ey;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < 0.001) { exact = ev; break; }
          const w = 1 / Math.pow(dist, 2.5);
          num += w * ev; den += w;
        }
        const val = !isNaN(exact) ? exact : (den > 0 ? num / den : 0);
        const tc = Math.max(0, Math.min(1, (val - vMin) / range));
        let R, G, B;
        if (isVoltage) {
          // Diverging blue → white → red
          if (tc < 0.5) { const s = tc * 2; R = G = (s * 255) | 0; B = 255; }
          else { const s = (tc - 0.5) * 2; R = 255; G = B = ((1 - s) * 255) | 0; }
        } else {
          // "heat" — blue → green → red gradient
          R = tc < 0.5 ? 0 : ((tc - 0.5) * 2 * 255) | 0;
          G = tc < 0.5 ? (tc * 2 * 255) | 0 : ((1 - tc) * 2 * 255) | 0;
          B = tc < 0.5 ? ((1 - tc * 2) * 255) | 0 : 0;
        }
        const off = (py * size + px) * 4;
        heatData[off] = R; heatData[off + 1] = G; heatData[off + 2] = B; heatData[off + 3] = 255;
      }
    }
    // Blit through an offscreen canvas so the main ctx.scale(dpr) applies via drawImage
    const off = document.createElement("canvas");
    off.width = size; off.height = size;
    off.getContext("2d").putImageData(heat, 0, 0);
    ctx.drawImage(off, 0, 0, size, size);

    ctx.strokeStyle = "#555";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - radius);
    ctx.lineTo(cx, cy - radius - 12);
    ctx.lineTo(cx + 8, cy - radius);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx - radius - 4, cy, 4, 12, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx + radius + 4, cy, 4, 12, 0, 0, Math.PI * 2);
    ctx.stroke();

    Object.entries(electrodeValues).forEach(([name, val]) => {
      const pos = ELECTRODE_2D[name];
      if (!pos) return;
      const ex = cx + (pos.x - 0.5) / 0.47 * radius;
      const ey = cy + (pos.y - 0.5) / 0.47 * radius;
      const isHover = hoverElec && hoverElec.name === name;
      ctx.fillStyle = isHover ? "#fff" : "#000";
      ctx.beginPath();
      ctx.arc(ex, ey, isHover ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (isHover) { ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = isHover ? "#fff" : "#ccc";
      ctx.font = "bold 8px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(name, ex, ey - 6);
    });

    const barX = size - 25, barY = 30, barH = size - 60, barW = 12;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const v = vMin + t * (vMax - vMin);
      ctx.fillStyle = valueToColor(v, vMin, vMax, displayMode === "voltage" ? "voltage" : "heat");
      ctx.fillRect(barX, barY + i, barW, 1);
    }
    ctx.strokeStyle = "#444";
    ctx.strokeRect(barX, barY, barW, barH);
    // Colorbar tick labels: max (top), mid, min (bottom)
    ctx.fillStyle = "#999";
    ctx.font = "8px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    const vMid = (vMin + vMax) / 2;
    ctx.fillText(fmtTopo(vMax), barX + barW + 2, barY + 6);
    ctx.fillText(fmtTopo(vMid), barX + barW + 2, barY + barH / 2 + 3);
    ctx.fillText(fmtTopo(vMin), barX + barW + 2, barY + barH);
  }, [electrodeValues, displayMode, hoverElec]);

  return (
    <FloatingPanel
      title="TOPOGRAPHIC MAP"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: 20, y: Math.round(window.innerHeight * 0.1) })}
      width={340} zIndex={80}
    >
      <div style={{ display: "flex", gap: 4, padding: "6px 12px", borderBottom: "1px solid #1a1a1a", flexWrap: "wrap" }}>
        {["voltage", "delta", "theta", "alpha", "beta", "gamma"].map(mode => (
          <button key={mode} onClick={() => setDisplayMode(mode)} style={{
            padding: "3px 8px", fontSize: 9, fontWeight: 600, cursor: "pointer", borderRadius: 0,
            background: displayMode === mode ? "#1a2a30" : "#111",
            border: `1px solid ${displayMode === mode ? "#4a9bab" : "#222"}`,
            color: displayMode === mode ? "#7ec8d9" : "#666",
          }}>{mode === "voltage" ? "RMS" : mode.charAt(0).toUpperCase() + mode.slice(1)}</button>
        ))}
      </div>

      {/* Metric title + units, and relative/absolute scale toggle (band modes only) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 12px 0" }}>
        <span style={{ fontSize: 10, color: "#9fd3e0", fontWeight: 700 }}>{metricLabel} <span style={{ color: "#556" }}>({unit})</span></span>
        {!isVoltageMode && (
          <div style={{ display: "flex", border: "1px solid #222" }}>
            {["relative", "absolute"].map(m => (
              <button key={m} onClick={() => setScaleMode(m)} style={{
                padding: "2px 7px", fontSize: 8, fontWeight: 700, cursor: "pointer", borderRadius: 0, border: "none",
                background: scaleMode === m ? "#1a2a30" : "#0c0c0c",
                color: scaleMode === m ? "#7ec8d9" : "#555",
              }}>{m === "relative" ? "Rel %" : "Abs"}</button>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: "6px 12px", display: "flex", justifyContent: "center" }}>
        <canvas ref={canvasRef} style={{ display: "block" }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHoverElec(pickElectrodeAt(e.clientX - r.left, e.clientY - r.top));
          }}
          onMouseLeave={() => setHoverElec(null)} />
      </div>

      {/* Hover readout */}
      <div style={{ padding: "0 12px", height: 14, textAlign: "center", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: "#7ec8d9" }}>
        {hoverElec ? `${hoverElec.name}: ${fmtTopo(hoverElec.value)} ${unit}` : <span style={{ color: "#444" }}>hover an electrode for its value</span>}
      </div>

      {/* Min / mean / max */}
      <div style={{ display: "flex", justifyContent: "space-around", padding: "6px 12px 4px", borderTop: "1px solid #141414", fontFamily: "'IBM Plex Mono', monospace" }}>
        {[["MIN", stats.min], ["MEAN", stats.mean], ["MAX", stats.max]].map(([lab, v]) => (
          <div key={lab} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.08em" }}>{lab}</div>
            <div style={{ fontSize: 11, color: "#ccc" }}>{fmtTopo(v)}<span style={{ fontSize: 8, color: "#556" }}> {unit}</span></div>
          </div>
        ))}
      </div>

      {/* Asymmetry + ratios (qEEG screening) */}
      <div style={{ display: "flex", justifyContent: "space-around", padding: "4px 12px 8px", fontFamily: "'IBM Plex Mono', monospace" }}>
        <div style={{ textAlign: "center" }} title="(meanL \u2212 meanR)/(meanL + meanR) of the mapped metric. + = left-dominant.">
          <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.08em" }}>ASYM L\u2013R</div>
          <div style={{ fontSize: 11, color: stats.asym === null ? "#555" : Math.abs(stats.asym) > 0.15 ? "#facc15" : "#ccc" }}>
            {stats.asym === null ? "\u2014" : (stats.asym > 0 ? "+" : "") + stats.asym.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: "center" }} title="Theta/Beta power ratio across scalp electrodes">
          <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.08em" }}>\u03B8/\u03B2</div>
          <div style={{ fontSize: 11, color: "#ccc" }}>{fmtTopo(stats.thetaBeta)}</div>
        </div>
        <div style={{ textAlign: "center" }} title="(Delta+Theta)/(Alpha+Beta) \u2014 slow-to-fast power ratio">
          <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.08em" }}>SLOW/FAST</div>
          <div style={{ fontSize: 11, color: "#ccc" }}>{fmtTopo(stats.slowFast)}</div>
        </div>
      </div>

      <div style={{ padding: "0 12px 8px", fontSize: 8, color: "#444", textAlign: "center" }}>
        IDW interpolation p=2.5 \u00B7 {Object.keys(electrodeValues).length} electrodes
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// QUANTITATIVE EEG ANALYSIS PANEL — floating overlay
// ══════════════════════════════════════════════════════════════
function QuantAnalysisPanel({ waveformData, channels, sampleRate, epochSec, epochStart, onClose, panelPos, setPanelPos }) {
  const [activeView, setActiveView] = useState("bands");

  // Compute spectral power per channel using simple FFT approximation
  // Hanning-windowed DFT for band power — reduces spectral leakage vs raw rectangular window
  const computeBandPower = (data, sr) => {
    if (!data || data.length === 0) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const N = data.length;
    const freqRes = sr / N;

    // Apply Hanning window: w[n] = 0.5 * (1 - cos(2πn/(N-1)))
    const windowed = new Float32Array(N);
    let winEnergy = 0;
    for (let n = 0; n < N; n++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      windowed[n] = data[n] * w;
      winEnergy += w * w;
    }
    const winNorm = winEnergy / N; // window energy correction factor

    const bandRanges = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
    const powers = {};
    let total = 0;

    Object.entries(bandRanges).forEach(([band, [fLow, fHigh]]) => {
      let bandPow = 0;
      const kLow = Math.max(1, Math.round(fLow / freqRes));
      const kHigh = Math.min(Math.floor(N / 2), Math.round(fHigh / freqRes));
      for (let k = kLow; k <= kHigh; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
          const angle = (2 * Math.PI * k * n) / N;
          re += windowed[n] * Math.cos(angle);
          im -= windowed[n] * Math.sin(angle);
        }
        bandPow += (re * re + im * im) / (N * N * winNorm);
      }
      powers[band] = bandPow;
      total += bandPow;
    });
    powers.total = total;
    return powers;
  };

  // Analyze all visible channels for current epoch
  const analysis = useMemo(() => {
    if (!waveformData || waveformData.length === 0) return null;

    // Subsample for performance (use first 512 samples max for FFT)
    const maxSamples = Math.min(512, waveformData[0]?.length || 0);

    // Artifact detection across all EEG channels — aggregate worst-case artifact %
    const AUX_EXCLUDE = new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]);
    let totalArtifactPct = 0, nArtChannels = 0;
    const channelArtifacts = {};

    const channelData = channels.map((ch, i) => {
      const raw = waveformData[i];
      if (!raw) return { channel: ch, bands: { delta:0, theta:0, alpha:0, beta:0, gamma:0, total:0 } };
      let sub = raw.slice(0, maxSamples);

      // Z-score artifact detection on EEG channels
      if (!AUX_EXCLUDE.has(ch)) {
        const { mask, artifactPct } = detectArtifacts(sub, sampleRate);
        channelArtifacts[ch] = artifactPct;
        totalArtifactPct += artifactPct;
        nArtChannels++;
        // Zero out artifact samples before spectral analysis
        if (artifactPct > 0) {
          sub = new Float32Array(sub);
          for (let j = 0; j < sub.length; j++) { if (mask[j]) sub[j] = 0; }
        }
      }

      // Spectral interpolation for 60 Hz line noise (cleaner than IIR notch)
      if (!AUX_EXCLUDE.has(ch) && sampleRate > 120) {
        sub = removeLineNoiseSpectral(sub, sampleRate, 60, 2);
      }

      const bands = computeBandPower(sub, sampleRate);
      return { channel: ch, bands };
    });

    const avgArtifactPct = nArtChannels > 0 ? totalArtifactPct / nArtChannels : 0;

    // Compute averages (exclude EKG and eye leads — not brain EEG)
    const avgBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const eegChannels = channelData.filter(c => !AUX_EXCLUDE.has(c.channel));
    eegChannels.forEach(c => {
      Object.keys(avgBands).forEach(b => { avgBands[b] += c.bands[b]; });
    });
    if (eegChannels.length > 0) {
      Object.keys(avgBands).forEach(b => { avgBands[b] /= eegChannels.length; });
    }

    // Alpha peak frequency — averaged across posterior channels with zero-padded 0.1 Hz resolution
    let peakAlphaFreq = 10;
    if (eegChannels.length > 0) {
      const posteriorNames = new Set(["P3","P4","Pz","O1","O2"]);
      const posteriorIdxs = channels.map((ch, i) => posteriorNames.has(ch.split("-")[0]) ? i : -1).filter(i => i >= 0);
      // Fall back to mid-channel if no posterior channels found
      const useIdxs = posteriorIdxs.length > 0 ? posteriorIdxs : [Math.floor(channels.length / 2)];
      // Average power spectrum across posterior channels for robust peak detection
      const Norig = Math.min(maxSamples, waveformData[0]?.length || 0);
      const Npad = Norig * 2; // zero-pad to 2x for finer freq resolution
      const freqRes = sampleRate / Npad;
      const kLow = Math.max(1, Math.round(7 / freqRes));
      const kHigh = Math.min(Math.floor(Npad / 2), Math.round(14 / freqRes));
      const avgSpectrum = new Float32Array(kHigh - kLow + 1);
      let nContrib = 0;
      for (const idx of useIdxs) {
        const raw = waveformData[idx]?.slice(0, Norig);
        if (!raw) continue;
        // Hanning window + zero-pad
        const padded = new Float32Array(Npad);
        for (let n = 0; n < Norig; n++) {
          padded[n] = raw[n] * 0.5 * (1 - Math.cos((2 * Math.PI * n) / (Norig - 1)));
        }
        for (let ki = 0; ki <= kHigh - kLow; ki++) {
          const k = kLow + ki;
          let re = 0, im = 0;
          for (let n = 0; n < Npad; n++) {
            const angle = (2 * Math.PI * k * n) / Npad;
            re += padded[n] * Math.cos(angle);
            im -= padded[n] * Math.sin(angle);
          }
          avgSpectrum[ki] += re * re + im * im;
        }
        nContrib++;
      }
      if (nContrib > 0) {
        let maxPow = 0;
        for (let ki = 0; ki < avgSpectrum.length; ki++) {
          const p = avgSpectrum[ki] / nContrib;
          if (p > maxPow) { maxPow = p; peakAlphaFreq = (kLow + ki) * freqRes; }
        }
        peakAlphaFreq = Math.round(peakAlphaFreq * 10) / 10; // round to 0.1 Hz
      }
    }

    // Hemispheric asymmetry (compare left vs right channel pairs)
    const leftChannels = channelData.filter(c => /^(Fp1|F3|C3|P3|O1|F7|T3|T5)/.test(c.channel.split("-")[0]));
    const rightChannels = channelData.filter(c => /^(Fp2|F4|C4|P4|O2|F8|T4|T6)/.test(c.channel.split("-")[0]));
    const leftAlpha = leftChannels.length > 0 ? leftChannels.reduce((s, c) => s + c.bands.alpha, 0) / leftChannels.length : 0;
    const rightAlpha = rightChannels.length > 0 ? rightChannels.reduce((s, c) => s + c.bands.alpha, 0) / rightChannels.length : 0;
    const asymmetryIndex = (leftAlpha + rightAlpha) > 0 ? ((rightAlpha - leftAlpha) / (rightAlpha + leftAlpha) * 100) : 0;

    // Theta/Beta ratio (frontal)
    const frontalChannels = channelData.filter(c => /^(Fp1|Fp2|F3|F4|Fz)/.test(c.channel.split("-")[0]));
    const frontalTheta = frontalChannels.length > 0 ? frontalChannels.reduce((s, c) => s + c.bands.theta, 0) / frontalChannels.length : 0;
    const frontalBeta = frontalChannels.length > 0 ? frontalChannels.reduce((s, c) => s + c.bands.beta, 0) / frontalChannels.length : 0;
    const thetaBetaRatio = frontalBeta > 0 ? frontalTheta / frontalBeta : 0;

    // Flag epochs with excessive slow activity
    const flags = [];
    channelData.forEach(c => {
      if (AUX_EXCLUDE.has(c.channel)) return;
      const total = c.bands.total || 1;
      const deltaPct = (c.bands.delta / total) * 100;
      const thetaPct = (c.bands.theta / total) * 100;
      if (deltaPct > 60) flags.push({ channel: c.channel, type: "Elevated Delta", value: `${deltaPct.toFixed(0)}%`, severity: "high" });
      else if (deltaPct > 45) flags.push({ channel: c.channel, type: "Moderate Delta", value: `${deltaPct.toFixed(0)}%`, severity: "med" });
      if (thetaPct > 40) flags.push({ channel: c.channel, type: "Elevated Theta", value: `${thetaPct.toFixed(0)}%`, severity: "high" });
    });

    // Frontotemporal slowing composite — key concussion biomarker
    const ftChannels = channelData.filter(c => /^(Fp1|Fp2|F3|F4|F7|F8|T3|T4|Fz)/.test(c.channel.split("-")[0]));
    if (ftChannels.length > 0) {
      const ftSlowPower = ftChannels.reduce((s, c) => s + c.bands.delta + c.bands.theta, 0) / ftChannels.length;
      const ftTotalPower = ftChannels.reduce((s, c) => s + (c.bands.total || 1), 0) / ftChannels.length;
      const ftSlowPct = (ftSlowPower / ftTotalPower) * 100;
      if (ftSlowPct > 55) flags.push({ channel: "F/T", type: "Frontotemporal Slowing", value: `${ftSlowPct.toFixed(0)}% slow (δ+θ)`, severity: "high" });
      else if (ftSlowPct > 40) flags.push({ channel: "F/T", type: "Mild FT Slowing", value: `${ftSlowPct.toFixed(0)}% slow (δ+θ)`, severity: "med" });
    }

    // Eye Movement Synchronicity Analysis — dual method: WPLI (primary) + Pearson (secondary)
    const loc1Idx = channels.indexOf("LOC1");
    const roc1Idx = channels.indexOf("ROC1");
    const loc2Idx = channels.indexOf("LOC2");
    const roc2Idx = channels.indexOf("ROC2");

    let eyeSync = null;
    const hasVertical = loc1Idx >= 0 && roc1Idx >= 0;
    const hasHorizontal = loc2Idx >= 0 && roc2Idx >= 0;

    if (hasVertical || hasHorizontal) {
      const maxS = Math.min(512, waveformData[0]?.length || 0);
      const loc1Data = hasVertical ? waveformData[loc1Idx]?.slice(0, maxS) : null;
      const roc1Data = hasVertical ? waveformData[roc1Idx]?.slice(0, maxS) : null;
      const loc2Data = hasHorizontal ? waveformData[loc2Idx]?.slice(0, maxS) : null;
      const roc2Data = hasHorizontal ? waveformData[roc2Idx]?.slice(0, maxS) : null;

      // WPLI (Vinck 2011) — volume-conduction resistant, primary sync metric
      const wpliVert = hasVertical ? computeWPLI(loc1Data, roc1Data, sampleRate, 1, 15) : null;
      const wpliHoriz = hasHorizontal ? computeWPLI(loc2Data, roc2Data, sampleRate, 1, 15) : null;

      // Pearson correlation — secondary/legacy metric
      const vertCorr = hasVertical ? computeCrossCorrelation(loc1Data, roc1Data) : null;
      const horizCorr = hasHorizontal ? computeCrossCorrelation(loc2Data, roc2Data) : null;

      // Blink amplitude symmetry: compare RMS of vertical channels
      let blinkSymmetry = null;
      if (hasVertical && loc1Data && roc1Data) {
        let rmsL = 0, rmsR = 0;
        for (let i = 0; i < maxS; i++) { rmsL += loc1Data[i] * loc1Data[i]; rmsR += roc1Data[i] * roc1Data[i]; }
        rmsL = Math.sqrt(rmsL / maxS); rmsR = Math.sqrt(rmsR / maxS);
        const maxRms = Math.max(rmsL, rmsR, 1);
        blinkSymmetry = 1 - Math.abs(rmsL - rmsR) / maxRms;
      }

      // Combined synchronicity score — WPLI-weighted (favors volume-conduction-resistant measure)
      const scores = [];
      if (wpliVert !== null) scores.push(wpliVert);
      if (wpliHoriz !== null) scores.push(wpliHoriz);
      if (blinkSymmetry !== null) scores.push(blinkSymmetry);
      const syncScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : null;

      eyeSync = { wpliVert, wpliHoriz, vertCorr, horizCorr, blinkSymmetry, syncScore };
    }

    // IRASA aperiodic slope — computed on averaged EEG data for efficiency
    let aperiodicSlope = null;
    if (eegChannels.length > 0) {
      // Average a few representative channels for slope estimate
      const slopeChNames = new Set(["Fz","Cz","Pz","F3","F4","C3","C4"]);
      const slopeIdxs = channels.map((ch, i) => slopeChNames.has(ch.split("-")[0]) ? i : -1).filter(i => i >= 0);
      const useIdxs = slopeIdxs.length > 0 ? slopeIdxs : [Math.floor(channels.length / 2)];
      // Average signal across selected channels
      const avgSig = new Float32Array(maxSamples);
      let nSig = 0;
      for (const idx of useIdxs) {
        const raw = waveformData[idx]?.slice(0, maxSamples);
        if (!raw) continue;
        for (let j = 0; j < maxSamples; j++) avgSig[j] += raw[j];
        nSig++;
      }
      if (nSig > 0) {
        for (let j = 0; j < maxSamples; j++) avgSig[j] /= nSig;
        aperiodicSlope = computeAperiodicSlope(avgSig, sampleRate);
      }
    }

    // Artifact flags
    if (avgArtifactPct > 20) flags.push({ channel: "ALL", type: "High Artifact", value: `${avgArtifactPct.toFixed(0)}% contaminated`, severity: "high" });
    else if (avgArtifactPct > 10) flags.push({ channel: "ALL", type: "Moderate Artifact", value: `${avgArtifactPct.toFixed(0)}% contaminated`, severity: "med" });

    // Aperiodic slope flag
    if (aperiodicSlope !== null && aperiodicSlope < -2.5) flags.push({ channel: "ALL", type: "Steep 1/f Slope", value: `${aperiodicSlope} (pathological)`, severity: "high" });
    else if (aperiodicSlope !== null && aperiodicSlope < -2.2) flags.push({ channel: "ALL", type: "Mild 1/f Steepening", value: `${aperiodicSlope}`, severity: "med" });

    return { channelData, avgBands, peakAlphaFreq, asymmetryIndex, thetaBetaRatio, flags, eyeSync, avgArtifactPct, aperiodicSlope };
  }, [waveformData, channels, sampleRate]);

  if (!analysis) return null;

  const bandColors = { delta: "#6366F1", theta: "#F59E0B", alpha: "#10B981", beta: "#3B82F6", gamma: "#EC4899" };
  const bandLabels = { delta: "Delta (0.5-4Hz)", theta: "Theta (4-8Hz)", alpha: "Alpha (8-13Hz)", beta: "Beta (13-30Hz)", gamma: "Gamma (30-50Hz)" };

  // Bar renderer
  const PowerBar = ({ value, max, color, label, pct }) => (
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
      <span style={{fontSize:9,color:"#666",width:50,textAlign:"right",fontFamily:"'IBM Plex Mono', monospace"}}>{label}</span>
      <div style={{flex:1,height:10,background:"#0a0a0a",border:"1px solid #1a1a1a",position:"relative"}}>
        <div style={{height:"100%",background:color,width:`${Math.min(100, (value/max)*100)}%`,transition:"width 0.2s"}}/>
      </div>
      <span style={{fontSize:9,color:"#888",width:36,textAlign:"right",fontFamily:"'IBM Plex Mono', monospace"}}>{pct}%</span>
    </div>
  );

  const views = [
    { id: "bands", label: "Band Power" },
    { id: "channels", label: "By Channel" },
    { id: "metrics", label: "Metrics" },
    { id: "flags", label: `Flags (${analysis.flags.length})` },
  ];

  return (
    <FloatingPanel
      titleNode={
        <div>
          <span style={{fontSize:10,fontWeight:700,color:"#666",letterSpacing:"0.1em"}}>qEEG ANALYSIS</span>
          <span style={{fontSize:9,color:"#444",marginLeft:8}}>Epoch {Math.floor(epochStart / (waveformData[0]?.length / sampleRate || 10)) + 1}</span>
        </div>
      }
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: 20, y: Math.round(window.innerHeight * 0.15) })}
      width={360} maxHeight="75vh" zIndex={80}
    >
      {/* View tabs */}
      <div style={{display:"flex",borderBottom:"1px solid #1a1a1a"}}>
        {views.map(v => (
          <button key={v.id} onClick={()=>setActiveView(v.id)} style={{
            flex:1,padding:"6px 4px",background:activeView===v.id?"#1a1a1a":"transparent",
            border:"none",borderBottom:activeView===v.id?"2px solid #7ec8d9":"2px solid transparent",
            color:activeView===v.id?"#ccc":"#555",fontSize:9,fontWeight:600,cursor:"pointer",
          }}>{v.label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{flex:1,overflow:"auto",padding:"10px 12px"}}>

        {/* Band Power View */}
        {activeView === "bands" && (<>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>GLOBAL AVERAGE BAND POWER</div>
            {Object.entries(bandColors).map(([band, color]) => {
              const val = analysis.avgBands[band];
              const total = analysis.avgBands.total || 1;
              const pct = ((val / total) * 100).toFixed(1);
              return <PowerBar key={band} value={val} max={total * 0.6} color={color} label={band.charAt(0).toUpperCase() + band.slice(1, 3)} pct={pct}/>;
            })}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr",gap:3,marginTop:8}}>
            {[
              {label:"α PEAK",value:`${analysis.peakAlphaFreq.toFixed(1)}`,unit:"Hz",color:analysis.peakAlphaFreq<8.5?"#F59E0B":"#10B981"},
              {label:"θ/β",value:analysis.thetaBetaRatio.toFixed(2),unit:"",color:analysis.thetaBetaRatio>3.5?"#f87171":analysis.thetaBetaRatio>2.5?"#F59E0B":"#10B981"},
              {label:"ASYM",value:`${analysis.asymmetryIndex>0?"+":""}${analysis.asymmetryIndex.toFixed(1)}`,unit:"%",color:Math.abs(analysis.asymmetryIndex)>15?"#F59E0B":"#7ec8d9"},
              {label:"1/f",value:analysis.aperiodicSlope!==null?analysis.aperiodicSlope.toFixed(1):"—",unit:"",color:analysis.aperiodicSlope!==null?(analysis.aperiodicSlope<-2.5?"#f87171":analysis.aperiodicSlope<-2.2?"#F59E0B":"#10B981"):"#555"},
              {label:"ART%",value:analysis.avgArtifactPct!==undefined?analysis.avgArtifactPct.toFixed(0):"0",unit:"%",color:analysis.avgArtifactPct>20?"#f87171":analysis.avgArtifactPct>10?"#F59E0B":"#10B981"},
              {label:"CH",value:channels.filter(c=>!new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]).has(c)).length,unit:"",color:"#888"},
            ].map((m,i)=>(
              <div key={i} style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"3px 4px",textAlign:"center"}}>
                <div style={{fontSize:6,color:"#555",letterSpacing:"0.06em"}}>{m.label}</div>
                <div style={{fontSize:11,fontWeight:700,color:m.color,fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}<span style={{fontSize:7,fontWeight:400}}>{m.unit}</span></div>
              </div>
            ))}
          </div>

          {/* Eye Movement Synchronicity */}
          {analysis.eyeSync && (() => {
            const s = analysis.eyeSync;
            const score = s.syncScore;
            const scoreColor = score >= 75 ? "#10B981" : score >= 50 ? "#F59E0B" : "#f87171";
            const statusLabel = score >= 75 ? "SYNC" : score >= 50 ? "MILD DESYNC" : "DESYNC";
            return (
              <div style={{marginTop:8,borderTop:"1px solid #1a1a1a",paddingTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <span style={{fontSize:8,color:"#F59E0B",fontWeight:700,letterSpacing:"0.06em"}}>EYE SYNCHRONICITY</span>
                  <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                    <span style={{fontSize:7,color:scoreColor,letterSpacing:"0.04em"}}>{statusLabel}</span>
                    <span style={{fontSize:14,fontWeight:700,color:scoreColor,fontFamily:"'IBM Plex Mono', monospace"}}>{score.toFixed(0)}%</span>
                  </div>
                </div>
                <div style={{height:3,background:"#111",borderRadius:2,marginBottom:6}}>
                  <div style={{height:"100%",background:scoreColor,width:`${Math.min(100, score)}%`,borderRadius:2,transition:"width 0.3s"}}/>
                </div>
                {/* WPLI — primary sync metric (volume-conduction resistant) */}
                {(s.wpliVert !== null || s.wpliHoriz !== null) && (
                  <div style={{display:"flex",gap:8,marginBottom:3}}>
                    {s.wpliVert !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 0"}}>
                        <span style={{fontSize:7,color:"#555"}}>WPLI Vert</span>
                        <span style={{fontSize:10,fontWeight:700,color:s.wpliVert>0.6?"#10B981":s.wpliVert>0.3?"#F59E0B":"#f87171",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.wpliVert.toFixed(3)}
                        </span>
                      </div>
                    )}
                    {s.wpliHoriz !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 0"}}>
                        <span style={{fontSize:7,color:"#555"}}>WPLI Horiz</span>
                        <span style={{fontSize:10,fontWeight:700,color:s.wpliHoriz>0.6?"#10B981":s.wpliHoriz>0.3?"#F59E0B":"#f87171",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.wpliHoriz.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {/* Pearson — secondary metric */}
                {(s.vertCorr !== null || s.horizCorr !== null) && (
                  <div style={{display:"flex",gap:8,marginBottom:3}}>
                    {s.vertCorr !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                        <span style={{fontSize:7,color:"#444"}}>r Vert</span>
                        <span style={{fontSize:9,fontWeight:600,color:s.vertCorr>0.7?"#10B98180":s.vertCorr>0.4?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.vertCorr.toFixed(3)}
                        </span>
                      </div>
                    )}
                    {s.horizCorr !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                        <span style={{fontSize:7,color:"#444"}}>r Horiz</span>
                        <span style={{fontSize:9,fontWeight:600,color:s.horizCorr>0.7?"#10B98180":s.horizCorr>0.4?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.horizCorr.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {s.blinkSymmetry !== null && (
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                    <span style={{fontSize:7,color:"#444"}}>Blink Sym</span>
                    <span style={{fontSize:9,fontWeight:600,color:s.blinkSymmetry>0.8?"#10B98180":s.blinkSymmetry>0.5?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                      {(s.blinkSymmetry * 100).toFixed(1)}%
                    </span>
                  </div>
                )}
                <div style={{fontSize:7,color:"#333",marginTop:4,lineHeight:1.3}}>
                  WPLI: phase synchrony resistant to volume conduction. Pearson: amplitude correlation. Low values may indicate oculomotor desynchrony.
                </div>
              </div>
            );
          })()}
        </>)}

        {/* Per-Channel View — compact inline rows */}
        {activeView === "channels" && (
          <div>
            <div style={{fontSize:8,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>BAND POWER BY CHANNEL</div>
            {analysis.channelData.filter(c => !new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]).has(c.channel)).map(c => {
              const total = c.bands.total || 1;
              return (
                <div key={c.channel} style={{display:"flex",alignItems:"center",gap:4,marginBottom:1}}>
                  <div style={{fontSize:8,color:"#888",fontFamily:"'IBM Plex Mono', monospace",width:28,textAlign:"right",flexShrink:0}}>{c.channel}</div>
                  <div style={{display:"flex",height:5,background:"#0a0a0a",border:"1px solid #111",flex:1}}>
                    {Object.entries(bandColors).map(([band, color]) => (
                      <div key={band} title={`${band}: ${((c.bands[band]/total)*100).toFixed(1)}%`}
                        style={{height:"100%",background:color,width:`${(c.bands[band]/total)*100}%`}}/>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap"}}>
              {Object.entries(bandColors).map(([band, color]) => (
                <div key={band} style={{display:"flex",alignItems:"center",gap:2,fontSize:7,color:"#555"}}>
                  <div style={{width:6,height:6,background:color}}/>{band}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metrics View */}
        {activeView === "metrics" && (
          <div>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>QUANTITATIVE METRICS</div>

            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:"#aaa",marginBottom:6}}>Band Power Distribution (Global)</div>
              {Object.entries(bandLabels).map(([band, label]) => {
                const total = analysis.avgBands.total || 1;
                const pct = ((analysis.avgBands[band] / total) * 100).toFixed(1);
                return (
                  <div key={band} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #111"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:8,height:8,background:bandColors[band]}}/>
                      <span style={{fontSize:10,color:"#888"}}>{label}</span>
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:bandColors[band],fontFamily:"'IBM Plex Mono', monospace"}}>{pct}%</span>
                  </div>
                );
              })}
            </div>

            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:"#aaa",marginBottom:6}}>Key Indices</div>
              {[
                { label: "Peak Alpha Frequency", value: `${analysis.peakAlphaFreq.toFixed(2)} Hz`, note: "Normal range: 9-11 Hz" },
                { label: "Frontal Theta/Beta Ratio", value: analysis.thetaBetaRatio.toFixed(3), note: "Elevated >3.0 may indicate attentional variance" },
                { label: "Alpha Asymmetry Index (R-L)", value: `${analysis.asymmetryIndex>0?"+":""}${analysis.asymmetryIndex.toFixed(2)}%`, note: "Values >15% indicate hemispheric difference" },
                { label: "Dominant Frequency", value: `${analysis.peakAlphaFreq > 8 ? "Alpha" : analysis.peakAlphaFreq > 4 ? "Theta" : "Delta"} range`, note: `${analysis.peakAlphaFreq.toFixed(1)} Hz` },
              ].map((m, i) => (
                <div key={i} style={{padding:"6px 0",borderBottom:"1px solid #111"}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:"#888"}}>{m.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}</span>
                  </div>
                  <div style={{fontSize:8,color:"#444",marginTop:2}}>{m.note}</div>
                </div>
              ))}
            </div>

            {/* Eye Movement Analysis */}
            {analysis.eyeSync && (() => {
              const es = analysis.eyeSync;
              const sc = es.syncScore;
              const sCol = sc >= 75 ? "#10B981" : sc >= 50 ? "#F59E0B" : "#f87171";
              const metrics = [];
              if (es.vertCorr !== null) metrics.push({
                label: "Vertical Correlation (LOC1↔ROC1)",
                value: `r = ${es.vertCorr.toFixed(4)}`,
                note: "Conjugate vertical gaze: expect r > 0.7 for normal bilateral tracking",
                color: es.vertCorr > 0.7 ? "#10B981" : es.vertCorr > 0.4 ? "#F59E0B" : "#f87171"
              });
              if (es.horizCorr !== null) metrics.push({
                label: "Horizontal Correlation (LOC2↔ROC2)",
                value: `r = ${es.horizCorr.toFixed(4)}`,
                note: "Conjugate horizontal gaze: expect r > 0.7 for normal bilateral tracking. Low correlation suggests desynchrony.",
                color: es.horizCorr > 0.7 ? "#10B981" : es.horizCorr > 0.4 ? "#F59E0B" : "#f87171"
              });
              if (es.blinkSymmetry !== null) metrics.push({
                label: "Blink Amplitude Symmetry",
                value: `${(es.blinkSymmetry * 100).toFixed(2)}%`,
                note: "RMS amplitude ratio of vertical channels: >80% indicates symmetric blink reflex",
                color: es.blinkSymmetry > 0.8 ? "#10B981" : es.blinkSymmetry > 0.5 ? "#F59E0B" : "#f87171"
              });
              metrics.push({
                label: "Combined Synchronicity Score",
                value: `${sc.toFixed(1)}%`,
                note: sc >= 75 ? "Normal bilateral eye movement coordination" : sc >= 50 ? "Mild oculomotor desynchrony — may warrant further evaluation" : "Significant desynchrony — consider oculomotor assessment",
                color: sCol
              });
              return (
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:10,color:"#F59E0B",marginBottom:6,fontWeight:700}}>Eye Movement Analysis</div>
                  {metrics.map((m, i) => (
                    <div key={i} style={{padding:"6px 0",borderBottom:"1px solid #111"}}>
                      <div style={{display:"flex",justifyContent:"space-between"}}>
                        <span style={{fontSize:10,color:"#888"}}>{m.label}</span>
                        <span style={{fontSize:11,fontWeight:700,color:m.color,fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}</span>
                      </div>
                      <div style={{fontSize:8,color:"#444",marginTop:2}}>{m.note}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

            <div style={{fontSize:8,color:"#333",padding:"8px 0",borderTop:"1px solid #1a1a1a",lineHeight:1.5}}>
              Quantitative values are computed from the current epoch. These are mathematical observations, not clinical interpretations. All metrics should be reviewed by a qualified professional.
            </div>
          </div>
        )}

        {/* Flags View */}
        {activeView === "flags" && (
          <div>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>EPOCH FLAGS</div>
            {analysis.flags.length === 0 ? (
              <div style={{padding:20,textAlign:"center",color:"#333",fontSize:11}}>No flags for this epoch</div>
            ) : (
              analysis.flags.map((f, i) => (
                <div key={i} style={{
                  display:"flex",alignItems:"center",gap:8,padding:"6px 8px",marginBottom:4,
                  background:f.severity==="high"?"#1a0a0a":"#1a1a0a",
                  border:`1px solid ${f.severity==="high"?"#991b1b30":"#854d0e30"}`,
                }}>
                  <span style={{fontSize:10,fontWeight:700,color:f.severity==="high"?"#f87171":"#facc15",fontFamily:"'IBM Plex Mono', monospace",width:60}}>{f.channel}</span>
                  <span style={{fontSize:10,color:"#aaa",flex:1}}>{f.type}</span>
                  <span style={{fontSize:10,fontWeight:700,color:f.severity==="high"?"#f87171":"#facc15",fontFamily:"'IBM Plex Mono', monospace"}}>{f.value}</span>
                </div>
              ))
            )}
            {analysis.flags.length > 0 && (
              <div style={{fontSize:8,color:"#444",marginTop:10,lineHeight:1.5}}>
                Flags indicate channels where band power exceeds threshold values for the current epoch. Elevated delta ({">"}60%) or theta ({">"}40%) relative power may warrant further review.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{padding:"6px 12px",borderTop:"1px solid #1a1a1a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:8,color:"#333"}}>qEEG v0.1 - Observational metrics only</span>
        <button onClick={()=>{
          const report = {
            pipelineVersion: PIPELINE_VERSION,
            timestamp: new Date().toISOString(),
            epochStart,
            sampleRate,
            channels: channels.length,
            bandPower: analysis.avgBands,
            peakAlphaFrequency: analysis.peakAlphaFreq,
            thetaBetaRatio: analysis.thetaBetaRatio,
            asymmetryIndex: analysis.asymmetryIndex,
            flags: analysis.flags,
            eyeSync: analysis.eyeSync,
            perChannel: analysis.channelData.map(c => ({ channel: c.channel, ...c.bands })),
          };
          const blob = new Blob([JSON.stringify(report, null, 2)], {type:"application/json"});
          const url = URL.createObjectURL(blob); const a = document.createElement("a");
          a.href = url; a.download = `qEEG-report-epoch${Math.floor(epochStart/epochSec)+1}.json`; a.click(); URL.revokeObjectURL(url);
        }} style={{padding:"3px 8px",background:"#111",border:"1px solid #222",color:"#666",cursor:"pointer",fontSize:9,fontWeight:600}}>
          {I.Save(12)} Export
        </button>
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// SPECTROGRAM PANEL — STFT time-frequency decomposition
// ══════════════════════════════════════════════════════════════
function SpectrogramPanel({ waveformData, channels, sampleRate, epochSec, epochStart, onClose, panelPos, setPanelPos }) {
  const canvasRef = useRef(null);
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [hoverInfo, setHoverInfo] = useState(null);
  const [colorScale, setColorScale] = useState("thermal"); // thermal | viridis | grayscale

  // Color maps
  const colorMaps = {
    thermal: (t) => {
      if (t < 0.25) return [0, Math.floor(t*4*128), Math.floor(t*4*255)];
      if (t < 0.5) return [0, Math.floor(128+(t-0.25)*4*127), Math.floor(255-(t-0.25)*4*128)];
      if (t < 0.75) return [Math.floor((t-0.5)*4*255), 255, Math.floor(127-(t-0.5)*4*127)];
      return [255, Math.floor(255-(t-0.75)*4*128), 0];
    },
    viridis: (t) => {
      const r = Math.floor(68 + t * (253 - 68));
      const g = Math.floor(1 + t * (231 - 1));
      const b = Math.floor(84 + (t < 0.5 ? t * 2 * (170 - 84) : (170 - (t - 0.5) * 2 * 170)));
      return [r, g, b];
    },
    grayscale: (t) => { const v = Math.floor(t * 255); return [v, v, v]; },
  };

  // STFT computation
  const stftData = useMemo(() => {
    if (!waveformData || !waveformData[selectedChannel]) return null;
    const data = waveformData[selectedChannel];
    const N = data.length;
    const winSize = Math.min(256, N);
    const hop = Math.floor(winSize / 2);
    const nFrames = Math.max(1, Math.floor((N - winSize) / hop) + 1);

    // Hanning window
    const hann = new Float32Array(winSize);
    for (let i = 0; i < winSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (winSize - 1)));

    // Frequency resolution
    const freqRes = sampleRate / winSize;
    const maxFreqBin = Math.min(Math.ceil(50 / freqRes), Math.floor(winSize / 2));
    const minFreqBin = Math.max(1, Math.floor(0.5 / freqRes));
    const nFreqs = maxFreqBin - minFreqBin + 1;

    // Compute STFT frames
    const powerMatrix = new Array(nFrames);
    let globalMax = -Infinity, globalMin = Infinity;

    for (let f = 0; f < nFrames; f++) {
      const offset = f * hop;
      // Apply window and compute FFT (using DFT for the relevant freq bins)
      const frame = new Float32Array(winSize);
      for (let i = 0; i < winSize; i++) frame[i] = (data[offset + i] || 0) * hann[i];

      const power = new Float32Array(nFreqs);
      for (let k = minFreqBin; k <= maxFreqBin; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < winSize; n++) {
          const angle = -2 * Math.PI * k * n / winSize;
          re += frame[n] * Math.cos(angle);
          im += frame[n] * Math.sin(angle);
        }
        const p = Math.log10((re * re + im * im) / winSize + 1e-10);
        power[k - minFreqBin] = p;
        if (p > globalMax) globalMax = p;
        if (p < globalMin) globalMin = p;
      }
      powerMatrix[f] = power;
    }

    return { powerMatrix, nFrames, nFreqs, minFreqBin, maxFreqBin, freqRes, globalMin, globalMax, hop };
  }, [waveformData, selectedChannel, sampleRate]);

  // Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stftData) return;
    const { powerMatrix, nFrames, nFreqs, minFreqBin, freqRes, globalMin, globalMax, hop } = stftData;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const margin = { left: 50, right: 20, top: 10, bottom: 30 };
    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;
    const cmap = colorMaps[colorScale] || colorMaps.thermal;
    const range = globalMax - globalMin || 1;

    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, W, H);

    // Draw spectrogram pixels
    const imgData = ctx.createImageData(plotW, plotH);
    for (let px = 0; px < plotW; px++) {
      const frameIdx = Math.min(nFrames - 1, Math.floor(px / plotW * nFrames));
      const frame = powerMatrix[frameIdx];
      for (let py = 0; py < plotH; py++) {
        const freqIdx = Math.floor((1 - py / plotH) * nFreqs);
        const val = frame ? (frame[Math.min(freqIdx, nFreqs - 1)] || globalMin) : globalMin;
        const t = Math.max(0, Math.min(1, (val - globalMin) / range));
        const [r, g, b] = cmap(t);
        const idx = (py * plotW + px) * 4;
        imgData.data[idx] = r; imgData.data[idx + 1] = g; imgData.data[idx + 2] = b; imgData.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, margin.left, margin.top);

    // Axes
    ctx.strokeStyle = "#333"; ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    // Y-axis labels (frequency)
    ctx.fillStyle = "#888"; ctx.font = "9px 'IBM Plex Mono', monospace"; ctx.textAlign = "right";
    const freqLabels = [1, 4, 8, 13, 20, 30, 40, 50];
    for (const f of freqLabels) {
      const y = margin.top + plotH * (1 - (f - minFreqBin * freqRes) / ((stftData.maxFreqBin - minFreqBin) * freqRes));
      if (y >= margin.top && y <= margin.top + plotH) {
        ctx.fillText(`${f}Hz`, margin.left - 4, y + 3);
        ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + 3, y); ctx.stroke();
      }
    }

    // X-axis labels (time)
    ctx.textAlign = "center";
    const totalSec = epochSec;
    for (let s = 0; s <= totalSec; s += Math.max(1, Math.floor(totalSec / 6))) {
      const x = margin.left + (s / totalSec) * plotW;
      ctx.fillText(`${(epochStart + s).toFixed(1)}s`, x, margin.top + plotH + 14);
      ctx.beginPath(); ctx.moveTo(x, margin.top + plotH); ctx.lineTo(x, margin.top + plotH + 3); ctx.stroke();
    }

    // Band markers
    ctx.strokeStyle = "#ffffff20"; ctx.setLineDash([2, 4]);
    for (const [name, lo, hi] of [["δ",0.5,4],["θ",4,8],["α",8,13],["β",13,30],["γ",30,50]]) {
      const y = margin.top + plotH * (1 - (lo - minFreqBin * freqRes) / ((stftData.maxFreqBin - minFreqBin) * freqRes));
      if (y >= margin.top && y <= margin.top + plotH) {
        ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
        ctx.fillStyle = "#555"; ctx.textAlign = "left";
        ctx.fillText(name, margin.left + 3, y - 2);
      }
    }
    ctx.setLineDash([]);
  }, [stftData, colorScale, epochSec, epochStart]);

  // Mouse hover for frequency/power readout
  const handleCanvasMove = useCallback((e) => {
    if (!stftData || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left - 50, my = e.clientY - rect.top - 10;
    const plotW = rect.width - 70, plotH = rect.height - 40;
    if (mx < 0 || mx > plotW || my < 0 || my > plotH) { setHoverInfo(null); return; }
    const { nFrames, nFreqs, minFreqBin, freqRes, powerMatrix, hop } = stftData;
    const frameIdx = Math.min(nFrames - 1, Math.floor(mx / plotW * nFrames));
    const freqIdx = Math.floor((1 - my / plotH) * nFreqs);
    const freq = (minFreqBin + freqIdx) * freqRes;
    const time = epochStart + (frameIdx * hop) / sampleRate;
    const power = powerMatrix[frameIdx] ? powerMatrix[frameIdx][Math.min(freqIdx, nFreqs - 1)] : 0;
    setHoverInfo({ freq: freq.toFixed(1), time: time.toFixed(2), power: power.toFixed(2), x: e.clientX, y: e.clientY });
  }, [stftData, epochStart, sampleRate]);

  // Filter EEG-only channels
  const eegChannels = channels.filter(ch => !/ECG|EKG|EOG|EMG|EDF Annot/i.test(ch));

  return (
    <FloatingPanel
      title="SPECTROGRAM — STFT" titleColor="#7ec8d9" titleSize={11} titleSpacing="0.05em"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: window.innerWidth - 620, y: 80 })}
      width={600} zIndex={1200}
      background="#0a0a0a" border="1px solid #1a3040"
      headerBg="#111" boxShadow="0 8px 32px rgba(0,0,0,0.8)"
      headerExtra={<span style={{fontSize:8,color:"#555"}}>v{PIPELINE_VERSION.split("-").pop()}</span>}
    >
      {/* Controls */}
      <div style={{display:"flex",gap:8,padding:"6px 12px",borderBottom:"1px solid #111",alignItems:"center"}}>
        <label style={{fontSize:10,color:"#666"}}>Channel:</label>
        <select value={selectedChannel} onChange={e=>setSelectedChannel(parseInt(e.target.value))}
          style={{background:"#111",border:"1px solid #222",color:"#7ec8d9",fontSize:10,padding:"2px 6px"}}>
          {eegChannels.map((ch,i) => <option key={ch} value={channels.indexOf(ch)}>{ch}</option>)}
        </select>
        <label style={{fontSize:10,color:"#666",marginLeft:8}}>Color:</label>
        <select value={colorScale} onChange={e=>setColorScale(e.target.value)}
          style={{background:"#111",border:"1px solid #222",color:"#7ec8d9",fontSize:10,padding:"2px 6px"}}>
          <option value="thermal">Thermal</option><option value="viridis">Viridis</option><option value="grayscale">Grayscale</option>
        </select>
        {hoverInfo && (
          <span style={{marginLeft:"auto",fontSize:9,color:"#888",fontFamily:"'IBM Plex Mono',monospace"}}>
            {hoverInfo.freq}Hz | {hoverInfo.time}s | {hoverInfo.power}dB
          </span>
        )}
      </div>
      {/* Canvas */}
      <div style={{padding:"8px 12px 12px"}}>
        <canvas ref={canvasRef} width={576} height={240}
          onMouseMove={handleCanvasMove} onMouseLeave={()=>setHoverInfo(null)}
          style={{width:"100%",height:240,cursor:"crosshair"}}/>
        {/* Color legend */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6}}>
          <span style={{fontSize:8,color:"#555"}}>Low</span>
          <div style={{flex:1,height:6,background:"linear-gradient(to right, #000033, #003366, #00cccc, #ffff00, #ff4400)",borderRadius:0}}/>
          <span style={{fontSize:8,color:"#555"}}>High</span>
          <span style={{fontSize:8,color:"#444",marginLeft:8}}>Power (dB)</span>
        </div>
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// COMPARE PANEL — cross-file frequency & eye sync comparison
// ══════════════════════════════════════════════════════════════

// Hanning-windowed FFT band power for a single segment — returns { delta, theta, alpha, beta, gamma, total, peakAlphaFreq }
function computeSegmentBands(seg, sr) {
  const N = seg.length;
  if (N < 16) return null;
  const freqRes = sr / N;
  const bandRanges = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
  const windowed = new Float32Array(N);
  let winE = 0;
  for (let n = 0; n < N; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
    windowed[n] = seg[n] * w;
    winE += w * w;
  }
  const winNorm = winE / N;

  // Compute full power spectrum for peak detection
  const maxK = Math.min(Math.floor(N / 2), Math.round(50 / freqRes));
  const spectrum = new Float32Array(maxK + 1);
  for (let k = 1; k <= maxK; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += windowed[n] * Math.cos(angle);
      im -= windowed[n] * Math.sin(angle);
    }
    spectrum[k] = (re * re + im * im) / (N * N * winNorm);
  }

  // Sum band powers from spectrum
  const powers = {};
  let total = 0;
  Object.entries(bandRanges).forEach(([band, [fLow, fHigh]]) => {
    let p = 0;
    const kL = Math.max(1, Math.round(fLow / freqRes));
    const kH = Math.min(maxK, Math.round(fHigh / freqRes));
    for (let k = kL; k <= kH; k++) p += spectrum[k];
    powers[band] = p;
    total += p;
  });
  powers.total = total;

  // Peak alpha frequency: highest-power bin in 7-13 Hz range
  const alphaLow = Math.max(1, Math.round(7 / freqRes));
  const alphaHigh = Math.min(maxK, Math.round(13 / freqRes));
  let peakK = alphaLow, peakP = 0;
  for (let k = alphaLow; k <= alphaHigh; k++) {
    if (spectrum[k] > peakP) { peakP = spectrum[k]; peakK = k; }
  }
  powers.peakAlphaFreq = peakK * freqRes;

  // Theta/beta ratio (frontal channels are handled by caller; here it's per-channel)
  const thetaPower = powers.theta || 0;
  const betaPower = powers.beta || 0.0001;
  powers.thetaBetaRatio = thetaPower / betaPower;

  return powers;
}

// Full-file analysis: multi-epoch averaged band power across all EEG channels
function analyzeFullFile(edfData) {
  if (!edfData?.channelData || !edfData.channelLabels) return null;
  const sr = edfData.sampleRate || 256;
  const normLabel = (l) => l.toUpperCase().replace(/^(EEG|ECG|EOG|EMG)\s+/, "").replace(/[\s\-.]/g, "");
  const AUX = new Set(["EKG","ECG","LOC1","LOC2","ROC1","ROC2","PG1","PG2","E1","E2","EOGL","EOGR"]);
  const eegIdxs = edfData.channelLabels.map((l, i) => AUX.has(normLabel(l)) ? -1 : i).filter(i => i >= 0);
  if (eegIdxs.length === 0) return null;

  // Analyze in 2-second non-overlapping epochs, average across all
  const epochSamples = sr * 2;
  const bandRanges = ["delta", "theta", "alpha", "beta", "gamma"];
  const avgBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
  let peakAlphaSum = 0, tbrSum = 0, nSegments = 0;

  for (const idx of eegIdxs) {
    const raw = edfData.channelData[idx];
    if (!raw || raw.length < epochSamples) continue;
    const nEpochs = Math.min(30, Math.floor(raw.length / epochSamples)); // cap at 30 epochs for performance
    for (let e = 0; e < nEpochs; e++) {
      const seg = raw.slice(e * epochSamples, (e + 1) * epochSamples);
      const bp = computeSegmentBands(seg, sr);
      if (!bp) continue;
      bandRanges.forEach(b => avgBands[b] += bp[b]);
      avgBands.total += bp.total;
      peakAlphaSum += bp.peakAlphaFreq;
      tbrSum += bp.thetaBetaRatio;
      nSegments++;
    }
  }
  if (nSegments === 0) return null;
  bandRanges.forEach(b => avgBands[b] /= nSegments);
  avgBands.total /= nSegments;

  return {
    bands: avgBands,
    peakAlphaFreq: peakAlphaSum / nSegments,
    thetaBetaRatio: tbrSum / nSegments,
    nChannels: eegIdxs.length,
    nSegments,
  };
}

// Full-file eye synchronicity: multi-epoch WPLI + Pearson across vertical and horizontal pairs
function analyzeFullFileEyeSync(edfData) {
  if (!edfData?.channelData || !edfData.channelLabels) return null;
  const sr = edfData.sampleRate || 256;
  const normLabel = (l) => l.toUpperCase().replace(/^(EEG|ECG|EOG|EMG)\s+/, "").replace(/[\s\-.]/g, "");
  const labels = edfData.channelLabels.map(normLabel);

  // Find eye channels with alias support
  const ALIASES = { "PG1": "LOC1", "PG2": "ROC1", "E1": "LOC1", "E2": "ROC1", "EOGL": "LOC1", "EOGR": "ROC1" };
  const findCh = (target) => {
    let idx = labels.indexOf(target);
    if (idx >= 0) return idx;
    for (let i = 0; i < labels.length; i++) { if (ALIASES[labels[i]] === target) return i; }
    return -1;
  };

  const loc1 = findCh("LOC1"), loc2 = findCh("LOC2"), roc1 = findCh("ROC1"), roc2 = findCh("ROC2");
  // Need at least one vertical pair (LOC1+ROC1) for sync analysis
  if (loc1 < 0 || roc1 < 0) return null;

  const epochSamples = sr * 2;
  const totalSamples = edfData.channelData[loc1].length;
  const nEpochs = Math.min(30, Math.floor(totalSamples / epochSamples));
  if (nEpochs < 1) return null;

  // Bilateral metrics (L vs R eye — LOC1 vs ROC1, LOC2 vs ROC2)
  let wpliVertSum = 0, wpliVertN = 0;
  let wpliHorizSum = 0, wpliHorizN = 0;
  let corrVertSum = 0, corrVertN = 0;
  let corrHorizSum = 0, corrHorizN = 0;
  let blinkEvents = 0, blinkSymCount = 0;
  // Per-eye metrics (LOC1 vs LOC2 = left eye, ROC1 vs ROC2 = right eye)
  let wpliLeftSum = 0, wpliLeftN = 0;
  let wpliRightSum = 0, wpliRightN = 0;
  let corrLeftSum = 0, corrLeftN = 0;
  let corrRightSum = 0, corrRightN = 0;

  for (let e = 0; e < nEpochs; e++) {
    const s = e * epochSamples;
    const aV = edfData.channelData[loc1].slice(s, s + epochSamples);
    const bV = edfData.channelData[roc1].slice(s, s + epochSamples);

    // Bilateral vertical WPLI (LOC1 vs ROC1)
    const wV = computeWPLI(aV, bV, sr, 1, 15);
    if (wV !== null) { wpliVertSum += wV; wpliVertN++; }
    const cV = computeCrossCorrelation(aV, bV);
    if (cV !== null) { corrVertSum += Math.max(0, cV); corrVertN++; }

    // Bilateral horizontal WPLI (LOC2 vs ROC2)
    if (loc2 >= 0 && roc2 >= 0) {
      const aH = edfData.channelData[loc2].slice(s, s + epochSamples);
      const bH = edfData.channelData[roc2].slice(s, s + epochSamples);
      const wH = computeWPLI(aH, bH, sr, 1, 15);
      if (wH !== null) { wpliHorizSum += wH; wpliHorizN++; }
      const cH = computeCrossCorrelation(aH, bH);
      if (cH !== null) { corrHorizSum += Math.max(0, cH); corrHorizN++; }
    }

    // Per-eye: Left eye (LOC1 vs LOC2 — vertical vs horizontal of left eye)
    if (loc2 >= 0) {
      const lH = edfData.channelData[loc2].slice(s, s + epochSamples);
      const wL = computeWPLI(aV, lH, sr, 1, 15);
      if (wL !== null) { wpliLeftSum += wL; wpliLeftN++; }
      const cL = computeCrossCorrelation(aV, lH);
      if (cL !== null) { corrLeftSum += Math.max(0, cL); corrLeftN++; }
    }

    // Per-eye: Right eye (ROC1 vs ROC2 — vertical vs horizontal of right eye)
    if (roc2 >= 0) {
      const rH = edfData.channelData[roc2].slice(s, s + epochSamples);
      const wR = computeWPLI(bV, rH, sr, 1, 15);
      if (wR !== null) { wpliRightSum += wR; wpliRightN++; }
      const cR = computeCrossCorrelation(bV, rH);
      if (cR !== null) { corrRightSum += Math.max(0, cR); corrRightN++; }
    }

    // Blink symmetry: detect blinks as peaks > 80µV in LOC1, check if ROC1 also peaks
    const blinkThresh = 80;
    for (let i = 1; i < aV.length - 1; i++) {
      if (Math.abs(aV[i]) > blinkThresh && Math.abs(aV[i]) > Math.abs(aV[i - 1]) && Math.abs(aV[i]) > Math.abs(aV[i + 1])) {
        blinkEvents++;
        let found = false;
        for (let j = Math.max(0, i - 10); j <= Math.min(bV.length - 1, i + 10); j++) {
          if (Math.abs(bV[j]) > blinkThresh * 0.5) { found = true; break; }
        }
        if (found) blinkSymCount++;
      }
    }
  }

  const wpliVert = wpliVertN > 0 ? wpliVertSum / wpliVertN : null;
  const wpliHoriz = wpliHorizN > 0 ? wpliHorizSum / wpliHorizN : null;
  const corrVert = corrVertN > 0 ? corrVertSum / corrVertN : null;
  const corrHoriz = corrHorizN > 0 ? corrHorizSum / corrHorizN : null;
  const blinkSymmetry = blinkEvents > 0 ? blinkSymCount / blinkEvents : null;
  const wpliLeft = wpliLeftN > 0 ? wpliLeftSum / wpliLeftN : null;
  const wpliRight = wpliRightN > 0 ? wpliRightSum / wpliRightN : null;
  const corrLeft = corrLeftN > 0 ? corrLeftSum / corrLeftN : null;
  const corrRight = corrRightN > 0 ? corrRightSum / corrRightN : null;

  // Combined score — WPLI-weighted
  const scores = [];
  if (wpliVert !== null) scores.push(wpliVert);
  if (wpliHoriz !== null) scores.push(wpliHoriz);
  if (blinkSymmetry !== null) scores.push(blinkSymmetry);
  const syncScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : null;

  return { wpliVert, wpliHoriz, corrVert, corrHoriz, wpliLeft, wpliRight, corrLeft, corrRight, blinkSymmetry, syncScore, nEpochs };
}

function ComparePanel({ records, edfFileStore, onClose, panelPos, setPanelPos }) {
  // Merged differential flow: pick a baseline (the "before" recording), then the recording to
  // compare it against (the "after"). Any two files may be chosen — across subjects too — but the
  // pair is always ordered chronologically so the earlier recording is the baseline and the later
  // one the comparison (a before→after delta, never retrocausal).
  const [baselineSel, setBaselineSel] = useState(null);
  const [compareSel, setCompareSel] = useState(null);

  // All library recordings, oldest-first, for chronological picking.
  const allFiles = useMemo(
    () => [...(records || [])].sort((a, b) => (a.date || "").localeCompare(b.date || "")),
    [records]
  );

  const comparison = useMemo(() => {
    if (!baselineSel || !compareSel) return { needsSelection: true };
    const r1 = records.find(r => r.filename === baselineSel);
    const r2 = records.find(r => r.filename === compareSel);
    if (!r1 || !r2) return { error: "Selected files not found in library." };
    // Earlier date → baseline (A / before); later → comparison (B / after).
    const [recA, recB] = (r1.date || "") <= (r2.date || "") ? [r1, r2] : [r2, r1];
    const edfA = edfFileStore?.[recA.filename];
    const edfB = edfFileStore?.[recB.filename];
    const analysisA = edfA ? analyzeFullFile(edfA) : null;
    const analysisB = edfB ? analyzeFullFile(edfB) : null;
    const eyeA = edfA ? analyzeFullFileEyeSync(edfA) : null;
    const eyeB = edfB ? analyzeFullFileEyeSync(edfB) : null;
    if (!analysisA && !analysisB) return { error: "No EDF data available for these files. Import real EDF data to compare.", recA, recB };
    return { recA, recB, analysisA, analysisB, eyeA, eyeB };
  }, [baselineSel, compareSel, records, edfFileStore]);

  const bandColors = { delta: "#6366F1", theta: "#F59E0B", alpha: "#10B981", beta: "#3B82F6", gamma: "#EC4899" };
  const bandNames = ["delta", "theta", "alpha", "beta", "gamma"];
  const bandLabels = { delta: "Delta (0.5-4)", theta: "Theta (4-8)", alpha: "Alpha (8-13)", beta: "Beta (13-30)", gamma: "Gamma (30-50)" };

  // One row in a file-selection step. Cross-subject picks are allowed.
  const FileRow = ({ r, selected, onPick }) => (
    <button onClick={() => onPick(r.filename)} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
      padding: "6px 10px", background: selected ? "#1a2a30" : "transparent",
      border: "none", cursor: "pointer", borderBottom: "1px solid #111",
      color: "#ccc", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10,
    }} onMouseEnter={e => e.currentTarget.style.background = "#1a1a1a"}
       onMouseLeave={e => e.currentTarget.style.background = selected ? "#1a2a30" : "transparent"}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.filename}</span>
      <span style={{ fontSize: 8, color: "#555", flexShrink: 0, marginLeft: 8 }}>{r.studyType} · {r.date}</span>
    </button>
  );

  const recA = comparison.recA;
  const recB = comparison.recB;

  return (
    <FloatingPanel
      title="CROSS-FILE COMPARISON" titleColor="#7ec8d9"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: Math.round(window.innerWidth / 2 - 220), y: 60 })}
      width={440} maxHeight="80vh" zIndex={85}
    >
      <div style={{ flex: 1, overflow: "auto", padding: "10px 12px" }}>
        {comparison.needsSelection ? (
          /* ── Guided two-step selection: baseline, then the file to compare ── */
          <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
            <div style={{ fontSize: 9, color: "#7ec8d9", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>
              STEP 1 — BASELINE (the earlier &ldquo;before&rdquo; recording)
            </div>
            <div style={{ border: "1px solid #1a3040", maxHeight: 150, overflow: "auto", marginBottom: 12 }}>
              {allFiles.length === 0 && <div style={{ padding: "10px", fontSize: 10, color: "#555" }}>No recordings in the library.</div>}
              {allFiles.map(r => (
                <FileRow key={r.id} r={r} selected={r.filename === baselineSel}
                  onPick={(fn) => { setBaselineSel(fn); if (fn === compareSel) setCompareSel(null); }}/>
              ))}
            </div>
            {baselineSel && (
              <>
                <div style={{ fontSize: 9, color: "#c084fc", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>
                  STEP 2 — COMPARE AGAINST (the recording to measure the change in)
                </div>
                <div style={{ border: "1px solid #302040", maxHeight: 150, overflow: "auto" }}>
                  {allFiles.filter(r => r.filename !== baselineSel).map(r => (
                    <FileRow key={r.id} r={r} selected={r.filename === compareSel} onPick={setCompareSel}/>
                  ))}
                </div>
                <div style={{ fontSize: 8, color: "#444", marginTop: 8, lineHeight: 1.4 }}>
                  The two files are compared chronologically — whichever recording is earlier becomes the baseline, so the change always reads before&nbsp;&rarr;&nbsp;after.
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Selected pair summary + reset */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0, background: "#0a1520", border: "1px solid #1a3040", padding: "4px 8px" }}>
                <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.06em" }}>BASELINE (BEFORE)</div>
                <div style={{ fontSize: 9, color: "#7ec8d9", fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{recA?.filename}</div>
                <div style={{ fontSize: 8, color: "#444" }}>{recA?.date}</div>
              </div>
              <span style={{ fontSize: 12, color: "#444", flexShrink: 0 }}>&rarr;</span>
              <div style={{ flex: 1, minWidth: 0, background: "#150a20", border: "1px solid #302040", padding: "4px 8px" }}>
                <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.06em" }}>COMPARISON (AFTER)</div>
                <div style={{ fontSize: 9, color: "#c084fc", fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{recB?.filename}</div>
                <div style={{ fontSize: 8, color: "#444" }}>{recB?.date}</div>
              </div>
              <button onClick={() => { setBaselineSel(null); setCompareSel(null); }} title="Choose different files" style={{
                background: "#111", border: "1px solid #2a2a2a", color: "#888", fontSize: 9, fontWeight: 700,
                padding: "4px 8px", cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0,
              }}>CHANGE</button>
            </div>

            {comparison.error ? (
              <div style={{ fontSize: 11, color: "#666", textAlign: "center", padding: "20px 10px", lineHeight: 1.6 }}>
                {comparison.error}
              </div>
            ) : (
              <>
            {/* ── SPECTRAL SPEED ── */}
            {comparison.analysisA && comparison.analysisB && (() => {
              const a = comparison.analysisA, b = comparison.analysisB;
              const totA = a.bands.total || 1, totB = b.bands.total || 1;
              const mono = "'IBM Plex Mono', monospace";
              const mkRow = (label, vA, vB, unit, inverted) => {
                const d = vB - vA;
                const c = Math.abs(d) < (unit === "%" ? 2 : unit === "Hz" ? 0.3 : 0.15) ? "#555"
                  : inverted ? (d > 0 ? "#f87171" : "#4ade80") : (d > 0 ? "#4ade80" : "#f87171");
                return (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: "#888", width: 72, flexShrink: 0 }}>{label}</span>
                    <span style={{ fontSize: 12, color: "#7ec8d9", fontFamily: mono, width: 56, textAlign: "right" }}>{typeof vA === "number" ? (unit === "%" ? vA.toFixed(1) : vA.toFixed(2)) : vA}{unit === "Hz" ? "" : unit === "%" ? "%" : ""}</span>
                    <span style={{ fontSize: 9, color: "#333" }}>&rarr;</span>
                    <span style={{ fontSize: 12, color: "#c084fc", fontFamily: mono, width: 56 }}>{typeof vB === "number" ? (unit === "%" ? vB.toFixed(1) : vB.toFixed(2)) : vB}{unit === "Hz" ? "" : unit === "%" ? "%" : ""}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: c, fontFamily: mono, flex: 1, textAlign: "right" }}>
                      {d > 0 ? "+" : ""}{unit === "%" ? d.toFixed(1) + "%" : unit === "Hz" ? d.toFixed(1) + "Hz" : d.toFixed(2)}
                    </span>
                  </div>
                );
              };
              const slowA = (a.bands.delta + a.bands.theta), fastA = (a.bands.alpha + a.bands.beta) || 0.0001;
              const slowB = (b.bands.delta + b.bands.theta), fastB = (b.bands.alpha + b.bands.beta) || 0.0001;
              return (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: "#666", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>SPECTRAL POWER CHANGE</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 9, color: "#333", width: 72, flexShrink: 0 }}></span>
                    <span style={{ fontSize: 9, color: "#7ec8d9", fontFamily: mono, width: 56, textAlign: "right" }}>FILE A</span>
                    <span style={{ fontSize: 9, color: "#333", width: 9 }}></span>
                    <span style={{ fontSize: 9, color: "#c084fc", fontFamily: mono, width: 56 }}>FILE B</span>
                    <span style={{ fontSize: 9, color: "#666", fontFamily: mono, flex: 1, textAlign: "right" }}>CHANGE</span>
                  </div>
                  {bandNames.map(band => mkRow(
                    band.charAt(0).toUpperCase() + band.slice(1),
                    (a.bands[band] / totA) * 100, (b.bands[band] / totB) * 100, "%",
                    band === "delta" || band === "theta"
                  ))}
                  <div style={{ borderTop: "1px solid #111", marginTop: 4, paddingTop: 4 }}>
                    {mkRow("Peak Alpha", a.peakAlphaFreq, b.peakAlphaFreq, "Hz", false)}
                    {mkRow("θ/β Ratio", a.thetaBetaRatio, b.thetaBetaRatio, "", true)}
                    {mkRow("Slow/Fast", slowA / fastA, slowB / fastB, "", true)}
                  </div>
                </div>
              );
            })()}

            {/* ── EYE SYNCHRONICITY ── */}
            {(comparison.eyeA || comparison.eyeB) && (
              <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 6, marginTop: 2 }}>
                <div style={{ fontSize: 8, color: "#F59E0B", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>EYE SYNCHRONICITY CHANGE</div>
                {comparison.eyeA && comparison.eyeB ? (() => {
                  const eA = comparison.eyeA, eB = comparison.eyeB;
                  const mono = "'IBM Plex Mono', monospace";
                  const eyeRow = (label, vA, vB, unit, labelColor) => {
                    if (vA === null || vB === null) return null;
                    const d = vB - vA;
                    const thresh = unit === "%" ? 3 : 0.03;
                    const c = Math.abs(d) < thresh ? "#555" : (d > 0 ? "#4ade80" : "#f87171");
                    return (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 1 }}>
                        <span style={{ fontSize: 8, color: labelColor || "#666", width: 68, flexShrink: 0 }}>{label}</span>
                        <span style={{ fontSize: 9, color: "#7ec8d9", fontFamily: mono, width: 44, textAlign: "right" }}>{unit === "%" ? vA.toFixed(0) + "%" : vA.toFixed(3)}</span>
                        <span style={{ fontSize: 7, color: "#333" }}>&rarr;</span>
                        <span style={{ fontSize: 9, color: "#c084fc", fontFamily: mono, width: 44 }}>{unit === "%" ? vB.toFixed(0) + "%" : vB.toFixed(3)}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: c, fontFamily: mono, flex: 1, textAlign: "right" }}>
                          {d > 0 ? "+" : ""}{unit === "%" ? d.toFixed(1) + "%" : d.toFixed(3)}
                        </span>
                      </div>
                    );
                  };
                  return (
                    <>
                      {/* Bilateral (L eye vs R eye) */}
                      <div style={{ fontSize: 7, color: "#444", marginBottom: 3 }}>Bilateral (L vs R eye)</div>
                      {eyeRow("Sync Score", eA.syncScore, eB.syncScore, "%", "#F59E0B")}
                      {eyeRow("WPLI Vert", eA.wpliVert, eB.wpliVert, "")}
                      {eyeRow("WPLI Horiz", eA.wpliHoriz, eB.wpliHoriz, "")}
                      {eyeRow("Blink Sym", eA.blinkSymmetry !== null ? eA.blinkSymmetry * 100 : null, eB.blinkSymmetry !== null ? eB.blinkSymmetry * 100 : null, "%")}

                      {/* Per-eye (L eye internal, R eye internal) */}
                      <div style={{ fontSize: 7, color: "#444", marginTop: 4, marginBottom: 3 }}>Per-eye (vertical vs horizontal within each eye)</div>
                      {eyeRow("L Eye WPLI", eA.wpliLeft, eB.wpliLeft, "", "#4fc3f7")}
                      {eyeRow("L Eye r", eA.corrLeft, eB.corrLeft, "")}
                      {eyeRow("R Eye WPLI", eA.wpliRight, eB.wpliRight, "", "#ce93d8")}
                      {eyeRow("R Eye r", eA.corrRight, eB.corrRight, "")}
                    </>
                  );
                })() : (
                  <div style={{ fontSize: 9, color: "#555" }}>Eye lead data (LOC/ROC) not available in both files.</div>
                )}
              </div>
            )}

            {/* Clinical note */}
            <div style={{ marginTop: 6, padding: "4px 8px", background: "#0a0a0a", border: "1px solid #1a1a1a" }}>
              <div style={{ fontSize: 7, color: "#444", lineHeight: 1.3 }}>
                Observational tool — not a diagnostic device.
              </div>
            </div>
              </>
            )}
          </>
        )}
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// RAW EDF INSPECTOR — peek at every signal actually in the .edf
// ══════════════════════════════════════════════════════════════
// A read-only inventory so the user can see the full picture of what the file contains
// before reading: every signal's label, mapped electrode, type, sample rate, units, and a
// quick RMS with a green "has signal" dot (vs flat/empty). De-identified header only.
function RawEdfPanel({ edfData, channels, filename, onClose, panelPos, setPanelPos }) {
  const mono = "'IBM Plex Mono', monospace";
  const fmt = (n, d = 1) => (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d);
  const typeColor = (t) => t === "EEG" ? "#7ec8d9" : t === "EOG" ? "#F59E0B" : t === "EKG" ? "#f472b6" : "#666";
  const th = { textAlign: "left", padding: "4px 8px", color: "#555", fontWeight: 700, fontSize: 8, letterSpacing: "0.06em", borderBottom: "1px solid #1a1a1a", position: "sticky", top: 0, background: "#0c0c0c" };
  const td = { padding: "3px 8px", color: "#888", whiteSpace: "nowrap" };
  const eegCount = channels.filter(c => c.type === "EEG").length;
  const dataCount = channels.filter(c => c.hasSignal).length;
  return (
    <FloatingPanel title="RAW EDF" titleColor="#7ec8d9"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: Math.round(window.innerWidth / 2 - 270), y: 56 })}
      width={540} maxHeight="80vh" zIndex={86}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1a1a1a", fontSize: 10, color: "#888", fontFamily: mono, display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
        <span style={{ color: "#7ec8d9" }}>{filename || "—"}</span>
        <span>start {edfData?.startDate || "—"} {edfData?.startTime || ""}</span>
        <span>dur {fmt(edfData?.totalDuration, 0)}s</span>
        <span>base {edfData?.sampleRate || "—"} Hz</span>
        <span>signals {channels.length}</span>
        <span>records {edfData?.numRecords ?? "—"}</span>
        <span style={{ color: "#22c55e" }}>{eegCount} EEG · {dataCount} with signal</span>
        {edfData?.impedances?.length ? <span style={{ color: "#facc15" }}>impedance: {edfData.impedances.length} ch</span> : null}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {channels.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "#555", fontSize: 11 }}>No EDF loaded.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: mono }}>
            <thead><tr>{["#", "Label", "Electrode", "Type", "Rate", "Units", "σ", "Data"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {channels.map(c => (
                <tr key={c.idx} style={{ borderBottom: "1px solid #111" }}>
                  <td style={td}>{c.idx + 1}</td>
                  <td style={{ ...td, color: "#ccc" }}>{c.label}</td>
                  <td style={td}>{c.electrode || "—"}</td>
                  <td style={{ ...td, color: typeColor(c.type), fontWeight: 700 }}>{c.type}</td>
                  <td style={td}>{c.sampleRate ?? "—"}</td>
                  <td style={td}>{c.physDim || "—"}</td>
                  <td style={{ ...td, color: c.hasSignal ? "#aaa" : "#444" }}>{fmt(c.std, 2)}</td>
                  <td style={td}>
                    <span title={c.hasSignal ? "carries signal" : "flat / no signal"} style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: c.hasSignal ? "#22c55e" : "transparent", border: c.hasSignal ? "none" : "1px solid #444" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ padding: "6px 12px", borderTop: "1px solid #1a1a1a", fontSize: 8, color: "#444", lineHeight: 1.4 }}>
        σ = mean-removed signal std-dev over the first ~8k samples (ignores DC offset). Green = the channel actually varies (carries signal); hollow = flat / no data. Raw inventory of the .edf — de-identified header only, no interpretation.
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// ANNOTATION PANEL — floating draggable overlay
// ══════════════════════════════════════════════════════════════
function AnnotationPanel({ annotations, setAnnotations, isAddingAnnotation, setIsAddingAnnotation,
  selectedAnnotationType, setSelectedAnnotationType, annotationConfidence, setAnnotationConfidence,
  epochStart, epochEnd, epochSec, setCurrentEpoch, filename, onClose,
  panelPos, setPanelPos }) {
  // Pseudonymous annotator label (local only). Re-render on change via local state mirror.
  const [annotatorLabel, setAnnotatorLabelState] = useState(() => getAnnotatorLabel());
  const annotatorId = hashAnnotator(annotatorLabel);
  const updateAnnotator = (v) => { setAnnotatorLabel(v); setAnnotatorLabelState(v); };
  // Concordant/discordant per annotation (descriptive only — needs ≥2 distinct annotators).
  const agreement = agreementByAnnotation(annotations);
  const AG_STYLE = {
    concordant: { color: "#10b981", label: "concordant" },
    discordant: { color: "#f59e0b", label: "discordant" },
  };
  return (
    <FloatingPanel
      title="ANNOTATIONS"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: window.innerWidth - 290, y: Math.round(window.innerHeight * 0.35) })}
      width={260} maxHeight="70vh" zIndex={80}
      headerExtra={
        <button onClick={()=>setIsAddingAnnotation(!isAddingAnnotation)} style={controlBtn(isAddingAnnotation)}>
          <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Plus()} ADD</span>
        </button>
      }
    >
      {isAddingAnnotation && (
        <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{...microLabel,marginBottom:6}}>Type</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {ANNOTATION_COLORS.map((ac,i)=>(
              <button key={i} onClick={()=>setSelectedAnnotationType(i)}
                title={`${ac.desc || ac.name}${ac.standard ? " · ACNS/ILAE standard term" : ""}`} style={{
                padding:"3px 8px",borderRadius:0,fontSize:9,fontWeight:600,cursor:"pointer",
                background:selectedAnnotationType===i?ac.color+"30":"#111",
                border:`1px solid ${selectedAnnotationType===i?ac.color+"60":"#222"}`,
                color:selectedAnnotationType===i?ac.color:"#666",
              }}>{ac.name}{ac.standard ? <span aria-hidden style={{opacity:0.5,marginLeft:3}}>✦</span> : null}</button>
            ))}
          </div>
          {/* Optional confidence (descriptive, not a probability) */}
          <div style={{...microLabel,margin:"8px 0 4px"}}>Confidence (optional)</div>
          <div style={{display:"flex",gap:4}}>
            {[["low","Low"],["med","Med"],["high","High"]].map(([v,lab])=>(
              <button key={v} onClick={()=>setAnnotationConfidence&&setAnnotationConfidence(annotationConfidence===v?null:v)} style={{
                padding:"3px 8px",borderRadius:0,fontSize:9,fontWeight:600,cursor:"pointer",
                background:annotationConfidence===v?"#1a2a30":"#111",
                border:`1px solid ${annotationConfidence===v?"#4a9bab":"#222"}`,
                color:annotationConfidence===v?"#7ec8d9":"#666",
              }}>{lab}</button>
            ))}
          </div>
          {/* Annotator pseudonym — only the hashed id is ever stored/exported */}
          <div style={{...microLabel,margin:"8px 0 4px"}}>Annotator (pseudonym)</div>
          <input value={annotatorLabel} onChange={e=>updateAnnotator(e.target.value)} placeholder="e.g. tech-A"
            title="Stored as an opaque hash on each annotation — your label is never exported or sent anywhere."
            style={{width:"100%",background:"#0a0a0a",border:"1px solid #2a2a2a",color:"#ddd",fontSize:11,padding:"4px 6px",outline:"none",fontFamily:"'IBM Plex Mono', monospace",boxSizing:"border-box"}}/>
          <div style={{fontSize:9,color:"#444",marginTop:3,fontFamily:"'IBM Plex Mono', monospace"}}>
            {annotatorId ? `id: ${annotatorId}` : "anonymous (no annotator set)"}
          </div>
          <div style={{fontSize:10,color:"#444",marginTop:6}}>✦ = ACNS/ILAE standard term · click the waveform to place</div>
        </div>
      )}
      <div style={{flex:1,overflow:"auto",padding:"6px 0"}}>
        {annotations.length===0 ? (
          <div style={{padding:20,textAlign:"center",color:"#333",fontSize:11}}>No annotations yet</div>
        ) : annotations.sort((a,b)=>a.time-b.time).map(ann=>(
          <div key={ann.id} onClick={()=>setCurrentEpoch(Math.floor(ann.time/epochSec))} style={{
            padding:"8px 12px",borderBottom:"1px solid #111",cursor:"pointer",transition:"background 0.1s",
            background:(ann.time>=epochStart&&ann.time<epochEnd)?"#111":"transparent",
          }} onMouseEnter={e=>e.currentTarget.style.background="#151515"}
             onMouseLeave={e=>e.currentTarget.style.background=(ann.time>=epochStart&&ann.time<epochEnd)?"#111":"transparent"}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                <div style={{width:8,height:8,borderRadius:0,background:ann.color,flexShrink:0}}/>
                <span style={{fontSize:11,fontWeight:600,color:ann.color}}>{ann.type}</span>
                {agreement[ann.id] && (
                  <span title={`Inter-rater: ${AG_STYLE[agreement[ann.id]].label} (≥2 annotators on this segment)`} style={{
                    fontSize:8,fontWeight:700,letterSpacing:"0.04em",padding:"1px 4px",borderRadius:0,flexShrink:0,
                    color:AG_STYLE[agreement[ann.id]].color, border:`1px solid ${AG_STYLE[agreement[ann.id]].color}55`,
                  }}>{AG_STYLE[agreement[ann.id]].label.toUpperCase()}</span>
                )}
              </div>
              <button onClick={e=>{e.stopPropagation();setAnnotations(annotations.filter(a=>a.id!==ann.id));}} style={{
                background:"none",border:"none",color:"#333",cursor:"pointer",padding:2
              }}>{I.Trash()}</button>
            </div>
            <div style={{fontSize:10,color:"#555",marginTop:2}}>
              {Math.floor(ann.time/60)}:{String(Math.floor(ann.time%60)).padStart(2,"0")}.{String(Math.round((ann.time%1)*100)).padStart(2,"0")}
              {ann.duration>0&&<span> — {ann.duration.toFixed(1)}s</span>}
              {ann.confidence&&<span style={{color:"#666"}}> · conf {ann.confidence}</span>}
              {ann.annotatorId&&<span title="Opaque annotator id" style={{color:"#3a6b75"}}> · {ann.annotatorId}</span>}
            </div>
            {ann.text&&ann.text!==ann.type&&<div style={{fontSize:10,color:"#444",marginTop:2}}>{ann.text}</div>}
          </div>
        ))}
      </div>
      <div style={{padding:"8px 12px",borderTop:"1px solid #1a1a1a"}}>
        <button onClick={()=>{
          // Annotation sidecar with provenance header — built via the shared sidecar helper
          // so schema/pipeline/app stamps are identical to the patient-package writer.
          const sidecar = buildAnnotationSidecar(annotations, filename);
          const blob=new Blob([JSON.stringify(sidecar,null,2)],{type:"application/json"});
          const url=URL.createObjectURL(blob); const a=document.createElement("a");
          a.href=url; a.download=`${filename||"annotations"}_annotations.json`; a.click(); URL.revokeObjectURL(url);
        }} style={{ width:"100%",padding:"6px 0",background:"#111",border:"1px solid #222",
          borderRadius:0,color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
          display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
          {I.Save()} Export
        </button>
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// CLINICAL NOTES PANEL — floating, draggable
// ══════════════════════════════════════════════════════════════
function ClinicalNotesPanel({ notes, setNotes, filename, onClose, panelPos, setPanelPos }) {
  const len = (notes || "").length;
  return (
    <FloatingPanel
      title="CLINICAL NOTES" titleColor="#888" titleSpacing="0.08em"
      onClose={onClose} panelPos={panelPos} setPanelPos={setPanelPos}
      defaultPos={() => ({ x: 20, y: Math.round(window.innerHeight * 0.35) })}
      width={280} zIndex={200}
      background="#111" fontFamily="'IBM Plex Mono', monospace"
      boxShadow="0 4px 20px rgba(0,0,0,0.6)"
    >
      <div style={{padding:"10px 12px"}}>
        <textarea value={notes||""} onChange={e=>setNotes(e.target.value.slice(0,500))} maxLength={500} placeholder="Injury location, date of injury, clinical context..."
          style={{width:"100%",height:120,background:"#0d0d0d",border:"1px solid #2a2a2a",color:"#e0e0e0",fontSize:12,fontFamily:"'IBM Plex Mono', monospace",
            padding:"8px",resize:"vertical",outline:"none",boxSizing:"border-box",lineHeight:1.5}}/>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:10}}>
          <span style={{color:"#555"}}>{filename}</span>
          <span style={{color:len>450?"#F59E0B":len>0?"#555":"#333"}}>{len}/500</span>
        </div>
      </div>
    </FloatingPanel>
  );
}

// ══════════════════════════════════════════════════════════════
// GLOBAL SPECTROGRAM MINIMAP — whole-file overview for the scrub bar
// ══════════════════════════════════════════════════════════════
// Goertzel power per 1 Hz bin (1..32 Hz) across the entire recording, averaged
// over a few representative channels and binned into COLS time columns (~1/sec,
// capped). Computed once per file (memoized by the caller). Cheap Goertzel inner
// loop (one mul-add per sample) keeps it fast even on long research recordings.
function computeGlobalSpectrogram(edfData) {
  const chans = edfData?.channelData;
  if (!chans || !chans.length || !chans[0]?.length) return null;
  const sr = edfData.sampleRate || 256;
  const totalSamples = chans[0].length;
  // 0.5 Hz bins across 0.5–30 Hz → finer delta–beta resolution than the old 1 Hz bins.
  const FMIN = 0.5, FSTEP = 0.5, FREQS = 60;
  const COLS = Math.min(600, Math.max(40, Math.floor(totalSamples / sr)));
  const segLen = Math.floor(totalSamples / COLS);
  if (segLen < 8) return null;
  const nCh = chans.length;
  const chIdxs = [];
  const cstep = Math.max(1, Math.floor(nCh / 4));
  for (let i = 0; i < nCh && chIdxs.length < 4; i += cstep) chIdxs.push(i);
  const coeffs = new Float32Array(FREQS);
  for (let f = 0; f < FREQS; f++) coeffs[f] = 2 * Math.cos((2 * Math.PI * (FMIN + f * FSTEP)) / sr);
  const mags = new Float32Array(COLS * FREQS);
  let maxMag = 1e-9;
  for (let c = 0; c < COLS; c++) {
    const start = c * segLen;
    for (let f = 0; f < FREQS; f++) {
      const coeff = coeffs[f];
      let acc = 0;
      for (let j = 0; j < chIdxs.length; j++) {
        const data = chans[chIdxs[j]];
        let s0 = 0, s1 = 0;
        for (let n = 0; n < segLen; n++) {
          const s = (data[start + n] || 0) + coeff * s0 - s1;
          s1 = s0; s0 = s;
        }
        const power = s0 * s0 + s1 * s1 - coeff * s0 * s1;
        acc += power > 0 ? Math.sqrt(power) : 0;
      }
      const m = acc / chIdxs.length;
      mags[c * FREQS + f] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  // Robust normalization reference (98th percentile). Dividing by the single global max
  // lets one strong artifact (an eye blink) set a huge max and flatten the rest of the map
  // to blue. Normalizing to p98 instead spreads ordinary activity across the full colour
  // range and lets strong artifacts saturate to red — making blinks/EMG easy to spot.
  const sorted = Float32Array.from(mags).sort();
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] || maxMag;
  const normRef = p98 > 1e-9 ? p98 : maxMag;
  return { cols: COLS, freqs: FREQS, mags, maxMag, normRef };
}

// Thermal colormap (blue→cyan→green→yellow→red) shared by the minimap.
function specHeat(t) {
  if (t < 0.25) return [0, (t * 4 * 128) | 0, (t * 4 * 255) | 0];
  if (t < 0.5)  return [0, (128 + (t - 0.25) * 4 * 127) | 0, (255 - (t - 0.25) * 4 * 128) | 0];
  if (t < 0.75) return [((t - 0.5) * 4 * 255) | 0, 255, (127 - (t - 0.5) * 4 * 127) | 0];
  return [255, (255 - (t - 0.75) * 4 * 128) | 0, 0];
}

// ══════════════════════════════════════════════════════════════
// REVIEW SCRUB BAR — dedicated bottom navigator (Wave: scrub bar)
// ══════════════════════════════════════════════════════════════
// Full-width bar: a whole-file spectrogram minimap with annotation/note tick
// markers, a translucent window showing the visible epoch, and a live playback
// head. Click or drag anywhere to snap the view to that point in the recording.
function ReviewScrubBar({ edfData, annotations = [], totalDuration, totalEpochs, epochSec, currentEpoch, setCurrentEpoch, playbackAbsSec = null, isPlaying = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(800);
  const STRIP_H = 20; // spectrogram strip height (px) — taller for the finer delta–beta bins
  const spec = useMemo(() => computeGlobalSpectrogram(edfData), [edfData]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Render the spectrogram minimap: build a small COLS×FREQS image then stretch
  // it across the bar (the browser interpolates it into a smooth heatmap).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = STRIP_H * dpr;
    canvas.style.width = width + "px"; canvas.style.height = STRIP_H + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!spec) {
      ctx.fillStyle = "#0c0c0c"; ctx.fillRect(0, 0, width, STRIP_H);
      ctx.fillStyle = "#444"; ctx.font = "9px 'IBM Plex Mono', monospace"; ctx.textAlign = "center";
      ctx.fillText("no signal overview", width / 2, STRIP_H / 2 + 3);
      return;
    }
    const off = document.createElement("canvas");
    off.width = spec.cols; off.height = spec.freqs;
    const octx = off.getContext("2d");
    const img = octx.createImageData(spec.cols, spec.freqs);
    const ref = spec.normRef || spec.maxMag;
    for (let c = 0; c < spec.cols; c++) {
      for (let f = 0; f < spec.freqs; f++) {
        // Normalize to the robust p98 reference (clamped), then apply a contrast curve.
        // Cells at/above p98 saturate to red; a mild gamma keeps mid-range activity vivid —
        // higher overall colour contrast than the old divide-by-global-max + sqrt.
        let t = Math.max(0, Math.min(1, spec.mags[c * spec.freqs + f] / ref));
        t = Math.pow(t, 0.6);
        const rgb = specHeat(t);
        const y = spec.freqs - 1 - f; // low freq at bottom
        const o = (y * spec.cols + c) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, width, STRIP_H);
  }, [spec, width]);

  const dur = totalDuration || 1;
  const epochStartSec = currentEpoch * epochSec;
  const winLeftPct = Math.max(0, Math.min(100, (epochStartSec / dur) * 100));
  const winWidthPct = Math.max(0.4, Math.min(100 - winLeftPct, (epochSec / dur) * 100));
  const headPct = playbackAbsSec != null ? Math.max(0, Math.min(100, (playbackAbsSec / dur) * 100)) : null;

  const seekToClientX = (clientX) => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const ep = (frac * dur) / epochSec;
    const maxEp = Math.max(0, (totalEpochs || 1) - 1);
    setCurrentEpoch(Math.max(0, Math.min(ep, maxEp)));
  };
  const onMouseDown = (e) => {
    e.preventDefault();
    seekToClientX(e.clientX);
    const move = (ev) => seekToClientX(ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div data-tut="Navigator: A whole-file spectrogram overview. Annotation and note ticks mark events; the cyan box is your current view and the white line is live playback. Click or drag to jump anywhere in the recording."
      style={{ flexShrink: 0, background: "#080808", borderTop: "1px solid #1a1a1a", padding: "3px 16px 4px" }}>
      <div ref={wrapRef} onMouseDown={onMouseDown}
        style={{ position: "relative", width: "100%", height: STRIP_H, cursor: "pointer", overflow: "hidden", border: "1px solid #1a1a1a" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", left: 0, top: 0, display: "block" }} />
        {/* Annotation / note markers */}
        {annotations.map((a) => (
          <div key={a.id} title={`${a.type}${a.text && a.text !== a.type ? ` — ${a.text}` : ""} @ ${fmt(a.time)}`}
            style={{ position: "absolute", top: 0, height: "100%", width: 2, marginLeft: -1,
              left: `${Math.max(0, Math.min(100, (a.time / dur) * 100))}%`,
              background: a.color || "#7ec8d9", boxShadow: `0 0 3px ${a.color || "#7ec8d9"}`, pointerEvents: "none" }} />
        ))}
        {/* Current-view window */}
        <div style={{ position: "absolute", top: 0, height: "100%", left: `${winLeftPct}%`, width: `${winWidthPct}%`,
          background: "rgba(126,200,217,0.18)", border: "1px solid #7ec8d9", boxSizing: "border-box", pointerEvents: "none" }} />
        {/* Live playback head */}
        {headPct != null && (isPlaying || (playbackAbsSec || 0) > 0.01) && (
          <div style={{ position: "absolute", top: 0, height: "100%", left: `${headPct}%`, width: 1, marginLeft: -0.5,
            background: "#fff", pointerEvents: "none" }} />
        )}
      </div>
      {/* Time axis ticks */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1, fontSize: 8, color: "#555", fontFamily: "'IBM Plex Mono', monospace" }}>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => <span key={p}>{fmt(dur * p)}</span>)}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EPOCH NAV BAR — shared
// ══════════════════════════════════════════════════════════════
function EpochNav({ currentEpoch, setCurrentEpoch, totalEpochs, epochSec, epochStart, epochEnd, totalDuration, isPlaying, onPlayPause, leftContent, rightContent }) {
  const secStep = epochSec > 0 ? 1 / epochSec : 1;
  const maxEpoch = Math.max(0, totalEpochs - 1);
  return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:8,
      padding:"8px 16px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0,flexWrap:"wrap" }}>
      {leftContent}
      {/* Play button — only shown when callback provided */}
      {onPlayPause && (
        <button onClick={onPlayPause} title="Play / Pause (Space)" data-tut="Play / pause real-time playback. A white cursor sweeps the page in real time and advances to the next epoch automatically. Spacebar also toggles it." style={{
          ...controlBtn(isPlaying),
          display:"flex",alignItems:"center",gap:4,minWidth:64,justifyContent:"center",
        }}>
          {isPlaying
            ? <><svg width="12" height="12" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> PAUSE</>
            : <><svg width="12" height="12" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> PLAY</>
          }
        </button>
      )}
      <button onClick={()=>setCurrentEpoch(Math.max(0, Math.floor(currentEpoch) - 1))} title="Back 1 epoch" style={controlBtn()}>|◀</button>
      <button onClick={()=>setCurrentEpoch(Math.max(0, currentEpoch - secStep))} title="Back 1 second" style={controlBtn()}>{I.ChevLeft()}</button>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:11,color:"#888"}}>
          Epoch <span style={{color:"#7ec8d9",fontWeight:700}}>{Math.floor(currentEpoch)+1}</span>
          <span style={{color:"#444"}}> / {totalEpochs}</span>
        </span>
        <span style={{color:"#333"}}>|</span>
        <span style={{fontSize:11,color:"#7ec8d9",fontWeight:600}}>
          {Math.floor(epochStart/60)}:{String(Math.floor(epochStart%60)).padStart(2,"0")}
        </span>
      </div>
      <span style={{fontSize:11,color:"#555"}}>
        {totalDuration != null ? `/ ${Math.floor(totalDuration/60)}:${String(Math.floor(totalDuration%60)).padStart(2,"0")}` : ""}
      </span>
      <button onClick={()=>setCurrentEpoch(Math.min(maxEpoch, currentEpoch + secStep))} title="Forward 1 second" style={controlBtn()}>{I.ChevRight()}</button>
      <button onClick={()=>setCurrentEpoch(Math.min(maxEpoch, Math.ceil(currentEpoch + 0.001)))} title="Forward 1 epoch" style={controlBtn()}>▶|</button>
      <span style={{color:"#333"}}>|</span>
      {rightContent}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ANNOTATION POPUP — at click position
// ══════════════════════════════════════════════════════════════
function AnnotationPopup({ draft, annotationType, text, setText, onConfirm, onCancel, containerRef }) {
  if (!draft) return null;
  const cw = containerRef.current?.getBoundingClientRect().width || 600;
  const ch = containerRef.current?.getBoundingClientRect().height || 400;
  const ac = ANNOTATION_COLORS[annotationType];
  return (
    <div style={{
      position:"absolute",
      left: Math.min(draft.x, cw - 360),
      top: Math.min(draft.y + 12, ch - 60),
      background:"#111", border:`1px solid ${ac.color}40`, borderRadius:0,
      padding:"10px 14px", display:"flex", alignItems:"center", gap:8,
      zIndex:10,
      whiteSpace:"nowrap",
    }}>
      <div style={{width:10,height:10,borderRadius:0,background:ac.color}}/>
      <span style={{fontSize:11,color:"#aaa"}}>{ac.name} @ {draft.time.toFixed(2)}s</span>
      <input value={text} onChange={e=>setText(e.target.value)} placeholder="Add note..."
        style={{ background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
          color:"#e0e0e0",fontSize:11,padding:"4px 8px",width:160,outline:"none" }}
        autoFocus onKeyDown={e=>e.key==="Enter"&&onConfirm()}/>
      <button onClick={onConfirm} style={{
        padding:"4px 10px",background:"#1a4a54",border:"1px solid #4a9bab40",
        borderRadius:0,color:"#7ec8d9",fontSize:10,fontWeight:700,cursor:"pointer"
      }}>SAVE</button>
      <button onClick={onCancel} style={{
        padding:"4px 8px",background:"none",border:"1px solid #333",
        borderRadius:0,color:"#666",fontSize:10,cursor:"pointer"
      }}>ESC</button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EEG SYSTEM TYPES — electrode placement standards (defined in CONFIGURATION block at top)
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// CHANNEL CONTEXT MENU — right-click on channel label
// ══════════════════════════════════════════════════════════════
function ChannelContextMenu({ x, y, channelName, isHidden, channelSens, chHpf, chLpf, globalHpf, globalLpf, onToggleVisibility, onAdjustSensitivity, onSetChHpf, onSetChLpf, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const miniBtn = {
    width:18,height:18,background:"#0a0a0a",border:"1px solid #333",borderRadius:0,
    color:"#aaa",cursor:"pointer",fontSize:12,lineHeight:1,padding:0,
    display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'IBM Plex Mono', monospace",
  };
  const rowStyle = { padding:"3px 9px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:6 };
  const lblStyle = { fontSize:9, color:"#666", letterSpacing:"0.06em", fontWeight:600 };
  const selStyle = { background:"#0a0a0a", border:"1px solid #333", borderRadius:0, color:"#ccc", fontSize:10, padding:"1px 4px", fontFamily:"'IBM Plex Mono', monospace", outline:"none" };

  const filterRow = (label, current, globalVal, options, onChange) => (
    <div style={rowStyle}>
      <span style={lblStyle}>{label}</span>
      <select value={current === undefined ? "" : String(current)}
        onChange={e=>{ const v=e.target.value; onChange(v === "" ? undefined : parseFloat(v)); }}
        onClick={e=>e.stopPropagation()} style={selStyle}>
        <option value="">{globalVal === 0 ? "Off" : `${globalVal}`}</option>
        {options.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
      </select>
    </div>
  );

  const hasOverride = chHpf !== undefined || chLpf !== undefined;

  return (
    <div ref={menuRef} style={{
      position:"fixed",left:x,top:y,zIndex:100,width:170,
      background:"#111",border:"1px solid #2a2a2a",borderRadius:0,overflow:"hidden",
    }}>
      {/* Header: channel name + visibility toggle + close */}
      <div style={{padding:"4px 9px",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <span style={{fontSize:10,color:"#7ec8d9",fontWeight:700,letterSpacing:"0.06em"}}>{channelName}</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={(e)=>{e.stopPropagation();onToggleVisibility();onClose();}}
            title={isHidden ? "Show channel" : "Hide channel"} aria-label={isHidden ? "Show channel" : "Hide channel"}
            style={{background:"none",border:"none",color:isHidden?"#7ec8d9":"#666",cursor:"pointer",padding:0,display:"flex",alignItems:"center"}}>
            {isHidden ? I.Eye(13) : I.EyeOff(13)}
          </button>
          <button onClick={(e)=>{e.stopPropagation();onClose();}}
            title="Close" aria-label="Close channel menu"
            style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:0,display:"flex",alignItems:"center"}}
            onMouseEnter={e=>e.currentTarget.style.color="#f87171"}
            onMouseLeave={e=>e.currentTarget.style.color="#666"}>
            {I.X(13)}
          </button>
        </div>
      </div>
      {/* Sensitivity */}
      <div style={rowStyle}>
        <span style={lblStyle}>SENS</span>
        <div style={{display:"flex",alignItems:"center",gap:3}}>
          <button onClick={()=>onAdjustSensitivity(-1)} style={miniBtn}>−</button>
          <span style={{fontSize:10,color:"#ccc",fontFamily:"'IBM Plex Mono', monospace",minWidth:18,textAlign:"center"}}>
            {channelSens > 0 ? `+${channelSens}` : channelSens}
          </span>
          <button onClick={()=>onAdjustSensitivity(1)} style={miniBtn}>+</button>
        </div>
      </div>
      {filterRow("LFF", chHpf, globalHpf, LFF_OPTIONS, onSetChHpf)}
      {filterRow("HFF", chLpf, globalLpf, HFF_OPTIONS, onSetChLpf)}
      {hasOverride && (
        <button onClick={(e)=>{e.stopPropagation();onSetChHpf(undefined);onSetChLpf(undefined);}}
          style={{background:"none",border:"none",borderTop:"1px solid #1a1a1a",color:"#666",cursor:"pointer",
            width:"100%",padding:"3px 9px",fontSize:9,textAlign:"left",fontFamily:"'IBM Plex Mono', monospace",letterSpacing:"0.04em"}}
          onMouseEnter={e=>e.currentTarget.style.color="#7ec8d9"}
          onMouseLeave={e=>e.currentTarget.style.color="#666"}>↺ clear overrides</button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// useEEGState — shared hook for viewer state
// ══════════════════════════════════════════════════════════════
function useEEGState(totalDuration = 600, edfData = null) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [montage, setMontage] = useState("bipolar-longitudinal");
  const [eegSystem, setEegSystem] = useState("10-20");
  const [hpf, setHpf] = useState(1);
  const [lpf, setLpf] = useState(70);
  const [notch, setNotch] = useState(60);
  const [epochSec, setEpochSec] = useState(10);
  const [currentEpoch, setCurrentEpoch] = useState(0);
  const [sensitivity, setSensitivity] = useState(20);
  const sampleRate = edfData?.sampleRate || 256;
  const [annotations, setAnnotations] = useState([]);
  const [selectedAnnotationType, setSelectedAnnotationType] = useState(0);
  const [isAddingAnnotation, setIsAddingAnnotation] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(null);
  const [showAnnotationPanel, setShowAnnotationPanel] = useState(true);
  const [hoveredTime, setHoveredTime] = useState(null);
  const [annotationText, setAnnotationText] = useState("");
  const [annotationConfidence, setAnnotationConfidence] = useState(null); // optional: "low"|"med"|"high"
  // Visibility state (hiddenChannels + forced overrides + cycleState) lives in a reducer —
  // see visibilityReducer at module scope. Setters below dispatch typed actions.
  const [visibility, visibilityDispatch] = useReducer(visibilityReducer, VISIBILITY_INITIAL);
  const hiddenChannels = visibility.hidden;
  const visibilityState = visibility.cycleState;
  const [channelSensitivity, setChannelSensitivity] = useState({});
  const [channelHpf, setChannelHpf] = useState({});
  const [channelLpf, setChannelLpf] = useState({});
  const [contextMenu, setContextMenu] = useState(null);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measureSel, setMeasureSel] = useState(null); // {startTime, endTime, startChIdx, endChIdx}
  const measureDragRef = useRef(null); // {startTime, startChIdx, curTime, curChIdx} during drag
  const [waveletDenoise, setWaveletDenoise] = useState(false);
  const [icaClean, setIcaClean] = useState(false);

  const [customElectrodes, setCustomElectrodes] = useState(
    () => new Set([...ELECTRODE_SETS["10-20"], "LOC1","LOC2","ROC1","ROC2"])
  );
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  // ── User-built bipolar montages (saved & reusable across files) ──
  const [customMontages, setCustomMontages] = useState(() => loadCustomMontages());
  const [showMontageBuilder, setShowMontageBuilder] = useState(false);
  const persistCustomMontages = useCallback((updater) => {
    setCustomMontages(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveCustomMontages(next);
      return next;
    });
  }, []);

  // Per-signal EDF analysis (electrodes present + which carry real signal) for the
  // file-derived montages below.
  const edfSig = useMemo(() => analyzeEdfSignals(edfData), [edfData]);

  // Auto-select the most appropriate default montage for each newly-opened EDF: a standard
  // 10-20 file → the classic longitudinal banana; a high-density file → the adaptive
  // double-banana built from the electrodes actually present (so all the data is shown, not
  // just 19 leads). Runs once per file (tracked by edfData identity); the user can change it
  // afterward, and the choice resets to the appropriate default when a different file opens.
  const autoMontageRef = useRef(null);
  useEffect(() => {
    if (!edfData || autoMontageRef.current === edfData) return;
    autoMontageRef.current = edfData;
    const sys = detectEdfSystem(edfData) || "10-20";
    setEegSystem(sys);
    setMontage(sys === "10-20" ? "bipolar-longitudinal" : MONTAGE_ADAPTIVE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edfData]);

  const allChannels = useMemo(() => {
    // A custom montage is just the user's saved list of "A-B" pairs fed through the same
    // bipolar-derivation pipeline as the presets (waveformData parses "A-B" → A − B).
    if (montage.startsWith(CUSTOM_MONTAGE_PREFIX)) {
      const cm = customMontages.find(m => CUSTOM_MONTAGE_PREFIX + m.id === montage);
      return cm ? cm.pairs.slice() : [];
    }
    // Adaptive double-banana — longitudinal bipolar chains built from the electrodes that
    // actually carry signal in THIS file (scales from 10-20 up to high-density).
    if (montage === MONTAGE_ADAPTIVE) return buildAdaptiveBanana([...edfSig.withData]);
    // As recorded — the file's own signals, one trace each, exactly as stored (honors a
    // pre-montaged EDF whose labels already contain derivations).
    if (montage === MONTAGE_AS_RECORDED) return asRecordedChannels(edfData);
    return getMontageChannels(montage, eegSystem, eegSystem === "custom" ? customElectrodes : null);
  }, [montage, eegSystem, customElectrodes, customMontages, edfSig, edfData]);
  // AUX_CHANNELS, EYE_CHANNELS, EYE_LEAD_ALIASES hoisted to CONFIGURATION block at top of file
  // visibilityState now derived from the visibility reducer above; setVisibilityState is gone

  // Normalize EDF label for matching (shared across hook)
  const normEdf = (l) => { const u = l.toUpperCase().trim(); if (/^(ECG|EKG)$/i.test(u)) return u.replace(/[\s\-\.]/g,""); return u.replace(/^(EEG|ECG|EOG|EMG)\s+/,"").replace(/[\s\-\.]/g,""); };
  const normCh  = (l) => l.toUpperCase().replace(/[\s\-\.]/g,"");

  // Compute which montage channels have real EDF coverage
  const channelsWithData = useMemo(() => {
    if (!edfData || !edfData.channelLabels) return new Set();
    const normed = edfData.channelLabels.map(normEdf);
    const covered = new Set();
    // "As recorded" channels ARE the raw file signals — match each by its full label.
    if (montage === MONTAGE_AS_RECORDED) {
      allChannels.forEach(ch => { if (normed.some(n => n === normCh(ch))) covered.add(ch); });
      return covered;
    }
    allChannels.forEach(ch => {
      const isEyeLead = ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2";
      const isEKG = ch === "EKG";
      if (isEKG) {
        if (normed.some(n => n === "ECG" || n === "EKG")) covered.add(ch);
        return;
      }
      if (isEyeLead) {
        if (normed.some(n => n === normCh(ch))) { covered.add(ch); return; }
        if (normed.some(n => EYE_LEAD_ALIASES[n] === ch)) covered.add(ch);
        return;
      }
      // Bipolar: need both electrodes
      if (ch.includes("-")) {
        const parts = ch.split("-");
        const ref = parts[parts.length - 1];
        if (ref === "Avg" || ref === "Cz") {
          if (normed.some(n => n === normCh(parts[0]))) covered.add(ch);
        } else if (parts.length === 2) {
          if (normed.some(n => n === normCh(parts[0])) && normed.some(n => n === normCh(parts[1]))) covered.add(ch);
          else if (normed.some(n => n === normCh(parts[0]))) covered.add(ch); // partial — show with ref subtracted
        }
      } else {
        if (normed.some(n => n === normCh(ch))) covered.add(ch);
      }
    });
    return covered;
  }, [edfData, allChannels, montage]);

  // auxWithData: subset for PatternTable LIVE/SIM badges
  const auxWithData = useMemo(() => {
    const s = new Set();
    AUX_CHANNELS.forEach(ch => { if (channelsWithData.has(ch)) s.add(ch); });
    return s;
  }, [channelsWithData]);

  // Auto-hide channels not present in the EDF whenever the file or montage changes.
  // Reducer reads the forced-override sets internally so this effect's dep array is
  // complete (no eslint-disable required).
  useEffect(() => {
    visibilityDispatch({ type: 'AUTO_HIDE_BY_DATA', channelsWithData, allChannels });
  }, [channelsWithData, allChannels]);

  const channels = allChannels.filter(ch => !hiddenChannels.has(ch));
  const totalEpochs = Math.ceil(totalDuration / epochSec);
  const epochStart = currentEpoch * epochSec;
  const epochEnd = Math.min(epochStart + epochSec, totalDuration);

  const toggleChannelVisibility = useCallback((ch) => {
    visibilityDispatch({ type: 'TOGGLE_CHANNEL', ch });
  }, []);

  const cycleVisibility = useCallback(() => {
    visibilityDispatch({ type: 'CYCLE', allChannels });
  }, [allChannels]);

  const setAvailableElectrodes = useCallback((electrodeSet) => {
    visibilityDispatch({ type: 'SET_AVAILABLE_ELECTRODES', electrodeSet, allChannels });
  }, [allChannels]);

  const adjustChannelSensitivity = (ch, delta) => {
    setChannelSensitivity(prev => ({ ...prev, [ch]: (prev[ch] || 0) + delta }));
  };

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const chHeight = rect.height / channels.length;
    const chIdx = Math.floor(y / chHeight);
    if (chIdx >= 0 && chIdx < channels.length) {
      setContextMenu({ x: e.clientX, y: e.clientY, channel: channels[chIdx], index: chIdx });
    }
  }, [channels]);

  // Common Average Reference (CAR) signal for the current epoch — the per-sample mean across
  // every scalp-EEG electrode present in the EDF (aux/EOG/EKG excluded via extractElectrodeName
  // so they don't bias the average). Computed once per epoch and reused by the average-reference
  // montage and by the partial-derivation fallback below. Returns null when fewer than 4 scalp
  // electrodes are available, since an average over too few channels isn't meaningful.
  // Common average reference, computed over the SAME guard-extended window the electrodes use
  // (so electrode − CAR stays aligned before cropping). Returns { data, lead, len } or null.
  const avgRefSignal = useMemo(() => {
    if (!edfData || !edfData.channelData || !edfData.channelLabels) return null;
    let sum = null, lead = 0, len = 0, count = 0;
    edfData.channelLabels.forEach((label, idx) => {
      if (!extractElectrodeName(label)) return; // scalp EEG electrodes only
      const w = getEDFEpochWindow(edfData, idx, epochStart, epochSec, sampleRate, FILTER_GUARD_SEC);
      if (!w) return;
      if (!sum) { sum = new Float32Array(w.data.length); lead = w.lead; len = w.len; }
      const m = Math.min(sum.length, w.data.length);
      for (let i = 0; i < m; i++) sum[i] += w.data[i];
      count++;
    });
    if (!sum || count < 4) return null;
    for (let i = 0; i < sum.length; i++) sum[i] /= count;
    return { data: sum, lead, len };
  }, [edfData, epochStart, epochSec, sampleRate]);

  // Subtract the common average reference from a guard-extended electrode window (electrode − CAR).
  // Returns a new Float32Array of the same length, or null if no average is available.
  const reReferenceToAverage = (extData) => {
    if (!extData || !avgRefSignal) return null;
    const a = avgRefSignal.data;
    const out = new Float32Array(extData.length);
    const m = Math.min(extData.length, a.length);
    for (let i = 0; i < extData.length; i++) out[i] = extData[i] - (i < m ? a[i] : 0);
    return out;
  };

  const waveformData = useMemo(() => {
    const Nep = Math.round(sampleRate * epochSec);
    // Fetch a guard-extended window for an electrode (real signal padding each side of the epoch).
    const win = (idx) => getEDFEpochWindow(edfData, idx, epochStart, epochSec, sampleRate, FILTER_GUARD_SEC);
    return channels.map((ch) => {
      const fullIdx = allChannels.indexOf(ch);
      let ext;                    // guard-extended signal (filtered as a whole, then cropped)
      let lead = 0, len = Nep;    // visible epoch lives at ext[lead .. lead+len)
      let isPartial = false;      // bipolar ref missing AND no average available → truly unreferenced
      let isAvgFallback = false;  // bipolar ref missing → re-referenced to the common average instead

      // Use real EDF data if available
      if (edfData && edfData.channelData) {
        const isEyeLead = ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2";
        const isEKG = ch === "EKG";
        // "As recorded" traces are raw file signals — match the full label and display as-is
        // (never re-derive), even when the label itself contains a "-" derivation.
        const isSingleLabel = montage === MONTAGE_AS_RECORDED || isEyeLead || isEKG || !ch.includes("-");

        if (isSingleLabel) {
          // EKG: match ECG label in EDF
          const searchLabel = isEKG ? "ECG" : ch;
          const edfIdx = edfData.channelLabels.findIndex(l => {
            const n = normEdf(l);
            if (n === normCh(searchLabel) || n === normCh(ch)) return true;
            if (isEKG && (n === "ECG" || n === "EKG")) return true;
            if (isEyeLead && EYE_LEAD_ALIASES[n] === ch) return true;
            return false;
          });
          if (edfIdx >= 0) {
            const w = win(edfIdx);
            if (w) {
              ext = w.data; lead = w.lead; len = w.len;
              // ECG channels in many EDF files are stored in mV — convert to µV for display
              if (isEKG) {
                let maxAbs = 0;
                for (let i = 0; i < ext.length; i++) { const a = Math.abs(ext[i]); if (a > maxAbs) maxAbs = a; }
                if (maxAbs > 0 && maxAbs < 10) { // values < 10 likely in mV, scale to µV
                  const scaled = new Float32Array(ext.length);
                  for (let i = 0; i < ext.length; i++) scaled[i] = ext[i] * 1000;
                  ext = scaled;
                }
              }
            }
          }
        } else {
          const parts = ch.split("-");
          const ref = parts[parts.length - 1];
          const isAvgRef = ref === "Avg";
          const isCzRef = ref === "Cz";

          const idx1 = edfData.channelLabels.findIndex(l => normEdf(l) === normCh(parts[0]));

          if (isAvgRef) {
            // Average-reference montage — electrode minus the common average. Falls back to the
            // raw electrode only when too few channels exist for a meaningful average.
            if (idx1 >= 0) {
              const w = win(idx1);
              if (w) { ext = reReferenceToAverage(w.data) || w.data; lead = w.lead; len = w.len; }
            }
          } else if (isCzRef) {
            if (idx1 >= 0) { const w = win(idx1); if (w) { ext = w.data; lead = w.lead; len = w.len; } }
          } else if (parts.length === 2) {
            const idx2 = edfData.channelLabels.findIndex(l => normEdf(l) === normCh(parts[1]));
            if (idx1 >= 0 && idx2 >= 0) {
              const w1 = win(idx1), w2 = win(idx2);
              if (w1 && w2) {
                // Both fetched with identical params → same lead/length, so they subtract aligned.
                ext = new Float32Array(w1.data.length); lead = w1.lead; len = w1.len;
                for (let i = 0; i < ext.length; i++) ext[i] = w1.data[i] - (i < w2.data.length ? w2.data[i] : 0);
              }
            } else if (idx1 >= 0) {
              // Reference electrode missing in the EDF. Rather than show this electrode
              // unreferenced (which carries whatever drift/artifact the original recording
              // reference had), re-reference it to the common average — this cancels shared
              // common-mode artifact while preserving the electrode's local activity. If there
              // aren't enough scalp electrodes for a meaningful average, fall back to the raw
              // single electrode and flag it as truly partial/unreferenced.
              const w = win(idx1);
              if (w) {
                lead = w.lead; len = w.len;
                const avg = reReferenceToAverage(w.data);
                if (avg) { ext = avg; isAvgFallback = true; }
                else { ext = w.data; isPartial = true; }
              }
            }
          }
        }
      }

      // Fall back: no matching EDF channel → flat line.
      // (Synthetic signal generation was removed — all displayed signals must come
      // from a real EDF in edfData.channelData.)
      if (!ext) { ext = new Float32Array(Nep); lead = 0; len = Nep; }

      const chHpf = channelHpf[ch] !== undefined ? channelHpf[ch] : hpf;
      const chLpf = channelLpf[ch] !== undefined ? channelLpf[ch] : lpf;
      // Filter the guard-extended window so the IIR/zero-phase filters settle on real
      // neighbouring data, THEN crop to the visible epoch — no edge transient pinned to the
      // window boundary. (At the true file start lead=0, so only that one edge can still reflect.)
      if (chHpf > 0) ext = applyHighPass(ext, chHpf, sampleRate);
      if (chLpf > 0) ext = applyLowPass(ext, chLpf, sampleRate);
      if (notch > 0) ext = applyNotch(ext, notch, sampleRate);
      // Wavelet denoising (EEG channels only)
      if (waveletDenoise && !AUX_CHANNELS.has(ch)) {
        const levels = sampleRate >= 256 ? 5 : 4;
        ext = applyWaveletDenoise(ext, levels).data;
      }
      // Crop the guard padding off, leaving exactly the visible epoch.
      const raw = (lead > 0 || len < ext.length) ? ext.slice(lead, lead + len) : ext;
      // Stamp derivation flags for the canvas label to surface
      if (isPartial) raw.__partial = true;
      if (isAvgFallback) raw.__avgRef = true;
      return raw;
    });
  }, [montage, hpf, lpf, notch, epochSec, currentEpoch, sampleRate, channels, allChannels, hiddenChannels, channelHpf, channelLpf, edfData, epochStart, waveletDenoise, avgRefSignal]);

  // ICA artifact cleaning — train the mixing matrix once per file+filter combo,
  // apply per-epoch via the cheap projection path.
  // Cache key includes file identity, filter settings, sample rate, and active channel
  // set (hidden/shown changes the EEG-vs-aux split, which would invalidate W).
  const icaCacheRef = useRef({ key: null, trained: null });
  const cleanedWaveformData = useMemo(() => {
    if (!icaClean) { icaCacheRef.current = { key: null, trained: null }; return waveformData; }
    const eegIdxs = [], auxData = [];
    channels.forEach((ch, i) => {
      if (AUX_CHANNELS.has(ch)) auxData.push(waveformData[i]);
      else eegIdxs.push(i);
    });
    if (eegIdxs.length < 2 || auxData.length === 0) return waveformData;
    const eegData = eegIdxs.map(i => waveformData[i]);

    const cacheKey = `${edfData?.startDate || 'sim'}|${edfData?.startTime || ''}|${hpf}|${lpf}|${notch}|${sampleRate}|${channels.join(',')}`;
    if (icaCacheRef.current.key !== cacheKey || !icaCacheRef.current.trained) {
      icaCacheRef.current = { key: cacheKey, trained: trainICA(eegData, auxData, sampleRate) };
    }
    const trained = icaCacheRef.current.trained;
    if (!trained) return waveformData;
    const cleaned = applyTrainedICA(eegData, trained);
    const result = [...waveformData];
    eegIdxs.forEach((origIdx, newIdx) => { result[origIdx] = cleaned[newIdx]; });
    return result;
  }, [waveformData, icaClean, channels, edfData, hpf, lpf, notch, sampleRate]);

  const getTimeFromX = useCallback((clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - 72;
    const plotW = rect.width - 72 - 16;
    if (x < 0 || x > plotW) return null;
    return epochStart + (x / plotW) * epochSec;
  }, [epochStart, epochSec]);

  const getChIdxFromY = useCallback((clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const { positions } = getChannelYPositions(channels, montage, rect.height);
    // Find closest channel by Y position
    for (let i = positions.length - 1; i >= 0; i--) {
      if (y >= positions[i].yTop) return i;
    }
    return 0;
  }, [channels, montage, canvasRef]);

  const handleCanvasMouseMove = (e) => {
    setHoveredTime(getTimeFromX(e.clientX));
    if (isMeasuring && measureDragRef.current) {
      const time = getTimeFromX(e.clientX);
      if (time === null) return;
      measureDragRef.current.curTime = time;
      measureDragRef.current.curChIdx = getChIdxFromY(e.clientY);
      // Force redraw via canvas
      if (canvasRef.current) canvasRef.current.__measureDirty = true;
    }
  };
  const handleCanvasMouseDown = (e) => {
    if (!isMeasuring) return;
    if (e.button !== 0) return;
    const time = getTimeFromX(e.clientX);
    if (time === null) return;
    const chIdx = getChIdxFromY(e.clientY);
    measureDragRef.current = { startTime: time, startChIdx: chIdx, curTime: time, curChIdx: chIdx };
    setMeasureSel(null);
    e.preventDefault();
  };
  const handleCanvasMouseUp = (e) => {
    if (!isMeasuring || !measureDragRef.current) return;
    const drag = measureDragRef.current;
    measureDragRef.current = null;
    const t0 = Math.min(drag.startTime, drag.curTime), t1 = Math.max(drag.startTime, drag.curTime);
    const c0 = Math.min(drag.startChIdx, drag.curChIdx), c1 = Math.max(drag.startChIdx, drag.curChIdx);
    if (t1 - t0 < 0.005) return; // too small, ignore
    setMeasureSel({ startTime: t0, endTime: t1, startChIdx: c0, endChIdx: c1 });
  };
  const handleCanvasClick = (e) => {
    if (isMeasuring) return; // handled by mousedown/mouseup
    // Annotation mode — left-click drops the draft pin
    if (isAddingAnnotation) {
      const time = getTimeFromX(e.clientX);
      if (time === null) return;
      const cRect = containerRef.current.getBoundingClientRect();
      setAnnotationDraft({ time: Math.round(time*100)/100, duration: 0.2, x: e.clientX-cRect.left, y: e.clientY-cRect.top });
      return;
    }
    // Default left-click: open the per-channel mini menu for the channel under
    // the cursor. Same menu the right-click context already opens.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < 0 || y > rect.height) return;
    const chHeight = rect.height / channels.length;
    const chIdx = Math.floor(y / chHeight);
    if (chIdx >= 0 && chIdx < channels.length) {
      setContextMenu({ x: e.clientX, y: e.clientY, channel: channels[chIdx], index: chIdx });
    }
  };
  const confirmAnnotation = () => {
    if (!annotationDraft) return;
    const t = ANNOTATION_COLORS[selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), code: t.code, time: annotationDraft.time, duration: annotationDraft.duration,
      type: t.name, color: t.color, text: annotationText || t.name, channel: -1, ...annotationProvenance(annotationConfidence) }]);
    setAnnotationDraft(null); setAnnotationText(""); setIsAddingAnnotation(false);
  };

  // ── Real-time playback ──
  // Cursor tracks ABSOLUTE file time (not epoch-relative). When playback crosses
  // the end of the currently-visible epoch, the view auto-snaps forward. If the
  // user manually navigates to a different epoch mid-playback, the cursor keeps
  // advancing at real-time pace and the auto-snap does NOT pull the view back —
  // the cursor simply renders only when its absolute time lies inside the
  // visible epoch. Spacebar toggles play/pause.
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackAbsSec, setPlaybackAbsSec] = useState(0);

  // Pause if the epoch length changes mid-playback (avoids confusing jumps).
  useEffect(() => { setIsPlaying(false); }, [epochSec]);

  // When the user presses PLAY: if the cursor isn't inside the currently-visible
  // epoch, snap it to the start of that epoch so playback resumes from where the
  // user is looking. Otherwise resume from wherever the cursor was paused.
  useEffect(() => {
    if (!isPlaying) return;
    setPlaybackAbsSec(prev => {
      const winStart = currentEpoch * epochSec;
      const winEnd = (currentEpoch + 1) * epochSec;
      return prev >= winStart && prev < winEnd ? prev : winStart;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Playback loop — only spins while isPlaying is true. setInterval (not rAF)
  // so it keeps ticking when the tab is backgrounded. epochSec/totalDuration are
  // read via refs so the interval only re-creates when isPlaying flips.
  const epochSecRef = useRef(epochSec);
  const totalDurationRef = useRef(totalDuration);
  const currentEpochRef = useRef(currentEpoch);
  useEffect(() => { epochSecRef.current = epochSec; }, [epochSec]);
  useEffect(() => { totalDurationRef.current = totalDuration; }, [totalDuration]);
  useEffect(() => { currentEpochRef.current = currentEpoch; }, [currentEpoch]);
  useEffect(() => {
    if (!isPlaying) return;
    let lastTs = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTs) / 1000;
      lastTs = now;
      setPlaybackAbsSec(prev => {
        const next = prev + dt;
        // End of file — pause and clamp.
        if (next >= totalDurationRef.current) {
          setIsPlaying(false);
          return totalDurationRef.current;
        }
        // Auto-snap view forward only when the cursor was *inside* the
        // currently-visible epoch and is now crossing into the next one. If the
        // user has manually navigated elsewhere, the cursor is outside the view
        // already and we leave currentEpoch alone — they retain control of the
        // view, and the cursor continues advancing in absolute file time.
        const winEnd   = (currentEpochRef.current + 1) * epochSecRef.current;
        const winStart =  currentEpochRef.current      * epochSecRef.current;
        if (prev >= winStart && prev < winEnd && next >= winEnd) {
          setCurrentEpoch(prevEp => prevEp + 1);
        }
        return next;
      });
    }, 33);
    return () => clearInterval(id);
  }, [isPlaying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      // Arrow keys handled by ReviewTab/AcquireTab to support hold-to-scroll; d/a as aliases (1 sec step)
      const secStep = epochSec > 0 ? 1 / epochSec : 1;
      if (e.key === "d") setCurrentEpoch(p => Math.min(p + secStep, totalEpochs - 1));
      if (e.key === "a") setCurrentEpoch(p => Math.max(p - secStep, 0));
      // Sensitivity: =/- and Up/Down arrows mirror the on-screen +/- buttons.
      // (Left/Right arrows are reserved for hold-to-scroll in ReviewTab.)
      if (e.key === "=" || e.key === "ArrowUp") { e.preventDefault(); setSensitivity(p => Math.min(p + 1, SENSITIVITY_MAX)); }
      if (e.key === "-" || e.key === "ArrowDown") { e.preventDefault(); setSensitivity(p => Math.max(p - 1, SENSITIVITY_MIN)); }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();          // prevent page scroll on the spacebar
        setIsPlaying(p => !p);
      }
      if (e.key === "Escape") { setIsAddingAnnotation(false); setAnnotationDraft(null); setIsMeasuring(false); setMeasureSel(null); measureDragRef.current = null; }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [totalEpochs, epochSec]);

  return {
    canvasRef, containerRef, montage, setMontage, eegSystem, setEegSystem,
    customElectrodes, setCustomElectrodes, showCustomPicker, setShowCustomPicker,
    customMontages, persistCustomMontages, showMontageBuilder, setShowMontageBuilder,
    hpf, setHpf, lpf, setLpf, notch, setNotch,
    epochSec, setEpochSec: (v) => { setEpochSec(v); setCurrentEpoch(0); },
    currentEpoch, setCurrentEpoch, sensitivity, setSensitivity, sampleRate,
    channels, allChannels, totalEpochs, epochStart, epochEnd, totalDuration, waveformData: cleanedWaveformData,
    annotations, setAnnotations, selectedAnnotationType, setSelectedAnnotationType,
    isAddingAnnotation, setIsAddingAnnotation, annotationDraft, setAnnotationDraft,
    showAnnotationPanel, setShowAnnotationPanel, hoveredTime, setHoveredTime,
    annotationText, setAnnotationText,
    annotationConfidence, setAnnotationConfidence,
    hiddenChannels, toggleChannelVisibility, setAvailableElectrodes, visibilityState, cycleVisibility,
    channelSensitivity, adjustChannelSensitivity,
    channelHpf, setChannelHpf, channelLpf, setChannelLpf,
    auxWithData, AUX_CHANNELS, channelsWithData,
    contextMenu, setContextMenu, handleContextMenu,
    isMeasuring, setIsMeasuring, measureSel, setMeasureSel, measureDragRef,
    waveletDenoise, setWaveletDenoise, icaClean, setIcaClean,
    handleCanvasMouseMove, handleCanvasMouseDown, handleCanvasMouseUp, handleCanvasClick, confirmAnnotation,
    // Playback (Wave 7e): real-time scrolling cursor + auto-advance to next epoch
    isPlaying, playbackAbsSec, togglePlayback: () => setIsPlaying(p => !p),
    pausePlayback: () => setIsPlaying(false),
  };
}

// ══════════════════════════════════════════════════════════════
// SUBJECT TIMELINE — multi-recording trend view per patient (Phase 2 #3)
// ══════════════════════════════════════════════════════════════
/**
 * Full-screen modal that pulls every recording sharing a subjectHash, sorts by
 * date, computes qEEG metrics per recording, and renders chronological line plots
 * of peak alpha frequency / theta-beta ratio / slowing index / hemispheric asymmetry
 * plus a topographic-slowing strip. Each timeline point is clickable to open the
 * corresponding recording in the Review tab.
 */
function SubjectTimeline({ subjectHash, records, edfFileStore, onClose, onOpenReview }) {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);
  // Filter to this subject, sort chronologically
  const subjectRecords = useMemo(() => {
    return records
      .filter(r => r.subjectHash === subjectHash)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  }, [records, subjectHash]);

  // Compute metrics per recording (memoized so flipping between subjects is cheap)
  const points = useMemo(() => subjectRecords.map(r => {
    const edf = edfFileStore?.[r.filename];
    const metrics = edf ? computeRecordMetrics(edf) : { peakAlphaFreq: null, thetaBetaRatio: null, slowingIndex: null, asymmetry: null, slowingByElectrode: {}, alphaByElectrode: {} };
    return { record: r, metrics };
  }), [subjectRecords, edfFileStore]);

  if (subjectRecords.length === 0) {
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`No recordings for subject ${subjectHash}`} onClick={e=>e.stopPropagation()} style={{background:"#0c0c0c",border:"1px solid #2a2a2a",padding:"24px 32px",fontFamily:"'IBM Plex Mono', monospace"}}>
          <div style={{color:"#f87171",fontSize:13,marginBottom:8}}>No recordings for subject {subjectHash}</div>
          <button onClick={onClose} style={{background:"#111",border:"1px solid #333",color:"#888",cursor:"pointer",padding:"6px 18px",fontSize:11,fontWeight:700}}>Dismiss</button>
        </div>
      </div>
    );
  }

  const firstDate = subjectRecords[0].date;
  const lastDate  = subjectRecords[subjectRecords.length - 1].date;

  // Line plot config
  const PLOT_W = 720;
  const PLOT_H = 110;
  const PAD_X  = 36;
  const PAD_Y  = 16;
  const usableW = PLOT_W - 2 * PAD_X;
  const usableH = PLOT_H - 2 * PAD_Y;

  const renderMetricPlot = (label, key, color, units, fmt = (v)=>v?.toFixed(1)) => {
    const values = points.map(p => p.metrics[key]).filter(v => v != null);
    if (values.length === 0) {
      return (
        <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"10px 12px"}}>
          <div style={{fontSize:9,letterSpacing:"0.1em",color:"#666",fontWeight:700,marginBottom:6}}>{label}</div>
          <div style={{height:PLOT_H,display:"flex",alignItems:"center",justifyContent:"center",color:"#444",fontSize:11,fontStyle:"italic"}}>No data available</div>
        </div>
      );
    }
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    const vRange = (vMax - vMin) || 1;
    const xStep = points.length > 1 ? usableW / (points.length - 1) : 0;
    // Build the polyline path, skipping null values
    const segments = [];
    let current = [];
    points.forEach((p, i) => {
      const v = p.metrics[key];
      if (v == null) { if (current.length) segments.push(current); current = []; return; }
      const x = PAD_X + i * xStep;
      const y = PAD_Y + (1 - (v - vMin) / vRange) * usableH;
      current.push([x, y]);
    });
    if (current.length) segments.push(current);

    return (
      <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"10px 12px"}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
          <span style={{fontSize:9,letterSpacing:"0.1em",color:"#666",fontWeight:700}}>{label}</span>
          <span style={{fontSize:10,color:color,fontFamily:"'JetBrains Mono', monospace"}}>
            {fmt(vMin)} – {fmt(vMax)} {units}
          </span>
        </div>
        <svg width={PLOT_W} height={PLOT_H} style={{display:"block",width:"100%",height:PLOT_H,background:"#080808"}}>
          {/* Horizontal grid lines */}
          <line x1={PAD_X} y1={PAD_Y} x2={PLOT_W-PAD_X} y2={PAD_Y} stroke="#1a1a1a" strokeWidth="0.5"/>
          <line x1={PAD_X} y1={PAD_Y+usableH/2} x2={PLOT_W-PAD_X} y2={PAD_Y+usableH/2} stroke="#161616" strokeWidth="0.5" strokeDasharray="2,3"/>
          <line x1={PAD_X} y1={PAD_Y+usableH} x2={PLOT_W-PAD_X} y2={PAD_Y+usableH} stroke="#1a1a1a" strokeWidth="0.5"/>
          {/* Y-axis min/max labels */}
          <text x={PAD_X-4} y={PAD_Y+4} fill="#555" fontSize="9" fontFamily="'JetBrains Mono', monospace" textAnchor="end">{fmt(vMax)}</text>
          <text x={PAD_X-4} y={PAD_Y+usableH+3} fill="#555" fontSize="9" fontFamily="'JetBrains Mono', monospace" textAnchor="end">{fmt(vMin)}</text>
          {/* Line segments */}
          {segments.map((seg, i) => (
            <polyline key={i} points={seg.map(p=>p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="1.5"/>
          ))}
          {/* Dots per timepoint */}
          {points.map((p, i) => {
            const v = p.metrics[key];
            if (v == null) {
              const x = PAD_X + i * xStep;
              return <circle key={i} cx={x} cy={PAD_Y+usableH/2} r="3" fill="#222" stroke="#444" strokeWidth="0.5"/>;
            }
            const x = PAD_X + i * xStep;
            const y = PAD_Y + (1 - (v - vMin) / vRange) * usableH;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r="4" fill={color} stroke="#0c0c0c" strokeWidth="1.5"
                  style={{cursor:"pointer"}} onClick={()=>{onOpenReview(p.record);onClose();}}>
                  <title>{p.record.date}: {fmt(v)} {units} — click to open in Review</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  // Small topographic strip — IDW interpolation of slowing index per timepoint
  const TOPO_SIZE = 80;
  const renderTopoCanvas = (slowingByElectrode) => {
    const values = Object.values(slowingByElectrode);
    if (values.length === 0) {
      return <div style={{width:TOPO_SIZE,height:TOPO_SIZE,background:"#111",border:"1px dashed #2a2a2a",display:"flex",alignItems:"center",justifyContent:"center",color:"#444",fontSize:9}}>no data</div>;
    }
    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    return (
      <canvas width={TOPO_SIZE} height={TOPO_SIZE} ref={(canvas) => {
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        canvas.width = TOPO_SIZE * dpr; canvas.height = TOPO_SIZE * dpr;
        canvas.style.width = TOPO_SIZE + "px"; canvas.style.height = TOPO_SIZE + "px";
        ctx.scale(dpr, dpr);
        ctx.fillStyle = "#080808"; ctx.fillRect(0, 0, TOPO_SIZE, TOPO_SIZE);
        const cx = TOPO_SIZE/2, cy = TOPO_SIZE/2, radius = TOPO_SIZE*0.44;
        const step = 2;
        for (let py = 0; py < TOPO_SIZE; py += step) {
          for (let px = 0; px < TOPO_SIZE; px += step) {
            const dx = px - cx, dy = py - cy;
            if (Math.sqrt(dx*dx + dy*dy) > radius) continue;
            const nx = 0.5 + (dx/radius) * 0.47;
            const ny = 0.5 + (dy/radius) * 0.47;
            const val = interpolateIDW(nx, ny, slowingByElectrode, 2.5);
            ctx.fillStyle = valueToColor(val, vMin, vMax, "heat");
            ctx.fillRect(px, py, step, step);
          }
        }
        ctx.strokeStyle = "#444"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI*2); ctx.stroke();
      }}/>
    );
  };

  const xLabelWidth = points.length > 1 ? usableW / (points.length - 1) : usableW;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:3000,display:"flex",alignItems:"center",justifyContent:"center",padding:24,overflow:"auto"}}
      onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="subject-timeline-title" onClick={e=>e.stopPropagation()} style={{
        background:"#0c0c0c",border:"1px solid #2a2a2a",width:"min(960px, 95vw)",maxHeight:"95vh",overflow:"auto",
        fontFamily:"'IBM Plex Mono', monospace",
      }}>
        {/* Header */}
        <div style={{padding:"14px 20px",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div id="subject-timeline-title" style={{fontSize:11,color:"#666",letterSpacing:"0.1em",fontWeight:700}}>SUBJECT TIMELINE</div>
            <div style={{fontSize:16,color:"#7ec8d9",fontWeight:700,marginTop:4}}>{subjectHash}</div>
            <div style={{fontSize:10,color:"#666",marginTop:2}}>
              {subjectRecords.length} recording{subjectRecords.length !== 1 ? "s" : ""} · {firstDate} → {lastDate}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close timeline" title="Close timeline" style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X(18)}</button>
        </div>

        {/* Metric line plots */}
        <div style={{padding:"14px 20px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {renderMetricPlot("PEAK ALPHA FREQUENCY",  "peakAlphaFreq", "#7ec8d9", "Hz",  v => v?.toFixed(2))}
          {renderMetricPlot("THETA / BETA RATIO",    "thetaBetaRatio", "#facc15", "",    v => v?.toFixed(2))}
          {renderMetricPlot("SLOWING INDEX (Δ+θ)",   "slowingIndex",   "#f87171", "%",  v => v?.toFixed(1))}
          {renderMetricPlot("HEMISPHERIC ASYMMETRY", "asymmetry",      "#a78bfa", "%",  v => (v >= 0 ? "+" : "") + v?.toFixed(1))}
        </div>

        {/* Topographic strip — slowing per timepoint */}
        <div style={{padding:"14px 20px",borderTop:"1px solid #1a1a1a"}}>
          <div style={{fontSize:9,letterSpacing:"0.1em",color:"#666",fontWeight:700,marginBottom:10}}>SLOWING INDEX (Δ+θ) — TOPOGRAPHIC PER RECORDING</div>
          <div style={{display:"flex",alignItems:"flex-start",gap:8,overflowX:"auto",paddingBottom:8}}>
            {points.map((p, i) => (
              <div key={i} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,minWidth:TOPO_SIZE,cursor:"pointer"}}
                onClick={()=>{onOpenReview(p.record); onClose();}}
                title={`${p.record.date} — click to open in Review`}>
                {renderTopoCanvas(p.metrics.slowingByElectrode)}
                <div style={{fontSize:9,color:"#888",fontFamily:"'JetBrains Mono', monospace"}}>{p.record.date}</div>
                <div style={{fontSize:8,color:"#555"}}>{p.record.studyType}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{padding:"10px 20px",borderTop:"1px solid #1a1a1a",fontSize:9,color:"#444",display:"flex",justifyContent:"space-between"}}>
          <span>Click any point or topo tile to open that recording in Review</span>
          <span>pipeline {PIPELINE_VERSION}</span>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TAB: LIBRARY
// ══════════════════════════════════════════════════════════════
// ── CollectionsSidebar — left rail used by Library and Repository tabs ──
function CollectionsSidebar({ collections, selectedCollectionId, onSelect, recordsByCollection, totalRecordCount, onCreateCollection, onRenameCollection, onDeleteCollection, showComplianceCriteria = false }) {
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  // True total — fall back to summing memberships if not provided
  const totalCount = (typeof totalRecordCount === "number")
    ? totalRecordCount
    : Object.values(recordsByCollection || {}).reduce((s, arr) => s + arr.length, 0);

  // Collapsed → minimize the sidebar to a vertical rail of one-letter collection icons.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.COLLECTIONS_COLLAPSED) === "1"; } catch { return false; }
  });
  const setCollapsedPersist = (v) => {
    setCollapsed(v);
    try { localStorage.setItem(STORAGE_KEYS.COLLECTIONS_COLLAPSED, v ? "1" : "0"); } catch {}
  };

  // The collections show/hide toggle is a square folder icon — same size in both states —
  // clicking it minimizes the bar to an icon rail or restores it.
  const folderToggle = (
    <button title={collapsed ? "Show collections" : "Hide collections"}
      aria-label={collapsed ? "Show collections" : "Hide collections"}
      onClick={() => setCollapsedPersist(!collapsed)}
      style={{ width:28, height:28, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center",
        cursor:"pointer", borderRadius:2, padding:0,
        background:"#111", border:"1px solid #4a9bab", color:"#7ec8d9" }}
      onMouseEnter={e=>{e.currentTarget.style.background="#1a2a30";}}
      onMouseLeave={e=>{e.currentTarget.style.background="#111";}}>
      {I.Folder(15)}
    </button>
  );

  if (collapsed) {
    const railBtn = (active, accent) => ({
      width: 30, height: 30, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 12, fontWeight: 700, cursor: "pointer", borderRadius: 2,
      background: active ? "#1a2a30" : "#111", border: `1px solid ${active ? "#4a9bab" : "#222"}`,
      color: active ? "#7ec8d9" : (accent || "#888"), fontFamily: "'IBM Plex Mono', monospace",
    });
    return (
      <div style={{width:46,height:"100%",background:"#0a0a0a",borderRight:"1px solid #1a1a1a",display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,paddingTop:8,gap:6,overflowY:"auto"}}>
        {folderToggle}
        <div style={{width:24,height:1,background:"#1a1a1a",margin:"1px 0"}}/>
        <button title={`All Recordings (${totalCount})`} onClick={()=>onSelect(null)} style={railBtn(selectedCollectionId===null)}>≡</button>
        {(collections || []).map(col => {
          const active = selectedCollectionId === col.id;
          const letter = ((col.name || "?").trim().charAt(0) || "?").toUpperCase();
          const count = recordsByCollection?.[col.id]?.length ?? 0;
          return (
            <button key={col.id} title={`${col.name}${count ? ` (${count})` : ""}`} onClick={()=>onSelect(col.id)} style={railBtn(active)}>{letter}</button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{width:200,height:"100%",background:"#0a0a0a",borderRight:"1px solid #1a1a1a",display:"flex",flexDirection:"column",flexShrink:0,minHeight:0}}>
      <div data-tut="Collections: User-defined groups for organizing recordings (e.g. by study, cohort or protocol). Click one to filter the list to just its members." style={{padding:"8px 10px",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",gap:8}}>
        {folderToggle}
        <span style={{flex:1,fontSize:9,fontWeight:700,color:"#666",letterSpacing:"0.1em"}}>COLLECTIONS</span>
        <button onClick={()=>setShowNew(p=>!p)} title="New collection"
          data-tut="New collection: Create a named group, then add recordings to it from each row's ⋮ actions menu." style={{
          background:"#111",border:"1px solid #222",color:"#7ec8d9",cursor:"pointer",padding:"2px 6px",fontSize:10,fontWeight:700}}>+
        </button>
      </div>
      {showNew && (
        <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",background:"#0c0c0c"}}>
          <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Collection name"
            style={{width:"100%",background:"#0a0a0a",border:"1px solid #2a2a2a",color:"#ddd",fontSize:11,padding:"4px 6px",outline:"none",fontFamily:"'IBM Plex Mono', monospace",marginBottom:4}}/>
          <input value={newDesc} onChange={e=>setNewDesc(e.target.value)} placeholder="Description (optional)"
            style={{width:"100%",background:"#0a0a0a",border:"1px solid #2a2a2a",color:"#ddd",fontSize:11,padding:"4px 6px",outline:"none",fontFamily:"'IBM Plex Mono', monospace",marginBottom:6}}/>
          <div style={{display:"flex",gap:4}}>
            <button onClick={()=>{setShowNew(false);setNewName("");setNewDesc("");}} style={{
              flex:1,background:"#111",border:"1px solid #222",color:"#888",fontSize:10,padding:"3px 6px",cursor:"pointer"}}>Cancel</button>
            <button onClick={()=>{if(newName.trim()){onCreateCollection({name:newName.trim(),description:newDesc.trim()});setShowNew(false);setNewName("");setNewDesc("");}}} disabled={!newName.trim()} style={{
              flex:1,background:newName.trim()?"#1a4a54":"#111",border:`1px solid ${newName.trim()?"#4a9bab":"#222"}`,color:newName.trim()?"#7ec8d9":"#444",fontSize:10,padding:"3px 6px",cursor:newName.trim()?"pointer":"default",fontWeight:700}}>Create</button>
          </div>
        </div>
      )}
      <div style={{overflowY:"auto",flex:1}}>
        <button onClick={()=>onSelect(null)} data-tut="All Recordings: Clears the collection filter and shows every recording in this tab." style={{
          width:"100%",textAlign:"left",padding:"8px 12px",background:selectedCollectionId===null?"#1a2a30":"transparent",
          border:"none",borderBottom:"1px solid #111",color:selectedCollectionId===null?"#7ec8d9":"#bbb",
          cursor:"pointer",fontSize:11,fontFamily:"'IBM Plex Mono', monospace",display:"flex",justifyContent:"space-between"}}>
          <span style={{fontWeight:selectedCollectionId===null?700:500}}>All Recordings</span>
          <span style={{color:"#555"}}>{totalCount}</span>
        </button>
        {(collections || []).map(col => {
          const count = recordsByCollection?.[col.id]?.length ?? 0;
          const active = selectedCollectionId === col.id;
          return (
            <div key={col.id} style={{display:"flex",alignItems:"center",background:active?"#1a2a30":"transparent",borderBottom:"1px solid #111"}}
              onMouseEnter={e=>{const x=e.currentTarget.querySelector('[data-del]');if(x)x.style.opacity='1';}}
              onMouseLeave={e=>{const x=e.currentTarget.querySelector('[data-del]');if(x)x.style.opacity='0';}}>
              <button onClick={()=>onSelect(col.id)} title={col.description || col.name}
                style={{
                  flex:1,textAlign:"left",padding:"8px 12px",background:"transparent",
                  border:"none",color:active?"#7ec8d9":"#bbb",
                  cursor:"pointer",fontSize:11,fontFamily:"'IBM Plex Mono', monospace",display:"flex",justifyContent:"space-between",alignItems:"center",minWidth:0}}>
                <span style={{fontWeight:active?700:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col.name}</span>
                <span style={{color:"#555",flexShrink:0,marginLeft:6}}>{count}</span>
              </button>
              {onDeleteCollection && (
                <button data-del onClick={(e)=>{e.stopPropagation();if(confirm(`Delete collection "${col.name}"? Records assigned to it will not be deleted.`))onDeleteCollection(col.id);}}
                  title="Delete collection"
                  style={{opacity:0,background:"transparent",border:"none",color:"#f87171",cursor:"pointer",padding:"4px 8px",fontSize:13,fontWeight:700,transition:"opacity 0.1s",flexShrink:0}}>×</button>
              )}
            </div>
          );
        })}
      </div>

      {showComplianceCriteria && (
        <div data-tut="Compliance criteria: The fixed checklist a recording must meet to be promotion-eligible in the repository. A recording is compliant when none of these fail (Unknown is allowed)."
          style={{borderTop:"1px solid #1a1a1a",background:"#080808",flexShrink:0,maxHeight:"42%",overflowY:"auto"}}>
          <div style={{padding:"8px 12px 4px",position:"sticky",top:0,background:"#080808"}}>
            <span style={{fontSize:9,fontWeight:700,color:"#4a9bab",letterSpacing:"0.1em"}}>COMPLIANCE CRITERIA</span>
          </div>
          <div style={{padding:"0 10px 10px"}}>
            {COMPLIANCE_CRITERIA.map(c => {
              // Drop the threshold text baked into the label (e.g. "Duration ≥ 5 min" → "Duration")
              // so the criterion name and its threshold stack cleanly without colliding.
              const name = c.label.replace(/\s*[≥≤].*$/, "").trim() || c.label;
              return (
                <div key={c.id} title={c.desc} style={{display:"flex",gap:6,padding:"4px 2px",borderBottom:"1px solid #0f0f0f"}}>
                  <span style={{color:"#3a6b75",fontSize:9,lineHeight:1.5,flexShrink:0}}>▸</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:10,color:"#bbb",lineHeight:1.3,wordBreak:"break-word"}}>{name}</div>
                    <div style={{fontSize:9,color:"#5a8b95",fontFamily:"'IBM Plex Mono', monospace",lineHeight:1.3,wordBreak:"break-word"}}>{c.threshold}</div>
                  </div>
                </div>
              );
            })}
            <div style={{fontSize:8,color:"#444",lineHeight:1.4,marginTop:6}}>
              Promotion-eligible when no criterion fails. “Unknown” (e.g. impedance not stored) does not block.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AddToCollectionMenu — small popover used by RecordActions ──
function AddToCollectionMenu({ record, collections, onToggle, onClose }) {
  return (
    <div style={{position:"absolute",right:0,top:"100%",marginTop:4,
      width:220,background:"#111",border:"1px solid #2a2a2a",borderRadius:0,zIndex:50,overflow:"hidden"}}>
      <div style={{padding:"6px 10px",borderBottom:"1px solid #1a1a1a",fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em"}}>ADD TO COLLECTION</div>
      <div style={{maxHeight:240,overflowY:"auto"}}>
        {(collections || []).map(col => {
          const inCol = (record.collectionIds || []).includes(col.id);
          return (
            <button key={col.id} onClick={(e)=>{e.stopPropagation();onToggle(col.id);}}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 12px",background:"transparent",border:"none",
                borderBottom:"1px solid #0a0a0a",color:inCol?"#7ec8d9":"#bbb",fontSize:11,cursor:"pointer",textAlign:"left",
                fontFamily:"'IBM Plex Mono', monospace"}}
              onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <span style={{width:14,height:14,border:`1px solid ${inCol?"#4a9bab":"#333"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:inCol?"#7ec8d9":"transparent",flexShrink:0}}>✓</span>
              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col.name}</span>
            </button>
          );
        })}
      </div>
      <div style={{padding:"6px 10px",borderTop:"1px solid #1a1a1a",textAlign:"right"}}>
        <button onClick={onClose} style={{background:"#111",border:"1px solid #222",color:"#888",cursor:"pointer",padding:"3px 10px",fontSize:10}}>Done</button>
      </div>
    </div>
  );
}

function LibraryTab({ onOpenTimeline, selectedCollectionId, setSelectedCollectionId }) {
  // App-global atoms from context; aliased to the on*-style names this component's body uses.
  const { records, setRecords, updateRecordStatus, edfFileStore, setEdfFileStore,
    setAnnotationsMap, setClinicalNotesMap, setBaselineMap, collections, setCollections,
    openReview: onOpenReview, promoteRecord: onPromoteRecord, demoteRecord: onDemoteRecord } = useAppStore();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [viewMode, setViewMode] = useState("table");
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [sortField, setSortField] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  // selectedCollectionId is lifted to the app root so the open folder is remembered
  // across tab switches (Review → Library returns to the same collection).
  const [packageImportResult, setPackageImportResult] = useState(null); // {manifest, imports, error}
  const pkgFileInputRef = useRef(null);
  const importDialogRef = useRef(null);
  const pkgResultDialogRef = useRef(null);
  useFocusTrap(importDialogRef, showImport, () => setShowImport(false));
  useFocusTrap(pkgResultDialogRef, !!packageImportResult, () => setPackageImportResult(null));

  const handlePackageImport = async (file) => {
    if (!file) return;
    const result = await parsePatientPackageZip(file);
    if (result.error) { setPackageImportResult({ error: result.error }); return; }
    // For each imported file: persist EDF, add to edfFileStore, build a library record, merge annotations + notes
    const newRecords = [];
    for (const imp of result.imports) {
      const parsed = parseEDFFile(imp.edfArrayBuffer);
      if (!parsed || parsed.error) continue;
      await saveEdfToDB(imp.filename, imp.edfArrayBuffer);
      setEdfFileStore(prev => ({ ...prev, [imp.filename]: parsed }));
      // Annotations: package-supplied annotations win; otherwise fall back to
      // EDF+ TAL annotations parsed from the file itself.
      if (imp.annotations.length > 0 && setAnnotationsMap) {
        setAnnotationsMap(prev => ({ ...prev, [imp.filename]: imp.annotations }));
      } else if (parsed.edfAnnotations?.length > 0 && setAnnotationsMap) {
        const converted = parsed.edfAnnotations.map((a, idx) => ({
          id: `EDF-PKG-${Date.now()}-${idx}`, time: a.time, duration: a.duration,
          type: a.text || "EDF Event", color: EDF_EVENT_COLOR, text: a.text, channel: -1, source: "edf",
        }));
        setAnnotationsMap(prev => ({ ...prev, [imp.filename]: converted }));
      }
      if (imp.notes && setClinicalNotesMap) {
        setClinicalNotesMap(prev => ({ ...prev, [imp.filename]: imp.notes }));
      }
      const meta = imp.metadata || {};
      newRecords.push({
        id: `PKG-${Date.now()}-${newRecords.length}`,
        subjectHash: result.manifest.subjectHash,
        subjectId: result.manifest.subjectHash, // hash-only — original subjectId not in package
        sport: "", position: "",
        studyType: meta.studyType || "BL",
        date: meta.date || new Date().toISOString().split("T")[0],
        filename: imp.filename,
        channels: meta.channels || parsed.numSignals, duration: meta.duration || Math.round(parsed.totalDuration / 60),
        durationSec: meta.durationSec || parsed.totalDuration, sampleRate: meta.sampleRate || parsed.sampleRate,
        fileSize: meta.fileSize || Math.round(imp.edfArrayBuffer.byteLength / 1024 / 1024 * 10) / 10,
        sex: meta.sex || "", age: meta.age ?? null,
        montage: detectEdfSystem(parsed) || "10-20", status: "pending",
        isTest: false, isImportedPackage: true, fileType: "imported-package",
        hasEdfData: true,
        notes: `Imported from patient package on ${new Date().toISOString().split("T")[0]}`,
        uploadedAt: new Date().toISOString(),
        pipelineVersion: meta.pipelineVersion || PIPELINE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        processingLog: [],
        repositoryStatus: "library",
        collectionIds: [],
        complianceResult: null,
      });
    }
    if (newRecords.length > 0) setRecords(prev => [...newRecords, ...prev]);
    setPackageImportResult({ manifest: result.manifest, imports: result.imports, imported: newRecords.length });
  };

  // Compute records-per-collection map for sidebar counts
  const recordsByCollection = useMemo(() => {
    const map = {};
    (collections || []).forEach(c => { map[c.id] = []; });
    records.forEach(r => {
      (r.collectionIds || []).forEach(cid => {
        if (!map[cid]) map[cid] = [];
        map[cid].push(r);
      });
    });
    return map;
  }, [records, collections]);

  // Compliance is computed lazily per record on first render — cached on the record after.
  // We trigger the compute via setRecords in an effect to avoid mutating during render.
  useEffect(() => {
    const needs = records.filter(r => r.complianceResult === null || r.complianceResult === undefined);
    if (needs.length === 0) return;
    const updates = new Map();
    needs.forEach(r => {
      const edf = edfFileStore?.[r.filename];
      updates.set(r.id, checkProtocolCompliance(r, edf || null));
    });
    setRecords(prev => prev.map(r => updates.has(r.id) ? { ...r, complianceResult: updates.get(r.id) } : r));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length, Object.keys(edfFileStore || {}).length]);

  // Toggle a record's membership in a given collection
  const toggleRecordInCollection = (recordId, collectionId) => {
    setRecords(prev => prev.map(r => {
      if (r.id !== recordId) return r;
      const ids = new Set(r.collectionIds || []);
      if (ids.has(collectionId)) ids.delete(collectionId); else ids.add(collectionId);
      return { ...r, collectionIds: [...ids] };
    }));
  };
  const handleCreateCollection = ({ name, description }) => {
    const id = `col-${Date.now().toString(36)}`;
    setCollections(prev => [...prev, {
      id, name, description, purpose: "user", protocolVersion: PIPELINE_VERSION,
      targetSubjectCount: 0, dateRange: { start: null, end: null }, filenames: [],
      schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), isSeed: false,
    }]);
  };
  const handleDeleteCollection = (collectionId) => {
    setCollections(prev => prev.filter(c => c.id !== collectionId));
    // Also drop the membership reference on any records that were in this collection
    setRecords(prev => prev.map(r => (r.collectionIds || []).includes(collectionId)
      ? { ...r, collectionIds: r.collectionIds.filter(id => id !== collectionId) }
      : r));
    if (selectedCollectionId === collectionId) setSelectedCollectionId(null);
  };

  const filtered = records.filter(r => {
    if (filterType !== "ALL" && r.studyType !== filterType) return false;
    if (filterStatus !== "ALL" && r.status !== filterStatus) return false;
    if (selectedCollectionId !== null && !(r.collectionIds || []).includes(selectedCollectionId)) return false;
    if (search) { const s = search.toLowerCase();
      return r.filename.toLowerCase().includes(s) || r.subjectHash.toLowerCase().includes(s)
        || r.sport.toLowerCase().includes(s) || r.position.toLowerCase().includes(s); }
    return true;
  }).sort((a, b) => {
    const d = sortDir === "asc" ? 1 : -1;
    if (sortField === "date") return d * a.date.localeCompare(b.date);
    if (sortField === "fileSize") return d * (a.fileSize - b.fileSize);
    if (sortField === "studyType") return d * a.studyType.localeCompare(b.studyType);
    return 0;
  });

  const stats = {
    total: records.length, verified: records.filter(r=>r.status==="verified").length,
    subjects: new Set(records.map(r=>r.subjectHash)).size,
    totalSize: Math.round(records.reduce((s,r)=>s+r.fileSize,0)*10)/10,
  };
  const handleIngest = (nr) => setRecords([nr, ...records]);
  const deleteRecord = (id) => setRecords(records.filter(r => r.id !== id));
  const toggleSort = (f) => { if (sortField===f) setSortDir(sortDir==="asc"?"desc":"asc"); else { setSortField(f); setSortDir("desc"); } };

  const inputStyle = {
    width:"100%",padding:"8px 10px",background:"#0d0d0d",border:"1px solid #2a2a2a",
    borderRadius:0,color:"#e0e0e0",fontSize:13,fontFamily:"'IBM Plex Mono', monospace",outline:"none",boxSizing:"border-box",
  };
  const formLabel = {display:"block",fontSize:11,color:"#777",marginBottom:4,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"};

  return (
    <div style={{display:"flex",flex:1,overflow:"hidden"}}>
      <CollectionsSidebar collections={collections} selectedCollectionId={selectedCollectionId}
        onSelect={setSelectedCollectionId} recordsByCollection={recordsByCollection}
        totalRecordCount={records.length}
        onCreateCollection={handleCreateCollection}
        onDeleteCollection={handleDeleteCollection}
        showComplianceCriteria/>
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden",minWidth:0}}>
      {/* Stats — 4-card grid, slightly tighter than the original */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:1,background:"#1a1a1a",borderBottom:"1px solid #1a1a1a",flexShrink:0}}>
        {[
          {label:"TOTAL RECORDS",value:stats.total,icon:I.Database()},
          {label:"VERIFIED",value:stats.verified,icon:I.Check()},
          {label:"UNIQUE SUBJECTS",value:stats.subjects,icon:I.Shield()},
          {label:"STORAGE",value:`${stats.totalSize} MB`,icon:I.Zap()},
        ].map((s,i)=>(
          <div key={i} style={{background:"#0a0a0a",padding:"12px 20px"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,color:"#555",fontSize:10,fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>{s.icon} {s.label}</div>
            <div style={{fontSize:18,fontWeight:800,color:"#e0e0e0",fontFamily:"'JetBrains Mono', monospace"}}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Controls — two visual groups (find on left, act on right) separated by flex:1 */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 24px",
        borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexWrap:"wrap",flexShrink:0}}>
        {/* Left group: find */}
        <div data-tut="Search: Filters the list as you type — matches filename, de-identified subject hash, sport and position." style={{display:"flex",alignItems:"center",gap:8,background:"#0a0a0a",border:"1px solid #2a2a2a",padding:"0 12px",width:360,maxWidth:"40vw"}}>
          {I.Search(14)}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search filename, hash, sport, position…"
            style={{background:"none",border:"none",color:"#e0e0e0",fontSize:12,padding:"8px 0",outline:"none",width:"100%",fontFamily:"'IBM Plex Mono', monospace"}}/>
        </div>
        <select value={filterType} onChange={e=>setFilterType(e.target.value)} title="Filter by study type"
          data-tut="Type filter: Narrows the list to one study type — Baseline, Post-Injury, Follow-Up, Routine or Long-Term."
          style={{...selectStyle, padding:"7px 10px"}}>
          <option value="ALL">All Types</option>
          {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} title="Filter by status"
          data-tut="Status filter: Shows only records in a given review state — Verified, Pending or Flagged."
          style={{...selectStyle, padding:"7px 10px"}}>
          <option value="ALL">All Status</option>
          <option value="verified">Verified</option><option value="pending">Pending</option><option value="flagged">Flagged</option>
        </select>
        <div data-tut="View toggle: Switch between a dense table layout and a card grid for browsing recordings." style={{display:"flex",background:"#0a0a0a",border:"1px solid #2a2a2a",overflow:"hidden"}}>
          {["table","grid"].map(m=>(
            <button key={m} onClick={()=>setViewMode(m)} title={m === "table" ? "Table view" : "Grid view"} style={{
              padding:"6px 10px",background:viewMode===m?"#1a2a30":"transparent",
              border:"none",color:viewMode===m?"#7ec8d9":"#555",cursor:"pointer",display:"flex",alignItems:"center"
            }}>{m==="table"?I.List(14):I.Grid(14)}</button>
          ))}
        </div>
        <span style={{color:"#666",fontSize:11,fontFamily:"'JetBrains Mono', monospace",letterSpacing:"0.05em"}}>{filtered.length} record{filtered.length !== 1 ? "s" : ""}</span>

        {/* Spacer — separates find (left) from act (right) */}
        <span style={{flex:1}}/>

        {/* Right group: act */}
        <button data-tut="Import: Bring in a single EDF/EDF+ recording. De-identifies the file, detects channels/rate/duration, and adds it to the library." onClick={()=>setShowImport(true)} style={{
          padding:"7px 16px",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,
          color:"#7ec8d9",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:6,letterSpacing:"0.05em"
        }}>{I.Plus(13)} IMPORT</button>
        <button onClick={()=>pkgFileInputRef.current?.click()} title="Import a REACT EEG patient package (.zip)"
          data-tut="Package: Import a REACT EEG patient package (.zip) — a bundle of one subject's recordings plus annotations and notes exported from another machine."
          style={{
            padding:"7px 16px",background:"#0a2a18",border:"1px solid #15532a",borderRadius:0,
            color:"#10b981",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:6,letterSpacing:"0.05em"
          }}>{I.Package(13)} PACKAGE</button>
        <input ref={pkgFileInputRef} type="file" accept=".zip,application/zip" style={{display:"none"}}
          onChange={(e)=>{const f = e.target.files?.[0]; if (f) handlePackageImport(f); e.target.value = "";}}/>
        <button data-tut="Export: Select recordings or whole subjects and export them as a metadata manifest with bundled EDF data for sharing or backup." onClick={()=>setShowExport(true)} style={{
          padding:"7px 16px",background:"#111",border:"1px solid #3B82F640",borderRadius:0,
          color:"#3B82F6",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:6,letterSpacing:"0.05em"
        }}>{I.Package(13)} EXPORT</button>
      </div>

      {/* Filename-convention reference — a quiet, centered background note so users
          can decode the de-identified naming scheme at a glance. Muted monochrome
          (deliberately recessive); each segment keeps a hover tooltip. */}
      <div data-tut="File naming: Every imported recording is renamed to a PHI-free convention — SUBJECT-SEX/AGE-TYPE-HASH-DATE-SEQ.edf. This strip decodes each segment for reference."
        style={{borderBottom:"1px solid #121212",background:"#080808",flexShrink:0}}>
        <div style={{margin:"0 auto",padding:"7px 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,flexWrap:"wrap"}}>
            <span style={{fontSize:8,fontWeight:700,letterSpacing:"0.22em",color:"#3f3f3f"}}>FILE NAMING</span>
            <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,whiteSpace:"nowrap",letterSpacing:"0.04em"}}>
              {[
                {t:"SUBJECT", tip:"Source acronym — where the recording came from (e.g. PHY for PhysioNet). The per-subject number is dropped; the HASH below is what uniquely identifies the subject."},
                {t:"SEX/AGE", tip:"Sex (M/F/X) + age in years, when provided (e.g. X or M34)"},
                {t:"TYPE",    tip:"Study type code — BL Baseline, PI Post-Injury, FU Follow-Up, RT Routine, LT Long-Term"},
                {t:"HASH",    tip:"De-identified subject hash — derived from the full subject ID, so the same subject always hashes the same. This is the actual subject identifier."},
                {t:"DATE",    tip:"Recording date in YYYYMMDD"},
                {t:"SEQ",     tip:"Zero-padded sequence number for multiple files on the same day (001, 002…)"},
              ].map((s,i)=>(
                <span key={s.t}>
                  {i>0 && <span style={{color:"#2e2e2e",margin:"0 7px"}}>-</span>}
                  <span title={s.tip} style={{color:"#6a6a6a",fontWeight:600,cursor:"help"}}>{s.t}</span>
                </span>
              ))}
              <span style={{color:"#444",marginLeft:7}}>.edf</span>
            </span>
          </div>
          <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:9,color:"#3a3a3a",letterSpacing:"0.06em"}}>
            PHY-X-BL-A9024A-20251012-001.edf
          </span>
        </div>
      </div>

      {/* Table — centered with max-width so it doesn't sprawl on ultrawide monitors */}
      <div style={{flex:1,overflow:"auto"}}>
       <div style={{padding:"0 12px"}}>
        {/* Responsive column visibility: drop the least-pertinent columns first as
            the window narrows, so the core (file/subject/type/status/compliance)
            always stays readable. Breakpoints account for the 200px collections rail. */}
        <style>{`
          @media (max-width: 1500px) { .lib-c-md { display: none; } }
          @media (max-width: 1250px) { .lib-c-sm { display: none; } }
          /* Center every field in its column so the data reads as evenly-spaced columns
             rather than being crammed against the right edge. */
          .lib-table th, .lib-table td { text-align: center; }
          .lib-table td > div { justify-content: center; }
        `}</style>
        {viewMode==="table" ? (
          <table className="lib-table" style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead>
              {/* Tier-1 super-header — groups columns by provenance. The six filename-derived
                  segments sit together under one banner so the SUBJECT-SEX/AGE-TYPE-HASH-DATE-SEQ
                  convention reads at a glance. Each group cell carries the same responsive-hide
                  class as its child columns, so both header rows stay column-aligned as columns
                  drop on narrow viewports. Spans sum to the 15 tier-2 columns. */}
              <tr style={{borderBottom:"1px solid #141414"}}>
                {[
                  {label:"",span:2},
                  {label:"DECODED FROM FILENAME",span:4,accent:true},
                  {label:"STUDY",span:1},
                  {label:"ACQUISITION",span:2,cls:"lib-c-md"},
                  {label:"",span:1,cls:"lib-c-sm"},
                  {label:"REVIEW",span:2},
                  {label:"",span:1},
                ].map((g,i)=>(
                  <th key={i} colSpan={g.span} className={g.cls} style={{
                    textAlign:"center",padding:"8px 16px 3px",fontSize:9,fontWeight:700,letterSpacing:"0.16em",
                    color:g.accent?"#4a9bab":"#3a3a3a",borderLeft:i>0&&i<5?"1px solid #161616":"none",whiteSpace:"nowrap",
                  }}>{g.label}</th>
                ))}
              </tr>
              <tr style={{borderBottom:"1px solid #1a1a1a"}}>
              {[
                {key:null,label:"",w:"4%"},
                {key:"filename",label:"FILE",sort:true,w:"17%"},
                {key:null,label:"SUBJECT",w:"8%"},
                {key:null,label:"SEQ",w:"5%"},
                {key:null,label:"SEX/AGE",w:"6%"},
                {key:null,label:"DATE",w:"7%"},
                {key:"studyType",label:"TYPE",sort:true,w:"8%"},
                {key:null,label:"RATE",w:"7%",cls:"lib-c-md"},
                {key:null,label:"SYSTEM",w:"7%",cls:"lib-c-md"},
                {key:null,label:"COLLECTIONS",w:"9%",cls:"lib-c-sm"},
                {key:null,label:"STATUS",w:"6%"},
                {key:null,label:"COMPLIANCE",w:"9%"},
                {key:null,label:"",w:"5%"},
              ].map((col,i)=>(
                // Proportional column widths (summing ~100%) so the columns spread evenly across
                // the full table width instead of FILE grabbing all the slack and crowding the
                // rest against the right edge. Auto table-layout still grows a column if its
                // content needs more, so buttons never clip.
                <th key={i} className={col.cls} onClick={()=>col.sort&&toggleSort(col.key === "filename" ? "date" : col.key)} style={{
                  textAlign:"center",padding:"8px 16px",color:"#555",fontSize:10,fontWeight:700,
                  letterSpacing:"0.1em",cursor:col.sort?"pointer":"default",userSelect:"none",
                  width:col.w,whiteSpace:"nowrap",
                }}>{col.label}{col.sort&&((col.key === "filename" && sortField === "date") || sortField===col.key)&&<span style={{marginLeft:4}}>{sortDir==="asc"?"▲":"▼"}</span>}</th>
              ))}
            </tr></thead>
            <tbody>{filtered.map(r=>{
              const st=STUDY_TYPES[r.studyType]||{label:"?",color:"#666"};
              const dotColor = !edfFileStore?.[r.filename] && r.fileType!=="simulated"&&!r.isSimulated ? "#ef4444" : r.isTest ? "#3b82f6" : r.isAcquired ? "#22c55e" : "#eab308";
              const dotTitle = !edfFileStore?.[r.filename] && r.fileType!=="simulated"&&!r.isSimulated ? "No EDF data" : r.isTest ? "Test" : r.isAcquired ? "Recorded" : "Imported";
              const durStr = r.durationSec && r.durationSec < 60 ? `${r.durationSec}s` : `${r.duration}m`;
              const dec = decodeReactFilename(r);
              return (
                <tr key={r.id} style={{borderBottom:"1px solid #141414",cursor:"pointer",transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#0f0f0f"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  {/* Far left: REVIEW button — right-aligned and snug so it sits next to the filename */}
                  <td style={{padding:"10px 8px 10px 16px",verticalAlign:"middle",textAlign:"right"}}>
                    <button data-tut="Review: Opens this recording in the waveform viewer to scroll, filter, annotate and analyze it." onClick={(e)=>{e.stopPropagation();onOpenReview(r);}} style={{
                      padding:"6px 14px",background:"#111",border:"1px solid #222",borderRadius:0,
                      color:"#7ec8d9",fontSize:11,fontWeight:700,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5
                    }}>{I.Eye(13)} REVIEW</button>
                  </td>
                  {/* FILE: single line — status dot + filename. Channel count / duration / size moved
                      to the hover tooltip so every row stays one line tall. */}
                  <td data-tut="File: The de-identified filename. The colored dot shows data status — green recorded, yellow imported, blue test, red no EDF data. Hover the name for channels, duration and size." style={{padding:"10px 16px 10px 4px",verticalAlign:"middle",textAlign:"left"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"flex-start"}}>
                      <span title={dotTitle} style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:dotColor,flexShrink:0}}/>
                      <span title={`${r.filename}  —  ${r.channels}ch · ${durStr} · ${r.fileSize}MB`} style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:13,color:"#ddd",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:200}}>{r.filename}</span>
                    </div>
                  </td>
                  {/* SUBJECT — source acronym only (provenance). The per-subject number is dropped
                      from the filename; the HASH (in the filename) is what uniquely identifies a subject. */}
                  <td data-tut="Subject: The source acronym — where the recording came from (e.g. PHY for PhysioNet). The per-subject number is dropped from the filename because the 6-character HASH already uniquely and deterministically identifies the subject (same subject → same hash). Recordings sharing a hash are the same patient." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span title={`Source: ${dec.source} · Subject hash: ${r.subjectHash || "—"}`} style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:"#aaa",letterSpacing:"0.02em",whiteSpace:"nowrap"}}>{dec.source}</span>
                  </td>
                  {/* SEQ — same-day sequence number (filename segment) */}
                  <td data-tut="Seq: Zero-padded sequence number distinguishing multiple recordings made on the same day (001, 002…)." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:dec.seq!=="—"?"#999":"#555",whiteSpace:"nowrap"}}>{dec.seq}</span>
                  </td>
                  {/* SEX/AGE — research covariates (not PHI). "—" = not recorded; M=Male, F=Female, X=Other. */}
                  <td data-tut="Sex / Age: Patient sex (M=Male, F=Female, X=Other) and age in years. Shows — when not recorded. De-identified research covariates, not identifying info." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span title={`Sex: ${r.sex==="M"?"Male":r.sex==="F"?"Female":r.sex==="X"?"Other":"not recorded"} · Age: ${r.age!=null?r.age:"not recorded"}`}
                      style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:(r.sex||r.age!=null)?"#999":"#555",whiteSpace:"nowrap"}}>{r.sex || "—"}{r.age != null ? ` / ${r.age}` : ""}</span>
                  </td>
                  {/* DATE — recording date (filename segment, YYYY-MM-DD) */}
                  <td data-tut="Date: The recording date, decoded from the filename (YYYY-MM-DD)." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:dec.date!=="—"?"#999":"#555",whiteSpace:"nowrap"}}>{dec.date}</span>
                  </td>
                  {/* TYPE — study-type code (filename segment) */}
                  <td data-tut="Type: The study type of this recording — Baseline, Post-Injury, Follow-Up, Routine or Long-Term." style={{padding:"10px 16px",verticalAlign:"middle"}}><TypeBadge record={r}/></td>
                  {/* Sample rate */}
                  <td className="lib-c-md" data-tut="Rate: The recording's sample rate in Hz." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:r.sampleRate?"#999":"#555",whiteSpace:"nowrap"}}>{r.sampleRate ? `${r.sampleRate} Hz` : "—"}</span>
                  </td>
                  {/* Electrode system */}
                  <td className="lib-c-md" data-tut="System: The electrode-placement system the recording uses (10-20, 10-10, high-density)." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <span style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:r.montage?"#999":"#555"}}>{r.montage || "—"}</span>
                  </td>
                  {/* Collections — chips matching the Repository tab's treatment */}
                  <td className="lib-c-sm" data-tut="Collections: Named groups this recording belongs to. Add a recording to a collection from its ⋮ actions menu." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    {(() => {
                      const cols = (r.collectionIds || []).map(cid => (collections||[]).find(c => c.id === cid)).filter(Boolean);
                      if (cols.length === 0) return <span style={{color:"#444",fontSize:11,fontStyle:"italic"}}>—</span>;
                      return (
                        <div style={{display:"flex",flexWrap:"wrap",gap:4,maxWidth:200}}>
                          {cols.map(c => (
                            <span key={c.id} title={c.description || c.name} style={{padding:"2px 6px",background:"#0c1f24",border:"1px solid #1a3a40",color:"#7ec8d9",fontSize:10,fontWeight:600,whiteSpace:"nowrap"}}>{c.name}</span>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                  {/* Status */}
                  <td data-tut="Status: The review state — click to cycle Pending → Verified → Flagged. Verified means a reviewer has signed off on the recording." style={{padding:"10px 16px",verticalAlign:"middle"}}><StatusControl status={r.status} size="compact" onSetStatus={(s)=>updateRecordStatus(r.id,s)}/></td>
                  {/* Compliance + Promote — kept on a single horizontal line (no wrap) */}
                  <td data-tut="Compliance & Promote: The badge shows whether the recording passes protocol checks; click it to re-run them. PROMOTE moves a passing recording into the Repository." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <div style={{display:"inline-flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}>
                      <ComplianceBadge result={r.complianceResult}
                        onRecompute={()=>setRecords(prev => prev.map(x => x.id===r.id ? {...x, complianceResult: checkProtocolCompliance(x, edfFileStore?.[x.filename] || null)} : x))}/>
                      {r.repositoryStatus !== "promoted" && (
                        <button onClick={(e)=>{e.stopPropagation();onPromoteRecord && onPromoteRecord(r);}}
                          title={r.complianceResult?.compliant ? "Promote to Repository" : "Compliance must pass before promotion"}
                          style={{
                            padding:"4px 10px",
                            background: r.complianceResult?.compliant ? "#0a2a18" : "#111",
                            border: `1px solid ${r.complianceResult?.compliant ? "#15532a" : "#222"}`,
                            borderRadius:0,
                            color: r.complianceResult?.compliant ? "#10b981" : "#444",
                            fontSize:10,fontWeight:700,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:4}}>
                          ↑ PROMOTE
                        </button>
                      )}
                      {r.repositoryStatus === "promoted" && (
                        <button onClick={(e)=>{e.stopPropagation();onDemoteRecord && onDemoteRecord(r);}}
                          title="Click to demote from Repository back to Library"
                          style={{padding:"4px 10px",background:"#0a2a18",border:"1px solid #15532a",borderRadius:0,
                            color:"#10b981",fontSize:10,fontWeight:700,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:4,
                            transition:"background 0.1s"}}
                          onMouseEnter={e=>{e.currentTarget.style.background="#15532a";e.currentTarget.style.color="#bbb";e.currentTarget.firstChild && (e.currentTarget.firstChild.nodeValue="↓ DEMOTE");}}
                          onMouseLeave={e=>{e.currentTarget.style.background="#0a2a18";e.currentTarget.style.color="#10b981";e.currentTarget.firstChild && (e.currentTarget.firstChild.nodeValue="★ REPO");}}>
                          ★ REPO
                        </button>
                      )}
                    </div>
                  </td>
                  {/* Actions menu */}
                  <td data-tut="Actions: Per-recording menu (⋮) — add to a collection, open the subject timeline, or delete the recording." style={{padding:"10px 16px",verticalAlign:"middle"}}>
                    <RecordActions record={r} onDelete={deleteRecord} onOpenReview={onOpenReview}
                      collections={collections} onToggleCollection={(cid)=>toggleRecordInCollection(r.id, cid)}
                      onOpenTimeline={onOpenTimeline}/>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,padding:"20px 28px"}}>
            {filtered.map(r=>{
              const st=STUDY_TYPES[r.studyType]||{label:"?",color:"#666"};
              const dotColor = !edfFileStore?.[r.filename] && r.fileType!=="simulated"&&!r.isSimulated ? "#ef4444" : r.isTest ? "#3b82f6" : r.isAcquired ? "#22c55e" : "#eab308";
              const dotTitle = !edfFileStore?.[r.filename] && r.fileType!=="simulated"&&!r.isSimulated ? "No EDF data" : r.isTest ? "Test" : r.isAcquired ? "Recorded" : "Imported";
              return (
                <div key={r.id} style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:0,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#333"} onMouseLeave={e=>e.currentTarget.style.borderColor="#1a1a1a"}
                  onClick={()=>onOpenReview(r)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span title={dotTitle} style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:dotColor,flexShrink:0}}/>
                      <TypeBadge record={r}/>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <StatusControl status={r.status} size="compact" onSetStatus={(s)=>updateRecordStatus(r.id,s)}/>
                      <RecordActions record={r} onDelete={deleteRecord} onOpenReview={onOpenReview}/>
                    </div>
                  </div>
                  <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:"#7ec8d9",marginBottom:10,wordBreak:"break-all"}}>{r.filename}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px",fontSize:11}}>
                    <span style={{color:"#555"}}>Date</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.date}</span>
                    <span style={{color:"#555"}}>Ch</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.channels}</span>
                    <span style={{color:"#555"}}>Rate</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.sampleRate}Hz</span>
                    <span style={{color:"#555"}}>Size</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.fileSize}MB</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {filtered.length===0&&<div style={{textAlign:"center",padding:"60px 20px",color:"#444",fontSize:14}}>No records match your filters.</div>}
       </div>
      </div>

      {/* Import Modal */}
      {showImport && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowImport(false)}>
          <div ref={importDialogRef} role="dialog" aria-modal="true" aria-label="Import recording" onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:28,width:780,maxWidth:"calc(100vw - 48px)",maxHeight:"85vh",overflow:"auto"}}>
            <IngestForm onClose={()=>setShowImport(false)} onIngest={handleIngest} setEdfFileStore={setEdfFileStore} setAnnotationsMap={setAnnotationsMap} setClinicalNotesMap={setClinicalNotesMap} setBaselineMap={setBaselineMap}/>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExport && (
        <ExportModal records={records} onClose={()=>setShowExport(false)}/>
      )}

      {/* Patient-package import result */}
      {packageImportResult && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}
          onClick={()=>setPackageImportResult(null)}>
          <div ref={pkgResultDialogRef} role="dialog" aria-modal="true" aria-label={packageImportResult.error ? "Package import failed" : "Patient package imported"} onClick={e=>e.stopPropagation()} style={{background:"#0c0c0c",border:`1px solid ${packageImportResult.error?"#991b1b":"#15532a"}`,borderRadius:0,padding:"20px 24px",width:520,maxHeight:"80vh",overflow:"auto",fontFamily:"'IBM Plex Mono', monospace"}}>
            {packageImportResult.error ? (
              <>
                <div style={{color:"#f87171",fontSize:13,fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>{I.Alert(14)} PACKAGE IMPORT FAILED</div>
                <div style={{fontSize:11,color:"#aaa",marginBottom:14}}>{packageImportResult.error}</div>
              </>
            ) : (
              <>
                <div style={{color:"#10b981",fontSize:13,fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>{I.Check(14)} PATIENT PACKAGE IMPORTED</div>
                <div style={{fontSize:11,color:"#bbb",marginBottom:14,lineHeight:1.6}}>
                  Subject hash: <span style={{color:"#7ec8d9"}}>{packageImportResult.manifest.subjectHash}</span><br/>
                  Bundled: <span style={{color:"#888"}}>{packageImportResult.manifest.bundledAt?.split("T")[0]}</span> ·
                  pipeline <span style={{color:"#888"}}>{packageImportResult.manifest.pipelineVersion}</span><br/>
                  Imported <span style={{color:"#10b981",fontWeight:700}}>{packageImportResult.imported}</span> of {packageImportResult.manifest.fileCount} recordings into the Library.
                </div>
              </>
            )}
            <div style={{textAlign:"right"}}>
              <button onClick={()=>setPackageImportResult(null)} style={{background:"#111",border:"1px solid #333",color:"#888",cursor:"pointer",padding:"6px 18px",fontSize:11,fontWeight:700}}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Panel */}
      {selectedRecord && (
        <div style={{position:"fixed",right:0,top:0,bottom:0,width:400,background:"#0d0d0d",borderLeft:"1px solid #2a2a2a",zIndex:999,overflow:"auto",padding:24}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
            <span style={{color:"#888",fontSize:12,fontWeight:600}}>RECORD DETAIL</span>
            <button onClick={()=>setSelectedRecord(null)} style={{background:"none",border:"none",color:"#666",cursor:"pointer"}}>{I.X()}</button>
          </div>
          <div style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:16,fontFamily:"'IBM Plex Mono', monospace",fontSize:13,color:"#7ec8d9",wordBreak:"break-all",marginBottom:20}}>
            <span style={{color:"#555",fontSize:10,display:"block",marginBottom:4}}>FILENAME</span>{selectedRecord.filename}
          </div>
          <button onClick={()=>{onOpenReview(selectedRecord);setSelectedRecord(null);}} style={{
            width:"100%",padding:"10px 0",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,color:"#7ec8d9",
            cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:12
          }}>{I.Eye()} Open in Review</button>
        </div>
      )}
    </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TAB: REPOSITORY — read-only view of compliance-passed recordings
// ══════════════════════════════════════════════════════════════
function RepositoryTab() {
  // App-global atoms from context; aliased to the on*-style names this component's body uses.
  const { records, setRecords, edfFileStore, collections, setCollections, annotationsMap,
    clinicalNotesMap, openReview: onOpenReview, demoteRecord: onDemoteRecord } = useAppStore();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [licenseTarget, setLicenseTarget] = useState(null);
  const [bundling, setBundling] = useState(null); // subjectHash currently being bundled
  const licenseDialogRef = useRef(null);
  useFocusTrap(licenseDialogRef, !!licenseTarget, () => setLicenseTarget(null));

  const handleBundleSubject = async (subjectHash) => {
    setBundling(subjectHash);
    try {
      const result = await buildPatientPackageZip({ subjectHash, records, annotationsMap, clinicalNotesMap });
      if (result.error) { notify("Bundle failed: " + result.error, "error"); return; }
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `REACT-Patient-${subjectHash}-${new Date().toISOString().split("T")[0]}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally { setBundling(null); }
  };

  // Promoted records only — Library handles the unpromoted set
  const repoRecords = records.filter(r => r.repositoryStatus === "promoted");

  const recordsByCollection = useMemo(() => {
    const map = {};
    (collections || []).forEach(c => { map[c.id] = []; });
    repoRecords.forEach(r => {
      (r.collectionIds || []).forEach(cid => {
        if (!map[cid]) map[cid] = [];
        map[cid].push(r);
      });
    });
    return map;
  }, [repoRecords, collections]);

  const filtered = repoRecords.filter(r => {
    if (filterType !== "ALL" && r.studyType !== filterType) return false;
    if (selectedCollectionId !== null && !(r.collectionIds || []).includes(selectedCollectionId)) return false;
    if (search) { const s = search.toLowerCase();
      return r.filename.toLowerCase().includes(s) || r.subjectHash.toLowerCase().includes(s); }
    return true;
  }).sort((a, b) => (b.repositoryPromotedAt || b.date).localeCompare(a.repositoryPromotedAt || a.date));

  const handleCreateCollection = ({ name, description }) => {
    const id = `col-${Date.now().toString(36)}`;
    setCollections(prev => [...prev, {
      id, name, description, purpose: "user", protocolVersion: PIPELINE_VERSION,
      targetSubjectCount: 0, dateRange: { start: null, end: null }, filenames: [],
      schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString(), isSeed: false,
    }]);
  };
  const handleDeleteCollection = (collectionId) => {
    setCollections(prev => prev.filter(c => c.id !== collectionId));
    setRecords(prev => prev.map(r => (r.collectionIds || []).includes(collectionId)
      ? { ...r, collectionIds: r.collectionIds.filter(id => id !== collectionId) }
      : r));
    if (selectedCollectionId === collectionId) setSelectedCollectionId(null);
  };

  return (
    <div style={{display:"flex",flex:1,overflow:"hidden"}}>
      <CollectionsSidebar collections={collections} selectedCollectionId={selectedCollectionId}
        onSelect={setSelectedCollectionId} recordsByCollection={recordsByCollection}
        totalRecordCount={repoRecords.length}
        onCreateCollection={handleCreateCollection}
        onDeleteCollection={handleDeleteCollection}
        showComplianceCriteria/>
      <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden",minWidth:0}}>
        {/* Stats */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:1,background:"#1a1a1a",borderBottom:"1px solid #1a1a1a"}}>
          {[
            {label:"PROMOTED RECORDS",value:repoRecords.length,icon:I.Package(14)},
            {label:"COMPLIANT",value:repoRecords.filter(r=>r.complianceResult?.compliant).length,icon:I.Check()},
            {label:"COLLECTIONS",value:(collections || []).length,icon:I.Folder()},
            {label:"UNIQUE SUBJECTS",value:new Set(repoRecords.map(r=>r.subjectHash)).size,icon:I.Shield()},
          ].map((s,i)=>(
            <div key={i} style={{background:"#0a0a0a",padding:"14px 20px"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,color:"#10b981",fontSize:10,fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>{s.icon} {s.label}</div>
              <div style={{fontSize:22,fontWeight:800,color:"#e0e0e0",fontFamily:"'JetBrains Mono', monospace"}}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div style={{padding:"14px 28px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid #1a1a1a",flexWrap:"wrap"}}>
          <div data-tut="Search: Filters the promoted recordings by filename or de-identified subject hash as you type." style={{display:"flex",alignItems:"center",gap:8,background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,padding:"0 10px",flex:"1 1 200px"}}>
            {I.Search()}
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search filename or subject hash..."
              style={{background:"none",border:"none",color:"#e0e0e0",fontSize:13,padding:"8px 0",outline:"none",width:"100%",fontFamily:"'IBM Plex Mono', monospace"}}/>
          </div>
          <select value={filterType} onChange={e=>setFilterType(e.target.value)}
            data-tut="Type filter: Narrows the promoted recordings to a single study type."
            style={{background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,color:"#aaa",fontSize:12,padding:"6px 8px",outline:"none"}}>
            <option value="ALL">All Types</option>
            {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
          <span style={{color:"#555",fontSize:12,fontFamily:"'JetBrains Mono', monospace"}}>{filtered.length} promoted recordings</span>
          <span style={{flex:1}}/>
          <span data-tut="Read-only: The Repository is a curated mirror of promoted recordings. Edit or demote them from the Library; this tab is for review, bundling and licensing only." style={{fontSize:10,color:"#444",letterSpacing:"0.06em"}}>READ-ONLY</span>
        </div>

        {/* Table */}
        <div style={{flex:1,overflow:"auto"}}>
          {filtered.length === 0 ? (
            <div style={{textAlign:"center",padding:"80px 20px",color:"#555",fontSize:13,lineHeight:1.6}}>
              <div style={{fontSize:36,marginBottom:12,color:"#2a2a2a"}}>{I.Package(36)}</div>
              <div style={{color:"#888",marginBottom:6,fontWeight:700}}>No recordings in the Repository yet.</div>
              <div style={{color:"#555",maxWidth:480,margin:"0 auto",fontSize:11}}>
                Promote compliant recordings from the Library tab using the <span style={{color:"#10b981",fontWeight:700}}>↑ PROMOTE</span> button.
                Only recordings whose protocol-compliance check passes are eligible.
              </div>
            </div>
          ) : (
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead><tr style={{borderBottom:"1px solid #1a1a1a"}}>
                {[{label:"FILENAME",w:"28%"},{label:"TYPE",w:"8%"},{label:"COLLECTIONS",w:"22%"},{label:"COMPLIANCE",w:"10%"},{label:"PROMOTED",w:"12%"},{label:"",w:"20%"}].map((c,i)=>(
                  <th key={i} style={{textAlign:"left",padding:"10px 10px",color:"#555",fontSize:10,fontWeight:700,letterSpacing:"0.08em",width:c.w}}>{c.label}</th>
                ))}
              </tr></thead>
              <tbody>{filtered.map(r => {
                const cols = (r.collectionIds || []).map(cid => collections?.find(c => c.id === cid)).filter(Boolean);
                return (
                  <tr key={r.id} style={{borderBottom:"1px solid #111",transition:"background 0.1s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#111"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <td data-tut="File: A promoted recording (★). De-identified filename of an EDF that passed compliance and was moved into the Repository." style={{padding:"10px 10px",fontFamily:"'IBM Plex Mono', monospace",fontSize:12,color:"#bbb"}}>
                      <span style={{color:"#10b981",marginRight:6}}>★</span>{r.filename}
                    </td>
                    <td data-tut="Type: Study type of this recording — Baseline, Post-Injury, Follow-Up, Routine or Long-Term." style={{padding:"10px 10px"}}><TypeBadge record={r}/></td>
                    <td data-tut="Collections: Groups this recording belongs to. Manage membership from the Library tab's ⋮ menu." style={{padding:"10px 10px"}}>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                        {cols.length === 0 ? <span style={{color:"#555",fontSize:11,fontStyle:"italic"}}>none</span> :
                          cols.map(c => (
                            <span key={c.id} style={{padding:"2px 6px",background:"#0c1f24",border:"1px solid #1a3a40",color:"#7ec8d9",fontSize:10,fontWeight:600}}>{c.name}</span>
                          ))}
                      </div>
                    </td>
                    <td data-tut="Compliance: The protocol-compliance result that qualified this recording for promotion. All checks must pass to be here." style={{padding:"10px 10px"}}><ComplianceBadge result={r.complianceResult}/></td>
                    <td data-tut="Promoted: The date this recording was promoted into the Repository (falls back to the recording date if unknown)." style={{padding:"10px 10px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>
                      {r.repositoryPromotedAt ? r.repositoryPromotedAt.split("T")[0] : r.date}
                    </td>
                    <td style={{padding:"10px 10px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <button data-tut="Review: Opens this promoted recording in the waveform viewer (read-only context — edits are made from the Library copy)." onClick={()=>onOpenReview(r)} style={{
                          padding:"4px 10px",background:"#111",border:"1px solid #222",borderRadius:0,
                          color:"#7ec8d9",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                          {I.Eye(12)} REVIEW
                        </button>
                        <button data-tut="Bundle: Packages every promoted recording for this subject — EDF, annotations and notes — into a .zip another REACT EEG install can import." onClick={()=>handleBundleSubject(r.subjectHash)}
                          disabled={bundling === r.subjectHash}
                          title={`Bundle all promoted recordings for subject ${r.subjectHash} into a .zip the recipient can import`}
                          style={{
                            padding:"4px 10px",background: bundling === r.subjectHash ? "#0a1a20" : "#0a1f24",border:"1px solid #15532a",borderRadius:0,
                            color:"#10b981",fontSize:10,fontWeight:700,cursor: bundling === r.subjectHash ? "wait" : "pointer",display:"flex",alignItems:"center",gap:4,opacity: bundling === r.subjectHash ? 0.6 : 1}}>
                          {bundling === r.subjectHash ? "..." : I.Package(12)} {bundling === r.subjectHash ? "BUNDLING" : "BUNDLE"}
                        </button>
                        <button data-tut="License: Begins the commercial licensing flow for this recording — packaging it with a compliance attestation for a data client (pipeline integration coming in a future release)." onClick={()=>setLicenseTarget(r)} title="License this recording for commercial use"
                          style={{
                            padding:"4px 10px",background:"#1a1a0a",border:"1px solid #854d0e",borderRadius:0,
                            color:"#facc15",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                          $ LICENSE
                        </button>
                        <button data-tut="Demote: Removes this recording from the Repository and returns it to Library-only status. The recording itself is not deleted." onClick={()=>{if(confirm(`Demote ${r.filename} from Repository back to Library?\\n\\nThe record stays in the Library; only its Repository status is removed.`))onDemoteRecord && onDemoteRecord(r);}}
                          title="Demote from Repository back to Library"
                          style={{
                            padding:"4px 10px",background:"#2a0a0a",border:"1px solid #991b1b",borderRadius:0,
                            color:"#f87171",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
                          ↓ DEMOTE
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      </div>

      {/* License placeholder modal */}
      {licenseTarget && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}
          onClick={()=>setLicenseTarget(null)}>
          <div ref={licenseDialogRef} role="dialog" aria-modal="true" aria-labelledby="license-modal-title" onClick={e=>e.stopPropagation()} style={{background:"#0c0c0c",border:"1px solid #854d0e",borderRadius:0,padding:"20px 24px",width:480,fontFamily:"'IBM Plex Mono', monospace"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <span id="license-modal-title" style={{color:"#facc15",fontSize:13,fontWeight:700,letterSpacing:"0.08em"}}>LICENSE RECORDING</span>
              <button onClick={()=>setLicenseTarget(null)} aria-label="Close license dialog" style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:2}}>{I.X(16)}</button>
            </div>
            <div style={{fontSize:11,color:"#bbb",marginBottom:8,wordBreak:"break-all"}}>{licenseTarget.filename}</div>
            <div style={{padding:"12px 14px",background:"#1a1a0a",border:"1px solid #854d0e",fontSize:11,color:"#facc15",lineHeight:1.5,marginBottom:14}}>
              Commercial licensing pipeline integration is planned for a future release. This action will eventually
              package the recording (EDF + annotations + compliance attestation + pipeline metadata) and submit it to
              the licensing partner of your choice.
            </div>
            <div style={{textAlign:"right"}}>
              <button onClick={()=>setLicenseTarget(null)} style={{background:"#111",border:"1px solid #333",color:"#888",cursor:"pointer",padding:"6px 18px",fontSize:11,fontWeight:700}}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ExportModal - select individual records, subjects, or study types to export ──
function ExportModal({ records, onClose }) {
  const [selected, setSelected] = useState(new Set());
  const [filterType, setFilterType] = useState("ALL");
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);

  // Group by subject
  const subjects = {};
  records.forEach(r => {
    if (!subjects[r.subjectHash]) subjects[r.subjectHash] = { hash: r.subjectHash, records: [], sport: r.sport };
    subjects[r.subjectHash].records.push(r);
  });

  const filteredRecords = records.filter(r => filterType === "ALL" || r.studyType === filterType);
  const allFilteredIds = new Set(filteredRecords.map(r => r.id));

  const toggleRecord = (id) => {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const toggleSubject = (subj) => {
    const ids = subj.records.filter(r => allFilteredIds.has(r.id)).map(r => r.id);
    const allSelected = ids.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      ids.forEach(id => { if (allSelected) n.delete(id); else n.add(id); });
      return n;
    });
  };
  const selectAll = () => {
    const ids = filteredRecords.map(r => r.id);
    const allSelected = ids.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      ids.forEach(id => { if (allSelected) n.delete(id); else n.add(id); });
      return n;
    });
  };

  const doExport = () => {
    const toExport = records.filter(r => selected.has(r.id));
    if (toExport.length === 0) return;
    const bySubject = {};
    toExport.forEach(r => {
      if (!bySubject[r.subjectHash]) bySubject[r.subjectHash] = [];
      bySubject[r.subjectHash].push(r);
    });
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      appVersion: APP_VERSION,
      exportDate: new Date().toISOString(),
      totalRecords: toExport.length,
      subjects: Object.entries(bySubject).map(([hash, recs]) => ({
        subjectHash: hash,
        recordCount: recs.length,
        records: recs.map(r => ({
          filename: r.filename, studyType: r.studyType, date: r.date,
          channels: r.channels, sampleRate: r.sampleRate, duration: r.duration, status: r.status,
          pipelineVersion: r.pipelineVersion || null,
          schemaVersion: r.schemaVersion || null,
          edfPath: `data/${r.studyType}/${r.filename}`,
          annotationPath: `annotations/${r.filename.replace('.edf','_annotations.json')}`,
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `REACT-EXPORT-${toExport.length}files-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const chk = (checked, onClick) => (
    <button onClick={onClick} style={{
      width:16,height:16,borderRadius:0,flexShrink:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
      background:checked?"#1a4a54":"#1a1a1a",border:`1px solid ${checked?"#4a9bab50":"#333"}`,color:checked?"#7ec8d9":"#555",fontSize:9,
    }}>{checked?"✓":" "}</button>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="export-modal-title" onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:0,width:620,maxHeight:"85vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

        {/* Header */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <h3 id="export-modal-title" style={{margin:0,color:"#e0e0e0",fontSize:16,fontWeight:700}}>Export Data</h3>
            <button onClick={onClose} aria-label="Close export dialog" style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
          </div>

          {/* Filter by study type + select all */}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <select value={filterType} onChange={e=>{setFilterType(e.target.value);setSelected(new Set());}}
              style={{background:"#0a0a0a",border:"1px solid #222",borderRadius:0,color:"#aaa",fontSize:11,padding:"4px 8px",outline:"none",fontFamily:"'IBM Plex Mono', monospace"}}>
              <option value="ALL">All Study Types</option>
              {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
            <button onClick={selectAll} style={{
              padding:"4px 10px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:"'IBM Plex Mono', monospace",
            }}>{filteredRecords.every(r=>selected.has(r.id))&&filteredRecords.length>0?"Deselect All":"Select All"}</button>
            <div style={{flex:1}}/>
            <span style={{fontSize:11,color:selected.size>0?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace"}}>
              {selected.size} selected
            </span>
          </div>
        </div>

        {/* Record list grouped by subject */}
        <div style={{flex:1,overflow:"auto"}}>
          {Object.values(subjects).map(subj => {
            const visible = subj.records.filter(r => allFilteredIds.has(r.id));
            if (visible.length === 0) return null;
            const allSubjSelected = visible.every(r => selected.has(r.id));
            const someSelected = visible.some(r => selected.has(r.id));
            return (
              <div key={subj.hash}>
                {/* Subject header */}
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 20px",background:"#0d0d0d",borderBottom:"1px solid #111"}}>
                  {chk(allSubjSelected, ()=>toggleSubject(subj))}
                  <span style={{fontSize:12,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{subj.hash}</span>
                  <span style={{fontSize:10,color:"#555"}}>{subj.sport}</span>
                  <span style={{fontSize:10,color:"#444"}}>{visible.length} recording{visible.length!==1?"s":""}</span>
                </div>
                {/* Individual records */}
                {visible.map(r => {
                  const st = STUDY_TYPES[r.studyType] || {label:"?",color:"#666"};
                  const isSel = selected.has(r.id);
                  return (
                    <div key={r.id} onClick={()=>toggleRecord(r.id)} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"6px 20px 6px 40px",
                      borderBottom:"1px solid #0a0a0a",cursor:"pointer",
                      background:isSel?"#0a1a20":"transparent",transition:"background 0.1s",
                    }} onMouseEnter={e=>e.currentTarget.style.background=isSel?"#0a1a20":"#0d0d0d"}
                       onMouseLeave={e=>e.currentTarget.style.background=isSel?"#0a1a20":"transparent"}>
                      {chk(isSel, ()=>toggleRecord(r.id))}
                      <span style={{padding:"2px 6px",borderRadius:0,fontSize:9,fontWeight:700,
                        background:st.color+"18",color:st.color,border:`1px solid ${st.color}30`}}>{st.label}</span>
                      <span style={{flex:1,fontSize:11,color:isSel?"#ccc":"#777",fontFamily:"'IBM Plex Mono', monospace"}}>{r.filename}</span>
                      <span style={{fontSize:10,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{r.date}</span>
                      <StatusBadge status={r.status}/>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 20px",borderTop:"1px solid #1a1a1a",background:"#0a0a0a"}}>
          <div style={{fontSize:10,color:"#555"}}>
            {selected.size} of {records.length} records selected
            {selected.size > 0 && (
              <span style={{color:"#444",marginLeft:8}}>
                ({new Set(records.filter(r=>selected.has(r.id)).map(r=>r.subjectHash)).size} subject{new Set(records.filter(r=>selected.has(r.id)).map(r=>r.subjectHash)).size!==1?"s":""})
              </span>
            )}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setSelected(new Set())} style={{
              padding:"6px 14px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:11,fontWeight:600,
            }}>Clear</button>
            <button onClick={doExport} disabled={selected.size===0} style={{
              padding:"6px 18px",background:selected.size>0?"#0a0a2a":"#1a1a1a",
              border:`1px solid ${selected.size>0?"#3B82F640":"#222"}`,borderRadius:0,
              color:selected.size>0?"#3B82F6":"#555",cursor:selected.size>0?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4,
            }}>{I.Package()} Export {selected.size > 0 ? `(${selected.size})` : ""}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EDF Import Validation Pipeline ──
// STANDARD_1020 defined in CONFIGURATION block at top of file
function validateEDFImport(parsed, form) {
  const errors = [], warnings = [], passed = [];
  // 1. Channel count
  const eegLabels = (parsed.channelLabels || []).filter(l => !/(ECG|EKG|EOG|EMG|EDF Annot)/i.test(l));
  if (eegLabels.length >= 19) passed.push(`${eegLabels.length} EEG channels detected`);
  else if (eegLabels.length >= 8) warnings.push(`Only ${eegLabels.length} EEG channels (standard requires 19)`);
  else errors.push(`Only ${eegLabels.length} EEG channels — minimum 8 required`);
  // 2. Duration
  const dur = parsed.totalDuration || (form.duration * 60);
  if (dur >= 300) passed.push(`Duration: ${Math.floor(dur/60)} min`);
  else warnings.push(`Recording only ${(dur/60).toFixed(1)} min — protocol requires 5+ min`);
  // 3. Sample rate consistency
  if (parsed.signals) {
    const rates = [...new Set(parsed.signals.map(s => s.sampleRate))];
    if (rates.length === 1) passed.push(`Consistent sample rate: ${rates[0]} Hz`);
    else warnings.push(`Mixed sample rates detected: ${rates.join(", ")} Hz`);
  }
  // 4. Channel label standardization
  const nonStd = eegLabels.map(l => {
    const clean = l.trim().replace(/^(EEG|ECG|EOG)\s+/i, "").split(/[\s\-]/)[0];
    return STANDARD_1020.has(clean) ? null : l.trim();
  }).filter(Boolean);
  if (nonStd.length === 0) passed.push("All channel labels match 10-20 standard");
  else if (nonStd.length <= 3) warnings.push(`Non-standard labels: ${nonStd.join(", ")}`);
  else warnings.push(`${nonStd.length} non-standard channel labels detected`);
  // 5. PHI scan
  const phiFields = [parsed.patientId, parsed.recordingId].filter(Boolean).join(" ");
  const phiPatterns = [/\b\d{3}-\d{2}-\d{4}\b/, /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/, /\b\d{2}\/\d{2}\/\d{4}\b/];
  let phiFound = false;
  for (const p of phiPatterns) { if (p.test(phiFields)) { phiFound = true; break; } }
  if (phiFound) warnings.push("Possible PHI detected in EDF header — verify de-identification");
  else passed.push("No obvious PHI in header fields");
  // 6. Amplitude range (RMS check on first 5 seconds of each EEG channel)
  if (parsed.channelData) {
    let flatCh = [], saturatedCh = [];
    parsed.channelLabels.forEach((label, i) => {
      if (/(ECG|EKG|EOG|EMG|EDF Annot)/i.test(label)) return;
      const data = parsed.channelData[i];
      if (!data) return;
      const sr = parsed.sampleRate || 256;
      const len = Math.min(sr * 5, data.length);
      let sum = 0;
      for (let j = 0; j < len; j++) sum += data[j] * data[j];
      const rms = Math.sqrt(sum / len);
      if (rms < 2) flatCh.push(label.trim());
      else if (rms > 200) saturatedCh.push(label.trim());
    });
    if (flatCh.length > 0) warnings.push(`Flat/disconnected channels (RMS<2µV): ${flatCh.join(", ")}`);
    if (saturatedCh.length > 0) warnings.push(`Saturated channels (RMS>200µV): ${saturatedCh.join(", ")}`);
    if (flatCh.length === 0 && saturatedCh.length === 0) passed.push("All channels within normal amplitude range");
  }
  return { errors, warnings, passed };
}

function IngestForm({ onClose, onIngest, setEdfFileStore, setAnnotationsMap, setClinicalNotesMap, setBaselineMap }) {
  const [form, setForm] = useState({
    subjectId:"",studyType:"BL",date:new Date().toISOString().split("T")[0],
    channels:21,sampleRate:256,duration:30,montage:"10-20",notes:"",sex:"",age:"",
    // Subject metadata
    handedness:"",medicationCategory:[],knownConditions:[],
    lastMealHours:"",lastSleepHours:"",caffeineHours:"",
    // Recording conditions
    consciousnessLevel:"awake",activationProcedures:[],
    phototicFrequencies:"",hvDurationMinutes:"",posture:"seated",
    environmentNoise:"quiet",recordingLocation:"",
    // Hardware
    hardwareManufacturer:"",hardwareModel:"",adcResolution:"24",
    fdaCleared:false,electrodeType:"gold_cup",applicationMethod:"paste",
  });
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const [validationResults, setValidationResults] = useState(null);
  const [validationOverride, setValidationOverride] = useState(false);
  const parsedEdfRef = useRef(null);
  const fileInputRef = useRef(null);

  const inputStyle = {width:"100%",padding:"8px 10px",background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,color:"#e0e0e0",fontSize:13,fontFamily:"'IBM Plex Mono', monospace",outline:"none",boxSizing:"border-box"};
  const formLabel = {display:"block",fontSize:11,color:"#777",marginBottom:4,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"};

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Detect .reegb bundle and unpack everything in one shot
    if (file.name.toLowerCase().endsWith(".reegb") || file.name.toLowerCase().endsWith(".json")) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const bundle = JSON.parse(ev.target.result);
          if (bundle.kind !== "react-eeg-bundle" || !bundle.record) {
            notify("Not a valid REACT EEG bundle file.", "error");
            return;
          }
          const rec = bundle.record;
          if (bundle.edfBase64 && setEdfFileStore) {
            const buf = base64ToArrayBuffer(bundle.edfBase64);
            const parsed = parseEDFFile(buf);
            if (parsed && !parsed.error) {
              setEdfFileStore(prev => ({ ...prev, [rec.filename]: parsed }));
              saveEdfToDB(rec.filename, buf);
            }
          }
          if (bundle.annotations && setAnnotationsMap) {
            setAnnotationsMap(prev => ({ ...prev, [rec.filename]: migrateAnnotations(bundle.annotations) }));
          }
          if (bundle.clinicalNotes && setClinicalNotesMap) {
            setClinicalNotesMap(prev => ({ ...prev, [rec.filename]: bundle.clinicalNotes }));
          }
          if (bundle.baselineFilename && setBaselineMap) {
            setBaselineMap(prev => ({ ...prev, [rec.filename]: bundle.baselineFilename }));
          }
          onIngest({ ...rec, id: rec.id || `REC-${Date.now()}` });
          onClose();
        } catch (err) {
          console.warn("Bundle parse error:", err);
          notify("Failed to parse bundle file: " + err.message, "error");
        }
      };
      reader.readAsText(file);
      return;
    }

    setSelectedFile(file);

    // Extract info from filename and file size
    const name = file.name;
    const sizeMB = Math.round(file.size / 1024 / 1024 * 10) / 10;
    const isEdf = name.toLowerCase().endsWith(".edf") || name.toLowerCase().endsWith(".bdf");

    // Try to parse REACT naming convention if present
    const reactMatch = name.match(/REACT-(\w+)-(\w+)-(\d{4})(\d{2})(\d{2})/);

    // Estimate duration from file size (rough: filesize / (channels * sampleRate * 2 bytes) / 60)
    const estChannels = form.channels || 21;
    const estRate = form.sampleRate || 256;
    const estDuration = Math.round(file.size / (estChannels * estRate * 2) / 60);

    setFileInfo({
      name: name,
      size: sizeMB,
      isEdf: isEdf,
      estDuration: estDuration > 0 ? estDuration : 30,
    });

    // Auto-fill form from file info
    if (reactMatch) {
      const studyType = reactMatch[1];
      const dateStr = `${reactMatch[3]}-${reactMatch[4]}-${reactMatch[5]}`;
      if (STUDY_TYPES[studyType]) setForm(prev => ({...prev, studyType}));
      setForm(prev => ({...prev, date: dateStr}));
    } else {
      // Try to get date from file lastModified
      const fDate = new Date(file.lastModified).toISOString().split("T")[0];
      setForm(prev => ({...prev, date: fDate}));
    }

    if (estDuration > 0) {
      setForm(prev => ({...prev, duration: estDuration}));
    }

    // Read EDF header (first 256 bytes) for channel/sample info
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const header = new Uint8Array(ev.target.result);
        const decoder = new TextDecoder("ascii");
        // EDF spec: bytes 236-244 = number of data records, 244-252 = duration of record
        // bytes 252-256 = number of signals
        const nSignals = parseInt(decoder.decode(header.slice(252, 256)).trim());
        if (nSignals > 0 && nSignals < 200) {
          setForm(prev => ({...prev, channels: nSignals}));
          setFileInfo(prev => ({...prev, detectedChannels: nSignals}));
          // Infer montage from channel count
          const detectedMontage = nSignals <= 21 ? "10-20" : nSignals <= 40 ? "hd-40" : "10-10";
          setForm(prev => ({...prev, montage: detectedMontage}));
          setFileInfo(prev => ({...prev, detectedMontage}));
        }
        // bytes 236-244 = number of data records
        const nRecords = parseInt(decoder.decode(header.slice(236, 244)).trim());
        // bytes 244-252 = duration of a data record in seconds
        const recordDuration = parseFloat(decoder.decode(header.slice(244, 252)).trim());
        if (nRecords > 0 && recordDuration > 0) {
          const totalMin = Math.round(nRecords * recordDuration / 60);
          if (totalMin > 0) {
            setForm(prev => ({...prev, duration: totalMin}));
            setFileInfo(prev => ({...prev, detectedDuration: totalMin}));
          }
        }
        // Detect sample rate: read per-signal header
        // "nr of samples in each data record" starts at byte 256 + nSignals*216, 8 bytes per signal
        if (nSignals > 0 && nSignals < 200 && recordDuration > 0) {
          const srOffset = 256 + nSignals * 216;
          const srEnd = srOffset + 8;
          const hdrBytes = new Uint8Array(ev.target.result);
          if (hdrBytes.length >= srEnd) {
            const samplesPerRecord = parseInt(decoder.decode(hdrBytes.slice(srOffset, srEnd)).trim());
            if (samplesPerRecord > 0) {
              const detectedSr = Math.round(samplesPerRecord / recordDuration);
              setForm(prev => ({...prev, sampleRate: detectedSr}));
              setFileInfo(prev => ({...prev, detectedSampleRate: detectedSr}));
            }
          }
        }
        // Patient ID from bytes 8-88
        const patientId = decoder.decode(header.slice(8, 88)).trim();
        if (patientId && patientId !== "X" && patientId.length > 0) {
          setFileInfo(prev => ({...prev, patientField: patientId}));
          // Try to auto-detect sex/age from EDF+ patient field
          const parsed = parseEdfPatientField(patientId);
          if (parsed.sex) setForm(prev => ({...prev, sex: parsed.sex}));
          if (parsed.age != null) setForm(prev => ({...prev, age: String(parsed.age)}));
        }
        // Recording date from bytes 168-176
        const startDate = decoder.decode(header.slice(168, 176)).trim();
        if (startDate) {
          setFileInfo(prev => ({...prev, startDate}));
        }
      } catch (err) {
        // Not a valid EDF, that's fine
      }
    };
    // Read enough header bytes for per-signal fields (up to ~60 signals)
    reader.readAsArrayBuffer(file.slice(0, 16384));
  };

  // Run validation on EDF when file is selected (pre-parse for validation)
  const runValidation = useCallback(() => {
    if (!selectedFile) { setValidationResults(null); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseEDFFile(ev.target.result);
      if (parsed && !parsed.error) {
        parsedEdfRef.current = { parsed, buffer: ev.target.result };
        const vr = validateEDFImport(parsed, form);
        setValidationResults(vr);
      } else {
        setValidationResults({ errors: ["Failed to parse EDF file"], warnings: [], passed: [] });
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  }, [selectedFile, form]);

  useEffect(() => { if (selectedFile) runValidation(); }, [selectedFile]);

  const handleSubmit = () => {
    if (!form.subjectId) return;
    // Block import if validation has blocking errors and user hasn't overridden
    if (validationResults && validationResults.errors.length > 0 && !validationOverride) return;
    const fileSizeMB = selectedFile ? Math.round(selectedFile.size/1024/1024*10)/10 :
      Math.round(form.channels*form.sampleRate*form.duration*60*2/1024/1024*10)/10;
    const deIdFilename = generateFilename(form.subjectId,form.studyType,form.date,form.sex,form.age);
    const record = {
      id:`REC-${Date.now()}`,subjectHash:hashSubjectId(form.subjectId),subjectId:form.subjectId,sport:"",position:"",
      studyType:form.studyType,date:form.date,filename:deIdFilename,
      channels:form.channels,duration:form.duration,sampleRate:form.sampleRate,
      fileSize:fileSizeMB,sex:form.sex||"",age:form.age?parseInt(form.age):null,
      montage:form.montage,status:"pending",isTest:false,notes:form.notes,uploadedAt:new Date().toISOString(),
      sourceFile: selectedFile ? selectedFile.name : null,
      hasEdfData: !!selectedFile,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      processingLog: [],
      repositoryStatus: "library",
      collectionIds: [],
      complianceResult: null,
      validationResults: validationResults ? { errors: validationResults.errors, warnings: validationResults.warnings, passed: validationResults.passed, overridden: validationOverride } : null,
      // Subject metadata
      handedness: form.handedness || null,
      medicationCategory: form.medicationCategory,
      knownConditions: form.knownConditions,
      lastMealHours: form.lastMealHours ? parseFloat(form.lastMealHours) : null,
      lastSleepHours: form.lastSleepHours ? parseFloat(form.lastSleepHours) : null,
      caffeineHours: form.caffeineHours ? parseFloat(form.caffeineHours) : null,
      // Recording conditions
      consciousnessLevel: form.consciousnessLevel,
      activationProcedures: form.activationProcedures,
      phototicFrequencies: form.phototicFrequencies || null,
      hvDurationMinutes: form.hvDurationMinutes ? parseFloat(form.hvDurationMinutes) : null,
      posture: form.posture, environmentNoise: form.environmentNoise,
      recordingLocation: form.recordingLocation || null,
      // Hardware
      hardware: {
        manufacturer: form.hardwareManufacturer || null, model: form.hardwareModel || null,
        adcResolution: form.adcResolution ? parseInt(form.adcResolution) : null,
        fdaCleared: form.fdaCleared, electrodeType: form.electrodeType,
        applicationMethod: form.applicationMethod,
      },
    };

    // Helper: convert EDF+ TAL annotations to the app's annotation shape and
    // seed annotationsMap[filename]. No-op if the user already has annotations
    // for this filename (e.g. from a bundle import).
    const writeEdfAnnotations = (parsed) => {
      if (!parsed?.edfAnnotations?.length || !setAnnotationsMap) return;
      const converted = parsed.edfAnnotations.map((a, i) => ({
        id: `EDF-${Date.now()}-${i}`,
        time: a.time, duration: a.duration,
        type: a.text || "EDF Event", color: EDF_EVENT_COLOR,
        text: a.text, channel: -1, source: "edf",
      }));
      setAnnotationsMap(prev => (prev[deIdFilename]?.length ? prev : { ...prev, [deIdFilename]: converted }));
    };

    if (selectedFile && setEdfFileStore) {
      // Use pre-parsed data from validation if available, otherwise re-read
      if (parsedEdfRef.current) {
        const { parsed, buffer } = parsedEdfRef.current;
        setEdfFileStore(prev => ({ ...prev, [deIdFilename]: parsed }));
        saveEdfToDB(deIdFilename, buffer);
        writeEdfAnnotations(parsed);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const parsed = parseEDFFile(ev.target.result);
          if (!parsed.error) {
            setEdfFileStore(prev => ({ ...prev, [deIdFilename]: parsed }));
            saveEdfToDB(deIdFilename, ev.target.result);
            writeEdfAnnotations(parsed);
          }
        };
        reader.readAsArrayBuffer(selectedFile);
      }
    }

    onIngest(record);
    onClose();
  };

  return (<>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
      <h3 style={{margin:0,color:"#e0e0e0",fontSize:16,fontWeight:700}}>Import New Record</h3>
      <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
    </div>

    {/* File picker */}
    <div style={{marginBottom:20}}>
      <input ref={fileInputRef} type="file" accept=".edf,.bdf,.EDF,.BDF,.reegb,.REEGB,.json" onChange={handleFileSelect}
        style={{display:"none"}}/>
      <button onClick={()=>fileInputRef.current.click()} style={{
        width:"100%",padding:"16px 20px",background:"#0a0a0a",border:"2px dashed #2a2a2a",borderRadius:0,
        color:selectedFile?"#7ec8d9":"#555",cursor:"pointer",fontSize:12,fontWeight:600,
        display:"flex",flexDirection:"column",alignItems:"center",gap:8,transition:"border-color 0.15s",
      }}
        onMouseEnter={e=>e.currentTarget.style.borderColor="#4a9bab"}
        onMouseLeave={e=>e.currentTarget.style.borderColor="#2a2a2a"}>
        {selectedFile ? (<>
          <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Check(14)} File Selected</span>
          <span style={{fontSize:11,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{selectedFile.name}</span>
          <span style={{fontSize:10,color:"#555"}}>{fileInfo?.size} MB{fileInfo?.detectedChannels ? ` - ${fileInfo.detectedChannels} channels detected` : ""}{fileInfo?.detectedDuration ? ` - ${fileInfo.detectedDuration} min` : ""}</span>
        </>) : (<>
          <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Upload(14)} Select EDF / BDF File</span>
          <span style={{fontSize:10,color:"#444"}}>Click to browse, or drag and drop</span>
        </>)}
      </button>
      {fileInfo && !fileInfo.isEdf && (
        <div style={{marginTop:6,fontSize:10,color:"#F59E0B"}}>Warning: file does not have .edf or .bdf extension</div>
      )}
      {fileInfo?.patientField && (
        <div style={{marginTop:6,fontSize:10,color:"#F59E0B"}}>
          EDF header contains patient ID field: "{fileInfo.patientField}" - this will NOT be stored. De-identified filename will be used.
        </div>
      )}
    </div>

    {form.subjectId&&<div style={{background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,padding:"8px 12px",marginBottom:20,fontFamily:"'IBM Plex Mono', monospace",fontSize:12,color:"#7ec8d9"}}>
      <span style={{color:"#555",fontSize:10,display:"block",marginBottom:2}}>GENERATED FILENAME</span>{generateFilename(form.subjectId,form.studyType,form.date,form.sex,form.age)}
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px 16px",marginBottom:16}}>
      <div style={{gridColumn:"1/3"}}><label style={formLabel}>Internal Subject ID</label><SubjectIdInput value={form.subjectId} onChange={v=>setForm({...form,subjectId:v})}/></div>
      <div><label style={formLabel}>Study Type</label><select style={inputStyle} value={form.studyType} onChange={e=>setForm({...form,studyType:e.target.value})}>{Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
      <div><label style={formLabel}>Sex</label><select style={inputStyle} value={form.sex} onChange={e=>setForm({...form,sex:e.target.value})}><option value="">—</option><option value="M">Male</option><option value="F">Female</option><option value="X">Other</option></select>{fileInfo?.patientField && form.sex && <span style={{fontSize:9,color:"#10B981",marginTop:2,display:"block"}}>detected from EDF</span>}</div>
      <div><label style={formLabel}>Age</label><input style={inputStyle} type="number" min={0} max={120} value={form.age} onChange={e=>setForm({...form,age:e.target.value})} placeholder="Years"/>{fileInfo?.patientField && form.age && <span style={{fontSize:9,color:"#10B981",marginTop:2,display:"block"}}>detected from EDF</span>}</div>
      <div><label style={formLabel}>Recording Date</label><input style={inputStyle} type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></div>
      <div style={{gridColumn:"1/-1"}}><label style={formLabel}>Notes</label><input style={inputStyle} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Optional notes"/></div>
    </div>

    {/* ── SUBJECT METADATA ── */}
    <div style={{borderTop:"1px solid #1a1a1a",paddingTop:12,marginBottom:16}}>
      <div style={{fontSize:10,color:"#4a9bab",fontWeight:700,letterSpacing:"0.1em",marginBottom:10}}>SUBJECT METADATA</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px 16px"}}>
        <div><label style={formLabel}>Handedness</label><select style={inputStyle} value={form.handedness} onChange={e=>setForm({...form,handedness:e.target.value})}><option value="">—</option><option value="R">Right</option><option value="L">Left</option><option value="A">Ambidextrous</option></select></div>
        <div><label style={formLabel}>Last Meal (hrs ago)</label><input style={inputStyle} type="number" min="0" max="48" step="0.5" value={form.lastMealHours} onChange={e=>setForm({...form,lastMealHours:e.target.value})} placeholder="e.g. 2"/></div>
        <div><label style={formLabel}>Last Sleep (hrs ago)</label><input style={inputStyle} type="number" min="0" max="72" step="0.5" value={form.lastSleepHours} onChange={e=>setForm({...form,lastSleepHours:e.target.value})} placeholder="e.g. 8"/></div>
        <div><label style={formLabel}>Caffeine (hrs ago)</label><input style={inputStyle} type="number" min="0" max="48" step="0.5" value={form.caffeineHours} onChange={e=>setForm({...form,caffeineHours:e.target.value})} placeholder="e.g. 3"/></div>
      </div>
      <div style={{marginTop:8}}><label style={formLabel}>Medications</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{["none","caffeine","anticonvulsant","benzodiazepine","SSRI","stimulant","cannabis","other"].map(m=>{
          const sel=form.medicationCategory.includes(m);
          return <button key={m} type="button" onClick={()=>{
            setForm(p=>{const cur=p.medicationCategory;if(sel)return{...p,medicationCategory:cur.filter(x=>x!==m)};if(m==="none")return{...p,medicationCategory:["none"]};return{...p,medicationCategory:[...cur.filter(x=>x!=="none"),m]};});
          }} style={{padding:"3px 8px",fontSize:9,fontWeight:600,cursor:"pointer",background:sel?"#1a2a30":"#111",border:`1px solid ${sel?"#4a9bab":"#222"}`,color:sel?"#7ec8d9":"#666"}}>{m}</button>
        })}</div>
      </div>
      <div style={{marginTop:8}}><label style={formLabel}>Known Conditions</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{["none","epilepsy","migraine","TBI_history","ADHD","anxiety","depression","sleep_disorder","other"].map(c=>{
          const sel=form.knownConditions.includes(c);
          return <button key={c} type="button" onClick={()=>{
            setForm(p=>{const cur=p.knownConditions;if(sel)return{...p,knownConditions:cur.filter(x=>x!==c)};if(c==="none")return{...p,knownConditions:["none"]};return{...p,knownConditions:[...cur.filter(x=>x!=="none"),c]};});
          }} style={{padding:"3px 8px",fontSize:9,fontWeight:600,cursor:"pointer",background:sel?"#1a2a30":"#111",border:`1px solid ${sel?"#4a9bab":"#222"}`,color:sel?"#7ec8d9":"#666"}}>{c.replace(/_/g," ")}</button>
        })}</div>
      </div>
    </div>

    {/* ── RECORDING CONDITIONS ── */}
    <div style={{borderTop:"1px solid #1a1a1a",paddingTop:12,marginBottom:16}}>
      <div style={{fontSize:10,color:"#4a9bab",fontWeight:700,letterSpacing:"0.1em",marginBottom:10}}>RECORDING CONDITIONS</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px 16px"}}>
        <div><label style={formLabel}>Consciousness</label><select style={inputStyle} value={form.consciousnessLevel} onChange={e=>setForm({...form,consciousnessLevel:e.target.value})}><option value="awake">Awake</option><option value="drowsy">Drowsy</option><option value="asleep">Asleep</option><option value="sedated">Sedated</option></select></div>
        <div><label style={formLabel}>Posture</label><select style={inputStyle} value={form.posture} onChange={e=>setForm({...form,posture:e.target.value})}><option value="supine">Supine</option><option value="seated">Seated</option><option value="standing">Standing</option></select></div>
        <div><label style={formLabel}>Environment</label><select style={inputStyle} value={form.environmentNoise} onChange={e=>setForm({...form,environmentNoise:e.target.value})}><option value="quiet">Quiet</option><option value="moderate">Moderate</option><option value="noisy">Noisy</option></select></div>
        <div style={{gridColumn:"1/-1"}}><label style={formLabel}>Location</label><input style={inputStyle} value={form.recordingLocation} onChange={e=>setForm({...form,recordingLocation:e.target.value})} placeholder="e.g. Clinic Room 3 (de-identified)"/></div>
      </div>
      <div style={{marginTop:8}}><label style={formLabel}>Activation Procedures</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{["none","hyperventilation","photic","sleep_deprivation"].map(p=>{
          const sel=form.activationProcedures.includes(p);
          return <button key={p} type="button" onClick={()=>{
            setForm(prev=>{const cur=prev.activationProcedures;if(sel)return{...prev,activationProcedures:cur.filter(x=>x!==p)};if(p==="none")return{...prev,activationProcedures:["none"]};return{...prev,activationProcedures:[...cur.filter(x=>x!=="none"),p]};});
          }} style={{padding:"3px 8px",fontSize:9,fontWeight:600,cursor:"pointer",background:sel?"#1a2a30":"#111",border:`1px solid ${sel?"#4a9bab":"#222"}`,color:sel?"#7ec8d9":"#666"}}>{p.replace(/_/g," ")}</button>
        })}</div>
      </div>
      {form.activationProcedures.includes("photic") && <div style={{marginTop:6}}><label style={formLabel}>Photic Frequencies</label><input style={inputStyle} value={form.phototicFrequencies} onChange={e=>setForm({...form,phototicFrequencies:e.target.value})} placeholder="e.g. 1,2,4,6,8,10,12,14,16,18,20,30"/></div>}
      {form.activationProcedures.includes("hyperventilation") && <div style={{marginTop:6}}><label style={formLabel}>HV Duration (min)</label><input style={inputStyle} type="number" min="0" max="10" step="0.5" value={form.hvDurationMinutes} onChange={e=>setForm({...form,hvDurationMinutes:e.target.value})} placeholder="3"/></div>}
    </div>

    {/* ── HARDWARE ── */}
    <div style={{borderTop:"1px solid #1a1a1a",paddingTop:12,marginBottom:16}}>
      <div style={{fontSize:10,color:"#4a9bab",fontWeight:700,letterSpacing:"0.1em",marginBottom:10}}>ACQUISITION HARDWARE</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px 16px"}}>
        <div><label style={formLabel}>Manufacturer</label><input style={inputStyle} value={form.hardwareManufacturer} onChange={e=>setForm({...form,hardwareManufacturer:e.target.value})} placeholder="e.g. OpenBCI"/></div>
        <div><label style={formLabel}>Model</label><input style={inputStyle} value={form.hardwareModel} onChange={e=>setForm({...form,hardwareModel:e.target.value})} placeholder="e.g. Cyton+Daisy"/></div>
        <div><label style={formLabel}>ADC Resolution</label><select style={inputStyle} value={form.adcResolution} onChange={e=>setForm({...form,adcResolution:e.target.value})}><option value="16">16-bit</option><option value="24">24-bit</option><option value="32">32-bit</option></select></div>
        <div><label style={formLabel}>Electrode Type</label><select style={inputStyle} value={form.electrodeType} onChange={e=>setForm({...form,electrodeType:e.target.value})}><option value="gold_cup">Gold Cup</option><option value="silver_chloride">Silver Chloride</option><option value="dry">Dry</option><option value="active">Active</option></select></div>
        <div><label style={formLabel}>Application</label><select style={inputStyle} value={form.applicationMethod} onChange={e=>setForm({...form,applicationMethod:e.target.value})}><option value="paste">Paste</option><option value="gel">Gel</option><option value="collodion">Collodion</option><option value="dry">Dry</option></select></div>
        <div style={{display:"flex",alignItems:"flex-end"}}><label style={{...formLabel,display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}><input type="checkbox" checked={form.fdaCleared} onChange={e=>setForm({...form,fdaCleared:e.target.checked})}/> FDA Cleared</label></div>
      </div>
    </div>

    {/* Impedance is a dynamic, per-electrode value measured at acquisition — a single
        number entered at import time isn't meaningful, so it is no longer collected here.
        When a recording carries impedance, it is read from the EDF and shown via the
        Impedance button in Review. The compliance cutoff still applies (≤ 5 kΩ). */}

    {/* Read-only file metadata — shown after EDF file selection */}
    {selectedFile && fileInfo && (
      <div style={{background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,padding:"12px 16px",marginBottom:16}}>
        <div style={{fontSize:10,color:"#555",fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:8}}>FILE METADATA</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 24px",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>
          <div><span style={{color:"#666"}}>Montage: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedMontage || form.montage}</span></div>
          <div><span style={{color:"#666"}}>Channels: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedChannels || form.channels}</span></div>
          <div><span style={{color:"#666"}}>Sample Rate: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedSampleRate || form.sampleRate} Hz</span></div>
          <div><span style={{color:"#666"}}>Duration: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedDuration || form.duration} min</span></div>
          <div><span style={{color:"#666"}}>File Size: </span><span style={{color:"#7ec8d9"}}>{fileInfo.size} MB</span></div>
          <div><span style={{color:"#666"}}>Format: </span><span style={{color:"#7ec8d9"}}>{fileInfo.isEdf ? "EDF/EDF+" : "Unknown"}</span></div>
          {fileInfo.startDate && <div><span style={{color:"#666"}}>Start Date: </span><span style={{color:"#7ec8d9"}}>{fileInfo.startDate}</span></div>}
        </div>
      </div>
    )}
    {/* ── VALIDATION RESULTS ── */}
    {validationResults && (
      <div style={{background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,padding:"12px 16px",marginBottom:16}}>
        <div style={{fontSize:10,color:"#4a9bab",fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:8}}>IMPORT VALIDATION</div>
        {validationResults.passed.map((msg,i) => (
          <div key={`p${i}`} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,fontSize:11}}>
            <span style={{color:"#22c55e",fontSize:13}}>✓</span><span style={{color:"#6b7280"}}>{msg}</span>
          </div>
        ))}
        {validationResults.warnings.map((msg,i) => (
          <div key={`w${i}`} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,fontSize:11}}>
            <span style={{color:"#f59e0b",fontSize:13}}>⚠</span><span style={{color:"#d4a44a"}}>{msg}</span>
          </div>
        ))}
        {validationResults.errors.map((msg,i) => (
          <div key={`e${i}`} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,fontSize:11}}>
            <span style={{color:"#ef4444",fontSize:13}}>✕</span><span style={{color:"#f87171"}}>{msg}</span>
          </div>
        ))}
        {validationResults.errors.length > 0 && !validationOverride && (
          <button type="button" onClick={()=>setValidationOverride(true)} style={{marginTop:8,padding:"4px 12px",fontSize:10,background:"#1a1010",border:"1px solid #ef444440",color:"#f87171",cursor:"pointer"}}>Override Errors & Import Anyway</button>
        )}
      </div>
    )}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <button onClick={onClose} style={{padding:"8px 16px",background:"transparent",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:13}}>Cancel</button>
      <button onClick={handleSubmit} disabled={!form.subjectId || (validationResults && validationResults.errors.length > 0 && !validationOverride)} style={{padding:"8px 20px",background:form.subjectId?"#1a4a54":"#1a1a1a",border:"1px solid "+(form.subjectId?"#4a9bab":"#333"),borderRadius:0,color:form.subjectId?"#7ec8d9":"#555",cursor:form.subjectId?"pointer":"default",fontSize:13,fontWeight:600}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Upload()} Import Record</span>
      </button>
    </div>
  </>);
}

// ══════════════════════════════════════════════════════════════
// TAB: REVIEW
// ══════════════════════════════════════════════════════════════
function ReviewTab({ record, onClearReview, notesShownFilesRef, openTabs, setOpenTabs, activeTabIdx, setActiveTabIdx, tabEpochCache }) {
  // App-global atoms from context (records + EDF blobs + annotation/notes/baseline maps and their
  // setters + updateRecordStatus + Review navigation). Destructured to the same local names the
  // body uses (openReview→onSelectRecord), so the rest of the ~810-line component is unchanged.
  const { records, setRecords, edfFileStore, setEdfFileStore, annotationsMap, setAnnotationsMap,
    clinicalNotesMap, setClinicalNotesMap, baselineMap, setBaselineMap, updateRecordStatus,
    openReview: onSelectRecord } = useAppStore();
  const filename = record?.filename || "";
  const edfData = edfFileStore?.[filename] || null;
  // Per-signal EDF analysis (electrode/type/RMS) — drives the montage-builder green dots
  // (strictly EEG-with-data) and the Raw EDF inspector.
  const edfInfo = useMemo(() => analyzeEdfSignals(edfData), [edfData]);
  // Backfill the electrode system from the actual EDF when a record is opened — corrects older
  // records (and seeds) that were stamped "10-20" by default but are really higher-density.
  useEffect(() => {
    if (!record || !edfData || !setRecords) return;
    const detected = detectEdfSystem(edfData);
    if (detected && record.montage !== detected) {
      setRecords(prev => prev.map(r => r.id === record.id ? { ...r, montage: detected } : r));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, edfData]);
  const totalDur = edfData ? edfData.totalDuration : 600;
  const recordSeed = useMemo(() => {
    const fn = record?.filename || "";
    let h = 0;
    for (let i = 0; i < fn.length; i++) h = ((h << 5) - h + fn.charCodeAt(i)) | 0;
    return Math.abs(h);
  }, [record?.filename]);
  const eeg = useEEGState(totalDur, edfData);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisPanelPos, setAnalysisPanelPos] = useState({ x: null, y: null });
  const [showCompare, setShowCompare] = useState(false);
  const [comparePanelPos, setComparePanelPos] = useState({ x: null, y: null });
  const [showClinicalNotes, setShowClinicalNotes] = useState(false);
  const [clinicalNotesPanelPos, setClinicalNotesPanelPos] = useState({ x: null, y: null });
  const notesBtnRef = useRef(null); // anchor for the clinical-notes panel
  // Position the notes panel just below the Notes button (clamped to viewport).
  const anchorNotesPanel = () => {
    const el = notesBtnRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const PANEL_W = 280;
    setClinicalNotesPanelPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 12)), y: r.bottom + 6 });
  };
  const [showTopo, setShowTopo] = useState(false);
  const [topoPanelPos, setTopoPanelPos] = useState({ x: null, y: null });
  const [showCompliance, setShowCompliance] = useState(false);
  const [compliancePanelPos, setCompliancePanelPos] = useState({ x: null, y: null });
  const [showRevImpedance, setShowRevImpedance] = useState(false);
  const [showRawEdf, setShowRawEdf] = useState(false);
  const [rawEdfPanelPos, setRawEdfPanelPos] = useState({ x: null, y: null });
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  const [spectrogramPanelPos, setSpectrogramPanelPos] = useState({ x: null, y: null });
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  // Stable refs so keyboard/scroll callbacks never capture stale values.
  // Playback itself lives entirely in useEEGState (eeg.isPlaying / eeg.playbackAbsSec /
  // eeg.togglePlayback) — ReviewTab only needs to pause it when the user scrolls.
  const totalEpochsRef = useRef(eeg.totalEpochs);
  const epochSecRef = useRef(eeg.epochSec);
  const setCurrentEpochRef = useRef(eeg.setCurrentEpoch);
  const pausePlaybackRef = useRef(eeg.pausePlayback);
  useEffect(() => { totalEpochsRef.current = eeg.totalEpochs; }, [eeg.totalEpochs]);
  useEffect(() => { epochSecRef.current = eeg.epochSec; }, [eeg.epochSec]);
  useEffect(() => { pausePlaybackRef.current = eeg.pausePlayback; });
  useEffect(() => { setCurrentEpochRef.current = eeg.setCurrentEpoch; }, [eeg.setCurrentEpoch]);
  // Reset or restore epoch when file changes
  useEffect(() => {
    const cached = tabEpochCache.current[record?.filename];
    eeg.setCurrentEpoch(cached !== undefined ? cached : 0);
  }, [record?.filename]);

  // Auto-open clinical notes on first review of a file, close on subsequent visits
  const prevNoteFilenameRef = useRef(null);
  useEffect(() => {
    if (!record?.filename) return;
    const fn = record.filename;
    if (fn === prevNoteFilenameRef.current) return;
    const isFirst = !notesShownFilesRef.current.has(fn);
    prevNoteFilenameRef.current = fn;
    notesShownFilesRef.current.add(fn);
    if (isFirst) anchorNotesPanel(); // anchor to the Notes button (set before opening → no flash)
    setShowClinicalNotes(isFirst);
  }, [record?.filename]);

  // Save epoch when switching away from a file
  const prevFilenameRef = useRef(null);
  useEffect(() => {
    if (!record) return;
    if (prevFilenameRef.current && prevFilenameRef.current !== record.filename) {
      tabEpochCache.current[prevFilenameRef.current] = eeg.currentEpoch;
    }
    prevFilenameRef.current = record.filename;
  }, [record?.filename]);

  // Baseline/differential comparison now lives entirely in the Compare panel (pick baseline →
  // pick comparison), so the Review toolbar no longer pins a per-file baseline.

  // Save bundle: gather everything for this record into a .reegb JSON file
  const handleSaveBundle = async () => {
    if (!record) return;
    try {
      const rawEdf = await getEdfRawFromDB(filename);
      const bundle = {
        version: 1,
        kind: "react-eeg-bundle",
        schemaVersion: SCHEMA_VERSION,
        pipelineVersion: PIPELINE_VERSION,
        appVersion: APP_VERSION,
        savedAt: new Date().toISOString(),
        record,
        edfBase64: rawEdf ? arrayBufferToBase64(rawEdf) : null,
        annotations: annotationsMap[filename] || [],
        clinicalNotes: clinicalNotesMap[filename] || "",
        baselineFilename: null,
      };
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.replace(/\.edf$/i, "") + ".reegb";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn("Save bundle failed:", e);
    }
  };

  const switchToTab = (idx) => {
    if (idx === activeTabIdx) return;
    const leavingTab = openTabs[activeTabIdx];
    if (leavingTab) tabEpochCache.current[leavingTab.filename] = eeg.currentEpoch;
    setActiveTabIdx(idx);
    const targetTab = openTabs[idx];
    if (targetTab) onSelectRecord(targetTab);
  };

  const closeTab = (idx, e) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter((_, i) => i !== idx);
      delete tabEpochCache.current[prev[idx].filename];
      if (next.length === 0) {
        // Closed the last tab — drop the record so the empty "NO FILE LOADED"
        // state takes over instead of rendering with a stale record.
        setActiveTabIdx(0);
        if (onClearReview) onClearReview();
      } else if (idx === activeTabIdx) {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabIdx(newIdx);
        onSelectRecord(next[newIdx]);
      } else if (idx < activeTabIdx) {
        setActiveTabIdx(activeTabIdx - 1);
      }
      return next;
    });
  };

  const annotations = annotationsMap[filename] || [];
  const setAnnotations = (newAnns) => {
    const resolved = typeof newAnns === "function" ? newAnns(annotations) : newAnns;
    setAnnotationsMap(prev => ({ ...prev, [filename]: resolved }));
  };

  // Override eeg annotations with app-level ones
  eeg.annotations = annotations;
  eeg.setAnnotations = setAnnotations;
  const origConfirm = eeg.confirmAnnotation;
  eeg.confirmAnnotation = () => {
    if (!eeg.annotationDraft) return;
    const t = ANNOTATION_COLORS[eeg.selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), time: eeg.annotationDraft.time, duration: eeg.annotationDraft.duration,
      code: t.code, type: t.name, color: t.color, text: eeg.annotationText || t.name, channel: -1, ...annotationProvenance(eeg.annotationConfidence) }]);
    eeg.setAnnotationDraft(null); eeg.setAnnotationText(""); eeg.setIsAddingAnnotation(false);
  };

  // Keyboard: Arrow=scroll, Enter=annotation. Spacebar (play/pause) and d/a
  // (1-sec step) are owned by useEEGState's handler — not duplicated here.
  const annotationDraftRef = useRef(null);
  const epochStartRef = useRef(eeg.epochStart);
  const epochSecKbRef = useRef(eeg.epochSec);
  const setIsAddingAnnotationRef = useRef(eeg.setIsAddingAnnotation);
  const setAnnotationDraftRef = useRef(eeg.setAnnotationDraft);
  useEffect(() => { annotationDraftRef.current = eeg.annotationDraft; }, [eeg.annotationDraft]);
  useEffect(() => { epochStartRef.current = eeg.epochStart; }, [eeg.epochStart]);
  useEffect(() => { epochSecKbRef.current = eeg.epochSec; }, [eeg.epochSec]);
  useEffect(() => { setIsAddingAnnotationRef.current = eeg.setIsAddingAnnotation; });
  useEffect(() => { setAnnotationDraftRef.current = eeg.setAnnotationDraft; });

  // Smooth, velocity-based epoch scrolling for the arrow keys. A quick tap nudges
  // one second; holding glides continuously via requestAnimationFrame with a
  // delta-time-normalized advance, so the trace scrolls fluidly AND at a constant
  // speed regardless of frame rate (slow frames advance proportionally further
  // rather than stuttering at a fixed cadence). currentEpoch is a float, so the
  // viewer renders a smoothly sliding window.
  useEffect(() => {
    let intervalId = null;
    let dir = 0;            // -1 = left, +1 = right, 0 = idle
    let lastTs = 0;
    let holdStart = 0;
    const TICK_MS = 22;               // ~45 fps glide driver (setInterval keeps ticking
                                      //   even when the tab loses compositing focus, unlike rAF)
    const HOLD_DELAY_MS = 190;        // tap-vs-hold threshold before gliding kicks in
    const GLIDE_EEG_SEC_PER_SEC = 10; // scroll speed while holding (EEG-seconds / wall-second)

    const clampStep = (deltaEpochs) => {
      setCurrentEpochRef.current(p => {
        const max = Math.max(0, totalEpochsRef.current - 1);
        return Math.min(Math.max(p + deltaEpochs, 0), max);
      });
    };

    const stopGlide = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } dir = 0; };

    const startGlide = () => {
      if (intervalId) clearInterval(intervalId);
      lastTs = performance.now();
      intervalId = setInterval(() => {
        if (!dir) return;
        const now = performance.now();
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        // Delta-time advance: velocity stays constant (EEG-sec/wall-sec) even if the
        // timer is throttled, so the scroll feels stable rather than stuttering.
        if (now - holdStart >= HOLD_DELAY_MS) {
          const epPerSec = GLIDE_EEG_SEC_PER_SEC / (epochSecRef.current || 10);
          clampStep(dir * epPerSec * dt);
        }
      }, TICK_MS);
    };

    const onKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!annotationDraftRef.current) {
          const t = epochStartRef.current + epochSecKbRef.current / 2;
          pausePlaybackRef.current?.();
          setIsAddingAnnotationRef.current(true);
          setAnnotationDraftRef.current({ time: Math.round(t * 100) / 100, duration: 0.2, x: 200, y: 100 });
          setShowAnnotations(true);
        }
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      if (e.repeat) return;          // ignore OS key-repeat; our timer drives the glide
      pausePlaybackRef.current?.();
      const d = e.key === "ArrowRight" ? 1 : -1;
      // Immediate 1-second nudge so a quick tap still steps crisply
      const nudge = (epochSecRef.current > 0 ? 1 / epochSecRef.current : 1) * d;
      clampStep(nudge);
      dir = d;
      holdStart = performance.now();
      startGlide();
    };
    const onKeyUp = (e) => {
      if ((e.key === "ArrowRight" && dir === 1) || (e.key === "ArrowLeft" && dir === -1)) {
        stopGlide();
      }
    };
    // Releasing focus (alt-tab, etc.) should stop a held glide so it doesn't run away.
    const onBlur = () => stopGlide();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (intervalId) clearInterval(intervalId);
    };
  }, []); // stable — all values via refs

  // Auto-verify pending records when opened for review
  useEffect(() => {
    if (record && record.status === "pending") {
      updateRecordStatus(record.id, "verified");
    }
  }, [record?.id]);

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* Multi-file tabs — always visible */}
      {openTabs.length >= 1 && (
        <div style={{display:"flex",alignItems:"center",gap:0,padding:"0 16px",borderBottom:"1px solid #1a1a1a",background:"#080808",overflow:"hidden",flexShrink:0}}>
          {openTabs.map((tab, idx) => {
            const isActive = idx === activeTabIdx;
            const tabName = tab.filename || "Unknown";
            const display = tabName.length > 30 ? tabName.slice(0, 27) + "..." : tabName;
            const patHash = extractPatientHash(tabName);
            const subId = extractSubjectId(tabName);
            // Deterministic color from patient hash so same patient = same color badge
            const hashColor = patHash ? `hsl(${(parseInt(patHash, 16) % 360)}, 60%, 55%)` : null;
            return (
              <div key={tab.filename || idx} onClick={()=>switchToTab(idx)}
                onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background="#111"}}
                onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background="transparent"}}
                style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",cursor:"pointer",
                  background:isActive?"#1a2a30":"transparent",borderBottom:isActive?"2px solid #7ec8d9":"2px solid transparent",
                  borderRight:"1px solid #1a1a1a",transition:"background 0.1s",maxWidth:260,minWidth:0}}>
                <span style={{width:6,height:6,borderRadius:"50%",flexShrink:0,
                  background:!edfFileStore?.[tab.filename]&&tab.fileType!=="simulated"&&!tab.isSimulated?"#ef4444":tab.isTest?"#3b82f6":tab.isAcquired?"#22c55e":"#eab308"}}/>
                {subId && <span style={{fontSize:8,fontWeight:700,color:hashColor||"#888",fontFamily:"'IBM Plex Mono', monospace",
                  background:`${hashColor||"#888"}15`,padding:"1px 4px",borderRadius:2,flexShrink:0,letterSpacing:"0.05em"}}
                  title={`Patient: ${subId} (${patHash||"?"})`}>{subId}</span>}
                <span style={{fontSize:10,color:isActive?"#7ec8d9":"#666",fontWeight:isActive?700:400,
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={tabName}>{display}</span>
                <span onClick={e=>closeTab(idx,e)}
                  onMouseEnter={e=>e.currentTarget.style.color="#EF4444"}
                  onMouseLeave={e=>e.currentTarget.style.color="#444"}
                  role="button" aria-label={`Close tab ${tabName}`} tabIndex={0}
                  onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();closeTab(idx,e);}}}
                  style={{fontSize:12,color:"#444",cursor:"pointer",display:"flex",alignItems:"center",padding:"0 2px",lineHeight:1}}
                  title="Close tab">&times;</span>
              </div>
            );
          })}
          {/* Quick-load: opens the file picker to add another recording as a tab
              (an alternate pathway to opening files from the Library). */}
          <button onClick={()=>setShowFilePicker(true)} title="Open another recording in a new tab"
            data-tut="Add tab: Quickly load another recording into Review as a new tab, without going back to the Library."
            aria-label="Open another recording in a new tab"
            style={{background:"transparent",border:"none",color:"#7ec8d9",cursor:"pointer",
              padding:"4px 10px",fontSize:15,fontWeight:700,lineHeight:1,flexShrink:0,display:"flex",alignItems:"center"}}
            onMouseEnter={e=>e.currentTarget.style.color="#a8e0ec"}
            onMouseLeave={e=>e.currentTarget.style.color="#7ec8d9"}>+</button>
          <span style={{fontSize:9,color:"#333",padding:"0 8px",flexShrink:0}}>{openTabs.length}/5</span>
        </div>
      )}

      {/* Empty state — no file loaded */}
      {!record && openTabs.length === 0 && (
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20,color:"#555"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
            {I.Brain(48)}
            <div style={{fontSize:14,fontWeight:700,color:"#666",letterSpacing:"0.05em"}}>NO FILE LOADED</div>
            <div style={{fontSize:11,color:"#444",maxWidth:300,textAlign:"center",lineHeight:1.6}}>
              Select a recording from the Library to begin review, or import a new EDF file.
            </div>
          </div>
          <button onClick={()=>setShowFilePicker(true)} style={{
            padding:"10px 24px",background:"#1a2a30",border:"1px solid #4a9bab",borderRadius:0,
            color:"#7ec8d9",fontSize:12,fontWeight:700,cursor:"pointer",
            fontFamily:"'IBM Plex Mono', monospace",letterSpacing:"0.05em",
            display:"flex",alignItems:"center",gap:8,transition:"all 0.15s",
          }}>{I.Upload(16)} Select File to Review</button>
        </div>
      )}

      {record && (<>
      {!toolbarCollapsed ? (<>
      {/* File info bar */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 16px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",fontSize:10,color:"#555"}}>
        {/* File type dot */}
        {record && <span title={!edfData&&record.fileType!=="simulated"&&!record.isSimulated?"No EDF data":record.isTest?"Test":record.isAcquired?"Recorded":"Imported"}
          style={{display:"inline-block",width:9,height:9,borderRadius:"50%",flexShrink:0,
            background:!edfData&&record.fileType!=="simulated"&&!record.isSimulated?"#ef4444":record.isTest?"#3b82f6":record.isAcquired?"#22c55e":"#eab308"}}/>}
        <span onClick={()=>setShowFilePicker(!showFilePicker)} style={{
          color:"#7ec8d9",fontWeight:700,cursor:"pointer",textDecoration:"underline",textDecorationStyle:"dotted",
          textUnderlineOffset:3,transition:"color 0.15s",
        }} title="Click to open another file">{filename}</span>
        <button onClick={handleSaveBundle} title="Save bundle (.reegb): EDF + annotations + notes + baseline link" style={{
          background:"#111",border:"1px solid #2a2a2a",color:"#7ec8d9",fontSize:9,fontWeight:700,
          padding:"3px 8px",cursor:"pointer",fontFamily:"'IBM Plex Mono', monospace",letterSpacing:"0.05em",
        }}>SAVE</button>
        <span style={{color:"#333"}}>|</span><span>{eeg.sampleRate}Hz</span>
        <span style={{color:"#333"}}>|</span><span>{eeg.channels.length}ch</span>
        {eeg.hiddenChannels.size > 0 && <span style={{color:"#F59E0B"}}>({eeg.hiddenChannels.size} hidden)</span>}
        <span style={{color:"#333"}}>|</span><span>{edfData ? `${Math.floor(edfData.totalDuration/60)}:${String(Math.floor(edfData.totalDuration%60)).padStart(2,"0")}` : "10:00"}</span>
        <span style={{color:"#333"}}>|</span>
        <span style={{color:edfData?"#10B981":"#ef4444",fontWeight:700}}>{edfData?"EDF":"NO DATA"}</span>
        {edfData && (
          <button data-tut="Raw EDF: A read-only inventory of every signal in the .edf — label, electrode, type, sample rate, units and a σ-based 'has signal' dot — so you can see exactly what data is available." onClick={(e)=>{e.stopPropagation();setShowRawEdf(p=>!p);}}
            title="Raw EDF — inventory of every signal in this file" style={{
            background:showRawEdf?"#1a2a30":"#111",border:`1px solid ${showRawEdf?"#4a9bab":"#2a2a2a"}`,color:"#7ec8d9",fontSize:9,fontWeight:700,
            padding:"2px 6px",cursor:"pointer",fontFamily:"'IBM Plex Mono', monospace",letterSpacing:"0.05em",display:"inline-flex",alignItems:"center",gap:3}}>
            {I.List(10)} RAW
          </button>
        )}
        <div style={{flex:1}}/>
        {record && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:9,color:"#444",fontWeight:600,letterSpacing:"0.08em"}}>STATUS</span>
            <StatusControl status={record.status} size="normal"
              onSetStatus={(s) => updateRecordStatus(record.id, s)}/>
          </div>
        )}
      </div>

      {/* File picker dropdown */}
      {showFilePicker && records && (
        <div style={{position:"relative",zIndex:50}}>
          <div style={{position:"absolute",left:16,top:0,width:500,maxHeight:300,overflow:"auto",
            background:"#111",border:"1px solid #2a2a2a",borderRadius:0}}>
            <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",fontSize:10,color:"#666",fontWeight:700,letterSpacing:"0.08em"}}>
              SELECT FILE TO REVIEW
            </div>
            {records.map(r => (
              <button key={r.id} onClick={()=>{onSelectRecord(r);setShowFilePicker(false);}} style={{
                display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",
                padding:"8px 12px",background:r.id===record?.id?"#1a2a30":"transparent",
                border:"none",cursor:"pointer",borderBottom:"1px solid #111",transition:"background 0.1s",
                color:"#ccc",fontFamily:"'IBM Plex Mono', monospace",fontSize:11,
              }} onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
                 onMouseLeave={e=>e.currentTarget.style.background=r.id===record?.id?"#1a2a30":"transparent"}>
                <span style={{display:"flex",alignItems:"center",gap:6}}>
                  <span title={!edfFileStore?.[r.filename]&&r.fileType!=="simulated"&&!r.isSimulated?"No EDF data":r.isTest?"Test":r.isAcquired?"Recorded":"Imported"} style={{display:"inline-block",width:7,height:7,borderRadius:"50%",flexShrink:0,
                    background:!edfFileStore?.[r.filename]&&r.fileType!=="simulated"&&!r.isSimulated?"#ef4444":r.isTest?"#3b82f6":r.isAcquired?"#22c55e":"#eab308"}}/>
                  <span style={{color:"#7ec8d9"}}>{r.filename}</span>
                </span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <StatusBadge status={r.status}/>
                  <span style={{color:"#555"}}>{r.date}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
        {/* Toolbar — two rows: waveform management (top) and analysis/review (bottom). */}
        <div style={{display:"flex",flexDirection:"column",gap:6,padding:"8px 16px",borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexShrink:0}}>
          {/* Row 1 — waveform management */}
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
            <button title={eeg.montage.startsWith(CUSTOM_MONTAGE_PREFIX) ? "Edit this custom montage" : "Build a custom bipolar montage"}
              data-tut="Montage builder: Create a bipolar montage from any two electrodes. Saved montages persist and are reusable across recordings."
              onClick={(e)=>{e.stopPropagation();eeg.setShowMontageBuilder(p=>!p);}}
              style={controlBtn(eeg.showMontageBuilder)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Edit(12)} {eeg.montage.startsWith(CUSTOM_MONTAGE_PREFIX) ? "Edit Montage" : "Build Montage"}</span>
            </button>
            <div style={{position:"relative"}}>
              <button data-tut="Show or hide individual channels. The green dot on the right of each row means that channel has signal in this EDF; a hollow dot means no data." onClick={(e)=>{e.stopPropagation();setShowChannelPicker(p=>!p);}} style={{...controlBtn(showChannelPicker),
                color:eeg.hiddenChannels.size>0?"#F59E0B":"#888",border:`1px solid ${eeg.hiddenChannels.size>0?"#F59E0B40":"#222"}`}}>
                <span style={{display:"flex",alignItems:"center",gap:4}}>
                  {I.Eye(12)} Channels {eeg.hiddenChannels.size>0?`(${eeg.allChannels.length-eeg.hiddenChannels.size}/${eeg.allChannels.length})`:""}
                </span>
              </button>
              {showChannelPicker && (<>
                <div style={{position:"fixed",inset:0,zIndex:1499}} onClick={()=>setShowChannelPicker(false)}/>
                <div style={{position:"absolute",top:"100%",left:0,zIndex:1500,background:"#111",border:"1px solid #2a2a2a",padding:"6px 0",minWidth:180,maxHeight:360,overflowY:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.8)"}}
                  onClick={e=>e.stopPropagation()}>
                  <div style={{display:"flex",gap:4,padding:"4px 8px",borderBottom:"1px solid #1a1a1a",marginBottom:4}}>
                    <button onClick={()=>{eeg.allChannels.forEach(ch=>{if(eeg.hiddenChannels.has(ch))eeg.toggleChannelVisibility(ch)});}} style={{fontSize:8,padding:"2px 6px",background:"#1a2a30",border:"1px solid #4a9bab40",color:"#7ec8d9",cursor:"pointer",fontWeight:700}}>ALL</button>
                    <button onClick={()=>{eeg.allChannels.forEach(ch=>{if(!eeg.hiddenChannels.has(ch))eeg.toggleChannelVisibility(ch)});}} style={{fontSize:8,padding:"2px 6px",background:"#1a1010",border:"1px solid #ef444440",color:"#f87171",cursor:"pointer",fontWeight:700}}>NONE</button>
                    <button onClick={()=>{const eegOnly=eeg.allChannels.filter(c=>!/EKG|LOC|ROC/i.test(c));eeg.allChannels.forEach(ch=>{const want=eegOnly.includes(ch);const hid=eeg.hiddenChannels.has(ch);if(want&&hid)eeg.toggleChannelVisibility(ch);if(!want&&!hid)eeg.toggleChannelVisibility(ch);});}} style={{fontSize:8,padding:"2px 6px",background:"#111",border:"1px solid #222",color:"#888",cursor:"pointer",fontWeight:700}}>EEG</button>
                  </div>
                  {eeg.allChannels.map(ch => {
                    const vis = !eeg.hiddenChannels.has(ch);
                    const isAux = /EKG|LOC|ROC/i.test(ch);
                    const hasData = eeg.channelsWithData.has(ch);
                    return (
                      <div key={ch} onClick={()=>eeg.toggleChannelVisibility(ch)}
                        style={{display:"flex",alignItems:"center",gap:6,padding:"3px 10px",cursor:"pointer",fontSize:10,fontFamily:"'IBM Plex Mono',monospace",
                          color:vis?(isAux?"#F59E0B":"#ccc"):"#444",background:vis?"transparent":"#0a0a0a"}}
                        onMouseEnter={e=>e.currentTarget.style.background=vis?"#1a1a1a":"#111"}
                        onMouseLeave={e=>e.currentTarget.style.background=vis?"transparent":"#0a0a0a"}>
                        <span style={{width:14,height:14,border:`1px solid ${vis?"#4a9bab":"#333"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:vis?"#7ec8d9":"transparent",flexShrink:0}}>✓</span>
                        <span style={{fontWeight:600}}>{ch}</span>
                        {/* Data-availability dot — green = real EDF data present for this
                            derivation, hollow grey = no matching signal in the file. Lets you
                            tell at a glance whether a hidden channel actually has data. */}
                        <span style={{flex:1}}/>
                        <span title={hasData ? "EEG data present in EDF" : "No matching signal in EDF"}
                          style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
                            background:hasData?"#22c55e":"transparent",
                            border:hasData?"none":"1px solid #444"}}/>
                      </div>
                    );
                  })}
                </div>
              </>)}
            </div>
            <button data-tut="Denoise: Applies wavelet denoising to smooth out high-frequency noise from every trace while keeping sharp spikes and transients intact. Toggle on or off." onClick={(e)=>{e.stopPropagation();eeg.setWaveletDenoise(prev=>!prev);}} style={controlBtn(eeg.waveletDenoise)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Waves()} Denoise</span>
            </button>
            <button data-tut="ICA Clean: Uses the eye and EKG reference channels to identify and subtract blink and heartbeat artifacts from the EEG, leaving cleaner brain signal." onClick={(e)=>{e.stopPropagation();eeg.setIcaClean(prev=>!prev);}} style={controlBtn(eeg.icaClean)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Zap()} ICA Clean</span>
            </button>
            <button data-tut="Pattern Table: Opens an NK-style trace configuration where you choose which derivations are drawn and in what order on the page." onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
            </button>
          </div>
          {/* Row 2 — analysis & review */}
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
            <button data-tut="qEEG: A quantitative analysis panel showing band powers, peak alpha frequency, theta/beta ratio and left-right asymmetry for the current epoch." onClick={(e)=>{e.stopPropagation();setShowAnalysis(prev => !prev);}} style={controlBtn(showAnalysis)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.BarChart()} qEEG</span>
            </button>
            <button data-tut="Compliance: Checks this recording's duration, channel count, impedances and PHI against protocol standards. The number in the label is how many checks failed." onClick={(e)=>{e.stopPropagation();setShowCompliance(prev => !prev);}} style={controlBtn(showCompliance)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Shield()} Compliance{record?.complianceResult?.failCount > 0 ? ` (${record.complianceResult.failCount})` : ""}</span>
            </button>
            <button data-tut="Impedance: Shows per-electrode impedance read from the EDF, if the recording stored it. Impedance is a dynamic value measured at acquisition; the compliance cutoff is ≤ 5 kΩ." onClick={(e)=>{e.stopPropagation();setShowRevImpedance(true);}} style={controlBtn()}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Zap(12)} Impedance{edfData?.impedances?.length ? ` (${edfData.impedances.length})` : ""}</span>
            </button>
            <button data-tut="Data Sheet: Generates a printable single-page summary — metadata, band powers and topography — in a new window, ready to print or save as PDF." onClick={(e)=>{
              e.stopPropagation();
              if (!record) return;
              const html = generateDataSheetHTML(record, edfData);
              const win = window.open("", "_blank", "width=900,height=1100");
              if (!win) { notify("Pop-up blocked — allow pop-ups for this site to generate the Data Sheet.", "warn"); return; }
              win.document.write(html);
              win.document.close();
              // Give the browser a beat to render before invoking print
              setTimeout(() => { try { win.focus(); win.print(); } catch (err) {} }, 350);
            }} title="Generate single-page Data Sheet (opens in new window, ready to print)"
              style={controlBtn()}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Save(12)} Data Sheet</span>
            </button>
            <button data-tut="Compare: Differential comparison — pick a baseline recording, then the file to compare it against. The two are aligned chronologically (earlier = baseline) and their frequency-band, peak-alpha and eye-sync changes are shown before → after." onClick={(e)=>{e.stopPropagation();setShowCompare(prev => !prev);}} style={controlBtn(showCompare)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.GitCompare()} Compare</span>
            </button>
            <button data-tut="Topo: Displays a topographic map of frequency power across different areas of the head for the current epoch — a scalp heat map of voltage or band power." onClick={(e)=>{e.stopPropagation();setShowTopo(prev => !prev);}} style={controlBtn(showTopo)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>Topo</span>
            </button>
            <button data-tut="STFT: A spectrogram view of one channel — shows how its frequency content changes over time across the epoch (time on X, frequency on Y, power as color)." onClick={(e)=>{e.stopPropagation();setShowSpectrogram(prev => !prev);}} style={controlBtn(showSpectrogram)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Zap()} STFT</span>
            </button>
            <button data-tut="Measure: Drag a box across the trace to read back its duration, peak-to-peak amplitude and dominant frequency band for that selection." onClick={(e)=>{e.stopPropagation();if(eeg.isMeasuring){eeg.setIsMeasuring(false);eeg.setMeasureSel(null);eeg.measureDragRef.current=null;}else{eeg.setIsMeasuring(true);eeg.setMeasureSel(null);eeg.setIsAddingAnnotation(false);}}} style={controlBtn(eeg.isMeasuring)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Ruler()} Measure</span>
            </button>
            <button data-tut="Annotations: Opens the marker list and lets you place event marks (spike, seizure, artifact and more) on the trace. The count shows how many exist on this recording." onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
            </button>
            <button ref={notesBtnRef} data-tut="Notes: Free-text clinical notes for this recording (injury, context, impressions). Opens a small panel anchored just beneath this button." onClick={(e)=>{
              e.stopPropagation();
              const willOpen = !showClinicalNotes;
              if (willOpen) anchorNotesPanel(); // anchor next to this button
              setShowClinicalNotes(willOpen);
            }} style={controlBtn(showClinicalNotes)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Edit()} Notes</span>
            </button>
          </div>
        </div>
        <div onClick={()=>setToolbarCollapsed(true)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#111"}
          style={{height:14,background:"#111",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9650;</span>
        </div>
      </>) : (
        <div onClick={()=>setToolbarCollapsed(false)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#151515"}
          style={{height:20,background:"#151515",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9660;</span>
        </div>
      )}
      {/* Combined dropdowns + scrubber bar — montage and filter settings live here, alongside the scroll bar */}
      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochSec={eeg.epochSec} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}
        totalDuration={eeg.totalDuration}
        isPlaying={eeg.isPlaying} onPlayPause={eeg.togglePlayback}
        leftContent={<>
          <select title="EEG System" data-tut="EEG System: Chooses the electrode placement standard used to interpret the file (10-20, 10-10, high-density, or a custom lead set)." value={eeg.eegSystem} onChange={e=>eeg.setEegSystem(e.target.value)}
            style={{...selectStyle,width:eeg.eegSystem==="custom"?120:140}}>
            {Object.entries(EEG_SYSTEMS).map(([k,v])=>{
              // The recording's system is stored on record.montage (e.g. "10-20"/"hd-40"/"10-10").
              const recSys = record?.eegSystem || record?.montage || "10-20";
              const disabled = !canViewInSystem(recSys, k);
              return <option key={k} value={k} disabled={disabled}>{v.label}{disabled?" (insufficient data)":""}</option>;
            })}
          </select>
          {eeg.eegSystem === "custom" && (
            <button onClick={()=>eeg.setShowCustomPicker(true)} title="Configure custom leads"
              style={{padding:"3px 6px",background:"#111",border:"1px solid #4a9bab",borderRadius:2,color:"#7ec8d9",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:3}}>
              {I.Edit(10)}
            </button>
          )}
          <select title="Montage: Sets how channels are derived and arranged. Presets, plus file-derived options (adaptive double-banana built from the electrodes present, and 'as recorded' which shows the file's own signals) and any custom montages you build." data-tut="Montage: Sets how channels are derived and arranged — e.g. bipolar longitudinal (banana), referential, or transverse. The 'From file' group adapts to this recording: an adaptive double-banana built from the electrodes present, and 'as recorded' showing the file's own signals. Custom montages you build appear at the bottom." value={eeg.montage} onChange={e=>eeg.setMontage(e.target.value)} style={{...selectStyle,width:200}}>
            {Object.entries(MONTAGE_DEFS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            {edfData && (
              <optgroup label="From file">
                <option value={MONTAGE_ADAPTIVE}>Adaptive Double-Banana</option>
                <option value={MONTAGE_AS_RECORDED}>As Recorded{edfHasDerivedLabels(edfData) ? " (montaged)" : ""}</option>
              </optgroup>
            )}
            {eeg.customMontages.length > 0 && (
              <optgroup label="Custom montages">
                {eeg.customMontages.map(m=><option key={m.id} value={CUSTOM_MONTAGE_PREFIX+m.id}>{m.name} ({m.pairs.length} ch)</option>)}
              </optgroup>
            )}
          </select>
          {/* Montage builder button moved to the toolbar row, in front of Channels */}
          <select title="LFF (Hz)" data-tut="LFF (Low-Frequency Filter): The high-pass cutoff — frequencies below this are attenuated to remove slow drift. Lower values (down to 0.01 Hz) preserve slow waves for research." value={eeg.hpf} onChange={e=>eeg.setHpf(parseFloat(e.target.value))} style={selectStyle}>
            {LFF_OPTIONS.map(v=><option key={v} value={v}>LFF {v===0?"Off":`${v} Hz`}</option>)}
          </select>
          <select title="HFF (Hz)" data-tut="HFF (High-Frequency Filter): The low-pass cutoff — frequencies above this are attenuated to remove muscle and high-frequency noise (up to 200 Hz for research-grade data)." value={eeg.lpf} onChange={e=>eeg.setLpf(parseFloat(e.target.value))} style={selectStyle}>
            {HFF_OPTIONS.map(v=><option key={v} value={v}>HFF {v===0?"Off":`${v} Hz`}</option>)}
          </select>
          <select title="Notch" data-tut="Notch: A narrow filter that removes electrical mains interference — set 50 Hz or 60 Hz to match your region's power line frequency." value={eeg.notch} onChange={e=>eeg.setNotch(parseFloat(e.target.value))} style={selectStyle}>
            <option value={0}>Notch Off</option><option value={50}>Notch 50 Hz</option><option value={60}>Notch 60 Hz</option>
          </select>
          <select title="Epoch length" data-tut="Epoch length: How many seconds of EEG are shown per page. Shorter epochs zoom in on detail; longer epochs show more context at once." value={eeg.epochSec} onChange={e=>eeg.setEpochSec(parseInt(e.target.value))} style={selectStyle}>
            {[5,10,15,20,30].map(v=><option key={v} value={v}>Epoch {v}s</option>)}
          </select>
          <span title="Sensitivity (mm/μV) — ↑/↓ arrow keys" data-tut="Sensitivity: Vertical gain of the traces in mm/µV. Increase to amplify low-voltage signals, decrease to keep high-amplitude traces from overlapping. Adjust with the ↑/↓ arrow keys." style={{display:"inline-flex",alignItems:"center",gap:4}}>
            <button onClick={()=>eeg.setSensitivity(p=>Math.max(p-1,SENSITIVITY_MIN))} style={controlBtn()} title="Decrease sensitivity">{I.ZoomOut()}</button>
            <span style={{fontSize:11,color:"#888",minWidth:32,textAlign:"center"}}>Sens {eeg.sensitivity}</span>
            <button onClick={()=>eeg.setSensitivity(p=>Math.min(p+1,SENSITIVITY_MAX))} style={controlBtn()} title="Increase sensitivity">{I.ZoomIn()}</button>
          </span>
          <span style={{color:"#333"}}>|</span>
        </>}/>
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <WaveformCanvas eeg={eeg} playbackAbsSec={eeg.playbackAbsSec} isPlaying={eeg.isPlaying}>
          <AnnotationPopup draft={eeg.annotationDraft} annotationType={eeg.selectedAnnotationType}
            text={eeg.annotationText} setText={eeg.setAnnotationText} onConfirm={eeg.confirmAnnotation}
            onCancel={()=>{eeg.setAnnotationDraft(null);eeg.setIsAddingAnnotation(false);}} containerRef={eeg.containerRef}/>
        </WaveformCanvas>
      </div>

      {/* Dedicated bottom navigator — whole-file spectrogram + markers + click-to-seek */}
      <ReviewScrubBar edfData={edfData} annotations={annotations}
        totalDuration={eeg.totalDuration} totalEpochs={eeg.totalEpochs} epochSec={eeg.epochSec}
        currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        playbackAbsSec={eeg.playbackAbsSec} isPlaying={eeg.isPlaying}/>

      {/* Floating annotation panel */}
      {showAnnotations && (
        <AnnotationPanel annotations={annotations} setAnnotations={setAnnotations}
          isAddingAnnotation={eeg.isAddingAnnotation} setIsAddingAnnotation={eeg.setIsAddingAnnotation}
          selectedAnnotationType={eeg.selectedAnnotationType} setSelectedAnnotationType={eeg.setSelectedAnnotationType}
          annotationConfidence={eeg.annotationConfidence} setAnnotationConfidence={eeg.setAnnotationConfidence}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} epochSec={eeg.epochSec}
          setCurrentEpoch={eeg.setCurrentEpoch} filename={filename}
          onClose={()=>setShowAnnotations(false)}
          panelPos={annotationPanelPos} setPanelPos={setAnnotationPanelPos}/>
      )}

      {/* Floating qEEG analysis panel */}
      {showAnalysis && (
        <QuantAnalysisPanel waveformData={eeg.waveformData} channels={eeg.channels}
          sampleRate={eeg.sampleRate} epochSec={eeg.epochSec} epochStart={eeg.epochStart}
          onClose={()=>setShowAnalysis(false)}
          panelPos={analysisPanelPos} setPanelPos={setAnalysisPanelPos}/>
      )}

      {/* Floating protocol-compliance panel */}
      {showCompliance && (
        <CompliancePanel result={record?.complianceResult} filename={filename}
          onClose={()=>setShowCompliance(false)}
          onRecompute={()=>{
            if (!record || !setRecords) return;
            const result = checkProtocolCompliance(record, edfData || null);
            setRecords(prev => prev.map(r => r.id === record.id ? { ...r, complianceResult: result } : r));
          }}
          panelPos={compliancePanelPos} setPanelPos={setCompliancePanelPos}/>
      )}

      {/* Review impedance viewer — read-only, from EDF (if present) */}
      {showRevImpedance && (
        <ImpedancePanel impedances={edfData?.impedances || []} readOnly
          onClose={()=>setShowRevImpedance(false)} onAccept={()=>setShowRevImpedance(false)}/>
      )}

      {/* Raw EDF inspector — full signal inventory */}
      {showRawEdf && (
        <RawEdfPanel edfData={edfData} channels={edfInfo.channels} filename={filename}
          onClose={()=>setShowRawEdf(false)} panelPos={rawEdfPanelPos} setPanelPos={setRawEdfPanelPos}/>
      )}

      {/* Floating differential comparison panel (baseline → comparison) */}
      {showCompare && (
        <ComparePanel records={records} edfFileStore={edfFileStore}
          onClose={()=>setShowCompare(false)}
          panelPos={comparePanelPos} setPanelPos={setComparePanelPos}/>
      )}

      {showTopo && (
        <TopographicPanel waveformData={eeg.waveformData} channels={eeg.channels}
          sampleRate={eeg.sampleRate} epochSec={eeg.epochSec} epochStart={eeg.epochStart}
          onClose={()=>setShowTopo(false)}
          panelPos={topoPanelPos} setPanelPos={setTopoPanelPos}/>
      )}

      {/* Floating spectrogram panel */}
      {showSpectrogram && (
        <SpectrogramPanel waveformData={eeg.waveformData} channels={eeg.channels}
          sampleRate={eeg.sampleRate} epochSec={eeg.epochSec} epochStart={eeg.epochStart}
          onClose={()=>setShowSpectrogram(false)}
          panelPos={spectrogramPanelPos} setPanelPos={setSpectrogramPanelPos}/>
      )}

      {/* Floating clinical notes panel */}
      {showClinicalNotes && (
        <ClinicalNotesPanel notes={clinicalNotesMap[filename]||""} setNotes={(text)=>setClinicalNotesMap(prev=>({...prev,[filename]:text}))}
          filename={filename} onClose={()=>setShowClinicalNotes(false)}
          panelPos={clinicalNotesPanelPos} setPanelPos={setClinicalNotesPanelPos}/>
      )}

      {eeg.showCustomPicker && (
        <CustomElectrodePicker customElectrodes={eeg.customElectrodes}
          setCustomElectrodes={eeg.setCustomElectrodes}
          onClose={()=>eeg.setShowCustomPicker(false)}/>
      )}

      {eeg.showMontageBuilder && (
        <MontageBuilderPanel
          availableElectrodes={edfInfo.presentEeg}
          dataElectrodes={edfInfo.withData}
          customMontages={eeg.customMontages} persistCustomMontages={eeg.persistCustomMontages}
          montage={eeg.montage} setMontage={eeg.setMontage}
          onClose={()=>eeg.setShowMontageBuilder(false)}/>
      )}

      {/* Channel context menu */}
      {eeg.contextMenu && (
        <ChannelContextMenu x={eeg.contextMenu.x} y={eeg.contextMenu.y}
          channelName={eeg.contextMenu.channel}
          isHidden={false}
          channelSens={eeg.channelSensitivity[eeg.contextMenu.channel] || 0}
          chHpf={eeg.channelHpf[eeg.contextMenu.channel]}
          chLpf={eeg.channelLpf[eeg.contextMenu.channel]}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          onToggleVisibility={()=>eeg.toggleChannelVisibility(eeg.contextMenu.channel)}
          onAdjustSensitivity={(d)=>eeg.adjustChannelSensitivity(eeg.contextMenu.channel,d)}
          onSetChHpf={(v)=>{const next={...eeg.channelHpf};if(v===undefined)delete next[eeg.contextMenu.channel];else next[eeg.contextMenu.channel]=v;eeg.setChannelHpf(next);}}
          onSetChLpf={(v)=>{const next={...eeg.channelLpf};if(v===undefined)delete next[eeg.contextMenu.channel];else next[eeg.contextMenu.channel]=v;eeg.setChannelLpf(next);}}
          onClose={()=>eeg.setContextMenu(null)}/>
      )}

      {/* Pattern Table */}
      {showPatternTable && (
        <PatternTable eegSystem={eeg.eegSystem} montage={eeg.montage}
          channels={eeg.channels} allChannels={eeg.allChannels}
          hiddenChannels={eeg.hiddenChannels} toggleChannelVisibility={eeg.toggleChannelVisibility}
          channelSensitivity={eeg.channelSensitivity} adjustChannelSensitivity={eeg.adjustChannelSensitivity}
          channelHpf={eeg.channelHpf} setChannelHpf={eeg.setChannelHpf}
          channelLpf={eeg.channelLpf} setChannelLpf={eeg.setChannelLpf}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          auxWithData={eeg.auxWithData} AUX_CHANNELS={eeg.AUX_CHANNELS}
          onClose={()=>setShowPatternTable(false)}/>
      )}
      </>)}

      {/* File picker overlay — available even in empty state */}
      {showFilePicker && (
        <div style={{position:"fixed",inset:0,background:"#000c",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowFilePicker(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",padding:20,maxHeight:"70vh",overflowY:"auto",width:500}}>
            <div style={{fontSize:12,color:"#7ec8d9",fontWeight:700,marginBottom:12,letterSpacing:"0.05em"}}>SELECT FILE TO REVIEW</div>
            {records.filter(r=>r.hasEdfData||r.fileType==="simulated"||r.isSimulated).map(r => (
              <div key={r.id} onClick={()=>{onSelectRecord(r);setShowFilePicker(false);}}
                style={{padding:"8px 12px",cursor:"pointer",borderBottom:"1px solid #1a1a1a",fontSize:11,color:"#ccc",display:"flex",justifyContent:"space-between",alignItems:"center"}}
                onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span>{r.filename}</span>
                <span style={{fontSize:9,color:"#555"}}>{r.studyType} · {r.sex}{r.age}</span>
              </div>
            ))}
            {records.filter(r=>r.hasEdfData||r.fileType==="simulated"||r.isSimulated).length === 0 && (
              <div style={{padding:16,color:"#555",fontSize:11,textAlign:"center"}}>No files with EDF data available. Import a file from the Library tab.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DEVICE REGISTRY — All supported hardware & protocols
// ══════════════════════════════════════════════════════════════
const DEVICE_PROTOCOLS = {
  brainflow: { label: "OpenBCI", color: "#3B82F6", desc: "Direct board API" },
  websocket: { label: "piEEG / WS", color: "#10B981", desc: "Live stream over local WebSocket bridge" },
  simulated: { label: "Simulated", color: "#F59E0B", desc: "Test signals" },
};

// DEVICE_CATALOG, CONN, CONN_LABELS defined in CONFIGURATION block at top of file

// ── Impedance simulator ──
function generateImpedances(channelCount) {
  const electrodes = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","TP7","TP8","FT9","FT10","PO3","PO4","POz","Oz","Iz","AF3","AF4","AF7","AF8",
    "F1","F2","F5","F6","C1","C2","C5","C6","P1","P2","P5","P6","CPz","FCz","FPz","TP9","TP10","PO7","PO8","P9","P10","Ref","Gnd"];
  return electrodes.slice(0, channelCount).map(name => ({
    name, value: Math.round((0.5 + Math.random() * 4.0) * 10) / 10,
    status: "good",
  }));
}
function generateNoConnectionImpedances(channelCount) {
  const electrodes = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"];
  return electrodes.slice(0, channelCount).map(name => ({ name, value: null, status: "poor" }));
}

// ══════════════════════════════════════════════════════════════
// DEVICE SELECTOR PANEL
// ══════════════════════════════════════════════════════════════
function DeviceSelector({ selectedDevice, setSelectedDevice, connectionState, onConnect, onDisconnect, deviceConfig, setDeviceConfig }) {
  const isConnected = connectionState >= CONN.connected;
  const connInfo = CONN_LABELS[connectionState] || CONN_LABELS[CONN.disconnected];

  return (
    <div style={{borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px"}}>
        {/* Connection status indicator */}
        <div style={{display:"flex",alignItems:"center",gap:6,minWidth:140}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:connInfo.color,
            animation: connectionState===CONN.connecting ? "pulse 1.5s ease infinite" : "none"}}/>
          <span style={{fontSize:11,fontWeight:700,color:connInfo.color,letterSpacing:"0.05em"}}>{connInfo.text}</span>
        </div>

        {/* Device dropdown — flat select */}
        <div style={{flex:1,position:"relative"}}>
          <div style={microLabel}>Input Source</div>
          <select value={selectedDevice?.id||""} onChange={e=>{
            const dev = DEVICE_CATALOG.find(d=>d.id===e.target.value);
            setSelectedDevice(dev||null);
            setDeviceConfig(prev => ({ ...prev,
              sampleRate: dev?.maxSr ? Math.min(256, dev.maxSr) : 256,
              channels: dev?.channels || 19,
              port: dev?.port || "",
              bridgeUrl: dev?.bridgeUrl || prev.bridgeUrl || "ws://localhost:8765",
            }));
          }} style={{...selectStyle,width:"100%",maxWidth:400,padding:"6px 8px",fontSize:12}}>
            {DEVICE_CATALOG.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.channels}ch, {d.maxSr}Hz)
              </option>
            ))}
          </select>
        </div>

        {/* Port config for brainflow devices */}
        {selectedDevice && selectedDevice.protocol === "brainflow" && !selectedDevice.wireless && (
          <div><div style={microLabel}>Port</div>
            <input value={deviceConfig.port} onChange={e=>setDeviceConfig({...deviceConfig,port:e.target.value})}
              placeholder="COM3" style={{...selectStyle,width:80,padding:"5px 8px"}}/></div>
        )}

        {/* Bridge URL for WebSocket devices (piEEG) */}
        {selectedDevice && selectedDevice.protocol === "websocket" && (
          <div><div style={microLabel}>Bridge URL</div>
            <input value={deviceConfig.bridgeUrl||""} onChange={e=>setDeviceConfig({...deviceConfig,bridgeUrl:e.target.value})}
              placeholder="ws://localhost:8765" title="Local Python/BrainFlow → WebSocket bridge that streams piEEG samples"
              style={{...selectStyle,width:180,padding:"5px 8px"}}/></div>
        )}

        {/* Action buttons */}
        <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
          {!isConnected ? (
            <button onClick={onConnect} disabled={!selectedDevice||connectionState===CONN.connecting} style={{
              padding:"6px 14px",background:selectedDevice?"#0a2a0a":"#1a1a1a",
              border:`1px solid ${selectedDevice?"#4a9bab40":"#333"}`,borderRadius:0,
              color:selectedDevice?"#7ec8d9":"#555",cursor:selectedDevice?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Zap()} CONNECT</button>
          ) : (
            <button onClick={onDisconnect} style={{
              padding:"6px 14px",background:"#111",border:"1px solid #EF444440",borderRadius:0,
              color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.X()} DISCONNECT</button>
          )}
        </div>
      </div>

      {/* Device info strip when connected */}
      {isConnected && selectedDevice && (
        <div style={{display:"flex",alignItems:"center",gap:16,padding:"6px 16px",borderTop:"1px solid #111",background:"#080808",fontSize:10}}>
          <span style={{color:DEVICE_PROTOCOLS[selectedDevice.protocol].color,fontWeight:700}}>
            {DEVICE_PROTOCOLS[selectedDevice.protocol].label}
          </span>
          <span style={{color:"#666"}}>{selectedDevice.name}</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{deviceConfig.sampleRate}Hz</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{selectedDevice.channels || deviceConfig.channels}ch</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{selectedDevice.resolution}</span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SUBJECT ID INPUT — with naming guide dropdown
// ══════════════════════════════════════════════════════════════
function SubjectIdInput({ value, onChange }) {
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setFocused(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const pattern = /^[A-Z]{2,4}-\d{3,5}$/;
  const isValid = pattern.test(value);
  const hasValue = value.length > 0;
  const segments = value.split("-");
  const prefixPart = segments[0] || "";
  const numPart = segments[1] || "";
  const hasHyphen = value.includes("-");
  const prefixDone = prefixPart.length >= 2 && prefixPart.length <= 4 && /^[A-Z]+$/.test(prefixPart);
  const numStarted = hasHyphen && numPart.length > 0;

  const handleChange = (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, "");
    const parts = raw.split("-");
    if (parts.length > 2) return;
    onChange(raw);
    if (!touched) setTouched(true);
  };

  const sportsExamples = [
    { prefix: "FB", desc: "Football" },
    { prefix: "SC", desc: "Soccer" },
    { prefix: "BK", desc: "Basketball" },
    { prefix: "HK", desc: "Hockey" },
    { prefix: "BB", desc: "Baseball" },
    { prefix: "TR", desc: "Track & Field" },
    { prefix: "WR", desc: "Wrestling" },
    { prefix: "BX", desc: "Boxing / MMA" },
    { prefix: "SW", desc: "Swimming" },
    { prefix: "VB", desc: "Volleyball" },
    { prefix: "LX", desc: "Lacrosse" },
    { prefix: "RG", desc: "Rugby" },
  ];
  const topExamples = [
    { prefix: "OT", desc: "Other" },
    { prefix: "ST", desc: "Standard" },
    { prefix: "RS", desc: "Research" },
  ];
  const [sportsOpen, setSportsOpen] = useState(false);

  const borderColor = !hasValue ? "#222" : isValid ? "#4a9bab40" : touched ? "#EF444430" : "#222";

  return (
    <div ref={wrapRef} style={{position:"relative",zIndex:40}}>
      <div style={microLabel}>Subject ID</div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input value={value} onChange={handleChange} placeholder="FB-001"
          onFocus={()=>setFocused(true)}
          style={{...selectStyle,width:160,padding:"5px 8px",fontSize:12,border:`1px solid ${borderColor}`,transition:"border-color 0.15s"}}/>
        {hasValue && (
          <span style={{fontSize:9,color:isValid?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace",minWidth:36}}>{hashSubjectId(value)}</span>
        )}
      </div>

      {focused && (
        <div style={{
          position:"absolute",top:"100%",left:0,marginTop:4,
          width:340,background:"#111",border:"1px solid #2a2a2a",borderRadius:0,
          overflow:"hidden",
        }}>
          {/* Format diagram */}
          <div style={{padding:"10px 12px",borderBottom:"1px solid #1a1a1a"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#888",letterSpacing:"0.08em",marginBottom:6}}>NAMING FORMAT</div>
            <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:14,color:"#e0e0e0",marginBottom:8,letterSpacing:"0.05em"}}>
              <span style={{color:prefixDone?"#7ec8d9":hasValue?"#F59E0B":"#555",padding:"2px 4px",background:prefixDone?"#7ec8d910":"transparent",borderRadius:0,transition:"all 0.15s"}}>
                {prefixPart || "XX"}
              </span>
              <span style={{color:hasHyphen?"#666":"#333",margin:"0 1px"}}>-</span>
              <span style={{color:numStarted?(numPart.length>=3?"#7ec8d9":"#F59E0B"):"#555",padding:"2px 4px",background:numPart.length>=3?"#7ec8d910":"transparent",borderRadius:0,transition:"all 0.15s"}}>
                {numPart || "000"}
              </span>
            </div>
            <div style={{display:"flex",gap:16,fontSize:9,color:"#555"}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:0,background:prefixDone?"#7ec8d9":"#333",transition:"background 0.15s"}}/>
                Sport / subject code (2-4 letters)
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:0,background:numPart.length>=3?"#7ec8d9":"#333",transition:"background 0.15s"}}/>
                Subject number (3-5 digits)
              </div>
            </div>
          </div>

          {/* Quick-fill sport codes */}
          <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",maxHeight:220,overflow:"auto"}}>
            <div style={{fontSize:9,fontWeight:700,color:"#555",letterSpacing:"0.08em",marginBottom:6}}>SUBJECT CODES — click to apply</div>

            {/* Top-level: OT, ST, RS */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3,marginBottom:6}}>
              {topExamples.map(ex => (
                <button key={ex.prefix} onClick={()=>onChange(ex.prefix+"-"+(numPart||""))}
                  style={{
                    display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"5px 8px",background:prefixPart===ex.prefix?"#1a2a30":"#0a0a0a",
                    border:`1px solid ${prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}`,borderRadius:0,
                    cursor:"pointer",transition:"all 0.1s",
                  }}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#333"}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}>
                  <span style={{fontSize:11,fontWeight:700,color:prefixPart===ex.prefix?"#7ec8d9":"#aaa",fontFamily:"'IBM Plex Mono', monospace"}}>{ex.prefix}</span>
                  <span style={{fontSize:10,color:"#555"}}>{ex.desc}</span>
                </button>
              ))}
            </div>

            {/* Sports subfolder */}
            <button onClick={()=>setSportsOpen(p=>!p)} style={{
              width:"100%",display:"flex",alignItems:"center",gap:6,padding:"5px 8px",
              background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:0,cursor:"pointer",marginBottom:sportsOpen?4:0,
              color:"#888",fontSize:10,fontWeight:700,letterSpacing:"0.06em",
            }}>
              <span style={{fontSize:9,color:"#444"}}>{sportsOpen?"▼":"▶"}</span>
              {I.Folder()} SPORTS
            </button>
            {sportsOpen && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3,paddingLeft:8}}>
                {sportsExamples.map(ex => (
                  <button key={ex.prefix} onClick={()=>onChange(ex.prefix+"-"+(numPart||""))}
                    style={{
                      display:"flex",alignItems:"center",justifyContent:"space-between",
                      padding:"5px 8px",background:prefixPart===ex.prefix?"#1a2a30":"#0a0a0a",
                      border:`1px solid ${prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}`,borderRadius:0,
                      cursor:"pointer",transition:"all 0.1s",
                    }}
                    onMouseEnter={e=>e.currentTarget.style.borderColor="#333"}
                    onMouseLeave={e=>e.currentTarget.style.borderColor=prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}>
                    <span style={{fontSize:11,fontWeight:700,color:prefixPart===ex.prefix?"#7ec8d9":"#aaa",fontFamily:"'IBM Plex Mono', monospace"}}>{ex.prefix}</span>
                    <span style={{fontSize:10,color:"#555"}}>{ex.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Step-by-step feedback */}
          <div style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:6,minHeight:28}}>
            {!hasValue && <span style={{fontSize:10,color:"#444"}}>Type a sport code or click one above, then add a number</span>}
            {hasValue && !hasHyphen && <span style={{fontSize:10,color:"#F59E0B"}}>Now type a hyphen ( - ) after your sport code</span>}
            {hasHyphen && !numStarted && <span style={{fontSize:10,color:"#F59E0B"}}>Enter a 3-5 digit subject number</span>}
            {hasHyphen && numStarted && numPart.length < 3 && <span style={{fontSize:10,color:"#F59E0B"}}>Need {3 - numPart.length} more digit{3-numPart.length!==1?"s":""}</span>}
            {isValid && (
              <span style={{fontSize:10,color:"#7ec8d9",display:"flex",alignItems:"center",gap:4}}>
                {I.Check(10)} Valid — hashes to <span style={{fontFamily:"'IBM Plex Mono', monospace",fontWeight:700}}>{hashSubjectId(value)}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PATTERN TABLE — NK-style trace configuration for RECORD
// ══════════════════════════════════════════════════════════════
function PatternTable({ eegSystem, montage, channels, allChannels, hiddenChannels, toggleChannelVisibility,
  channelSensitivity, adjustChannelSensitivity, channelHpf, setChannelHpf, channelLpf, setChannelLpf,
  globalHpf, globalLpf, onClose, auxWithData, AUX_CHANNELS }) {

  const hpfOptions = LFF_OPTIONS;
  const lpfOptions = HFF_OPTIONS;

  const regions = [
    { label: "LEFT PARASAGITTAL", filter: ch => /^(Fp1|F3|C3|P3|O1|F1|FC1|C1|CP1|P1)/.test(ch.split("-")[0]) },
    { label: "RIGHT PARASAGITTAL", filter: ch => /^(Fp2|F4|C4|P4|O2|F2|FC2|C2|CP2|P2)/.test(ch.split("-")[0]) },
    { label: "LEFT TEMPORAL", filter: ch => /^(F7|T3|T5|FT9|TP9|AF7|F5|FC5|C5|CP5|F9|FT7|T9|P7)/.test(ch.split("-")[0]) },
    { label: "RIGHT TEMPORAL", filter: ch => /^(F8|T4|T6|FT10|TP10|AF8|F6|FC6|C6|CP6|F10|FT8|T10|P8)/.test(ch.split("-")[0]) },
    { label: "MIDLINE", filter: ch => /^(Fz|Cz|Pz|FCz|CPz|POz|Oz|FPz|Iz)/.test(ch.split("-")[0]) },
    { label: "OTHER", filter: ch => ch === "EKG" || /^(AF3|AF4|PO3|PO4)/.test(ch.split("-")[0]) },
  ];

  const tinySelect = { background:"#0a0a0a",border:"1px solid #222",borderRadius:0,color:"#aaa",fontSize:9,padding:"2px 3px",outline:"none",fontFamily:"'IBM Plex Mono', monospace",width:"100%" };

  const renderAuxChannels = () => {
          const auxChs = allChannels.filter(ch => AUX_CHANNELS.has(ch));
          if (auxChs.length === 0) return null;
          return (
            <div>
              <div style={{padding:"6px 20px",background:"#0d0d0d",borderBottom:"1px solid #111",
                fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em",
                display:"flex",alignItems:"center",gap:8}}>
                AUX CHANNELS (EYE / EKG)
                <span style={{fontSize:8,color:"#444",fontWeight:400}}>— activate to display when no hardware input is present</span>
              </div>
              {auxChs.map(ch => {
                const isHidden = hiddenChannels.has(ch);
                const hasRealData = auxWithData.has(ch);
                const isEKG = ch === "EKG";
                const isEye = !isEKG;
                const sens = channelSensitivity[ch] || 0;
                const chHpfVal = channelHpf[ch];
                const chLpfVal = channelLpf[ch];
                return (
                  <div key={ch} style={{
                    display:"flex",alignItems:"center",padding:"4px 20px",borderBottom:"1px solid #0d0d0d",
                    background:isHidden?"#0a0a0a":"transparent",opacity:isHidden?0.5:1,transition:"all 0.15s",
                  }}>
                    <div style={{width:30,textAlign:"center"}}>
                      <button onClick={()=>toggleChannelVisibility(ch)} style={{
                        width:16,height:16,borderRadius:0,
                        background:isHidden?"#1a1a1a":"#1a4a54",
                        border:`1px solid ${isHidden?"#333":"#4a9bab50"}`,cursor:"pointer",
                        display:"flex",alignItems:"center",justifyContent:"center",
                        color:isHidden?"#555":"#7ec8d9",fontSize:9,
                      }}>{isHidden?" ":"✓"}</button>
                    </div>
                    <span style={{width:34,textAlign:"center",fontSize:9,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{allChannels.indexOf(ch)+1}</span>
                    <span style={{flex:1,fontSize:11,fontWeight:600,fontFamily:"'IBM Plex Mono', monospace",
                      color:isHidden?"#444":isEKG?"#EC4899":"#F59E0B"}}>{ch}</span>
                    {/* Data source badge */}
                    <span style={{
                      fontSize:8,padding:"1px 5px",marginRight:8,fontWeight:700,
                      border:`1px solid ${hasRealData?"#10B98140":"#33333380"}`,
                      color:hasRealData?"#10B981":"#555",background:hasRealData?"#10B98110":"transparent",
                      letterSpacing:"0.06em",
                    }}>{hasRealData ? "LIVE" : "SIM"}</span>
                    <div style={{width:56,display:"flex",justifyContent:"center"}}>
                      <select value={chHpfVal !== undefined ? chHpfVal : ""} onChange={e=>{
                        const v = e.target.value;
                        if (v===""){const next={...channelHpf};delete next[ch];setChannelHpf(next);}
                        else setChannelHpf({...channelHpf,[ch]:parseFloat(v)});
                      }} style={{...tinySelect,color:chHpfVal!==undefined?"#7ec8d9":"#555"}}>
                        <option value="">—</option>
                        {hpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                      </select>
                    </div>
                    <div style={{width:56,display:"flex",justifyContent:"center"}}>
                      <select value={chLpfVal !== undefined ? chLpfVal : ""} onChange={e=>{
                        const v = e.target.value;
                        if (v===""){const next={...channelLpf};delete next[ch];setChannelLpf(next);}
                        else setChannelLpf({...channelLpf,[ch]:parseFloat(v)});
                      }} style={{...tinySelect,color:chLpfVal!==undefined?"#7ec8d9":"#555"}}>
                        <option value="">—</option>
                        {lpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                      </select>
                    </div>
                    <div style={{width:80,display:"flex",alignItems:"center",justifyContent:"center",gap:2}}>
                      <button onClick={()=>adjustChannelSensitivity(ch,-1)} style={{
                        width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                        color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                      }}>−</button>
                      <span style={{fontSize:9,color:sens!==0?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace",
                        minWidth:22,textAlign:"center"}}>{sens>0?`+${sens}`:sens}</span>
                      <button onClick={()=>adjustChannelSensitivity(ch,1)} style={{
                        width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                        color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                      }}>+</button>
                    </div>
                    <div style={{width:40,display:"flex",justifyContent:"center"}}>
                      <div style={{width:20,height:3,background:isEKG?"#EC4899":"#F59E0B",opacity:isHidden?0.15:0.6}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          );
  };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:0,
        width:820,maxHeight:"85vh",overflow:"hidden",display:"flex",flexDirection:"column",
      }}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div>
            <h3 style={{margin:0,color:"#e0e0e0",fontSize:14,fontWeight:700}}>Pattern Table</h3>
            <span style={{fontSize:10,color:"#555"}}>{EEG_SYSTEMS[eegSystem]?.label} — {MONTAGE_DEFS[montage]?.label} — {allChannels.length} traces</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
        </div>

        <div style={{display:"flex",alignItems:"center",padding:"8px 20px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em"}}>
          <span style={{width:30,textAlign:"center"}}>ON</span>
          <span style={{width:34,textAlign:"center"}}>#</span>
          <span style={{flex:1}}>CHANNEL</span>
          <span style={{width:56,textAlign:"center"}}>LFF</span>
          <span style={{width:56,textAlign:"center"}}>HFF</span>
          <span style={{width:80,textAlign:"center"}}>SENSITIVITY</span>
          <span style={{width:40,textAlign:"center"}}>COLOR</span>
        </div>

        <div style={{flex:1,overflow:"auto"}}>
          {regions.map((region, ri) => {
            const regionChannels = allChannels.filter(region.filter);
            if (regionChannels.length === 0) return null;
            return (
              <div key={ri}>
                <div style={{padding:"6px 20px",background:"#0d0d0d",borderBottom:"1px solid #111",fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em"}}>{region.label}</div>
                {regionChannels.map(ch => {
                  const globalIdx = allChannels.indexOf(ch);
                  const isHidden = hiddenChannels.has(ch);
                  const sens = channelSensitivity[ch] || 0;
                  const isEKG = ch === "EKG";
                  const chHpfVal = channelHpf[ch];
                  const chLpfVal = channelLpf[ch];
                  return (
                    <div key={ch} style={{
                      display:"flex",alignItems:"center",padding:"4px 20px",borderBottom:"1px solid #0d0d0d",
                      background:isHidden?"#0a0a0a":"transparent",opacity:isHidden?0.4:1,transition:"all 0.15s",
                    }}>
                      <div style={{width:30,textAlign:"center"}}>
                        <button onClick={()=>toggleChannelVisibility(ch)} style={{
                          width:16,height:16,borderRadius:0,background:isHidden?"#1a1a1a":"#1a4a54",
                          border:`1px solid ${isHidden?"#333":"#4a9bab50"}`,cursor:"pointer",
                          display:"flex",alignItems:"center",justifyContent:"center",color:isHidden?"#555":"#7ec8d9",fontSize:9,
                        }}>{isHidden?" ":"✓"}</button>
                      </div>
                      <span style={{width:34,textAlign:"center",fontSize:9,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{globalIdx+1}</span>
                      <span style={{flex:1,fontSize:11,fontWeight:600,color:isEKG?"#EC4899":isHidden?"#444":"#ccc",fontFamily:"'IBM Plex Mono', monospace"}}>{ch}</span>

                      {/* LFF (per-channel high-pass) */}
                      <div style={{width:56,display:"flex",justifyContent:"center"}}>
                        <select value={chHpfVal !== undefined ? chHpfVal : ""} onChange={e=>{
                          const v = e.target.value;
                          if (v === "") { const next = {...channelHpf}; delete next[ch]; setChannelHpf(next); }
                          else setChannelHpf({...channelHpf, [ch]: parseFloat(v)});
                        }} style={{...tinySelect, color: chHpfVal !== undefined ? "#7ec8d9" : "#555"}}>
                          <option value="">—</option>
                          {hpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                        </select>
                      </div>

                      {/* HFF (per-channel low-pass) */}
                      <div style={{width:56,display:"flex",justifyContent:"center"}}>
                        <select value={chLpfVal !== undefined ? chLpfVal : ""} onChange={e=>{
                          const v = e.target.value;
                          if (v === "") { const next = {...channelLpf}; delete next[ch]; setChannelLpf(next); }
                          else setChannelLpf({...channelLpf, [ch]: parseFloat(v)});
                        }} style={{...tinySelect, color: chLpfVal !== undefined ? "#7ec8d9" : "#555"}}>
                          <option value="">—</option>
                          {lpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                        </select>
                      </div>

                      {/* Sensitivity */}
                      <div style={{width:80,display:"flex",alignItems:"center",justifyContent:"center",gap:2}}>
                        <button onClick={()=>adjustChannelSensitivity(ch,-1)} style={{
                          width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                          color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                        }}>−</button>
                        <span style={{fontSize:9,color:sens!==0?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace",
                          minWidth:22,textAlign:"center"}}>{sens>0?`+${sens}`:sens}</span>
                        <button onClick={()=>adjustChannelSensitivity(ch,1)} style={{
                          width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                          color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                        }}>+</button>
                      </div>

                      <div style={{width:40,display:"flex",justifyContent:"center"}}>
                        <div style={{width:20,height:3,borderRadius:0,background:isEKG?"#EC4899":"#7ec8d9",opacity:isHidden?0.2:0.6}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

          {/* AUX CHANNELS section — Eye Leads + EKG */}
          {renderAuxChannels()}
          <div style={{fontSize:10,color:"#555"}}>
            {channels.length} visible / {allChannels.length} total — {hiddenChannels.size} hidden
            {Object.keys(channelHpf).length > 0 || Object.keys(channelLpf).length > 0 ? (
              <span style={{color:"#F59E0B",marginLeft:8}}>{Object.keys(channelHpf).length + Object.keys(channelLpf).length} custom filters</span>
            ) : null}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{setChannelHpf({});setChannelLpf({});}} style={{
              padding:"5px 12px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
            }}>Reset Filters</button>
            <button onClick={()=>{allChannels.forEach(ch=>{if(hiddenChannels.has(ch))toggleChannelVisibility(ch);});}} style={{
              padding:"5px 12px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
            }}>Show All</button>
            <button onClick={onClose} style={{
              padding:"5px 12px",background:"#1a4a54",border:"1px solid #4a9bab40",borderRadius:0,
              color:"#7ec8d9",cursor:"pointer",fontSize:10,fontWeight:700,
            }}>Done</button>
          </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// IMPEDANCE CHECK PANEL
// ══════════════════════════════════════════════════════════════
function ImpedancePanel({ impedances, onClose, onAccept, readOnly = false }) {
  const list = Array.isArray(impedances) ? impedances : [];
  const allGood = list.length > 0 && list.every(e => e.status !== "poor");
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true, onClose);
  return (
    <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:20}}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="impedance-modal-title" style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:24,width:560,maxHeight:"80vh",overflow:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <h3 id="impedance-modal-title" style={{margin:0,color:"#e0e0e0",fontSize:14,fontWeight:700}}>{readOnly ? "Impedance (from EDF)" : "Impedance Check"}</h3>
            <span style={{fontSize:10,color:"#555"}}>{readOnly ? "Compliance cutoff is ≤ 5 kΩ per electrode." : "All electrodes should be below 10 kΩ for quality recording"}</span>
          </div>
          <button onClick={onClose} aria-label="Close impedance check" style={{background:"none",border:"none",color:"#666",cursor:"pointer"}}>{I.X()}</button>
        </div>

        {list.length === 0 ? (
          <div style={{padding:"24px 8px",textAlign:"center",color:"#666",fontSize:12,lineHeight:1.6}}>
            No impedance data in this recording.<br/>
            <span style={{fontSize:10,color:"#444"}}>Standard EDF rarely stores impedance; it is a dynamic value captured at acquisition. Compliance reports this as “Unknown”.</span>
          </div>
        ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:6,marginBottom:20}}>
          {list.map((e,i) => (
            <div key={i} style={{
              background:"#0a0a0a",border:`1px solid ${e.status==="good"?"#1a4a5440":e.status==="fair"?"#854d0e40":"#991b1b40"}`,
              borderRadius:0,padding:"8px 10px",display:"flex",alignItems:"center",justifyContent:"space-between",
            }}>
              <span style={{fontSize:11,fontWeight:600,color:"#ccc",fontFamily:"'IBM Plex Mono', monospace"}}>{e.name}</span>
              <span style={{fontSize:12,fontWeight:700,fontFamily:"'IBM Plex Mono', monospace",
                color:e.value===null?"#f87171":e.status==="good"?"#7ec8d9":e.status==="fair"?"#facc15":"#f87171"
              }}>{e.value===null?"-":`${e.value}kΩ`}</span>
            </div>
          ))}
        </div>
        )}

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:16,fontSize:10}}>
            <span style={{color:"#7ec8d9"}}>● &lt;5kΩ Good</span>
            <span style={{color:"#facc15"}}>● 5-10kΩ Fair</span>
            <span style={{color:"#f87171"}}>● &gt;10kΩ Poor</span>
          </div>
          {readOnly ? (
            <button onClick={onClose} style={{padding:"6px 18px",background:"#111",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:11,fontWeight:700}}>Close</button>
          ) : (
          <div style={{display:"flex",gap:8}}>
            <button onClick={onClose} style={{padding:"6px 14px",background:"#111",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:11,fontWeight:600}}>Re-check</button>
            <button onClick={onAccept} style={{
              padding:"6px 18px",background:allGood?"#1a4a54":"#7f1d1d",
              border:`1px solid ${allGood?"#4a9bab50":"#EF444450"}`,borderRadius:0,
              color:allGood?"#7ec8d9":"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700
            }}>{allGood?"Accept & Ready":"Accept Anyway"}</button>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TAB: RECORD (Live Recording) — with Device Manager
// ══════════════════════════════════════════════════════════════
function AcquireTab() {
  // App-global atoms from context (annotations + records + EDF blob store + Review navigation).
  const { annotationsMap, setAnnotationsMap, setRecords, edfFileStore, setEdfFileStore, openReview } = useAppStore();
  // State declared before useEEGState so they can be passed as args
  const [selectedDevice, setSelectedDevice] = useState(DEVICE_CATALOG.find(d => d.id === "openbci-cyton-16") || null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [subjectId, setSubjectId] = useState("");
  const [studyType, setStudyType] = useState("BL");
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [showPostRecordPrompt, setShowPostRecordPrompt] = useState(false);
  const [lastRecordedFile, setLastRecordedFile] = useState(null);
  const timerRef = useRef(null);
  const postRecordDialogRef = useRef(null);
  useFocusTrap(postRecordDialogRef, showPostRecordPrompt, () => setShowPostRecordPrompt(false));

  const acqDuration = elapsedSec > 0 ? elapsedSec : 0;
  const eeg = useEEGState(Math.max(acqDuration, 1), null);

  // Auto-hide channels that don't match the hardware's available electrodes
  useEffect(() => {
    if (!selectedDevice) return;
    const hw = OPENBCI_CHANNEL_MAP[selectedDevice.id] || PIEEG_CHANNEL_MAP[selectedDevice.id];
    if (hw) eeg.setAvailableElectrodes(new Set(hw));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, eeg.montage, eeg.eegSystem]);

  // Close any open bridge socket when the Acquire tab unmounts.
  useEffect(() => () => { if (wsRef.current) { try { wsRef.current.close(); } catch {} } }, []);

  // Use app-level annotations keyed by acquire filename
  const acqFilename = subjectId ? generateFilename(subjectId, studyType, new Date().toISOString().split("T")[0]) : "acquire-session";
  const annotations = annotationsMap[acqFilename] || [];
  const setAnnotations = (newAnns) => {
    const resolved = typeof newAnns === "function" ? newAnns(annotations) : newAnns;
    setAnnotationsMap(prev => ({ ...prev, [acqFilename]: resolved }));
  };
  eeg.annotations = annotations;
  eeg.setAnnotations = setAnnotations;
  eeg.confirmAnnotation = () => {
    if (!eeg.annotationDraft) return;
    const t = ANNOTATION_COLORS[eeg.selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), time: eeg.annotationDraft.time, duration: eeg.annotationDraft.duration,
      code: t.code, type: t.name, color: t.color, text: eeg.annotationText || t.name, channel: -1, ...annotationProvenance(eeg.annotationConfidence) }]);
    eeg.setAnnotationDraft(null); eeg.setAnnotationText(""); eeg.setIsAddingAnnotation(false);
  };

  // Device state
  const [connectionState, setConnectionState] = useState(CONN.disconnected);
  const [deviceConfig, setDeviceConfig] = useState({ sampleRate: 125, channels: 16, port: "COM3", bridgeUrl: "ws://localhost:8765" });
  const [impedances, setImpedances] = useState(null);
  const [showImpedance, setShowImpedance] = useState(false);

  // ── Live WebSocket bridge (piEEG and other protocol:"websocket" devices) ──
  // The browser cannot talk to a Pi HAT / BrainFlow board directly, so a small local
  // bridge process (Python/BrainFlow → WebSocket) streams frames here. Protocol:
  //   • text JSON  {type:"samples", data:[[c0,c1,...],...]}  — one inner array per time-frame
  //   • text JSON  {type:"impedance", values:[kΩ,...]}        — per-channel impedance
  //   • binary     Float32 buffer, channel-interleaved per frame
  // We buffer samples while recording and flush them to a real EDF on stop.
  const wsRef = useRef(null);
  const liveBufRef = useRef(null);   // { labels:[], data:[[]...], sr }
  const recordingRef = useRef(false);

  const appendSamples = (rows) => {
    if (!recordingRef.current) return;          // only capture while recording
    const buf = liveBufRef.current; if (!buf) return;
    for (const row of rows) {
      for (let c = 0; c < buf.data.length; c++) buf.data[c].push(Number(row[c]) || 0);
    }
  };
  const handleWsMessage = (ev) => {
    const labels = liveBufRef.current?.labels || [];
    if (typeof ev.data === "string") {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "impedance" || msg.cmd === "impedance") {
        const vals = msg.values || msg.impedances || [];
        const imp = vals.map((v, i) => ({ name: labels[i] || `Ch${i + 1}`, value: Math.round(v * 10) / 10, status: v <= 5 ? "good" : v <= 10 ? "fair" : "poor" }));
        setImpedances(imp.length ? imp : generateImpedances(selectedDevice?.channels || 8));
        setConnectionState(CONN.impedance); setShowImpedance(true);
      } else if (msg.type === "samples" && Array.isArray(msg.data)) {
        appendSamples(msg.data);
      }
    } else if (ev.data instanceof ArrayBuffer) {
      const arr = new Float32Array(ev.data);
      const ch = labels.length || 1;
      const rows = [];
      for (let i = 0; i + ch <= arr.length; i += ch) {
        const row = new Array(ch);
        for (let c = 0; c < ch; c++) row[c] = arr[i + c];
        rows.push(row);
      }
      appendSamples(rows);
    }
  };

  // Connection flow. WebSocket devices (piEEG) open a real client to the local bridge;
  // BrainFlow direct-board integration is still pending and resolves to an error.
  const handleConnect = useCallback(() => {
    if (!selectedDevice) return;
    setConnectionState(CONN.connecting);

    if (selectedDevice.protocol === "websocket") {
      const url = deviceConfig.bridgeUrl || selectedDevice.bridgeUrl || "ws://localhost:8765";
      const labels = PIEEG_CHANNEL_MAP[selectedDevice.id] || ELECTRODE_SETS["10-20"].slice(0, selectedDevice.channels);
      liveBufRef.current = { labels, data: labels.map(() => []), sr: deviceConfig.sampleRate || selectedDevice.maxSr || 250 };
      let ws;
      try { ws = new WebSocket(url); ws.binaryType = "arraybuffer"; }
      catch { setConnectionState(CONN.error); notify(`Invalid bridge URL: ${url}`, "error"); return; }
      wsRef.current = ws;
      let errored = false, opened = false;
      const fail = () => {
        if (errored) return; errored = true; clearTimeout(to);
        setConnectionState(CONN.error);
        notify(`piEEG bridge unreachable at ${url}. Start the bridge process and retry.`, "error");
      };
      const to = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch {} fail(); } }, 4000);
      ws.onopen = () => { opened = true; clearTimeout(to); setConnectionState(CONN.connected); try { ws.send(JSON.stringify({ cmd: "impedance" })); } catch {} };
      ws.onmessage = handleWsMessage;
      ws.onerror = () => fail();
      // Only treat a close as a clean disconnect if we actually had an open session.
      ws.onclose = () => { clearTimeout(to); if (errored) return; if (opened) setConnectionState(CONN.disconnected); else fail(); };
      return;
    }

    // BrainFlow direct-board integration not yet implemented.
    setTimeout(() => { setConnectionState(CONN.error); }, 2000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice, deviceConfig]);

  const handleDisconnect = () => {
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    recordingRef.current = false;
    setConnectionState(CONN.disconnected);
    setImpedances(null);
    setShowImpedance(false);
    if (isRecording) { setIsRecording(false); setIsPaused(false); }
  };

  const handleAcceptImpedance = () => {
    setShowImpedance(false);
    setConnectionState(CONN.ready);
  };

  // Stable ref for eeg methods so recording tick can call them without stale closures
  const eegRef = useRef(eeg);
  eegRef.current = eeg;

  // Recording engine — real hardware streams samples into a channelData buffer that we
  // flush to EDF on stopRecording. With no live hardware integration yet, this only ticks
  // the elapsed-time counter so the UI shows recording progress.
  useEffect(() => {
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => {
        setElapsedSec(p => { const next = p+1; eegRef.current.setCurrentEpoch(Math.floor(next/eegRef.current.epochSec)); return next; });
      }, 1000);
      return () => clearInterval(timerRef.current);
    } else {
      clearInterval(timerRef.current);
    }
  }, [isRecording, isPaused]);

  const startRecording = () => {
    if (!subjectId || connectionState < CONN.ready) return;
    // Reset the live capture buffer so this recording starts clean.
    if (liveBufRef.current) liveBufRef.current.data = liveBufRef.current.labels.map(() => []);
    recordingRef.current = true;
    setIsRecording(true); setIsPaused(false); setElapsedSec(0); eeg.setCurrentEpoch(0);
  };
  const stopRecording = () => {
    setIsRecording(false); setIsPaused(false);
    recordingRef.current = false;
    if (!subjectId || elapsedSec < 1) return;

    const today = new Date().toISOString().split("T")[0];
    const acqFile = generateFilename(subjectId, studyType, today);
    const actualDurationSec = elapsedSec;

    // Prefer the captured live buffer (piEEG/WebSocket). When no real samples were
    // streamed (e.g. BrainFlow not yet wired), fall back to a valid-but-flat EDF so the
    // record schema stays consistent.
    const liveBuf = liveBufRef.current;
    const hasLive = selectedDevice?.protocol === "websocket" && liveBuf && liveBuf.data.some(a => a.length > 0);
    let electrodes, channelData, sr;
    if (hasLive) {
      electrodes = liveBuf.labels;
      channelData = liveBuf.data.map(a => Float32Array.from(a));
      sr = liveBuf.sr || deviceConfig.sampleRate || 250;
    } else {
      sr = deviceConfig.sampleRate || 256;
      electrodes = ELECTRODE_SETS[eeg.eegSystem] || ELECTRODE_SETS["10-20"];
      channelData = electrodes.map(() => new Float32Array(sr * actualDurationSec));
    }

    // Build EDF binary and parse it back
    const edfBuffer = buildEDFFile({
      channelLabels: electrodes,
      channelData,
      sampleRate: sr,
      recordDurationSec: 1,
      patientId: hashSubjectId(subjectId),
      recordingId: `REACT-${studyType}`,
    });
    const parsed = parseEDFFile(edfBuffer);

    // Store in edfFileStore for review and persist to IndexedDB
    if (setEdfFileStore && !parsed.error) {
      setEdfFileStore(prev => ({ ...prev, [acqFile]: parsed }));
      saveEdfToDB(acqFile, edfBuffer);
    }

    const chCount = electrodes.length;
    const durationMin = Math.round(actualDurationSec / 60 * 10) / 10;
    const newRecord = {
      id: `ACQ-${Date.now()}`,
      subjectHash: hashSubjectId(subjectId),
      subjectId,
      sport: "",
      position: "",
      studyType,
      date: today,
      filename: acqFile,
      channels: chCount,
      duration: durationMin,
      durationSec: actualDurationSec,
      sampleRate: sr,
      fileSize: Math.round(edfBuffer.byteLength / 1024 / 1024 * 10) / 10,
      montage: eeg.eegSystem,
      status: "pending",
      isTest: false,
      isAcquired: true,
      notes: `Recorded via ${selectedDevice?.name || "unknown device"}`,
      uploadedAt: new Date().toISOString(),
      sourceFile: null,
      hasEdfData: true,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      processingLog: [],
      repositoryStatus: "library",
      collectionIds: [],
      complianceResult: null,
    };
    if (setRecords) setRecords(prev => [newRecord, ...prev]);

    // Trigger post-recording prompt (Patch D)
    setLastRecordedFile({ record: newRecord, filename: acqFile });
    setShowPostRecordPrompt(true);
  };
  const togglePause = () => {
    const next = !isPaused;
    setIsPaused(next);
    recordingRef.current = !next && isRecording;  // pause halts live capture
    if (next) setShowAnnotations(true);  // auto-open annotation panel on pause
  };

  const elapsed = `${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,"0")}`;
  const hash = subjectId ? hashSubjectId(subjectId) : "----";
  const canRecord = connectionState >= CONN.ready && subjectId;

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden",position:"relative"}}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {!toolbarCollapsed ? (<>
      {/* Device Selector */}
      <DeviceSelector selectedDevice={selectedDevice} setSelectedDevice={setSelectedDevice}
        connectionState={connectionState} onConnect={handleConnect} onDisconnect={handleDisconnect}
        deviceConfig={deviceConfig} setDeviceConfig={setDeviceConfig}/>

      {/* Recording controls bar */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"8px 16px",borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexShrink:0}}>
        {!isRecording ? (<>
          <SubjectIdInput value={subjectId} onChange={setSubjectId}/>
          <div><div style={microLabel}>Study Type</div>
            <select value={studyType} onChange={e=>setStudyType(e.target.value)} style={selectStyle}>
              {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select></div>
          {subjectId && (
            <div style={{padding:"6px 12px",background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:"#7ec8d9"}}>
              <span style={{color:"#555",fontSize:9}}>FILE → </span>
              {generateFilename(subjectId, studyType, new Date().toISOString().split("T")[0])}
            </div>
          )}
        </>) : (<>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:isPaused?"#F59E0B":"#EF4444",
              animation:isPaused?"none":"pulse 1.5s ease infinite"}}/>
            <span style={{fontSize:12,fontWeight:800,color:isPaused?"#F59E0B":"#EF4444",letterSpacing:"0.1em"}}>
              {isPaused?"PAUSED":"RECORDING"}</span>
          </div>
          <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:18,fontWeight:800,color:"#e0e0e0",minWidth:60}}>{elapsed}</div>
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{hash}</span>
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#888"}}>{STUDY_TYPES[studyType]?.label}</span>
          {selectedDevice && (<>
            <span style={{fontSize:10,color:"#555"}}>|</span>
            <span style={{fontSize:10,color:DEVICE_PROTOCOLS[selectedDevice.protocol].color}}>{selectedDevice.name}</span>
          </>)}
        </>)}
      </div>
        <EEGControls montage={eeg.montage} setMontage={eeg.setMontage}
          eegSystem={eeg.eegSystem} setEegSystem={eeg.setEegSystem}
          onOpenCustomPicker={()=>eeg.setShowCustomPicker(true)}
          hpf={eeg.hpf} setHpf={eeg.setHpf}
          lpf={eeg.lpf} setLpf={eeg.setLpf} notch={eeg.notch} setNotch={eeg.setNotch}
          epochSec={eeg.epochSec} setEpochSec={eeg.setEpochSec} sensitivity={eeg.sensitivity} setSensitivity={eeg.setSensitivity}
          rightContent={<>
            <button onClick={(e)=>{e.stopPropagation();eeg.cycleVisibility();}} style={{...controlBtn(),
              color:eeg.visibilityState===2?"#666":"#F59E0B",border:`1px solid ${eeg.visibilityState===2?"#22222280":"#F59E0B40"}`}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>
                {eeg.visibilityState===0 && <>{I.Eye(12)} Show All ({eeg.hiddenChannels.size})</>}
                {eeg.visibilityState===1 && <>{I.EyeDots(12)} Show Eyes</>}
                {eeg.visibilityState===2 && <>{I.EyeOff(12)} Hide</>}
              </span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
            </button>
          </>}/>
        <div onClick={()=>setToolbarCollapsed(true)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#111"}
          style={{height:14,background:"#111",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9650;</span>
        </div>
      </>) : (
        <div onClick={()=>setToolbarCollapsed(false)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#151515"}
          style={{height:20,background:"#151515",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9660;</span>
        </div>
      )}
      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochSec={eeg.epochSec} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}
        totalDuration={acqDuration}
        isPlaying={isRecording && !isPaused} onPlayPause={isRecording ? togglePause : undefined}
        leftContent={connectionState >= CONN.ready && !isRecording ? (
          <button onClick={()=>{setShowImpedance(true);setImpedances(generateNoConnectionImpedances(selectedDevice?.channels||19));}} style={{
            padding:"4px 10px",background:"#111",border:"1px solid #8B5CF640",borderRadius:0,
            color:"#8B5CF6",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{I.Ohm(14)} Z</button>
        ) : null}
        rightContent={!isRecording ? (
          connectionState >= CONN.ready ? (
            <button onClick={startRecording} disabled={!canRecord} style={{
              padding:"4px 14px",background:canRecord?"#7f1d1d":"#1a1a1a",border:`1px solid ${canRecord?"#EF444450":"#333"}`,
              borderRadius:0,color:canRecord?"#EF4444":"#555",cursor:canRecord?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Record()} REC</button>
          ) : null
        ) : (
          <button onClick={stopRecording} style={{
            padding:"4px 10px",background:"#111",border:"1px solid #EF444440",borderRadius:0,
            color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{I.Square()} STOP</button>
        )}/>

      <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
        <WaveformCanvas eeg={eeg}>
          <AnnotationPopup draft={eeg.annotationDraft} annotationType={eeg.selectedAnnotationType}
            text={eeg.annotationText} setText={eeg.setAnnotationText} onConfirm={eeg.confirmAnnotation}
            onCancel={()=>{eeg.setAnnotationDraft(null);eeg.setIsAddingAnnotation(false);}} containerRef={eeg.containerRef}/>

          {/* Overlay states */}
          {connectionState < CONN.ready && !isRecording && (
            <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
              {connectionState === CONN.disconnected && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #2a2a2a",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#444"}}>{I.Radio(20)}</div>
                  <div style={{color:"#555",fontSize:14,fontWeight:600}}>No Input Source Connected</div>
                  <div style={{color:"#333",fontSize:11,maxWidth:300,textAlign:"center",lineHeight:1.5}}>
                    Select a device from the Input Source dropdown above, then click CONNECT
                  </div>
                </>
              )}
              {connectionState === CONN.connecting && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #F59E0B30",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#F59E0B",
                    animation:"pulse 1.5s ease infinite"}}>{I.Radio(20)}</div>
                  <div style={{color:"#F59E0B",fontSize:14,fontWeight:600}}>Connecting to device...</div>
                </>
              )}
              {connectionState === CONN.connected && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #7ec8d930",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#7ec8d9"}}>{I.Check(20)}</div>
                  <div style={{color:"#7ec8d9",fontSize:14,fontWeight:600}}>Connected — running impedance check...</div>
                </>
              )}
              {connectionState === CONN.error && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #EF444430",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#EF4444"}}>{I.Alert(20)}</div>
                  <div style={{color:"#EF4444",fontSize:14,fontWeight:600}}>No Device Detected</div>
                  <div style={{color:"#666",fontSize:11}}>Check device power, USB connection, and port settings</div>
                </>
              )}
            </div>
          )}

          {/* Ready but not recording */}
          {connectionState >= CONN.ready && !isRecording && (
            <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,color:"#7ec8d9"}}>
                {I.Check(18)} <span style={{fontSize:14,fontWeight:700}}>Device Ready</span>
              </div>
              <div style={{color:"#555",fontSize:12}}>
                {subjectId ? "Click REC in the bottom bar to begin acquisition" : "Enter a Subject ID to begin"}
              </div>
            </div>
          )}
        </WaveformCanvas>
      </div>

      {/* Floating annotation panel */}
      {showAnnotations && (
        <AnnotationPanel annotations={annotations} setAnnotations={setAnnotations}
          isAddingAnnotation={eeg.isAddingAnnotation} setIsAddingAnnotation={eeg.setIsAddingAnnotation}
          selectedAnnotationType={eeg.selectedAnnotationType} setSelectedAnnotationType={eeg.setSelectedAnnotationType}
          annotationConfidence={eeg.annotationConfidence} setAnnotationConfidence={eeg.setAnnotationConfidence}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} epochSec={eeg.epochSec}
          setCurrentEpoch={eeg.setCurrentEpoch} filename={acqFilename}
          onClose={()=>setShowAnnotations(false)}
          panelPos={annotationPanelPos} setPanelPos={setAnnotationPanelPos}/>
      )}

      {/* Impedance modal */}
      {showImpedance && impedances && (
        <ImpedancePanel impedances={impedances} onClose={()=>setShowImpedance(false)} onAccept={handleAcceptImpedance}/>
      )}

      {/* Channel context menu */}
      {eeg.contextMenu && (
        <ChannelContextMenu x={eeg.contextMenu.x} y={eeg.contextMenu.y}
          channelName={eeg.contextMenu.channel}
          isHidden={false}
          channelSens={eeg.channelSensitivity[eeg.contextMenu.channel] || 0}
          chHpf={eeg.channelHpf[eeg.contextMenu.channel]}
          chLpf={eeg.channelLpf[eeg.contextMenu.channel]}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          onToggleVisibility={()=>eeg.toggleChannelVisibility(eeg.contextMenu.channel)}
          onAdjustSensitivity={(d)=>eeg.adjustChannelSensitivity(eeg.contextMenu.channel,d)}
          onSetChHpf={(v)=>{const next={...eeg.channelHpf};if(v===undefined)delete next[eeg.contextMenu.channel];else next[eeg.contextMenu.channel]=v;eeg.setChannelHpf(next);}}
          onSetChLpf={(v)=>{const next={...eeg.channelLpf};if(v===undefined)delete next[eeg.contextMenu.channel];else next[eeg.contextMenu.channel]=v;eeg.setChannelLpf(next);}}
          onClose={()=>eeg.setContextMenu(null)}/>
      )}

      {/* Pattern Table */}
      {showPatternTable && (
        <PatternTable eegSystem={eeg.eegSystem} montage={eeg.montage}
          channels={eeg.channels} allChannels={eeg.allChannels}
          hiddenChannels={eeg.hiddenChannels} toggleChannelVisibility={eeg.toggleChannelVisibility}
          channelSensitivity={eeg.channelSensitivity} adjustChannelSensitivity={eeg.adjustChannelSensitivity}
          channelHpf={eeg.channelHpf} setChannelHpf={eeg.setChannelHpf}
          channelLpf={eeg.channelLpf} setChannelLpf={eeg.setChannelLpf}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          auxWithData={eeg.auxWithData} AUX_CHANNELS={eeg.AUX_CHANNELS}
          onClose={()=>setShowPatternTable(false)}/>
      )}

      {eeg.showCustomPicker && (
        <CustomElectrodePicker customElectrodes={eeg.customElectrodes}
          setCustomElectrodes={eeg.setCustomElectrodes}
          onClose={()=>eeg.setShowCustomPicker(false)}/>
      )}

      {/* Post-recording prompt */}
      {showPostRecordPrompt && lastRecordedFile && (
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}>
          <div ref={postRecordDialogRef} role="dialog" aria-modal="true" aria-labelledby="post-record-title" style={{background:"#111",border:"1px solid #2a2a2a",padding:"32px 40px",maxWidth:420,textAlign:"center"}}>
            <div id="post-record-title" style={{color:"#7ec8d9",fontSize:14,fontWeight:700,marginBottom:8}}>Recording Saved</div>
            <div style={{color:"#888",fontSize:12,fontFamily:"'IBM Plex Mono', monospace",marginBottom:6}}>{lastRecordedFile.filename}</div>
            <div style={{color:"#555",fontSize:11,marginBottom:24}}>
              {lastRecordedFile.record.durationSec}s recorded | {lastRecordedFile.record.channels} channels | {lastRecordedFile.record.sampleRate}Hz
            </div>
            <div style={{color:"#ccc",fontSize:13,marginBottom:24}}>Do you wish to load current recording to Review?</div>
            <div style={{display:"flex",gap:12,justifyContent:"center"}}>
              <button onClick={()=>setShowPostRecordPrompt(false)} style={{
                padding:"8px 20px",background:"transparent",border:"1px solid #333",borderRadius:0,
                color:"#888",cursor:"pointer",fontSize:12
              }}>No</button>
              <button onClick={()=>{setShowPostRecordPrompt(false);if(openReview&&lastRecordedFile.record)openReview(lastRecordedFile.record);}} style={{
                padding:"8px 20px",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,
                color:"#7ec8d9",cursor:"pointer",fontSize:12,fontWeight:700
              }}>Yes, Open in Review</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN APP — Tab Controller
// ══════════════════════════════════════════════════════════════
export default function ReactEEGApp() {
  const [activeTab, setActiveTab] = useState("library");
  const [tabsMinimized, setTabsMinimized] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.TABS_MINIMIZED) === "1"; } catch { return false; }
  });
  const setTabsMinimizedPersist = (v) => {
    setTabsMinimized(v);
    try { localStorage.setItem(STORAGE_KEYS.TABS_MINIMIZED, v ? "1" : "0"); } catch {}
  };
  const [records, setRecords] = useState([]);
  const [reviewRecord, setReviewRecord] = useState(null);
  const [annotationsMap, setAnnotationsMap] = useState({});
  const [clinicalNotesMap, setClinicalNotesMap] = useState({});
  const notesShownFilesRef = useRef(new Set()); // tracks which files have had notes auto-opened (persists across tab switches)
  const [edfFileStore, setEdfFileStore] = useState({});
  // baselineMap loaded asynchronously from IDB in the init effect below
  const [baselineMap, setBaselineMap] = useState({});
  // Collections (Phase 2 task #2) — list of {id, name, filenames, ...}; loaded from IDB on init
  const [collections, setCollections] = useState([]);
  const [initialized, setInitialized] = useState(false);
  const [dataDir, setDataDir] = useState("");

  // Multi-tab state (lifted from ReviewTab so it persists across tab switches)
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const tabEpochCache = useRef({});
  // StrictMode-safe init guard — prevents seed generation / migration from running twice in dev
  const didInitRef = useRef(false);

  // ── Decorative header waveforms (purely aesthetic, NOT clinical signal) ──
  // Four faint EEG-like traces stretched across the title bar. Each line samples
  // independently — 80% chance of "fast" (high-beta + low-gamma, the typical
  // awake-EEG look) and 20% chance of "slow" (the previous beta/gamma values,
  // which now serve as the slowest possible — anything slower would look
  // encephalopathic). Regenerated once per app load so every session has its
  // own signature.
  const headerWavePaths = useMemo(() => {
    const W = 2400, H = 100, lines = 4, SAMPLES = 320;
    const out = [];
    for (let i = 0; i < lines; i++) {
      const isSlow = Math.random() < 0.20;
      // Slow case = current floor; Fast case = ~1.5× faster (high beta + mid gamma)
      const alphaFreq = isSlow
        ? 16 + Math.random() * 8                      // 16–24 Hz (floor / "slow")
        : 24 + Math.random() * 12;                    // 24–36 Hz (typical fast)
      const betaFreq  = isSlow
        ? 32 + Math.random() * 16                     // 32–48 Hz (floor / "slow")
        : 48 + Math.random() * 28;                    // 48–76 Hz (typical fast)
      const alphaAmp  = 5 + Math.random() * 4;        // px
      const betaAmp   = 1.5 + Math.random() * 2;
      // ~15% of lines get intermittent artifacts (spikes, muscle bursts, or slow
      // waves) — purely aesthetic, makes the banner feel more like a live recording.
      // When enabled, 2–4 events sprinkled at random t across the line, each ~20-
      // sample wide with a Gaussian envelope.
      const hasArtifacts = Math.random() < 0.15;
      const artifacts = hasArtifacts
        ? Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => ({
            center: 20 + Math.floor(Math.random() * (SAMPLES - 40)),
            kind: ["spike", "muscle", "slow"][Math.floor(Math.random() * 3)],
            amp: 14 + Math.random() * 16,
            width: 1.6 + Math.random() * 2.4,
            sign: Math.random() < 0.5 ? 1 : -1,
          }))
        : null;
      const aPhase    = Math.random() * Math.PI * 2;
      const bPhase    = Math.random() * Math.PI * 2;
      const yCenter   = (H / (lines + 1)) * (i + 1);
      let d = "";
      for (let s = 0; s <= SAMPLES; s++) {
        const t = (s / SAMPLES) * 2;                  // "2 s" of signal across the bar
        const x = (s / SAMPLES) * W;
        let y = yCenter
          + alphaAmp * Math.sin(2 * Math.PI * alphaFreq * t + aPhase)
          + betaAmp  * Math.sin(2 * Math.PI * betaFreq  * t + bPhase)
          + (Math.random() - 0.5) * 0.4;              // hint of noise
        // Apply artifact contributions when this sample is near an event center.
        // Three shapes: sharp asymmetric spike, high-freq muscle burst, broad slow wave.
        if (artifacts) {
          for (const a of artifacts) {
            const ds = s - a.center;
            const reach = a.width * (a.kind === "slow" ? 8 : a.kind === "muscle" ? 4 : 3);
            if (Math.abs(ds) > reach) continue;
            if (a.kind === "spike") {
              const env = Math.exp(-(ds*ds) / (2 * a.width * a.width));
              // Asymmetric — fast up phase, slower opposite-polarity return
              y += a.sign * a.amp * env * (ds < 0 ? 1 : -0.55);
            } else if (a.kind === "muscle") {
              const sigma = a.width * 2;
              const env = Math.exp(-(ds*ds) / (2 * sigma * sigma));
              y += a.sign * a.amp * 0.55 * env * Math.sin(ds * 2.2);
            } else { // slow
              const sigma = a.width * 4;
              const env = Math.exp(-(ds*ds) / (2 * sigma * sigma));
              y += a.sign * a.amp * 0.45 * env;
            }
          }
        }
        d += (s === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(2);
      }
      out.push(d);
    }
    return out;
  }, []);

  // ── Initialize on first launch ──
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    (async () => {
      try {
        const dir = await tauriBridge.invoke("initialize_app");
        setDataDir(dir || "");
      } catch (e) { console.warn("App init failed:", e); }

      // Migrate legacy localStorage data into IDB stores (no-op in Tauri or if already migrated)
      await migrateLocalStorageToIdb();

      // Load baseline map from IDB (was localStorage pre-v14)
      try {
        const map = await tauriBridge.loadBaselineMap();
        if (map && typeof map === "object") setBaselineMap(map);
      } catch (e) { console.warn("Failed to load baselineMap:", e); }

      // Load collections from IDB; seed defaults on first launch (Phase 2 task #2)
      try {
        let cols = await tauriBridge.loadCollections();
        if (!Array.isArray(cols) || cols.length === 0) {
          cols = seedDefaultCollections();
          await tauriBridge.saveCollections(cols);
          debugLog("[REACT] Seeded default collections:", cols.map(c => c.name).join(", "));
        }
        setCollections(cols);
      } catch (e) { console.warn("Failed to load collections:", e); }

      // One-time migration: clear legacy single-sim library to trigger v14 seed generation.
      // After migrateLocalStorageToIdb the library lives in IDB, so we check there.
      // Load saved library + drop any legacy simulation records (synthetic seeds /
      // sim acquisitions / TEST-SIM-1 stub). Real recordings only from v14.1+.
      let existingRecords = [];
      try {
        const json = await tauriBridge.invoke("load_library_index");
        existingRecords = JSON.parse(json || "[]");
      } catch (e) { /* no saved library */ }
      const droppedSimCount = existingRecords.filter(r => r.isSimulated || r.fileType === "simulated" || r.id === "TEST-SIM-1").length;
      existingRecords = existingRecords.filter(r => !r.isSimulated && r.fileType !== "simulated" && r.id !== "TEST-SIM-1");
      if (droppedSimCount > 0) {
        debugLog(`[REACT] Dropped ${droppedSimCount} legacy simulation record(s) on load`);
        await idbPut(STORE_LIBRARY, "records", existingRecords);
      }

      // Seed the library with 10 real public-domain EDFs (PhysioNet EEGMMIDB) on
      // first launch — but only if no real PhysioNet seed records exist yet.
      const hasPhysioSeeds = existingRecords.some(r => r.fileType === "real-public");
      if (hasPhysioSeeds || existingRecords.length > 0) {
        setRecords(existingRecords.map(migrateRecord));
        setInitialized(true);
        loadAllEdfsFromDB().then(stored => {
          if (Object.keys(stored).length > 0) setEdfFileStore(prev => ({ ...prev, ...stored }));
        });
      } else {
        debugLog("[REACT] First launch — fetching 10 real public-domain EDFs (PhysioNet EEGMMIDB)...");
        const realRecords = await loadRealSeedEdfs(setEdfFileStore, setAnnotationsMap);
        setRecords(realRecords);
        setInitialized(true);
        debugLog("[REACT] Seed loaded:", realRecords.length, "real recordings");
      }
    })();

    // Listen for EDF file open events (double-click .edf in Explorer)
    if (window.__TAURI__) {
      const unlisten = window.__TAURI__.event.listen("open-edf-file", (event) => {
        const filePath = event.payload;
        debugLog("Opening EDF file:", filePath);
        // Extract filename from path
        const parts = filePath.replace(/\\/g, "/").split("/");
        const filename = parts[parts.length - 1];
        // Switch to review tab with this file
        setReviewRecord({ filename, status: "pending", id: "ext-" + Date.now() });
        setActiveTab("review");
      });
      return () => { unlisten.then(fn => fn()); };
    }
  }, []);

  // ── Auto-save library to disk when records change ──
  useEffect(() => {
    if (initialized && records.length > 0) {
      tauriBridge.saveLibrary(records);
    }
  }, [records, initialized]);

  // ── Persist baselineMap (IDB-backed via tauriBridge) ──
  useEffect(() => {
    if (!initialized) return; // don't overwrite on the empty initial state before IDB load
    tauriBridge.saveBaselineMap(baselineMap);
  }, [baselineMap, initialized]);

  // ── Persist collections (IDB-backed via tauriBridge) ──
  useEffect(() => {
    if (!initialized) return;
    tauriBridge.saveCollections(collections);
  }, [collections, initialized]);

  // ── Load clinical notes for all records on init ──
  useEffect(() => {
    if (!initialized || records.length === 0) return;
    (async () => {
      const map = {};
      for (const r of records) {
        const text = await tauriBridge.loadClinicalNotes(r.filename);
        if (text) map[r.filename] = text;
      }
      if (Object.keys(map).length > 0) setClinicalNotesMap(prev => ({ ...prev, ...map }));
    })();
  }, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced auto-save clinical notes ──
  const notesTimerRef = useRef(null);
  useEffect(() => {
    if (!initialized) return;
    clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      Object.entries(clinicalNotesMap).forEach(([fn, text]) => {
        tauriBridge.saveClinicalNotes(fn, text);
      });
    }, 1000);
    return () => clearTimeout(notesTimerRef.current);
  }, [clinicalNotesMap, initialized]);

  const openReview = (record) => {
    setReviewRecord(record);
    setActiveTab("review");
    // Add to multi-tab list (max 5)
    setOpenTabs(prev => {
      const existingIdx = prev.findIndex(t => t.filename === record.filename);
      if (existingIdx >= 0) {
        setActiveTabIdx(existingIdx);
        return prev;
      }
      let next = [...prev, record];
      if (next.length > 5) next = next.slice(next.length - 5);
      setActiveTabIdx(next.length - 1);
      return next;
    });
  };

  const updateRecordStatus = (recordId, newStatus) => {
    setRecords(prev => prev.map(r => r.id === recordId ? { ...r, status: newStatus } : r));
    if (reviewRecord && reviewRecord.id === recordId) {
      setReviewRecord(prev => ({ ...prev, status: newStatus }));
    }
  };

  // Promote a record to the Repository if it passes protocol compliance.
  // The compliance check is re-run at promotion time so the user can't promote stale results.
  const [promoteRejection, setPromoteRejection] = useState(null);
  const promoteRejectDialogRef = useRef(null);
  useFocusTrap(promoteRejectDialogRef, !!promoteRejection, () => setPromoteRejection(null));
  const promoteRecord = (record) => {
    const edf = edfFileStore?.[record.filename];
    const result = checkProtocolCompliance(record, edf || null);
    if (!result.compliant) {
      setPromoteRejection({ record, result });
      return;
    }
    setRecords(prev => prev.map(r => r.id === record.id
      ? { ...r, repositoryStatus: "promoted", repositoryPromotedAt: new Date().toISOString(), complianceResult: result }
      : r));
  };
  // Demote a record from the Repository back to the Library.
  const demoteRecord = (record) => {
    setRecords(prev => prev.map(r => r.id === record.id
      ? { ...r, repositoryStatus: "library", repositoryPromotedAt: null }
      : r));
  };
  // Subject Timeline modal — opened by clicking "Timeline" on any record
  const [timelineSubjectHash, setTimelineSubjectHash] = useState(null);

  // Library collection selection lifted to root so the open folder is remembered
  // when navigating away to Review and back.
  const [libraryCollectionId, setLibraryCollectionId] = useState(null);

  // Tutorial mode — when ON, hovering any control with a `data-tut` description
  // shows a mouse-following help box. Toggled by the REACT EEG brain icon in the
  // header. Persisted so a user's preference survives reloads.
  const [tutorialMode, setTutorialMode] = useState(() => {
    try { return localStorage.getItem("react_eeg_tutorial_mode") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("react_eeg_tutorial_mode", tutorialMode ? "1" : "0"); } catch { /* ignore */ }
  }, [tutorialMode]);

  const [showSplash, setShowSplash] = useState(true);
  // Splash is user-dismissed (click ENTER) — this gives a moment for the
  // background init effect to populate IDB/records, and shows the changelog.
  const splashEnterRef = useRef(null);
  useEffect(() => {
    if (!showSplash) return;
    // Focus the ENTER button after the fade-in so keyboard users can dismiss
    // with Enter/Space without first having to Tab into it.
    const t = setTimeout(() => splashEnterRef.current?.focus(), 850);
    return () => clearTimeout(t);
  }, [showSplash]);

  // Browser tab title — single-sourced from APP_VERSION so we don't have to
  // remember to edit index.html every wave bump.
  useEffect(() => {
    document.title = `REACT EEG ${APP_VERSION} — Biometric Data Acquisition & Storage`;
  }, []);


  const tabs = [
    { id: "library",    label: "LIBRARY",    icon: I.Database(18), desc: "File Repository", tut: "Library — all imported and seeded recordings. Import EDF/EDF+ files, organize into collections, and open any record for review." },
    { id: "review",     label: "REVIEW",     icon: I.Eye(18),      desc: "Waveform Viewer", tut: "Review — the waveform viewer. Page through epochs, apply filters/montages, annotate, run qEEG, and play back in real time." },
    { id: "repository", label: "REPOSITORY", icon: I.Package(18),  desc: "Compliant Recordings", tut: "Repository — recordings that passed protocol compliance and were promoted. The curated, shareable/licensable set." },
    // Record intentionally NOT here — files come from external hardware. Live recording
    // is reachable via the BrainElectrode icon in the header (top-right).
  ];

  // ── Splash Screen ──
  if (showSplash) {
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="splash-title" style={{
        height:"100vh",background:"#000",display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",position:"relative",padding:"40px 24px",
        fontFamily:"'IBM Plex Mono','JetBrains Mono',monospace",
      }}
      onKeyDown={(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setShowSplash(false);}}}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap');
          @keyframes splashFadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        `}</style>
        {/* Logo + tagline */}
        <div style={{
          animation: "splashFadeIn 0.7s ease forwards",
          display:"flex",flexDirection:"column",alignItems:"center",gap:0,
        }}>
          <div id="splash-title" style={{
            fontSize:64,fontWeight:700,color:"#fff",letterSpacing:"0.08em",
            lineHeight:1,fontFamily:"'Rajdhani', sans-serif",
          }}>REACT <span style={{color:"#7ec8d9"}}>EEG</span></div>
          <div style={{
            fontSize:12,fontWeight:500,color:"#ccc",letterSpacing:"0.12em",
            marginTop:12,textAlign:"center",lineHeight:1.5,fontFamily:"'Rajdhani', sans-serif",
          }}>Rapid Electroencephalographic Audit of Cortical Trends</div>
        </div>

        {/* Patch log — concise list of recent changes, latest first */}
        <div style={{
          animation: "splashFadeIn 0.7s ease 0.25s both",
          marginTop:36, width:"min(620px, 90vw)", maxHeight:"45vh", overflow:"auto",
          background:"#0a0a0a", border:"1px solid #1a3040",
          padding:"18px 22px", textAlign:"left",
        }}>
          <div style={{
            fontSize:10,color:"#4a9bab",fontWeight:700,letterSpacing:"0.14em",
            marginBottom:14,fontFamily:"'IBM Plex Mono', monospace",
          }}>PATCH LOG</div>
          {CHANGELOG.map((entry, i) => (
            <div key={entry.version} style={{marginBottom: i === CHANGELOG.length - 1 ? 0 : 14}}>
              <div style={{
                fontSize:11,color: i === 0 ? "#7ec8d9" : "#888",
                fontWeight:700,letterSpacing:"0.08em",marginBottom:5,
                fontFamily:"'IBM Plex Mono', monospace",
              }}>
                {entry.version}{i === 0 && <span style={{color:"#4a9bab",marginLeft:8,fontWeight:500,letterSpacing:"0.06em"}}>· current</span>}
              </div>
              <ul style={{listStyle:"none",margin:0,padding:0}}>
                {entry.items.map((item, j) => (
                  <li key={j} style={{
                    fontSize:11, color: i === 0 ? "#ccc" : "#777", lineHeight:1.55,
                    paddingLeft:14, position:"relative", marginBottom:2,
                    fontFamily:"'IBM Plex Mono', monospace",
                  }}>
                    <span style={{position:"absolute",left:0,top:0,color: i === 0 ? "#4a9bab" : "#444"}}>•</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* ENTER button — user-dismissed, no auto-timeout */}
        <button ref={splashEnterRef} onClick={() => setShowSplash(false)}
          style={{
            animation: "splashFadeIn 0.7s ease 0.5s both",
            marginTop:28, padding:"10px 38px",
            background:"#1a4a54", border:"1px solid #4a9bab",
            color:"#7ec8d9", fontSize:12, fontWeight:700, letterSpacing:"0.16em",
            cursor:"pointer", fontFamily:"'IBM Plex Mono', monospace",
            display:"flex", alignItems:"center", gap:8,
          }}>
          ENTER →
        </button>

        <div style={{
          position:"absolute",bottom:24,
          fontSize:10,color:"#444",fontWeight:400,letterSpacing:"0.06em",
          animation: "splashFadeIn 0.7s ease 0.6s both",
          display:"flex",alignItems:"center",gap:12,
          fontFamily:"'IBM Plex Mono', monospace",
        }}>REACT EEG, LLC &mdash; 2026 <span style={{color:"#4a9bab80",fontSize:10,fontWeight:600,letterSpacing:"0.1em"}}>{APP_VERSION}</span></div>
      </div>
    );
  }

  return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#080808",color:"#e0e0e0",fontFamily:"'IBM Plex Mono','JetBrains Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 0; }
        select:focus, input:focus, textarea:focus { border-color: #4a9bab !important; outline: none; }
        select:focus-visible, input:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible {
          outline: 2px solid #7ec8d9; outline-offset: 1px;
        }
      `}</style>

      {/* ══ Header ══ */}
      <header style={{padding:"12px 24px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0,overflow:"hidden"}}>
        <div style={{position:"relative",zIndex:1}}>
        {/* Top row — logo + Record button. The decorative EEG-trace background
            lives ONLY inside this row so it stops cleanly above the tab bar. */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,position:"relative"}}>
          {/* Decorative waveforms (alpha + beta mix, regenerated per session).
              Extends past the header's 12/24 padding via negative inset so traces
              still go edge-to-edge of the viewport. pointer-events:none + zIndex 0
              so the tabs and toolbar buttons always sit in front of it. */}
          <svg viewBox="0 0 2400 100" preserveAspectRatio="none" aria-hidden="true"
            style={{position:"absolute",top:-12,left:-24,width:"calc(100% + 48px)",height:"calc(100% + 12px)",opacity:0.18,pointerEvents:"none",zIndex:0}}>
            {headerWavePaths.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="#7ec8d9" strokeWidth="0.7" vectorEffect="non-scaling-stroke"/>
            ))}
          </svg>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {/* REACT EEG icon doubles as the tutorial-mode toggle.
                Active  → illuminated blue fill (tutorial ON).
                Inactive → grey fill, blue border + blue brain (tutorial OFF). */}
            <button onClick={()=>setTutorialMode(m=>!m)}
              data-tut="Tutorial mode. When lit, hover any button or control and a help box follows your cursor explaining what it does. Click again to turn off."
              title={tutorialMode ? "Tutorial mode ON — hover any control for a description. Click to turn off." : "Tutorial mode OFF — click to enable hover help"}
              aria-pressed={tutorialMode} aria-label="Toggle tutorial mode"
              style={{width:36,height:36,borderRadius:0,padding:0,cursor:"pointer",
                background: tutorialMode ? "#1a4a54" : "#1a1a1a",
                border: `1px solid ${tutorialMode ? "#7ec8d9" : "#4a9bab"}`,
                boxShadow: tutorialMode ? "0 0 10px #4a9bab55" : "none",
                color:"#7ec8d9",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s"}}>
              {I.Brain()}
            </button>
            <div>
              <div style={{fontSize:18,fontWeight:700,letterSpacing:"0.04em",color:"#e0e0e0",fontFamily:"'Rajdhani', sans-serif",display:"flex",alignItems:"baseline",gap:8}}>
                REACT <span style={{color:"#7ec8d9"}}>EEG</span>
                <span style={{fontSize:9,fontWeight:600,color:"#4a9bab80",letterSpacing:"0.08em",fontFamily:"'IBM Plex Mono', monospace"}}>{APP_VERSION}</span>
              </div>
              <div style={{fontSize:9,color:"#555",letterSpacing:"0.12em",fontWeight:600,fontFamily:"'Rajdhani', sans-serif",textTransform:"uppercase"}}>BIOMETRIC DATA ACQUISITION & STORAGE</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:6,color:"#7ec8d9",fontSize:11,fontWeight:600,fontFamily:"'Rajdhani', sans-serif",letterSpacing:"0.08em"}}>
              {I.Shield()} PHI PROTECTED
            </div>
            <button onClick={()=>setActiveTab("acquire")} title="Record — External Source"
              data-tut="Record — connect external EEG hardware (e.g. OpenBCI) to acquire a live recording. Currently a passive shell until hardware integration lands." style={{
              width:32,height:32,padding:0,borderRadius:4,cursor:"pointer",
              background:activeTab==="acquire"?"#1a3a40":"#111",
              border:activeTab==="acquire"?"1px solid #7ec8d9":"1px solid #2a2a2a",
              color:activeTab==="acquire"?"#7ec8d9":"#555",
              display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.15s",
            }}>{I.BrainElectrode(18)}</button>
          </div>
        </div>

        {/* ── Tab Bar ── Tabs can only be hidden while in Review (where vertical space is
            tight). Everywhere else they always show, so you can never get stuck without nav. */}
        {(activeTab !== "review" || !tabsMinimized) && (
        <div style={{display:"flex",gap:0,alignItems:"stretch",borderTop:"1px solid #141414"}}>
          {tabs.map(tab => {
            const active = activeTab === tab.id;
            return (
            <button key={tab.id} data-tut={tab.tut} onClick={() => setActiveTab(tab.id)} style={{
              flex:1, padding:"14px 20px", borderRadius:0,
              background: active ? "rgba(126,200,217,0.12)" : "transparent",
              border: "none", borderTop: active ? "2px solid #7ec8d9" : "2px solid transparent",
              borderBottom: active ? "2px solid #7ec8d9" : "2px solid transparent",
              color: active ? "#eaf6f9" : "#777",
              cursor: "pointer", transition: "all 0.1s",
              display: "flex", alignItems: "center", justifyContent: "center", gap:10,
            }}
              onMouseEnter={e=>{ if(!active) e.currentTarget.style.background="#141414"; }}
              onMouseLeave={e=>{ if(!active) e.currentTarget.style.background="transparent"; }}>
              <span style={{color: active ? "#7ec8d9" : "#555"}}>{tab.icon}</span>
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:15,fontWeight:700,letterSpacing:"0.1em",fontFamily:"'Rajdhani', sans-serif",color: active ? "#7ec8d9" : "inherit"}}>{tab.label}</div>
                <div style={{fontSize:9,color: active ? "#7a8a90" : "#444",fontWeight:500,fontFamily:"'Rajdhani', sans-serif"}}>{tab.desc}</div>
              </div>
            </button>
            );
          })}
        </div>
        )}
        {/* Hide/Show toggle — only in Review (the only tab where reclaiming the tab-bar height
            matters). When minimized, the centered SHOW-TABS pill is flanked by compact LIBRARY /
            REPOSITORY buttons sitting exactly where their full tabs were, so you can still jump to
            the other tabs without first expanding the bar. Three equal thirds align with the tabs. */}
        {activeTab === "review" && (
        <div style={{display:"flex",alignItems:"stretch",justifyContent:tabsMinimized?"stretch":"center",background:"#0c0c0c",borderTop:"1px solid #161616",borderBottom:"1px solid #1a1a1a"}}>
          {tabsMinimized && (
            <button onClick={()=>setActiveTab("library")} title="Go to Library"
              style={{flex:1,height:17,padding:0,background:"transparent",border:"none",borderRight:"1px solid #161616",borderRadius:0,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",userSelect:"none"}}
              onMouseEnter={e=>{e.currentTarget.style.background="#161616";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:"#6c8088",fontFamily:"'Rajdhani', sans-serif"}}>LIBRARY</span>
            </button>
          )}
          <button onClick={()=>setTabsMinimizedPersist(!tabsMinimized)}
            aria-label={tabsMinimized ? "Show tab bar" : "Hide tab bar"}
            title={tabsMinimized ? "Show the navigation tabs" : "Hide the navigation tabs to free up space"}
            style={{...(tabsMinimized?{flex:1}:{width:"33.3333%"}),height:17,padding:0,background:"transparent",border:"none",borderRadius:0,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",gap:6,userSelect:"none"}}
            onMouseEnter={e=>{e.currentTarget.style.background="#161616";}}
            onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
            <span style={{fontSize:9,color:"#7ec8d9",lineHeight:1}}>{tabsMinimized ? "▼" : "▲"}</span>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:"#9fb4bb",fontFamily:"'Rajdhani', sans-serif"}}>{tabsMinimized ? "SHOW TABS" : "HIDE TABS"}</span>
          </button>
          {tabsMinimized && (
            <button onClick={()=>setActiveTab("repository")} title="Go to Repository"
              style={{flex:1,height:17,padding:0,background:"transparent",border:"none",borderLeft:"1px solid #161616",borderRadius:0,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center",userSelect:"none"}}
              onMouseEnter={e=>{e.currentTarget.style.background="#161616";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:"#6c8088",fontFamily:"'Rajdhani', sans-serif"}}>REPOSITORY</span>
            </button>
          )}
        </div>
        )}
        </div>
      </header>

      {/* ══ Tab Content ══ */}
      {/* AppStoreContext.Provider — the app-global data atoms + record-lifecycle callbacks are
          supplied here once; each tab reads them via useAppStore() instead of prop drilling.
          Value is built inline (not memoized) so the callbacks never capture stale closures; the
          tabs already re-render with this component, so there is no extra-render cost. */}
      <AppStoreContext.Provider value={{
        records, setRecords, edfFileStore, setEdfFileStore,
        annotationsMap, setAnnotationsMap, clinicalNotesMap, setClinicalNotesMap,
        baselineMap, setBaselineMap, collections, setCollections,
        updateRecordStatus, promoteRecord, demoteRecord, openReview,
      }}>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",borderTop:"1px solid #2a2a2a"}}>
        {activeTab === "library" && <LibraryTab onOpenTimeline={(hash)=>setTimelineSubjectHash(hash)} selectedCollectionId={libraryCollectionId} setSelectedCollectionId={setLibraryCollectionId}/>}
        {activeTab === "review" && <ReviewTab
          record={reviewRecord} onClearReview={()=>setReviewRecord(null)}
          notesShownFilesRef={notesShownFilesRef}
          openTabs={openTabs} setOpenTabs={setOpenTabs} activeTabIdx={activeTabIdx} setActiveTabIdx={setActiveTabIdx} tabEpochCache={tabEpochCache}/>}
        {activeTab === "repository" && <RepositoryTab/>}
        {activeTab === "acquire" && <AcquireTab/>}
      </div>
      </AppStoreContext.Provider>

      {/* Global tooltip layer — reads data-tip / title from any hovered element */}
      <TooltipOverlay tutorialMode={tutorialMode}/>

      {/* Global toast notifications — subscribes to notificationBus */}
      <NotificationToasts/>

      {/* Subject Timeline modal */}
      {timelineSubjectHash && (
        <SubjectTimeline subjectHash={timelineSubjectHash} records={records}
          edfFileStore={edfFileStore}
          onClose={()=>setTimelineSubjectHash(null)}
          onOpenReview={openReview}/>
      )}

      {/* Promote-to-Repository rejection dialog */}
      {promoteRejection && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}
          onClick={()=>setPromoteRejection(null)}>
          <div ref={promoteRejectDialogRef} role="dialog" aria-modal="true" aria-labelledby="promote-reject-title" onClick={e=>e.stopPropagation()} style={{background:"#0c0c0c",border:"1px solid #991b1b",borderRadius:0,padding:"20px 24px",width:520,maxHeight:"80vh",overflow:"auto",fontFamily:"'IBM Plex Mono', monospace"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
              <span id="promote-reject-title" style={{color:"#f87171",fontSize:13,fontWeight:700,letterSpacing:"0.08em"}}>{I.Alert(14)} CANNOT PROMOTE TO REPOSITORY</span>
              <button onClick={()=>setPromoteRejection(null)} aria-label="Close rejection dialog" style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:2}}>{I.X(16)}</button>
            </div>
            <div style={{fontSize:11,color:"#888",marginBottom:14,wordBreak:"break-all"}}>{promoteRejection.record.filename}</div>
            <div style={{fontSize:11,color:"#bbb",marginBottom:8}}>The following compliance check{promoteRejection.result.failCount > 1 ? "s" : ""} failed:</div>
            {promoteRejection.result.checks.filter(c => c.status === "fail").map(c => (
              <div key={c.id} style={{padding:"8px 12px",background:"#2a0a0a",border:"1px solid #4a1010",marginBottom:6,fontSize:11,color:"#f87171"}}>
                <div style={{fontWeight:700,color:"#f87171"}}>✗ {c.name}</div>
                <div style={{color:"#aaa",marginTop:2}}>{c.message}</div>
              </div>
            ))}
            <div style={{marginTop:14,fontSize:10,color:"#666",lineHeight:1.5}}>
              Repository promotion requires all compliance checks to pass (warnings and unknowns are OK).
              Address the failures above and recompute compliance, then try promoting again.
            </div>
            <div style={{marginTop:14,textAlign:"right"}}>
              <button onClick={()=>setPromoteRejection(null)} style={{background:"#111",border:"1px solid #333",color:"#888",cursor:"pointer",padding:"6px 18px",fontSize:11,fontWeight:700}}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
