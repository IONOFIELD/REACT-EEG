import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "./version.js";

// Export-envelope builders. Like sidecar.js, each JSON artifact that leaves the app is
// assembled here — pure functions, no React/DOM — so version provenance is stamped in
// exactly one place per format and enforced by test/manifests.test.js. App.jsx call
// sites only gather the inputs and serialize the result.

/**
 * Manifest for the patient-package .zip (one subject, all promoted recordings).
 * @param {string} subjectHash
 * @param {Array}  fileEntries — per-recording summary rows (built by buildPatientPackageZip)
 */
export function buildPatientPackageManifest(subjectHash, fileEntries) {
  const files = Array.isArray(fileEntries) ? fileEntries : [];
  return {
    kind: "react-eeg-patient-package",
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    subjectHash,
    bundledAt: new Date().toISOString(),
    fileCount: files.length,
    files,
  };
}

/**
 * Metadata manifest for the ExportModal JSON export (no signal data, paths only).
 * Groups the selected records by subjectHash.
 * @param {Array} records — the selected library records
 */
export function buildExportManifest(records) {
  const list = Array.isArray(records) ? records : [];
  const bySubject = {};
  list.forEach(r => {
    if (!bySubject[r.subjectHash]) bySubject[r.subjectHash] = [];
    bySubject[r.subjectHash].push(r);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    exportDate: new Date().toISOString(),
    totalRecords: list.length,
    subjects: Object.entries(bySubject).map(([hash, recs]) => ({
      subjectHash: hash,
      recordCount: recs.length,
      records: recs.map(r => ({
        filename: r.filename, studyType: r.studyType, date: r.date,
        channels: r.channels, sampleRate: r.sampleRate, duration: r.duration, status: r.status,
        sourceType: r.sourceType || null, nonClinical: !!r.nonClinical,
        pipelineVersion: r.pipelineVersion || null,
        schemaVersion: r.schemaVersion || null,
        edfPath: `data/${r.studyType}/${r.filename}`,
        annotationPath: `annotations/${r.filename.replace('.edf', '_annotations.json')}`,
      })),
    })),
  };
}

/**
 * Single-recording .reegb bundle envelope (record + raw EDF + annotations + notes).
 * @param {object} args
 * @param {object} args.record
 * @param {string|null} args.edfBase64
 * @param {Array}  args.annotations
 * @param {string} args.clinicalNotes
 */
export function buildReegbBundle({ record, edfBase64 = null, annotations, clinicalNotes } = {}) {
  return {
    version: 1,
    kind: "react-eeg-bundle",
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    record: record || null,
    edfBase64,
    annotations: Array.isArray(annotations) ? annotations : [],
    clinicalNotes: clinicalNotes || "",
    baselineFilename: null, // per-file baseline pinning removed in v16.4
  };
}

/**
 * Whole-library metadata backup envelope. Bundles everything the browser holds that a
 * user can't otherwise regenerate — the record index, per-file clinical notes and
 * annotations, collections and the baseline map — into one restorable JSON file. This is
 * the durability escape hatch: browser storage (IndexedDB) is not a backup and can be
 * cleared by the browser or the user, so this lets them snapshot and restore.
 *
 * Raw EDF signal blobs are deliberately NOT included (they'd bloat the file and are
 * re-importable from the original .edf / per-subject .zip packages). A restored record
 * whose EDF isn't present just shows the Library's existing "no signal" flag until the
 * .edf is re-imported.
 *
 * @param {object} args
 * @param {Array}  args.records
 * @param {object} args.notesMap        — { [filename]: noteText }
 * @param {object} args.annotationsMap  — { [filename]: annotation[] }
 * @param {Array}  args.collections
 * @param {object} args.baselineMap
 */
export function buildLibraryBackup({ records, notesMap, annotationsMap, collections, baselineMap } = {}) {
  const recs = Array.isArray(records) ? records : [];
  const notesIn = notesMap && typeof notesMap === "object" ? notesMap : {};
  const annsIn = annotationsMap && typeof annotationsMap === "object" ? annotationsMap : {};
  // Keep only non-empty notes/annotations so the file stays lean.
  const notes = {};
  for (const [k, v] of Object.entries(notesIn)) if (typeof v === "string" && v) notes[k] = v;
  const annotations = {};
  for (const [k, v] of Object.entries(annsIn)) if (Array.isArray(v) && v.length) annotations[k] = v;
  return {
    kind: "react-eeg-library-backup",
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    includesEdf: false,
    recordCount: recs.length,
    records: recs,
    notes,
    annotations,
    collections: Array.isArray(collections) ? collections : [],
    baselines: baselineMap && typeof baselineMap === "object" ? baselineMap : {},
  };
}

/**
 * Inverse of buildLibraryBackup: validate a backup file back into its pieces. Tolerant of
 * a hand-edited/partial file (missing sections default to empty), strict on the wrong kind
 * of file (returns { error } — never throws). Records are kept only if they carry a string
 * filename; notes coerced to strings, annotation entries to arrays. Schema migration of the
 * restored records/annotations is the CALLER's job (migrateRecord / migrateAnnotations),
 * same convention as every other import path.
 *
 * @param {string|object} input — JSON text or parsed envelope
 * @returns {{records, notes, annotations, collections, baselines, counts, appVersion} | {error}}
 */
export function parseLibraryBackup(input) {
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); } catch { return { error: "not valid JSON" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "not a REACT EEG library backup" };
  if (data.kind && data.kind !== "react-eeg-library-backup") return { error: `unexpected file kind: ${data.kind}` };
  const isPlainObject = (o) => o && typeof o === "object" && !Array.isArray(o);
  const records = Array.isArray(data.records)
    ? data.records.filter(r => r && typeof r === "object" && typeof r.filename === "string")
    : [];
  const notes = {};
  if (isPlainObject(data.notes)) for (const [k, v] of Object.entries(data.notes)) if (typeof v === "string" && v) notes[k] = v;
  const annotations = {};
  if (isPlainObject(data.annotations)) for (const [k, v] of Object.entries(data.annotations)) if (Array.isArray(v)) annotations[k] = v;
  const collections = Array.isArray(data.collections) ? data.collections.filter(c => c && typeof c === "object") : [];
  const baselines = isPlainObject(data.baselines) ? data.baselines : {};
  return {
    records, notes, annotations, collections, baselines,
    counts: {
      records: records.length,
      notes: Object.keys(notes).length,
      annotations: Object.keys(annotations).length,
      collections: collections.length,
    },
    appVersion: typeof data.appVersion === "string" ? data.appVersion : null,
  };
}
