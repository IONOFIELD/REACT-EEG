// ══════════════════════════════════════════════════════════════
// REACT EEG — annotation taxonomy + migration
// ══════════════════════════════════════════════════════════════
// Annotations are DESCRIPTIVE technologist markups, never clinical impressions —
// REACT is non-diagnostic. The standard terms below are the field-standard ACNS
// Standardized Critical Care EEG Terminology / ILAE IIIC nomenclature (public-domain
// medical vocabulary), implemented here from that standard only.
//
// Each type carries a STABLE `code` (the persisted identity) plus a human `name`
// (button label) and `color`. Records store `code`; the array index is UI-only.
// Legacy data (pre-v15) stored only `type` (the display name) or, very early, a
// numeric index — migrateAnnotation() upgrades both losslessly.

// Order 0–8 is preserved from the original 9-type scheme so any legacy numeric
// `type` index still resolves correctly. New ACNS periodic/rhythmic terms are appended.
export const ANNOTATION_TYPES = [
  // ── Epileptiform (ACNS standard) ──
  { code: "SPIKE",    name: "Spike",         color: "#EF4444", category: "epileptiform", standard: true,  desc: "Epileptiform spike (<70 ms)" },
  { code: "SHARP",    name: "Sharp Wave",    color: "#F59E0B", category: "epileptiform", standard: true,  desc: "Sharp wave (70–200 ms)" },
  { code: "SZ",       name: "Seizure",       color: "#DC2626", category: "ictal",        standard: true,  desc: "Electrographic seizure" },
  // ── REACT-specific descriptive markups (no ACNS clinical equivalent) ──
  { code: "ARTIFACT", name: "Artifact",      color: "#6B7280", category: "technical",    standard: false, desc: "Non-cerebral / technical artifact" },
  { code: "AROUSAL",  name: "Arousal",       color: "#8B5CF6", category: "sleep",        standard: false, desc: "Arousal from sleep" },
  { code: "SPINDLE",  name: "Sleep Spindle", color: "#3B82F6", category: "sleep",        standard: false, desc: "Sleep spindle" },
  { code: "KCOMPLEX", name: "K-Complex",     color: "#14B8A6", category: "sleep",        standard: false, desc: "K-complex" },
  { code: "EYE",      name: "Eye Movement",  color: "#EC4899", category: "ocular",       standard: false, desc: "Eye-movement transient" },
  { code: "NOTE",     name: "Note",          color: "#10B981", category: "note",         standard: false, desc: "Free-text technologist note" },
  // ── ACNS periodic / rhythmic patterns (added v15) ──
  { code: "LPD",      name: "LPD",           color: "#FB923C", category: "periodic",     standard: true,  desc: "Lateralized Periodic Discharges" },
  { code: "GPD",      name: "GPD",           color: "#FACC15", category: "periodic",     standard: true,  desc: "Generalized Periodic Discharges" },
  { code: "LRDA",     name: "LRDA",          color: "#38BDF8", category: "rhythmic",     standard: true,  desc: "Lateralized Rhythmic Delta Activity" },
  { code: "GRDA",     name: "GRDA",          color: "#84CC16", category: "rhythmic",     standard: true,  desc: "Generalized Rhythmic Delta Activity" },
];

// Lookups
export const ANNOTATION_BY_CODE = Object.fromEntries(ANNOTATION_TYPES.map(t => [t.code, t]));
const CODES = new Set(ANNOTATION_TYPES.map(t => t.code));

// Legacy display-name → code (the original 9 stored `type` as these strings).
const NAME_TO_CODE = Object.fromEntries(ANNOTATION_TYPES.map(t => [t.name, t.code]));

// Very-early data stored `type` as a numeric index into the original 9-type array.
const LEGACY_INDEX_TO_CODE = ["SPIKE", "SHARP", "SZ", "ARTIFACT", "AROUSAL", "SPINDLE", "KCOMPLEX", "EYE", "NOTE"];

// Resolve any historical `type` value to a stable code, or null if unknown.
export function codeForType(type) {
  if (type === null || type === undefined) return null;
  if (typeof type === "number") return LEGACY_INDEX_TO_CODE[type] ?? null;
  if (CODES.has(type)) return type;          // already a code
  return NAME_TO_CODE[type] ?? null;         // display name → code
}

// Upgrade a single annotation to the current schema by attaching a stable `code`.
// LOSSLESS: only adds fields; never removes or rewrites existing payload (except
// normalizing a numeric `type` index to its display name for readability).
export function migrateAnnotation(ann) {
  if (!ann || typeof ann !== "object") return ann;
  if (CODES.has(ann.code)) return ann;        // already migrated — idempotent
  const code = codeForType(ann.type) ?? (ann.source === "edf" ? "EDF_EVENT" : null);
  const out = { ...ann, code };
  if (typeof ann.type === "number") {
    const t = ANNOTATION_BY_CODE[code];
    if (t) out.type = t.name;                 // numeric index → readable name
  }
  return out;
}

export function migrateAnnotations(list) {
  if (!Array.isArray(list)) return [];
  return list.map(migrateAnnotation);
}
