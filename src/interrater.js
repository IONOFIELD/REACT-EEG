// ══════════════════════════════════════════════════════════════
// REACT EEG — inter-rater / provenance helpers
// ══════════════════════════════════════════════════════════════
// Lets more than one annotator mark the same segment and surfaces a simple
// concordant/discordant indicator. This is NOT a statistics or inference engine —
// it only reports whether two or more distinct annotators chose the same code.
//
// Privacy: annotator identity is pseudonymous. We hash the user's chosen label to an
// opaque id and store ONLY the hash on annotations/exports — never the label, never PHI.

// Opaque, deterministic annotator id from a pseudonymous label (cyrb53-family hash,
// public-domain algorithm, implemented locally). Same label → same id (so a rater's marks
// group together); empty/blank label → null (treated as anonymous, not a distinct rater).
export function hashAnnotator(label, salt = "REACT-EEG-annotator") {
  const s = String(label ?? "").trim();
  if (!s) return null;
  const str = salt + "|" + s;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return "anr-" + n.toString(36).padStart(8, "0").slice(-8);
}

// Do two annotations cover overlapping time? Point marks (duration 0) overlap within eps.
export function annotationsOverlap(a, b, eps = 0.001) {
  if (!a || !b || typeof a.time !== "number" || typeof b.time !== "number") return false;
  const aS = a.time, aE = a.time + (a.duration || 0);
  const bS = b.time, bE = b.time + (b.duration || 0);
  return aS <= bE + eps && bS <= aE + eps;
}

// Interval-merge annotations into segments of overlapping marks (sorted by start time).
export function groupBySegment(annotations, eps = 0.001) {
  const sorted = (Array.isArray(annotations) ? annotations : [])
    .filter(a => a && typeof a.time === "number")
    .sort((x, y) => x.time - y.time);
  const groups = [];
  let cur = null, curEnd = -Infinity;
  for (const a of sorted) {
    const s = a.time, e = a.time + (a.duration || 0);
    if (cur && s <= curEnd + eps) { cur.push(a); curEnd = Math.max(curEnd, e); }
    else { cur = [a]; groups.push(cur); curEnd = e; }
  }
  return groups;
}

// Agreement for one overlapping segment:
//   • null         — fewer than 2 DISTINCT annotators (nothing to compare)
//   • "concordant" — all distinct annotators chose the same code
//   • "discordant" — distinct annotators chose different codes
// Descriptive only; no weighting, no inference.
export function segmentAgreement(group) {
  const codesByRater = new Map();
  for (const a of (group || [])) {
    const id = a && a.annotatorId;
    if (!id) continue; // anonymous marks don't count as a distinct rater
    if (!codesByRater.has(id)) codesByRater.set(id, new Set());
    codesByRater.get(id).add(a.code ?? a.type ?? null);
  }
  if (codesByRater.size < 2) return null;
  const all = new Set();
  for (const set of codesByRater.values()) for (const c of set) all.add(c);
  return all.size === 1 ? "concordant" : "discordant";
}

// Map every annotation id → its segment agreement (or null). Used by the UI to badge marks.
export function agreementByAnnotation(annotations) {
  const out = {};
  for (const g of groupBySegment(annotations)) {
    const ag = segmentAgreement(g);
    for (const a of g) if (a && a.id != null) out[a.id] = ag;
  }
  return out;
}
