// Phase 4 — inter-rater / provenance helpers.
//
// Covers: pseudonymous (hashed) annotator ids, segment overlap grouping, and the
// descriptive concordant/discordant indicator. No statistics/inference is asserted —
// only the simple "did ≥2 distinct annotators pick the same code" rule.
import { describe, it, expect } from "vitest";
import {
  hashAnnotator, annotationsOverlap, groupBySegment, segmentAgreement, agreementByAnnotation,
} from "../src/interrater.js";

describe("hashAnnotator", () => {
  it("is deterministic and opaque (never echoes the label)", () => {
    const id = hashAnnotator("Dr. Jane Smith");
    expect(id).toBe(hashAnnotator("Dr. Jane Smith"));   // stable
    expect(id).toMatch(/^anr-[0-9a-z]{1,8}$/);
    expect(id.toLowerCase()).not.toContain("jane");      // no PHI leakage
    expect(id.toLowerCase()).not.toContain("smith");
  });
  it("distinct labels give distinct ids; blank → null (anonymous)", () => {
    expect(hashAnnotator("tech-A")).not.toBe(hashAnnotator("tech-B"));
    expect(hashAnnotator("")).toBeNull();
    expect(hashAnnotator("   ")).toBeNull();
    expect(hashAnnotator(null)).toBeNull();
  });
});

describe("annotationsOverlap", () => {
  it("detects overlapping and point-coincident marks", () => {
    expect(annotationsOverlap({ time: 1, duration: 2 }, { time: 2, duration: 1 })).toBe(true);
    expect(annotationsOverlap({ time: 5, duration: 0 }, { time: 5, duration: 0 })).toBe(true);
    expect(annotationsOverlap({ time: 1, duration: 1 }, { time: 5, duration: 1 })).toBe(false);
  });
});

describe("groupBySegment", () => {
  it("interval-merges overlapping marks into segments", () => {
    const anns = [
      { id: 1, time: 0, duration: 2 },
      { id: 2, time: 1, duration: 2 },   // overlaps 1
      { id: 3, time: 10, duration: 1 },  // separate
    ];
    const groups = groupBySegment(anns);
    expect(groups).toHaveLength(2);
    expect(groups[0].map(a => a.id).sort()).toEqual([1, 2]);
    expect(groups[1].map(a => a.id)).toEqual([3]);
  });
});

describe("segmentAgreement", () => {
  const A = hashAnnotator("rater-A");
  const B = hashAnnotator("rater-B");
  it("returns null when fewer than 2 distinct annotators", () => {
    expect(segmentAgreement([{ annotatorId: A, code: "SZ" }])).toBeNull();
    expect(segmentAgreement([{ annotatorId: A, code: "SZ" }, { annotatorId: A, code: "LPD" }])).toBeNull(); // same rater
    expect(segmentAgreement([{ code: "SZ" }, { code: "SZ" }])).toBeNull(); // anonymous → not distinct raters
  });
  it("concordant when distinct annotators chose the same code", () => {
    expect(segmentAgreement([{ annotatorId: A, code: "SZ" }, { annotatorId: B, code: "SZ" }])).toBe("concordant");
  });
  it("discordant when distinct annotators chose different codes", () => {
    expect(segmentAgreement([{ annotatorId: A, code: "SZ" }, { annotatorId: B, code: "LPD" }])).toBe("discordant");
  });
});

describe("agreementByAnnotation", () => {
  const A = hashAnnotator("rater-A");
  const B = hashAnnotator("rater-B");
  it("badges every mark in a multi-rater segment and leaves solo marks null", () => {
    const anns = [
      { id: 1, time: 0, duration: 2, annotatorId: A, code: "SZ" },
      { id: 2, time: 1, duration: 1, annotatorId: B, code: "SZ" }, // overlaps 1, same code
      { id: 3, time: 20, duration: 1, annotatorId: A, code: "LPD" }, // solo
      { id: 4, time: 30, duration: 2, annotatorId: A, code: "GPD" },
      { id: 5, time: 31, duration: 1, annotatorId: B, code: "GRDA" }, // overlaps 4, different code
    ];
    const out = agreementByAnnotation(anns);
    expect(out[1]).toBe("concordant");
    expect(out[2]).toBe("concordant");
    expect(out[3]).toBeNull();
    expect(out[4]).toBe("discordant");
    expect(out[5]).toBe("discordant");
  });
  it("multiple annotations per segment from different annotators are all retained", () => {
    // (the model stores them as independent records — nothing dedupes)
    const anns = [
      { id: 1, time: 5, duration: 1, annotatorId: A, code: "SZ" },
      { id: 2, time: 5, duration: 1, annotatorId: B, code: "SZ" },
    ];
    expect(groupBySegment(anns)[0]).toHaveLength(2);
    expect(agreementByAnnotation(anns)[1]).toBe("concordant");
  });
});
