// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// ══════════════════════════════════════════════════════════════
// REACT EEG — EEG recording structure detection (pure)
// ══════════════════════════════════════════════════════════════
// Works out how an EDF's scalp channels were recorded, from their labels alone, so Review can
// open each file in a montage that actually displays it:
//
//   referential — one electrode per channel, against a common reference:
//                 "Fp1", "Fc3.", "EEG Fp1-Ref", "EEG FP1-LE", "Fp1-A1"
//   derived     — the file already stores derivations (it was montaged before export):
//                 "FP1-F7", "F7-T7" (CHB-MIT), "EEG Fpz-Cz" (Sleep-EDF)
//   unknown     — no recognisable scalp electrodes
//
// The electrode-name table lives in App.jsx (it is shared with topo/montage building), so the
// caller passes `canon(token) → canonical 10-10 name | null`. Pure, unit-tested in
// test/eeg-structure.test.js against real labels from four public datasets.

// Suffix tokens that mean "referenced to a common reference", not "minus another scalp electrode".
// Cz is deliberately NOT here: "Fpz-Cz" is a real derivation in Sleep-EDF.
const REFERENCE_TOKENS = new Set([
  "REF", "REFERENCE", "LE", "RE", "A1", "A2", "A12", "A1A2", "M1", "M2", "LM",
  "AVG", "AV", "AVE", "AVERAGE", "CAR",
]);

// The 19 electrodes the classic 10-20 longitudinal bipolar ("double banana") montage uses.
export const CLASSIC_BANANA_ELECTRODES = [
  "Fp1", "F3", "C3", "P3", "O1", "Fp2", "F4", "C4", "P4", "O2",
  "F7", "T3", "T5", "F8", "T4", "T6", "Fz", "Cz", "Pz",
];
// A referential 10-20 file covering at least this many of them opens in the classic banana;
// sparser files (or modern T7/P7 naming) open in the adaptive banana, which bridges gaps.
export const BANANA_MIN_COVERAGE = 16;

export const MONTAGE = { CLASSIC: "bipolar-longitudinal", ADAPTIVE: "adaptive-banana", AS_RECORDED: "as-recorded" };

export function isReferenceToken(token) {
  return REFERENCE_TOKENS.has(String(token || "").trim().toUpperCase().replace(/[\s.+]/g, ""));
}

/**
 * Split an EDF signal label into its base electrode token and what follows the dash.
 * "EEG Fp1-Ref" → { base: "Fp1", ref: "Ref" }; "Fc3." → { base: "Fc3", ref: null };
 * "FP1-F7" → { base: "FP1", ref: "F7" }.
 */
export function splitEdfLabel(label) {
  const s = String(label || "").trim().replace(/^(EEG|ECG|EKG|EOG|EMG)\s+/i, "").replace(/\.+$/, "").trim();
  const dash = s.indexOf("-");
  if (dash <= 0) return { base: s.replace(/\./g, ""), ref: null };
  return { base: s.slice(0, dash).replace(/\./g, "").trim(), ref: s.slice(dash + 1).replace(/\./g, "").trim() || null };
}

/**
 * Matching key for a referential label: its electrode name in the montage code's normalised form
 * (upper-case, no spaces/dots). "EEG Fp1-Ref" → "FP1". Returns null for a derivation ("FP1-F7"),
 * which has no single-electrode meaning.
 */
export function electrodeMatchKey(label) {
  const { base, ref } = splitEdfLabel(label);
  if (!base || (ref && !isReferenceToken(ref))) return null;
  return base.toUpperCase().replace(/[\s.]/g, "");
}

/**
 * Classify a recording's scalp-channel structure.
 * @param {string[]} labels  EDF signal labels
 * @param {(token: string) => string|null} canon  token → canonical electrode name, or null
 * @returns {{ kind: "referential"|"derived"|"unknown", electrodes: string[], system: string|null,
 *             referentialCount: number, derivedCount: number, bananaCoverage: number }}
 */
export function classifyStructure(labels, canon) {
  const referential = new Set();
  const derived = new Set();
  let referentialCount = 0, derivedCount = 0;
  for (const label of Array.isArray(labels) ? labels : []) {
    const { base, ref } = splitEdfLabel(label);
    const e = base ? canon(base) : null;
    if (!e) continue;
    if (!ref || isReferenceToken(ref)) { referentialCount++; referential.add(e); continue; }
    const r = canon(ref);
    if (r) { derivedCount++; derived.add(e); derived.add(r); }
  }
  const kind = referentialCount === 0 && derivedCount === 0 ? "unknown"
    : derivedCount > referentialCount ? "derived" : "referential";
  const electrodes = [...(kind === "derived" ? derived : referential)];
  const n = electrodes.length;
  return {
    kind,
    electrodes,
    system: n === 0 ? null : n <= 21 ? "10-20" : n <= 40 ? "hd-40" : "10-10",
    referentialCount,
    derivedCount,
    bananaCoverage: CLASSIC_BANANA_ELECTRODES.filter((x) => referential.has(x)).length,
  };
}

/** The montage a recording should open in, given its structure. */
export function recommendMontage(structure) {
  if (!structure || structure.kind !== "referential") return MONTAGE.AS_RECORDED;
  if (structure.system === "10-20" && structure.bananaCoverage >= BANANA_MIN_COVERAGE) return MONTAGE.CLASSIC;
  return MONTAGE.ADAPTIVE;
}

/** Short plain-language description, e.g. "Referential 10-20 · 19 electrodes". */
export function describeStructure(structure) {
  if (!structure || structure.kind === "unknown") return "No standard scalp electrodes recognised";
  const n = structure.electrodes.length;
  if (structure.kind === "derived") return `Pre-montaged derivations · ${n} electrodes`;
  return `Referential ${structure.system} · ${n} electrodes`;
}
