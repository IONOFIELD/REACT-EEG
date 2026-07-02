import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "./version.js";

// Single builder for the annotation JSON sidecar envelope. BOTH writers — the per-file
// Export button (AnnotationPanel) and the patient-package ZIP (buildPatientPackageZip) —
// go through here, so the version provenance (schema/pipeline/app) is stamped in exactly
// one place and can be enforced by a unit test (test/versioning.test.js). Changing the
// envelope shape now means changing one function, not hunting call sites.
export function buildAnnotationSidecar(annotations, sourceFilename = null) {
  const list = Array.isArray(annotations) ? annotations : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    appVersion: APP_VERSION,
    sourceFilename: sourceFilename || null,
    exportedAt: new Date().toISOString(),
    annotationCount: list.length,
    annotations: list,
  };
}

/**
 * Inverse of buildAnnotationSidecar: validate a sidecar file back into an annotation list.
 * Tolerant on input shape (full envelope, or a bare annotation array from hand-edited /
 * third-party files), strict on the entries themselves: anything without a finite,
 * non-negative `time` is dropped and counted in `skipped`. Migration to the current
 * annotation taxonomy (migrateAnnotations) is the CALLER's job — same "migrate at each
 * load site" convention as every other annotation reader.
 *
 * @param {string|object|Array} input — JSON text, parsed envelope, or bare array
 * @returns {{annotations: Array, sourceFilename: string|null, skipped: number} | {error: string}}
 */
export function parseAnnotationSidecar(input) {
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); } catch { return { error: "not valid JSON" }; }
  }
  const list = Array.isArray(data) ? data
    : (data && typeof data === "object" && Array.isArray(data.annotations)) ? data.annotations
    : null;
  if (!list) return { error: "no annotations array found (not an annotation sidecar?)" };
  const annotations = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const time = Number(a.time);
    if (!Number.isFinite(time) || time < 0) continue;
    const duration = Number(a.duration);
    annotations.push({
      ...a,
      time,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      type: (typeof a.type === "string" && a.type) ? a.type
        : (typeof a.text === "string" && a.text) ? a.text : "Note",
      channel: Number.isInteger(a.channel) ? a.channel : -1,
    });
  }
  return {
    annotations,
    sourceFilename: (!Array.isArray(data) && typeof data.sourceFilename === "string" && data.sourceFilename) ? data.sourceFilename : null,
    skipped: list.length - annotations.length,
  };
}
