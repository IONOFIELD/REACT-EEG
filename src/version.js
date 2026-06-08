// ── App identity / versioning ──
// Single source of truth for the three version stamps, shared by App.jsx (UI, record +
// sidecar stamping) and dsp.js (pipeline provenance in DSP logs). Bump SCHEMA_VERSION when
// the persisted record/annotation shape changes (and add a migration); bump APP_VERSION on
// release; PIPELINE_VERSION tracks the DSP pipeline contract.
export const APP_VERSION = "v18.3";
export const PIPELINE_VERSION = "react-pipeline-1.0.0";
export const SCHEMA_VERSION = "v15.0"; // record/annotation-shape version; bump on breaking schema changes
// v15.0: annotations gain a stable ACNS/ILAE `code`; ACNS periodic/rhythmic terms added.
