// ── App identity / versioning — THE versioning scheme (single source of truth) ──
//
// REACT EEG stamps three independent version namespaces. They answer different
// questions and move at different speeds; none is derivable from another:
//
//   APP_VERSION       "v<major>.<minor>"        — What build of the application is this?
//                     Bumped every release wave. Shown in the header chip, splash
//                     footer and document.title; stamped on exports for support
//                     traceability ("which build wrote this file?").
//
//   PIPELINE_VERSION  "react-pipeline-<semver>" — What DSP contract produced these numbers?
//                     Bumped ONLY when an algorithm change alters analysis OUTPUT
//                     (filters, band power, ICA, artifact handling, compliance math).
//                     Two exports with the same PIPELINE_VERSION are numerically
//                     comparable; a UI-only release must NOT bump this.
//
//   SCHEMA_VERSION    "v<major>.<minor>"        — What shape are the persisted records?
//                     Bumped ONLY when the stored record/annotation shape changes in a
//                     way readers must handle. Every bump REQUIRES a matching step in
//                     migrateRecord() (App.jsx) so older libraries load cleanly.
//                     History: v13 → v14.0 → v14.1 → v15.0 → v16.0.
//                     v15.0: annotations gain a stable ACNS/ILAE `code`; ACNS
//                     periodic/rhythmic terms added.
//                     v16.0: records gain a structured `sourceType` provenance tag
//                     (pieeg/acquire/import/package/public-dataset) + `nonClinical` flag.
//
// STAMPING RULE (enforced by test/versioning.test.js + test/manifests.test.js):
// every artifact that leaves the app — annotation sidecar (sidecar.js), patient-package
// zip manifest, ExportModal JSON manifest, .reegb bundle (all manifests.js), Data Sheet
// HTML — must carry PIPELINE_VERSION and SCHEMA_VERSION (plus APP_VERSION on the JSON
// envelopes). Build export envelopes in src/manifests.js or src/sidecar.js, never as
// ad-hoc object literals in App.jsx, so the tests can see them.
//
// RELEASE CHECKLIST when bumping APP_VERSION (all four, in this order):
//   1. APP_VERSION here (flows to UI + exports automatically)
//   2. "version" in package.json            (= APP_VERSION without the leading "v", + ".0" patch)
//   3. package-lock.json — BOTH the top-level "version" AND packages[""].version
//   4. Prepend { version, items } to CHANGELOG in App.jsx (top entry renders as "· current")
// test/versioning.test.js fails if 1/2/3/4 drift apart.
export const APP_VERSION = "v20.0";
export const PIPELINE_VERSION = "react-pipeline-1.0.0";
export const SCHEMA_VERSION = "v16.0";
