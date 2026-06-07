// Enforce — don't merely declare — provenance stamping.
//
// Both annotation-sidecar writers in App.jsx (the per-file Export button and the
// patient-package ZIP) route through buildAnnotationSidecar(). Asserting the stamp here
// therefore guarantees every annotation sidecar REACT writes carries the schema, pipeline
// and app versions. If a future edit drops a field or hardcodes a stale version, this fails.
import { describe, it, expect } from "vitest";
import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "../src/version.js";
import { buildAnnotationSidecar } from "../src/sidecar.js";

describe("version constants", () => {
  it("are non-empty strings", () => {
    for (const v of [APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION]) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });
});

describe("buildAnnotationSidecar — provenance is always stamped", () => {
  const sample = [
    { id: 1, time: 1.0, duration: 0.5, type: "Spike", channel: -1 },
    { id: 2, time: 4.2, duration: 1.0, type: "Seizure", channel: -1 },
  ];

  for (const [label, anns] of [["with annotations", sample], ["empty", []], ["null-safe", null]]) {
    it(`stamps schema/pipeline/app versions (${label})`, () => {
      const sc = buildAnnotationSidecar(anns, "REACT-BL-A7F3-20260309-001.edf");
      expect(sc.schemaVersion).toBe(SCHEMA_VERSION);
      expect(sc.pipelineVersion).toBe(PIPELINE_VERSION);
      expect(sc.appVersion).toBe(APP_VERSION);
      // every version field present & truthy
      for (const k of ["schemaVersion", "pipelineVersion", "appVersion"]) {
        expect(sc[k]).toBeTruthy();
      }
    });
  }

  it("records an ISO timestamp and the source filename", () => {
    const sc = buildAnnotationSidecar(sample, "file.edf");
    expect(sc.sourceFilename).toBe("file.edf");
    expect(() => new Date(sc.exportedAt).toISOString()).not.toThrow();
    expect(sc.exportedAt).toBe(new Date(sc.exportedAt).toISOString());
  });

  it("preserves annotation payload and count", () => {
    const sc = buildAnnotationSidecar(sample, "file.edf");
    expect(sc.annotationCount).toBe(2);
    expect(sc.annotations).toEqual(sample);
  });

  it("is null-safe (missing list → empty array, count 0)", () => {
    const sc = buildAnnotationSidecar(undefined);
    expect(sc.annotations).toEqual([]);
    expect(sc.annotationCount).toBe(0);
    expect(sc.sourceFilename).toBeNull();
  });
});
