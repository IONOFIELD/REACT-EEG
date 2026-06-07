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
