// Dataset Browser — catalog parser + access rules. The primary fixture is the REAL neoxai catalog
// snapshot bundled with the app; the small hand-written tables only exercise format drift
// (reordered / missing columns, malformed rows) so a changed upstream catalog degrades to an error
// state instead of crashing.
import { describe, it, expect } from "vitest";
import snapshot from "../src/data/neoxai-datasets.snapshot.json";
import {
  parseDatasetTable, parseMarkdownLinks, stripMarkdown, classifyAccess, planRow, filterRows,
  parseZenodoFiles, suggestSubjectId, sourceAttribution, formatBytes,
  TIER, ACTION, LARGE_FILE_BYTES, CATALOG_ATTRIBUTION,
} from "../src/dataset-catalog.js";

const parsed = parseDatasetTable(snapshot.markdown);
const planned = parsed.rows.map(planRow);
const byName = (re) => planned.find((r) => re.test(r.name));

describe("bundled neoxai snapshot", () => {
  it("is dated, attributed and pinned to an upstream commit", () => {
    expect(snapshot.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.license).toBe("CC-BY-4.0");
    expect(snapshot.curator).toBe("neowalter");
    expect(snapshot.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("parses every dataset row with no errors or skipped rows", () => {
    expect(parsed.error).toBeUndefined();
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows).toHaveLength(17);
    const eegmmi = parsed.rows[0];
    expect(eegmmi.name).toBe("EEG Motor Movement/Imagery (EEGMMI)");
    expect(eegmmi.officialUrl).toBe("https://physionet.org/content/eegmmidb/1.0.0/");
    expect(eegmmi.licenseText).toBe("PhysioNet open access");
    expect(eegmmi.citation).toContain("Schalk et al.");
  });

  it("strips markdown emphasis from license text", () => {
    expect(byName(/^TUH/).licenseText).toBe("Registration + research DUA; not a public dump");
  });
});

describe("parseDatasetTable — format drift never throws", () => {
  const header = "| Dataset | What it is | Official access | License / access | Cite (start here) |\n| --- | --- | --- | --- | --- |";

  it("finds columns by name, not position", () => {
    const md = "| Cite | License / access | Official access | Dataset | What it is |\n|---|---|---|---|---|\n| Doe 2020 | CC-BY | [Home](https://example.org/a) | Alpha | A thing |";
    const r = parseDatasetTable(md);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ name: "Alpha", description: "A thing", officialUrl: "https://example.org/a", licenseText: "CC-BY", citation: "Doe 2020" });
  });

  it("reports a missing column instead of guessing", () => {
    const md = "| Dataset | What it is | Official access | Cite |\n| --- | --- | --- | --- |\n| Alpha | x | [h](https://e.org) | y |";
    const r = parseDatasetTable(md);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/missing column: license/);
  });

  it("skips malformed rows and keeps the good ones", () => {
    const md = `${header}\n| Alpha | a | [h](https://e.org/a) | CC-BY | c |\n| only two | cells |\n|  | b | [h](https://e.org/b) | CC-BY | c |`;
    const r = parseDatasetTable(md);
    expect(r.rows.map((x) => x.name)).toEqual(["Alpha"]);
    expect(r.skipped).toBe(2);
  });

  it("returns an error state for empty, non-string or table-less input", () => {
    for (const bad of ["", "   ", null, undefined, 42, "# Datasets\n\nNo table here."]) {
      const r = parseDatasetTable(bad);
      expect(r.rows).toEqual([]);
      expect(typeof r.error).toBe("string");
    }
  });

  it("honours escaped pipes inside a cell", () => {
    const r = parseDatasetTable(`${header}\n| A \\| B | d | [h](https://e.org) | CC0 | c |`);
    expect(r.rows[0].name).toBe("A | B");
  });
});

describe("markdown helpers", () => {
  it("extracts links and plain text", () => {
    expect(parseMarkdownLinks("[One](https://a.org/1) and [Two](https://b.org/2)")).toEqual([
      { text: "One", url: "https://a.org/1" }, { text: "Two", url: "https://b.org/2" },
    ]);
    expect(stripMarkdown("**Application required** — see [site](https://x.org)")).toBe("Application required — see site");
  });
});

describe("classifyAccess", () => {
  it("marks registration / DUA / application datasets restricted (restricted wins)", () => {
    expect(classifyAccess("Registration + research DUA; not a public dump")).toBe(TIER.RESTRICTED);
    expect(classifyAccess("Application required")).toBe(TIER.RESTRICTED);
    expect(classifyAccess("Kaggle + original DUA")).toBe(TIER.RESTRICTED);
    expect(classifyAccess("CC-BY after signed DUA")).toBe(TIER.RESTRICTED);
  });
  it("marks open-access and Creative Commons datasets open", () => {
    expect(classifyAccess("PhysioNet open access")).toBe(TIER.OPEN);
    expect(classifyAccess("CC-BY (confirm on page)")).toBe(TIER.OPEN);
    expect(classifyAccess("CC as on Zenodo")).toBe(TIER.OPEN);
    expect(classifyAccess("Per-dataset (often CC0 / CC-BY)")).toBe(TIER.OPEN);
  });
  it("leaves everything else as check-the-terms", () => {
    expect(classifyAccess("Competition terms (research)")).toBe(TIER.TERMS);
    expect(classifyAccess("See repo")).toBe(TIER.TERMS);
    expect(classifyAccess("")).toBe(TIER.TERMS);
  });
});

describe("planRow — what each dataset offers", () => {
  it("PhysioNet EDF sets: download from the host, then open the file (PhysioNet blocks browser downloads)", () => {
    for (const re of [/^EEG Motor/, /^CHB-MIT/, /^Sleep-EDF/]) {
      const r = byName(re);
      expect(r).toMatchObject({ tier: TIER.OPEN, format: "EDF", action: ACTION.DOWNLOAD_THEN_OPEN, host: "physionet.org", zenodoRecord: null });
    }
  });

  it("Helsinki neonatal: corrected to Zenodo 2547147 and loadable on demand", () => {
    const r = byName(/Helsinki neonatal/);
    expect(r.action).toBe(ACTION.LOAD);
    expect(r.zenodoRecord).toBe("2547147");
    expect(r.officialUrl).toBe("https://zenodo.org/records/2547147");
    expect(r.correctionNote).toMatch(/2547147/);
    expect(r.subjectPrefix).toBe("HEL");
  });

  it("registration / DUA datasets never get a download or open action", () => {
    for (const re of [/^TUH/, /^DEAP/, /^SEED/, /^Grasp-and-Lift/]) {
      const r = byName(re);
      expect(r.tier).toBe(TIER.RESTRICTED);
      expect(r.action).toBe(ACTION.LINK);
    }
    expect(planned.filter((r) => r.tier === TIER.RESTRICTED).every((r) => r.action === ACTION.LINK)).toBe(true);
  });

  it("open but non-EDF datasets link to the source page only", () => {
    expect(byName(/^OpenNeuro/)).toMatchObject({ tier: TIER.OPEN, format: "BIDS (varies)", action: ACTION.LINK });
    expect(byName(/^MNE-Python/)).toMatchObject({ format: "FIF", action: ACTION.LINK });
    expect(byName(/^MOABB/).action).toBe(ACTION.LINK);
  });

  it("only Zenodo-hosted rows are directly loadable", () => {
    expect(planned.filter((r) => r.action === ACTION.LOAD).every((r) => r.host === "zenodo.org")).toBe(true);
  });
});

describe("filterRows", () => {
  it("filters by search text, tier and format", () => {
    expect(filterRows(planned, { query: "seizure" }).map((r) => r.name)).toContain("CHB-MIT Scalp EEG");
    expect(filterRows(planned, { tier: TIER.RESTRICTED }).every((r) => r.tier === TIER.RESTRICTED)).toBe(true);
    const edf = filterRows(planned, { format: "EDF" });
    expect(edf.length).toBeGreaterThanOrEqual(5);
    expect(edf.every((r) => r.format === "EDF")).toBe(true);
    expect(filterRows(planned, { format: "other" }).some((r) => r.format === "EDF")).toBe(false);
    expect(filterRows(planned, {})).toHaveLength(planned.length);
  });
});

describe("parseZenodoFiles", () => {
  it("keeps only https Zenodo EDF files, smallest first", () => {
    const files = parseZenodoFiles({ files: [
      { key: "eeg13.edf", size: 300, links: { self: "https://zenodo.org/api/records/2547147/files/eeg13.edf/content" } },
      { key: "clinical_information.csv", size: 5, links: { self: "https://zenodo.org/api/records/2547147/files/clinical_information.csv/content" } },
      { key: "eeg57.edf", size: 100, links: { self: "https://zenodo.org/api/records/2547147/files/eeg57.edf/content" } },
      { key: "evil.edf", size: 1, links: { self: "http://elsewhere.example/evil.edf" } },
    ] });
    expect(files.map((f) => f.name)).toEqual(["eeg57.edf", "eeg13.edf"]);
  });
  it("tolerates malformed responses", () => {
    expect(parseZenodoFiles(null)).toEqual([]);
    expect(parseZenodoFiles({ files: "nope" })).toEqual([]);
  });
});

describe("import handoff helpers", () => {
  it("suggests a Subject ID in the app's SOURCE-NNN format", () => {
    expect(suggestSubjectId("HEL", "eeg57.edf")).toBe("HEL-057");
    expect(suggestSubjectId("CHB", "chb01_03.edf")).toBe("CHB-001");
    expect(suggestSubjectId("MMI", "S001R01.edf")).toBe("MMI-001");
    for (const id of [suggestSubjectId("HEL", "eeg57.edf"), suggestSubjectId("SLP", "SC4001E0-PSG.edf")]) {
      expect(id).toMatch(/^[A-Z]{2,4}-\d{3,5}$/);
    }
    expect(suggestSubjectId("HEL", "notes.edf")).toBe("");
    expect(suggestSubjectId(null, "eeg57.edf")).toBe("");
  });

  it("builds provenance carrying the dataset's license and citation", () => {
    const a = sourceAttribution(byName(/Helsinki neonatal/), "eeg57.edf");
    expect(a).toMatchObject({ url: "https://zenodo.org/records/2547147", originalPath: "eeg57.edf", catalog: CATALOG_ATTRIBUTION });
    expect(a.citation).toContain("Stevenson");
  });

  it("guards large files at 200 MB and formats sizes", () => {
    expect(LARGE_FILE_BYTES).toBe(200 * 1024 * 1024);
    expect(formatBytes(32.1 * 1024 * 1024)).toBe("32.1 MB");
    expect(formatBytes(0)).toBe("—");
  });
});
