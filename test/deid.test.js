// Golden-vector tests for the de-identification module (HIPAA Safe Harbor).
// Deterministic inputs, exact assertions. These guard every behavior-changing edit
// to the de-id path — per the audit, the EDF-header scrub is the legal core.
//   run:  npm test        (vitest run)
//   watch: npm run test:watch
import { describe, it, expect } from "vitest";
import {
  hashSubjectId, generateFilename, parseEdfPatientField,
  generalizeDateToYear, capAge, parseHashYearFromFilename,
  scrubEdfHeader, scrubEdfHeaderForFilename, scanTextForPHI, scanLibraryForPHI, setHashSalt,
} from "../src/deid.js";

const ascii = (buf, off, len) => new TextDecoder("ascii").decode(new Uint8Array(buf, off, len));

// Build a synthetic EDF header with PHI planted at the four fixed-offset fields,
// plus a deterministic sentinel pattern across the signal-header region (offset 256+)
// so we can prove the scrub leaves everything after the main header byte-for-byte.
function makeEdf({ patient, recording, date, time }) {
  const buf = new ArrayBuffer(512);
  const b = new Uint8Array(buf);
  const w = (off, len, s) => { for (let i = 0; i < len; i++) b[off + i] = i < s.length ? s.charCodeAt(i) : 0x20; };
  w(0, 8, "0       ");
  w(8, 80, patient);
  w(88, 80, recording);
  w(168, 8, date);
  w(176, 8, time);
  for (let i = 256; i < 512; i++) b[i] = (i * 7) & 0xff; // signal-header sentinel
  return buf;
}

describe("hashSubjectId", () => {
  it("is deterministic and 6 uppercase hex chars", () => {
    expect(hashSubjectId("PHY-S001")).toBe("A9024A");
    expect(hashSubjectId("PHY-S001")).toBe(hashSubjectId("PHY-S001"));
    expect(hashSubjectId("PHY-S001")).toMatch(/^[0-9A-F]{6}$/);
  });
  it("does not collide on short similar ids (the bug the cyrb53 hash fixed)", () => {
    expect(hashSubjectId("PHY-S004")).toBe("864A9F");
    expect(hashSubjectId("PHY-S001")).not.toBe(hashSubjectId("PHY-S004"));
  });
  it("is salt-dependent", () => {
    expect(hashSubjectId("PHY-S001", "other-salt")).not.toBe(hashSubjectId("PHY-S001"));
  });
});

describe("generateFilename", () => {
  it("emits SOURCE[-SEXAGE]-TYPE-HASH-DATE-SEQ.edf with source acronym only", () => {
    expect(generateFilename("PHY-S001", "BL", "2026-01-01", "X", "")).toBe("PHY-X-BL-A9024A-20260101-001.edf");
    expect(generateFilename("PHY-S001", "FU", "2026-01-01", "M", 34, 2)).toBe("PHY-M34-FU-A9024A-20260101-002.edf");
  });
  it("Safe Harbor: collapses a full day/month recording date to year-only in the filename", () => {
    // The embedded date must never carry the real month/day — only YYYY0101.
    expect(generateFilename("PHY-S001", "FU", "2026-03-15", "M", 34, 2)).toBe("PHY-M34-FU-A9024A-20260101-002.edf");
    expect(generateFilename("PHY-S001", "BL", "2025-12-31")).toBe("PHY-BL-A9024A-20250101-001.edf");
  });
  it("omits the demographic segment when sex/age are absent", () => {
    expect(generateFilename("PHY-S001", "BL", "2026-01-01")).toBe("PHY-BL-A9024A-20260101-001.edf");
  });
});

describe("Safe Harbor field generalization", () => {
  it("collapses dates to Jan 1 of the year", () => {
    expect(generalizeDateToYear("2026-03-15")).toBe("2026-01-01");
    expect(generalizeDateToYear("2026")).toBe("2026-01-01");
    expect(generalizeDateToYear("")).toBe("");
  });
  it("aggregates ages over 89 into 90+", () => {
    expect(capAge(95)).toBe(90);
    expect(capAge(90)).toBe(90);
    expect(capAge(89)).toBe(89);
    expect(capAge(0)).toBe(0);
    expect(capAge(null)).toBe(null);
    expect(capAge("")).toBe("");
  });
});

describe("parseEdfPatientField (keeps only sex + age, discards everything else)", () => {
  it("extracts sex and derives age from birthdate, dropping name/code/DOB", () => {
    const fixedNow = new Date(2026, 0, 1);
    const r = parseEdfPatientField("MCH-0234567 F 02-MAY-1951 Haagse_Harry", fixedNow);
    expect(r.sex).toBe("F");
    expect(r.age).toBe(74); // 1951 → 2026
  });
  it("returns nulls for empty/unknown fields", () => {
    expect(parseEdfPatientField("")).toEqual({ sex: null, age: null });
    expect(parseEdfPatientField("X")).toEqual({ sex: null, age: null });
  });
});

describe("parseHashYearFromFilename", () => {
  it("recovers hash + year from a REACT filename", () => {
    expect(parseHashYearFromFilename("PHY-X-BL-A9024A-20260101-001.edf")).toEqual({ hash: "A9024A", year: "2026" });
  });
  it("returns nulls for a non-conforming name", () => {
    expect(parseHashYearFromFilename("random.edf")).toEqual({ hash: "", year: null });
  });
});

describe("scrubEdfHeader (the legal core — no PHI survives into stored/exported bytes)", () => {
  const PHI_PATIENT = "MCH-0234567 F 02-MAY-1951 Haagse_Harry";
  const PHI_RECORDING = "Startdate 02-MAR-2002 EMG561 BK/JOP Sony";
  const original = () => makeEdf({ patient: PHI_PATIENT, recording: PHI_RECORDING, date: "02.03.02", time: "13.45.10" });

  it("removes patient name, MRN, and birthdate; keeps only the hash code", () => {
    const out = scrubEdfHeader(original(), { hash: "A9024A", year: "2026" });
    const patient = ascii(out, 8, 80);
    expect(patient.trim()).toBe("A9024A X X X");
    expect(patient).not.toContain("Haagse");
    expect(patient).not.toContain("MCH-0234567");
    expect(patient).not.toContain("1951");
  });

  it("removes recording date, technician, and hospital code", () => {
    const out = scrubEdfHeader(original(), { hash: "A9024A", year: "2026" });
    const recording = ascii(out, 88, 80);
    expect(recording.trim()).toBe("Startdate X X X X");
    expect(recording).not.toContain("EMG561");
    expect(recording).not.toContain("BK/JOP");
    expect(recording).not.toContain("Sony");
    expect(recording).not.toContain("2002");
  });

  it("generalizes start date to year-only and zeroes the start time", () => {
    const out = scrubEdfHeader(original(), { hash: "A9024A", year: "2026" });
    expect(ascii(out, 168, 8)).toBe("01.01.26");
    expect(ascii(out, 176, 8)).toBe("00.00.00");
  });

  it("leaves the signal-header region (offset 256+) byte-for-byte intact", () => {
    const out = scrubEdfHeader(original(), { hash: "A9024A", year: "2026" });
    const b = new Uint8Array(out);
    for (let i = 256; i < 512; i++) expect(b[i]).toBe((i * 7) & 0xff);
  });

  it("does not mutate the input buffer (returns a copy)", () => {
    const input = original();
    scrubEdfHeader(input, { hash: "A9024A", year: "2026" });
    expect(ascii(input, 8, 80)).toContain("Haagse"); // original still has PHI
  });

  it("returns sub-256-byte buffers unchanged (not an EDF)", () => {
    const tiny = new ArrayBuffer(10);
    expect(scrubEdfHeader(tiny, { hash: "X", year: "2026" })).toBe(tiny);
  });
});

describe("scrubEdfHeaderForFilename (the saveEdfToDB chokepoint form)", () => {
  it("derives hash + year from the de-identified filename and scrubs accordingly", () => {
    const fname = "PHY-X-BL-A9024A-20260101-001.edf";
    const out = scrubEdfHeaderForFilename(makeEdf({
      patient: "Jane Doe 12-DEC-1980", recording: "Startdate 01-JAN-2020 TechName Hosp", date: "01.06.20", time: "09.30.00",
    }), fname);
    expect(ascii(out, 8, 80).trim()).toBe("A9024A X X X");
    expect(ascii(out, 168, 8)).toBe("01.01.26");
    expect(ascii(out, 88, 80)).not.toContain("Hosp");
  });
});

describe("scanTextForPHI (free-text export warning)", () => {
  it("flags SSN, MRN, email, phone, dates and long digit runs", () => {
    expect(scanTextForPHI("SSN 123-45-6789")).toContain("SSN");
    expect(scanTextForPHI("see MRN: 4456788")).toContain("MRN");
    expect(scanTextForPHI("contact jane@hospital.org")).toContain("email");
    expect(scanTextForPHI("call 415-555-0199")).toContain("phone");
    expect(scanTextForPHI("seen 03/14/2026")).toContain("date");
    expect(scanTextForPHI("DOB 12-MAR-1951")).toContain("date");
    expect(scanTextForPHI("acct 123456789")).toContain("long-digit-run");
  });
  it("returns empty for clean clinical text and non-strings", () => {
    expect(scanTextForPHI("Mild diffuse slowing in the theta band; alpha reactive.")).toEqual([]);
    expect(scanTextForPHI("")).toEqual([]);
    expect(scanTextForPHI(null)).toEqual([]);
    expect(scanTextForPHI(undefined)).toEqual([]);
  });
  it("dedupes and can report multiple categories at once", () => {
    const hits = scanTextForPHI("MRN 778899 emailed to bob@x.com on 01/02/2030");
    expect(hits).toContain("MRN");
    expect(hits).toContain("email");
    expect(hits).toContain("date");
  });
});

// N1: the whole-library backup embeds clinical notes + record notes + annotations verbatim,
// so its export must sweep exactly those three sources — the union of clinical-notes files,
// annotation files and record files — the same way the .zip / .reegb gates do per record.
describe("scanLibraryForPHI (N1 — whole-library backup gate)", () => {
  it("flags PHI in a clinical note by filename", () => {
    const out = scanLibraryForPHI([], { "a.edf": "SSN 123-45-6789" }, {});
    expect(out).toContain("• notes (a.edf): SSN");
  });
  it("scans record.notes and the union catches record-only files (no clinicalNotesMap entry)", () => {
    // b.edf has no clinicalNotesMap key — only a record with .notes. The union must still reach it.
    const out = scanLibraryForPHI([{ filename: "b.edf", notes: "contact jane@hospital.org" }], {}, {});
    expect(out).toContain("• record notes (b.edf): email");
  });
  it("scans both annotation .label and .text, with per-file 1-based indexing", () => {
    const anns = { "c.edf": [
      { label: "call 415-555-0199" },          // #1 — phone via label
      { text: "see MRN: 4456" },               // #2 — MRN via text (short digits → MRN only)
    ] };
    const out = scanLibraryForPHI([], {}, anns);
    expect(out).toContain("• annotation #1 (c.edf): phone");
    expect(out).toContain("• annotation #2 (c.edf): MRN");
  });
  it("flags a file present ONLY in annotationsMap (proves the union drives the sweep)", () => {
    const out = scanLibraryForPHI([], {}, { "d.edf": [{ label: "acct 123456789" }] });
    expect(out).toContain("• annotation #1 (d.edf): long-digit-run");
  });
  it("returns [] for a clean library and never leaks the raw matched value", () => {
    expect(scanLibraryForPHI(
      [{ filename: "x.edf", notes: "alpha reactive, no epileptiform activity" }],
      { "x.edf": "mild diffuse theta slowing" },
      { "x.edf": [{ label: "eyes open" }] },
    )).toEqual([]);
    // A finding must name the category, not echo the identifier back into the warning.
    const out = scanLibraryForPHI([], { "y.edf": "SSN 123-45-6789" }, {});
    expect(out.join("\n")).not.toContain("123-45-6789");
  });
  it("is null-tolerant (malformed maps / records do not throw)", () => {
    expect(scanLibraryForPHI(null, null, null)).toEqual([]);
    expect(scanLibraryForPHI(undefined, { "z.edf": 42 }, { "z.edf": "not-an-array" })).toEqual([]);
    expect(scanLibraryForPHI([{ notes: "MRN 778899" }], {}, {})).toEqual([]); // record w/o filename skipped
  });
});

describe("hash salt (G7 — per-deployment, default stable)", () => {
  it("the salt changes the hash (same id, different salt → different hash)", () => {
    expect(hashSubjectId("PHY-S001", "SITE-A")).not.toBe(hashSubjectId("PHY-S001", "SITE-B"));
  });
  it("setHashSalt overrides the default and is restorable", () => {
    expect(hashSubjectId("PHY-S001")).toBe("A9024A");   // default salt
    setHashSalt("OTHER-DEPLOYMENT");
    expect(hashSubjectId("PHY-S001")).not.toBe("A9024A");
    setHashSalt("REACT-EEG-2026");                        // restore default for other tests
    expect(hashSubjectId("PHY-S001")).toBe("A9024A");
  });
  it("setHashSalt ignores empty / non-string values", () => {
    setHashSalt("");
    setHashSalt(null);
    setHashSalt(123);
    expect(hashSubjectId("PHY-S001")).toBe("A9024A");     // unchanged
  });
});
