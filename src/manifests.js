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
