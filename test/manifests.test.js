// Provenance enforcement for the three JSON export envelopes that aren't the annotation
// sidecar (that one is covered in versioning.test.js). Every artifact REACT writes must
// carry schemaVersion + pipelineVersion (+ appVersion on JSON envelopes) — see the
// STAMPING RULE in src/version.js. If a future edit drops a stamp or bypasses these
// builders, this file or the source-scan tests in versioning.test.js fail.
import { describe, it, expect } from "vitest";
import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "../src/version.js";
import { buildPatientPackageManifest, buildExportManifest, buildReegbBundle,
  buildLibraryBackup, parseLibraryBackup } from "../src/manifests.js";

const STAMPS = ["schemaVersion", "pipelineVersion", "appVersion"];

function expectStamped(obj) {
  expect(obj.schemaVersion).toBe(SCHEMA_VERSION);
  expect(obj.pipelineVersion).toBe(PIPELINE_VERSION);
  expect(obj.appVersion).toBe(APP_VERSION);
  for (const k of STAMPS) expect(obj[k]).toBeTruthy();
}

const rec = (over = {}) => ({
  filename: "PHY-BL-A7F3C2-20260101-001.edf", studyType: "BL", date: "2026-01-01",
  channels: 64, sampleRate: 160, duration: 1, status: "pending",
  subjectHash: "A7F3C2", pipelineVersion: "react-pipeline-1.0.0", schemaVersion: "v16.0",
  sourceType: "import", nonClinical: false,
  ...over,
});

describe("buildPatientPackageManifest", () => {
  const entries = [{ filename: rec().filename, studyType: "BL" }];

  it("stamps schema/pipeline/app versions", () => {
    expectStamped(buildPatientPackageManifest("A7F3C2", entries));
  });

  it("carries kind, subject, count and entries verbatim", () => {
    const m = buildPatientPackageManifest("A7F3C2", entries);
    expect(m.kind).toBe("react-eeg-patient-package");
    expect(m.formatVersion).toBe(1);
    expect(m.subjectHash).toBe("A7F3C2");
    expect(m.fileCount).toBe(1);
    expect(m.files).toEqual(entries);
    expect(m.bundledAt).toBe(new Date(m.bundledAt).toISOString());
  });

  it("is null-safe on entries (still stamped)", () => {
    const m = buildPatientPackageManifest("A7F3C2", null);
    expectStamped(m);
    expect(m.fileCount).toBe(0);
    expect(m.files).toEqual([]);
  });
});

describe("buildExportManifest", () => {
  it("stamps schema/pipeline/app versions", () => {
    expectStamped(buildExportManifest([rec()]));
  });

  it("groups records by subjectHash and preserves per-record provenance", () => {
    const recs = [rec(), rec({ filename: "PHY-TX-A7F3C2-20260101-002.edf", studyType: "TX" }),
                  rec({ subjectHash: "B91D04", filename: "PHY-BL-B91D04-20260101-001.edf" })];
    const m = buildExportManifest(recs);
    expect(m.totalRecords).toBe(3);
    expect(m.subjects.length).toBe(2);
    const a = m.subjects.find(s => s.subjectHash === "A7F3C2");
    expect(a.recordCount).toBe(2);
    // per-record stamps pass through (these are the *record's own* provenance, may differ from current)
    expect(a.records[0].pipelineVersion).toBe("react-pipeline-1.0.0");
    expect(a.records[0].schemaVersion).toBe("v16.0");
    expect(a.records[0].edfPath).toBe("data/BL/PHY-BL-A7F3C2-20260101-001.edf");
    expect(a.records[0].annotationPath).toBe("annotations/PHY-BL-A7F3C2-20260101-001_annotations.json");
  });

  it("carries the sourceType provenance + nonClinical flag through the export", () => {
    const m = buildExportManifest([rec({ sourceType: "pieeg", nonClinical: true })]);
    const r = m.subjects[0].records[0];
    expect(r.sourceType).toBe("pieeg");
    expect(r.nonClinical).toBe(true);
    // absent provenance → null/false, never undefined
    const m2 = buildExportManifest([rec({ sourceType: undefined, nonClinical: undefined })]);
    expect(m2.subjects[0].records[0].sourceType).toBeNull();
    expect(m2.subjects[0].records[0].nonClinical).toBe(false);
  });

  it("per-record provenance is null (not omitted) for legacy records", () => {
    const m = buildExportManifest([rec({ pipelineVersion: undefined, schemaVersion: undefined })]);
    const r = m.subjects[0].records[0];
    expect(r.pipelineVersion).toBeNull();
    expect(r.schemaVersion).toBeNull();
  });

  it("is null-safe (empty selection still stamped)", () => {
    const m = buildExportManifest(null);
    expectStamped(m);
    expect(m.totalRecords).toBe(0);
    expect(m.subjects).toEqual([]);
  });
});

describe("buildReegbBundle", () => {
  const args = { record: rec(), edfBase64: "QUJD", annotations: [{ id: 1, type: "Spike" }], clinicalNotes: "n" };

  it("stamps schema/pipeline/app versions", () => {
    expectStamped(buildReegbBundle(args));
  });

  it("carries kind, payload and savedAt verbatim", () => {
    const b = buildReegbBundle(args);
    expect(b.kind).toBe("react-eeg-bundle");
    expect(b.version).toBe(1);
    expect(b.record).toEqual(args.record);
    expect(b.edfBase64).toBe("QUJD");
    expect(b.annotations).toEqual(args.annotations);
    expect(b.clinicalNotes).toBe("n");
    expect(b.baselineFilename).toBeNull();
    expect(b.savedAt).toBe(new Date(b.savedAt).toISOString());
  });

  it("is null-safe (no args → stamped empty envelope)", () => {
    const b = buildReegbBundle();
    expectStamped(b);
    expect(b.record).toBeNull();
    expect(b.edfBase64).toBeNull();
    expect(b.annotations).toEqual([]);
    expect(b.clinicalNotes).toBe("");
  });
});

describe("buildLibraryBackup / parseLibraryBackup", () => {
  const backupArgs = () => ({
    records: [rec(), rec({ filename: "PHY-TX-A7F3C2-20260101-002.edf", studyType: "TX" })],
    notesMap: { "PHY-BL-A7F3C2-20260101-001.edf": "resting baseline", "empty.edf": "" },
    annotationsMap: {
      "PHY-BL-A7F3C2-20260101-001.edf": [{ id: 1, time: 2.0, duration: 0.5, type: "Spike", channel: -1 }],
      "none.edf": [],
    },
    collections: [{ id: "c1", name: "Study A", filenames: ["PHY-BL-A7F3C2-20260101-001.edf"] }],
    baselineMap: { "PHY-BL-A7F3C2-20260101-001.edf": "PHY-TX-A7F3C2-20260101-002.edf" },
  });

  it("stamps schema/pipeline/app versions and carries kind + counts", () => {
    const b = buildLibraryBackup(backupArgs());
    expectStamped(b);
    expect(b.kind).toBe("react-eeg-library-backup");
    expect(b.formatVersion).toBe(1);
    expect(b.includesEdf).toBe(false);
    expect(b.recordCount).toBe(2);
    expect(b.exportedAt).toBe(new Date(b.exportedAt).toISOString());
  });

  it("drops empty notes/annotations entries but keeps records/collections/baselines verbatim", () => {
    const b = buildLibraryBackup(backupArgs());
    expect(Object.keys(b.notes)).toEqual(["PHY-BL-A7F3C2-20260101-001.edf"]); // "empty.edf" dropped
    expect(Object.keys(b.annotations)).toEqual(["PHY-BL-A7F3C2-20260101-001.edf"]); // "none.edf" [] dropped
    expect(b.records.length).toBe(2);
    expect(b.collections.length).toBe(1);
    expect(b.baselines["PHY-BL-A7F3C2-20260101-001.edf"]).toBe("PHY-TX-A7F3C2-20260101-002.edf");
  });

  it("is null-safe (no args → stamped empty backup)", () => {
    const b = buildLibraryBackup();
    expectStamped(b);
    expect(b.recordCount).toBe(0);
    expect(b.records).toEqual([]);
    expect(b.notes).toEqual({});
    expect(b.annotations).toEqual({});
    expect(b.collections).toEqual([]);
    expect(b.baselines).toEqual({});
  });

  it("round-trips through JSON via parseLibraryBackup", () => {
    const json = JSON.stringify(buildLibraryBackup(backupArgs()), null, 2);
    const p = parseLibraryBackup(json);
    expect(p.error).toBeUndefined();
    expect(p.counts).toEqual({ records: 2, notes: 1, annotations: 1, collections: 1 });
    expect(p.records.map(r => r.filename)).toEqual([
      "PHY-BL-A7F3C2-20260101-001.edf", "PHY-TX-A7F3C2-20260101-002.edf",
    ]);
    expect(p.notes["PHY-BL-A7F3C2-20260101-001.edf"]).toBe("resting baseline");
    expect(p.annotations["PHY-BL-A7F3C2-20260101-001.edf"][0].type).toBe("Spike");
    expect(p.baselines["PHY-BL-A7F3C2-20260101-001.edf"]).toBe("PHY-TX-A7F3C2-20260101-002.edf");
    expect(p.appVersion).toBe(APP_VERSION);
  });

  it("drops records without a string filename; coerces bad notes/annotations shapes", () => {
    const p = parseLibraryBackup({
      kind: "react-eeg-library-backup",
      records: [{ filename: "ok.edf" }, { nope: 1 }, null, "junk"],
      notes: { "ok.edf": "keep", "bad.edf": 42 },
      annotations: { "ok.edf": [{ time: 1 }], "bad.edf": "not-an-array" },
      collections: [{ id: "c" }, null, 7],
      baselines: { a: "b" },
    });
    expect(p.records).toEqual([{ filename: "ok.edf" }]);
    expect(p.notes).toEqual({ "ok.edf": "keep" });
    expect(Object.keys(p.annotations)).toEqual(["ok.edf"]);
    expect(p.collections).toEqual([{ id: "c" }]);
    expect(p.baselines).toEqual({ a: "b" });
  });

  it("rejects the wrong kind of file / malformed input (never throws)", () => {
    expect(parseLibraryBackup("{not json").error).toBeTruthy();
    expect(parseLibraryBackup({ kind: "react-eeg-bundle" }).error).toBeTruthy();
    expect(parseLibraryBackup(42).error).toBeTruthy();
    expect(parseLibraryBackup(null).error).toBeTruthy();
    expect(parseLibraryBackup([]).error).toBeTruthy();
  });

  it("accepts a kind-less but otherwise valid object (tolerant of hand-assembled files)", () => {
    const p = parseLibraryBackup({ records: [{ filename: "x.edf" }] });
    expect(p.error).toBeUndefined();
    expect(p.counts.records).toBe(1);
  });
});
