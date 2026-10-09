// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// ══════════════════════════════════════════════════════════════
// REACT EEG — public dataset catalog (neoxai) — pure logic
// ══════════════════════════════════════════════════════════════
// The Dataset Browser lists the open EEG/BCI datasets curated by neowalter in the neoxai catalog
// (https://github.com/neowalter/neoxai, CC-BY-4.0). The catalog is CONSUMED, not forked: it is
// fetched live from upstream, with a dated snapshot bundled as the offline fallback.
//
// Everything here is pure (no React / DOM / network) so the parser and the access rules are
// unit-tested (test/dataset-catalog.test.js). Rules this module enforces:
//   • Nothing is proxied, mirrored, cached or redistributed. A file is fetched only when the user
//     clicks "Load into Review", straight from its official host, and only from hosts that allow
//     browser downloads (CORS). Everything else links to the official access page.
//   • Datasets behind registration / a DUA / an application never get a download or open action.

export const CATALOG_URL = "https://raw.githubusercontent.com/neowalter/neoxai/main/datasets/README.md";
export const CATALOG_REPO_URL = "https://github.com/neowalter/neoxai";
export const CATALOG_ATTRIBUTION = "Catalog: neoxai by neowalter — CC-BY-4.0";

// Files above this size get a confirmation first: the whole file is decoded into memory, and very
// long recordings are a known out-of-memory risk in Review.
export const LARGE_FILE_BYTES = 200 * 1024 * 1024;

export const TIER = { OPEN: "open", TERMS: "check-terms", RESTRICTED: "restricted" };
export const ACTION = { LOAD: "load", DOWNLOAD_THEN_OPEN: "download-then-open", LINK: "link" };

// Hosts whose files a browser can fetch directly (they send Access-Control-Allow-Origin).
// Verified from https://ionofield.github.io on 2026-10-08: Zenodo's API and file downloads are
// allowed; PhysioNet blocks cross-origin fetches of both its files and its RECORDS lists.
const DIRECT_DOWNLOAD_HOSTS = new Set(["zenodo.org"]);

// What the catalog does NOT say: file format, and how to list a dataset's files. These hints are
// REACT EEG's own annotations layered on top of the catalog, matched against a row's official
// URL (or its name). Only formats we are confident of are listed; anything else is "Unknown".
const DATASET_HINTS = [
  { match: /physionet\.org\/content\/eegmmidb\//i, format: "EDF", subjectPrefix: "MMI" },
  { match: /physionet\.org\/content\/chbmit\//i, format: "EDF", subjectPrefix: "CHB" },
  { match: /physionet\.org\/content\/sleep-edfx\//i, format: "EDF", subjectPrefix: "SLP" },
  { match: /isip\.piconepress\.com.*tuh/i, format: "EDF" },
  {
    // The catalog's link (zenodo 1250690, marked "confirm current DOI") resolves to an unrelated
    // record. The Helsinki neonatal EEG dataset (Stevenson et al.) is Zenodo record 2547147,
    // CC-BY-4.0, 79 EDF files — verified 2026-10-08.
    matchName: /helsinki neonatal/i,
    format: "EDF", subjectPrefix: "HEL",
    zenodoRecord: "2547147",
    correctedUrl: "https://zenodo.org/records/2547147",
    note: "The catalog link points to an unrelated Zenodo record; corrected to record 2547147 (A dataset of neonatal EEG recordings with seizures annotations).",
  },
  { match: /mne\.tools/i, format: "FIF" },
  { match: /erpinfo\.org\/erp-core/i, format: "EEGLAB (.set)" },
  { match: /openneuro\.org/i, format: "BIDS (varies)" },
  { match: /kaggle\.com\/c\/grasp-and-lift/i, format: "CSV" },
  { match: /github\.com\/NeuroTechX\/moabb/i, format: "Python library" },
];

// ── Markdown helpers ─────────────────────────────────────────────

/** All `[text](url)` links in a markdown cell. */
export function parseMarkdownLinks(cell) {
  const out = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(cell || ""))) out.push({ text: m[1].trim(), url: m[2].trim() });
  return out;
}

/** Plain text of a markdown cell: links become their text, emphasis and code marks are dropped. */
export function stripMarkdown(cell) {
  return (cell || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Split one markdown table line into trimmed cells, honouring escaped pipes (\|).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

// Required columns, located by header keyword rather than position so a reordered catalog still
// parses. If any is missing the catalog format has changed and we report it instead of guessing.
const COLUMNS = {
  name: (h) => /^dataset$|^name$/.test(h),
  description: (h) => /what it is|description/.test(h),
  access: (h) => /official access|^access$|^link/.test(h),
  license: (h) => /licen[cs]e/.test(h),
  citation: (h) => /cite|citation/.test(h),
};

/**
 * Parse the neoxai datasets table. Never throws.
 * @returns {{ rows: object[], skipped: number, error?: string }}
 */
export function parseDatasetTable(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return { rows: [], skipped: 0, error: "The catalog is empty." };
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !isSeparator(lines[i + 1])) continue;
    const headers = splitRow(lines[i]).map((h) => stripMarkdown(h).toLowerCase());
    const idx = {};
    for (const [key, test] of Object.entries(COLUMNS)) idx[key] = headers.findIndex(test);
    if (idx.name < 0) continue; // some other table — keep looking
    const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => k);
    if (missing.length) {
      return { rows: [], skipped: 0, error: `The catalog's table format has changed (missing column: ${missing.join(", ")}).` };
    }
    const rows = [];
    let skipped = 0;
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const cells = splitRow(lines[j]);
      const name = stripMarkdown(cells[idx.name]);
      if (cells.length < headers.length || !name) { skipped++; continue; }
      const links = parseMarkdownLinks(cells[idx.access]);
      rows.push({
        name,
        description: stripMarkdown(cells[idx.description]),
        accessText: stripMarkdown(cells[idx.access]),
        accessLinks: links,
        officialUrl: links[0]?.url || "",
        licenseText: stripMarkdown(cells[idx.license]),
        citation: stripMarkdown(cells[idx.citation]),
      });
    }
    if (!rows.length) return { rows: [], skipped, error: "The catalog table has no readable rows." };
    return { rows, skipped };
  }
  return { rows: [], skipped: 0, error: "No dataset table was found in the catalog." };
}

// ── Access rules ─────────────────────────────────────────────────

/** Access tier from the catalog's "License / access" text. Restricted wins over open. */
export function classifyAccess(licenseText) {
  const t = (licenseText || "").toLowerCase();
  if (/\b(application|apply|registration|register|dua|data use agreement|credential|login|sign[- ]?up)\b/.test(t)) return TIER.RESTRICTED;
  if (/open access|\bcc0\b|\bcc[- ]by\b|\bcc\b|creative commons|public domain|odc-by/.test(t)) return TIER.OPEN;
  return TIER.TERMS;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function findHint(row) {
  return DATASET_HINTS.find((h) => (h.match && h.match.test(row.officialUrl)) || (h.matchName && h.matchName.test(row.name))) || null;
}

/**
 * Decide what the browser offers for one catalog row.
 *   LOAD               — open + EDF + host allows browser downloads → list files, load on click
 *   DOWNLOAD_THEN_OPEN — open + EDF, but the host blocks browser downloads → official link, then
 *                        the user opens the file they downloaded
 *   LINK               — everything else (non-EDF, unclear terms, or restricted) → official page only
 */
export function planRow(row) {
  const hint = findHint(row);
  const tier = classifyAccess(row.licenseText);
  const format = hint?.format || "Unknown";
  const officialUrl = hint?.correctedUrl || row.officialUrl;
  const host = hostOf(officialUrl);
  let action = ACTION.LINK;
  if (tier === TIER.OPEN && format === "EDF") {
    action = DIRECT_DOWNLOAD_HOSTS.has(host) && hint?.zenodoRecord ? ACTION.LOAD : ACTION.DOWNLOAD_THEN_OPEN;
  }
  return {
    ...row,
    officialUrl,
    tier,
    format,
    action,
    host,
    zenodoRecord: action === ACTION.LOAD ? hint.zenodoRecord : null,
    subjectPrefix: hint?.subjectPrefix || null,
    correctionNote: hint?.note || null,
  };
}

/** Rows filtered by free-text search, access tier and format ("EDF" | "other" | "all"). */
export function filterRows(rows, { query = "", tier = "all", format = "all" } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tier !== "all" && r.tier !== tier) return false;
    if (format === "EDF" && r.format !== "EDF") return false;
    if (format === "other" && r.format === "EDF") return false;
    if (!q) return true;
    return [r.name, r.description, r.citation, r.licenseText, r.format].some((v) => (v || "").toLowerCase().includes(q));
  });
}

// ── Zenodo file listing ──────────────────────────────────────────

export const zenodoRecordApiUrl = (record) => `https://zenodo.org/api/records/${encodeURIComponent(record)}`;

/** EDF files from a Zenodo record API response, smallest first. Tolerant of missing fields. */
export function parseZenodoFiles(json) {
  const files = Array.isArray(json?.files) ? json.files : [];
  return files
    .map((f) => ({ name: String(f?.key || ""), size: Number(f?.size) || 0, url: f?.links?.self || f?.links?.content || "" }))
    .filter((f) => /\.edf$/i.test(f.name) && /^https:\/\/zenodo\.org\//.test(f.url))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ── Import handoff helpers ───────────────────────────────────────

/**
 * Suggested Subject ID for a dataset file, in the app's required SOURCE-NNN form
 * (^[A-Z]{2,4}-\d{3,5}$). Uses the first number in the filename: eeg57.edf → HEL-057,
 * chb01_03.edf → CHB-001, S001R01.edf → MMI-001. The user can change it before importing.
 */
export function suggestSubjectId(prefix, filename) {
  if (!prefix || !/^[A-Z]{2,4}$/.test(prefix)) return "";
  const m = String(filename || "").match(/\d+/);
  if (!m) return "";
  const n = String(parseInt(m[0], 10));
  if (n.length > 5) return "";
  return `${prefix}-${n.padStart(3, "0")}`;
}

/** The provenance attached to an imported dataset file (stored on the library record). */
export function sourceAttribution(plannedRow, fileName) {
  return {
    dataset: plannedRow.name,
    url: plannedRow.officialUrl,
    license: plannedRow.licenseText,
    citation: plannedRow.citation,
    originalPath: fileName || null,
    catalog: CATALOG_ATTRIBUTION,
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
