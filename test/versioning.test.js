// Enforce — don't merely declare — provenance stamping.
//
// Both annotation-sidecar writers in App.jsx (the per-file Export button and the
// patient-package ZIP) route through buildAnnotationSidecar(). Asserting the stamp here
// therefore guarantees every annotation sidecar REACT writes carries the schema, pipeline
// and app versions. If a future edit drops a field or hardcodes a stale version, this fails.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION } from "../src/version.js";
import { buildAnnotationSidecar, parseAnnotationSidecar } from "../src/sidecar.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appSrc = read("../src/App.jsx");

describe("version constants", () => {
  it("are non-empty strings", () => {
    for (const v of [APP_VERSION, PIPELINE_VERSION, SCHEMA_VERSION]) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("follow the documented formats (version.js scheme)", () => {
    expect(APP_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(PIPELINE_VERSION).toMatch(/^react-pipeline-\d+\.\d+\.\d+$/);
    expect(SCHEMA_VERSION).toMatch(/^v\d+\.\d+$/);
  });
});

// ── Release checklist sync (the four places in src/version.js must agree) ──
describe("release-checklist sync", () => {
  const pkg = JSON.parse(read("../package.json"));
  const lock = JSON.parse(read("../package-lock.json"));
  const appMajorMinor = APP_VERSION.replace(/^v/, ""); // "v18.5" → "18.5"

  it("package.json version matches APP_VERSION", () => {
    expect(pkg.version === appMajorMinor || pkg.version.startsWith(appMajorMinor + ".")).toBe(true);
  });

  it("package-lock.json matches package.json (both top-level and packages[''])", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("CHANGELOG top entry matches APP_VERSION", () => {
    const m = appSrc.match(/const CHANGELOG = \[\s*\{\s*version:\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(APP_VERSION);
  });
});

// ── Source-scan enforcement: every export surface stamps, no ad-hoc envelopes ──
// The JSON envelopes are pure functions in src/manifests.js / src/sidecar.js and are
// unit-tested directly (manifests.test.js + below). These scans close the remaining
// holes: App.jsx must actually CALL the builders (not re-inline an envelope), the
// HTML Data Sheet must reference the constants, and nothing may hardcode a stamp.
describe("export stamping — source scan of App.jsx", () => {
  it("all four envelope builders are called", () => {
    for (const fn of ["buildAnnotationSidecar(", "buildPatientPackageManifest(", "buildExportManifest(", "buildReegbBundle("]) {
      expect(appSrc.includes(fn), `App.jsx must call ${fn})`).toBe(true);
    }
  });

  it("no inline export-envelope construction (kind: \"react-eeg-…\" literals live only in manifests.js)", () => {
    // `.kind === "react-eeg-…"` comparisons on the import paths are fine; constructing
    // an envelope inline (`kind: "react-eeg-…"`) would bypass the stamped builders.
    expect(appSrc).not.toMatch(/kind:\s*["']react-eeg-/);
  });

  it("Data Sheet HTML references PIPELINE_VERSION and SCHEMA_VERSION", () => {
    const start = appSrc.indexOf("function generateDataSheetHTML");
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf("\nfunction ", start + 1);
    const body = appSrc.slice(start, end > -1 ? end : undefined);
    expect(body).toContain("PIPELINE_VERSION");
    expect(body).toContain("SCHEMA_VERSION");
  });

  it("no hardcoded version stamps anywhere in App.jsx", () => {
    // Stamps must come from the version.js constants, never string literals.
    expect(appSrc).not.toMatch(/pipelineVersion\s*:\s*["']/);
    expect(appSrc).not.toMatch(/appVersion\s*:\s*["']/);
    expect(appSrc.includes("react-pipeline-")).toBe(false);
    // schemaVersion object-literal strings are likewise banned; migrateRecord's
    // `r.schemaVersion = "vXX"` assignments (the migration ladder) use `=`, not `:`,
    // so they are intentionally exempt from this pattern.
    expect(appSrc).not.toMatch(/schemaVersion\s*:\s*["']/);
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

describe("parseAnnotationSidecar — sidecar import round-trip", () => {
  const sample = [
    { id: 1, time: 1.0, duration: 0.5, type: "Spike", channel: -1 },
    { id: 2, time: 4.2, duration: 1.0, type: "Seizure", channel: 3, text: "left temporal" },
  ];

  it("round-trips what buildAnnotationSidecar exports (via JSON text)", () => {
    const json = JSON.stringify(buildAnnotationSidecar(sample, "file.edf"), null, 2);
    const res = parseAnnotationSidecar(json);
    expect(res.error).toBeUndefined();
    expect(res.annotations).toEqual(sample);
    expect(res.sourceFilename).toBe("file.edf");
    expect(res.skipped).toBe(0);
  });

  it("accepts a bare annotation array (hand-edited / third-party files)", () => {
    const res = parseAnnotationSidecar(JSON.stringify(sample));
    expect(res.annotations).toEqual(sample);
    expect(res.sourceFilename).toBeNull();
  });

  it("drops entries without a finite non-negative time, counts them in skipped", () => {
    const res = parseAnnotationSidecar({ annotations: [
      sample[0], { type: "Spike" }, { time: -3, type: "Spike" }, { time: "NaN-ish", type: "x" }, null, "junk",
    ]});
    expect(res.annotations).toEqual([sample[0]]);
    expect(res.skipped).toBe(5);
  });

  it("normalizes malformed fields (string time, missing duration/type/channel)", () => {
    const res = parseAnnotationSidecar({ annotations: [{ time: "2.5", text: "blink" }] });
    const a = res.annotations[0];
    expect(a.time).toBe(2.5);
    expect(a.duration).toBe(0);
    expect(a.type).toBe("blink"); // falls back to text, then "Note"
    expect(a.channel).toBe(-1);
  });

  it("rejects non-sidecar input with an error (never throws)", () => {
    expect(parseAnnotationSidecar("{not json").error).toBeTruthy();
    expect(parseAnnotationSidecar({ foo: 1 }).error).toBeTruthy();
    expect(parseAnnotationSidecar(42).error).toBeTruthy();
    expect(parseAnnotationSidecar(null).error).toBeTruthy();
  });
});
