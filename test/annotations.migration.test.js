// Phase 3 — annotation taxonomy + lossless migration.
//
// Locks two guarantees:
//   1. The ACNS/ILAE standard terms (Seizure, LPD, GPD, LRDA, GRDA + spike/sharp) are present
//      as first-class types with stable codes, and the REACT-specific markups are retained.
//   2. Pre-v15 sidecars (which stored only a display-name `type`, or a very-early numeric
//      index) load without data loss — migration only ADDS a `code`, never drops payload.
import { describe, it, expect } from "vitest";
import {
  ANNOTATION_TYPES, ANNOTATION_BY_CODE, codeForType, migrateAnnotation, migrateAnnotations,
} from "../src/annotations.js";

describe("taxonomy", () => {
  it("includes the ACNS/ILAE standard terms as first-class codes", () => {
    for (const code of ["SZ", "LPD", "GPD", "LRDA", "GRDA", "SPIKE", "SHARP"]) {
      expect(ANNOTATION_BY_CODE[code]).toBeTruthy();
      expect(ANNOTATION_BY_CODE[code].standard).toBe(true);
    }
  });
  it("retains the REACT-specific descriptive markups (non-standard)", () => {
    for (const code of ["ARTIFACT", "AROUSAL", "SPINDLE", "KCOMPLEX", "EYE", "NOTE"]) {
      expect(ANNOTATION_BY_CODE[code]).toBeTruthy();
      expect(ANNOTATION_BY_CODE[code].standard).toBe(false);
    }
  });
  it("preserves the original 9 types at their legacy indices (numeric back-compat)", () => {
    const legacy = ["SPIKE", "SHARP", "SZ", "ARTIFACT", "AROUSAL", "SPINDLE", "KCOMPLEX", "EYE", "NOTE"];
    legacy.forEach((code, i) => expect(ANNOTATION_TYPES[i].code).toBe(code));
  });
  it("every type has a unique code, a name and a colour", () => {
    const codes = ANNOTATION_TYPES.map(t => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const t of ANNOTATION_TYPES) {
      expect(t.name).toBeTruthy();
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("codeForType", () => {
  it("maps legacy display names to codes", () => {
    expect(codeForType("Spike")).toBe("SPIKE");
    expect(codeForType("Sharp Wave")).toBe("SHARP");
    expect(codeForType("Seizure")).toBe("SZ");
    expect(codeForType("K-Complex")).toBe("KCOMPLEX");
  });
  it("maps legacy numeric indices to codes", () => {
    expect(codeForType(0)).toBe("SPIKE");
    expect(codeForType(2)).toBe("SZ");
    expect(codeForType(8)).toBe("NOTE");
  });
  it("passes through values that are already codes", () => {
    expect(codeForType("LPD")).toBe("LPD");
    expect(codeForType("GRDA")).toBe("GRDA");
  });
  it("returns null for unknown / empty", () => {
    expect(codeForType("Totally Unknown")).toBeNull();
    expect(codeForType(null)).toBeNull();
    expect(codeForType(undefined)).toBeNull();
  });
});

describe("migrateAnnotation — lossless upgrade", () => {
  it("adds a stable code to a legacy name-based annotation, keeping all fields", () => {
    const legacy = { id: 7, time: 12.5, duration: 0.8, type: "Seizure", color: "#DC2626", text: "onset", channel: -1 };
    const m = migrateAnnotation(legacy);
    expect(m.code).toBe("SZ");
    // every original field preserved
    for (const k of Object.keys(legacy)) expect(m[k]).toEqual(legacy[k]);
  });
  it("normalizes a numeric-index type to its display name and adds the code", () => {
    const m = migrateAnnotation({ id: 1, type: 2, time: 0, duration: 0 }); // 2 → Seizure
    expect(m.code).toBe("SZ");
    expect(m.type).toBe("Seizure");
    expect(m.time).toBe(0);
  });
  it("is idempotent — re-migrating an already-coded annotation is a no-op", () => {
    const once = migrateAnnotation({ id: 1, type: "Spike" });
    const twice = migrateAnnotation(once);
    expect(twice).toBe(once); // returns the same object reference, unchanged
  });
  it("tags EDF-sourced events without forcing them into the taxonomy", () => {
    const edf = { id: 9, type: "T0", source: "edf", time: 3.1, duration: 0 };
    const m = migrateAnnotation(edf);
    expect(m.code).toBe("EDF_EVENT");
    expect(m.type).toBe("T0");       // original label preserved
    expect(m.source).toBe("edf");
  });
  it("leaves an unknown user type with a null code (no data invented or lost)", () => {
    const m = migrateAnnotation({ id: 5, type: "Custom thing", text: "keep me" });
    expect(m.code).toBeNull();
    expect(m.type).toBe("Custom thing");
    expect(m.text).toBe("keep me");
  });
});

describe("migrateAnnotations (array, as used at load sites)", () => {
  it("migrates a mixed legacy sidecar payload", () => {
    const list = [
      { id: 1, type: "Spike" },
      { id: 2, type: 2 },
      { id: 3, type: "GRDA" },          // already a code
      { id: 4, type: "T1", source: "edf" },
    ];
    const out = migrateAnnotations(list);
    expect(out.map(a => a.code)).toEqual(["SPIKE", "SZ", "GRDA", "EDF_EVENT"]);
    expect(out).toHaveLength(4);
  });
  it("returns [] for non-array input", () => {
    expect(migrateAnnotations(null)).toEqual([]);
    expect(migrateAnnotations(undefined)).toEqual([]);
  });
});
