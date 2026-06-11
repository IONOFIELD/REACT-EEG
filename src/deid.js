// ─────────────────────────────────────────────────────────────────────────────
// De-identification module (HIPAA Safe Harbor)
// ─────────────────────────────────────────────────────────────────────────────
// Pure, dependency-free functions for de-identifying recordings on import/export.
// Kept in their own module (no React / no DOM) so they can be unit-tested with
// golden vectors (see tests/deid.test.js) — these tests guard every behavior-
// changing edit to the de-identification path.
//
// Posture: HIPAA Safe Harbor. All 18 identifiers are removed (not pseudonymized);
// dates are generalized to the year; ages over 89 are aggregated to "90+". The
// 6-char hash (derived from the full subject id) is the ONLY retained subject key.

// Deterministic 6-hex-char subject hash (xxHash-style mix). Salted; same id +
// salt always yields the same hash, so a subject's recordings group by hash with
// no reversible identifier. (Replaced an earlier djb2 variant that collided badly
// on short similar inputs like "PHY-S001" / "PHY-S004".)
export function hashSubjectId(id, salt = "REACT-EEG-2026") {
  const str = salt + id;
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(16).toUpperCase().padStart(6, "0").slice(-6);
}

// Build the de-identified filename. The visible leading segment is only the SOURCE
// acronym (e.g. "PHY-S001" → "PHY") for provenance; the per-subject number is
// dropped because the hash already identifies the subject. The date is whatever the
// caller passes — callers should pass an already-Safe-Harbor-generalized date
// (see generalizeDateToYear) so the embedded YYYYMMDD carries year only (mm/dd = 0101).
export function generateFilename(subjectId, studyType, date, sex = "", age = "", seq = 1) {
  const hash = hashSubjectId(subjectId);
  const cleanId = subjectId.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase();
  const source = cleanId.split("-")[0] || cleanId;
  // Safe Harbor: collapse the embedded date to year-only (YYYY0101) regardless of what the
  // caller passes, so a full recording date can never leak through the filename.
  const d = generalizeDateToYear(date).replace(/-/g, "");
  const demo = (sex || age) ? `-${(sex || "").toUpperCase()}${age}` : "";
  return `${source}${demo}-${studyType}-${hash}-${d}-${String(seq).padStart(3, "0")}.edf`;
}

// Parse an EDF+ "local patient identification" field ("code sex dd-MMM-yyyy name")
// for the ONLY two research covariates we keep — sex and age. Everything else (code,
// name, birthdate) is discarded; the birthdate is converted to an age and then thrown
// away. Returns { sex: "M"|"F"|"X"|null, age: number|null }.
export function parseEdfPatientField(field, now = new Date()) {
  if (!field || !field.trim()) return { sex: null, age: null };
  const parts = field.trim().split(/\s+/);
  let sex = null, age = null;
  if (parts.length >= 2 && /^[MFX]$/i.test(parts[1])) sex = parts[1].toUpperCase();
  if (parts.length >= 3 && /^\d{2}-[A-Z]{3}-\d{4}$/i.test(parts[2])) {
    const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    const [dd, mmm, yyyy] = parts[2].split("-");
    const mo = months[mmm.toUpperCase()];
    if (mo !== undefined) {
      const bd = new Date(parseInt(yyyy), mo, parseInt(dd));
      age = Math.floor((now - bd) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 0 || age > 120) age = null;
    }
  }
  return { sex, age };
}

// HIPAA Safe Harbor: dates more specific than a year must be removed. Collapse any
// YYYY[-MM-DD] date to Jan 1 of that year, preserving only the year for trend work.
export function generalizeDateToYear(dateStr) {
  const m = (dateStr || "").match(/^(\d{4})/);
  return m ? `${m[1]}-01-01` : dateStr;
}

// HIPAA Safe Harbor: all ages over 89 are aggregated into a single "90+" category.
// Returns 90 as the sentinel for that aggregate; callers display it as "90+".
export function capAge(age) {
  if (age == null || age === "") return age;
  const n = Number(age);
  if (!Number.isFinite(n)) return age;
  return n > 89 ? 90 : n;
}

// Scan free text (clinical notes, annotation labels, record notes) for likely HIPAA identifiers
// before it is EXPORTED. Returns a deduped array of matched category names (e.g. ["SSN","email"]).
// Conservative + regex-based: it WARNS the user, it does NOT auto-redact (that would risk
// destroying legitimate clinical content). Personal names cannot be reliably caught by regex and
// are intentionally not attempted — the user remains responsible for not typing names into notes.
export function scanTextForPHI(text) {
  if (!text || typeof text !== "string") return [];
  const patterns = [
    ["SSN", /\b\d{3}-\d{2}-\d{4}\b/],
    ["MRN", /\b(MRN|mrn)[:\s#]*\d{3,}\b/],
    ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ["phone", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/],
    ["date", /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{4}|\d{4}-\d{2}-\d{2})\b/],
    ["long-digit-run", /\b\d{7,}\b/],
  ];
  const hits = [];
  for (const [name, re] of patterns) if (re.test(text)) hits.push(name);
  return hits;
}

// Extract the hash and year from a REACT-convention filename whose trailing segments
// are always …-<HASH(6 hex)>-<YYYYMMDD>-<SEQ>.edf. Used to drive the on-store header
// scrub. Returns { hash, year } with year as a 4-digit string, or nulls if unmatched.
export function parseHashYearFromFilename(filename) {
  const m = (filename || "").match(/-([0-9A-Fa-f]{6})-(\d{4})\d{4}-\d+\.edf$/);
  return m ? { hash: m[1].toUpperCase(), year: m[2] } : { hash: "", year: null };
}

// Scrub every HIPAA-relevant field from a raw EDF/EDF+ header and return a NEW
// (copied) ArrayBuffer — the input is never mutated. EDF headers are fixed-offset
// ASCII (EDF spec §1):
//   offset   8 (80 bytes): local patient identification   → "<hash> X X X"  (no name/MRN/DOB)
//   offset  88 (80 bytes): local recording identification → "Startdate X X X X" (no date/tech/site)
//   offset 168 ( 8 bytes): start date dd.mm.yy            → "01.01.yy" (year only, Safe Harbor)
//   offset 176 ( 8 bytes): start time hh.mm.ss            → "00.00.00"
// Signal headers (offset 256+) and all sample data are left byte-for-byte intact, so
// the scrubbed file still parses and renders identically.
export function scrubEdfHeader(arrayBuffer, { hash = "", year = null } = {}) {
  if (!arrayBuffer || arrayBuffer.byteLength < 256) return arrayBuffer;
  const copy = arrayBuffer.slice(0);
  const bytes = new Uint8Array(copy);
  const writeField = (off, len, text) => {
    for (let i = 0; i < len; i++) {
      const code = i < text.length ? text.charCodeAt(i) : 0x20; // space-pad (EDF ASCII)
      bytes[off + i] = code < 128 ? code : 0x20;                // strip any non-ASCII
    }
  };
  writeField(8, 80, `${hash || "X"} X X X`);   // patient: code only; sex/birthdate/name dropped
  writeField(88, 80, "Startdate X X X X");      // recording: date/technician/hospital dropped
  if (year != null && /^\d{4}$/.test(String(year))) {
    writeField(168, 8, `01.01.${String(year).slice(-2)}`); // keep year, drop month/day
  }
  writeField(176, 8, "00.00.00");              // drop the precise start time
  return copy;
}

// Convenience: scrub using the hash/year recoverable from the (already de-identified)
// filename. This is the form called at the IndexedDB store chokepoint so no raw EDF
// header with PHI is ever persisted, regardless of which import path produced it.
export function scrubEdfHeaderForFilename(arrayBuffer, filename) {
  return scrubEdfHeader(arrayBuffer, parseHashYearFromFilename(filename));
}
