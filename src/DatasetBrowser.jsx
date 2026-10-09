// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// ══════════════════════════════════════════════════════════════
// REACT EEG — Dataset Browser
// ══════════════════════════════════════════════════════════════
// Search the neoxai catalog of open EEG/BCI datasets (CC-BY-4.0, curated by neowalter) and bring
// open-access EDF recordings into the app. Isolated by design: its ONLY integration point is
// `onImport(file, source)`, which hands a File to the app's existing import form — that form does
// the parsing, de-identification and saving, unchanged. All catalog rules live in
// dataset-catalog.js (pure, unit-tested).
//
// Privacy: nothing is uploaded anywhere. Files are fetched only on click, straight from the
// dataset's official host, held in memory just long enough to hand to the import form, and never
// cached or mirrored. Registration / DUA datasets get their official link and nothing else.
import { useEffect, useMemo, useRef, useState } from "react";
import snapshot from "./data/neoxai-datasets.snapshot.json";
import {
  CATALOG_URL, CATALOG_REPO_URL, CATALOG_ATTRIBUTION, LARGE_FILE_BYTES, TIER, ACTION,
  parseDatasetTable, planRow, filterRows, zenodoRecordApiUrl, parseZenodoFiles,
  suggestSubjectId, sourceAttribution, formatBytes,
} from "./dataset-catalog.js";

const MONO = "'IBM Plex Mono', monospace";
const HEAD = "'Rajdhani', sans-serif";
const ACCENT = "#7ec8d9";
const CATALOG_TIMEOUT_MS = 8000;

const TIER_BADGE = {
  [TIER.OPEN]: { label: "OPEN ACCESS", color: "#4ade80", bg: "#4ade8014" },
  [TIER.TERMS]: { label: "CHECK TERMS", color: "#fbbf24", bg: "#fbbf2414" },
  [TIER.RESTRICTED]: { label: "REGISTRATION / DUA REQUIRED", color: "#f87171", bg: "#f8717114" },
};

// Open an external page in the user's browser. Inside the desktop app the webview can't navigate
// away, so a small native command opens the default browser (https links only).
function openExternal(url) {
  if (!/^https:\/\//i.test(url || "")) return;
  const invoke = typeof window !== "undefined" && window.__TAURI__?.invoke;
  if (invoke) { invoke("open_external_url", { url }).catch(() => {}); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

function ExtLink({ url, children, strong }) {
  if (!url) return null;
  return (
    <a href={url} onClick={(e) => { e.preventDefault(); openExternal(url); }}
      style={{ color: strong ? ACCENT : "#8fb8c2", fontSize: 11, fontWeight: strong ? 700 : 500, textDecoration: "none", whiteSpace: "nowrap" }}>
      {children} ↗
    </a>
  );
}

const btn = (primary) => ({
  padding: "6px 12px", background: primary ? "#1a4a54" : "#161616", border: `1px solid ${primary ? "#4a9bab80" : "#2a2a2a"}`,
  borderRadius: 0, color: primary ? ACCENT : "#bbb", cursor: "pointer", fontSize: 11, fontWeight: 700,
  letterSpacing: "0.04em", fontFamily: MONO, whiteSpace: "nowrap",
});

export default function DatasetBrowser({ onClose, onImport }) {
  const [catalog, setCatalog] = useState({ status: "loading", rows: [], note: "" });
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState("all");
  const [format, setFormat] = useState("all");

  // Live catalog first; the bundled snapshot if offline or if upstream's table format changed.
  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CATALOG_TIMEOUT_MS);
    const useSnapshot = (why) => {
      const snap = parseDatasetTable(snapshot.markdown);
      if (snap.error) setCatalog({ status: "error", rows: [], note: `${why} The offline snapshot could not be read either: ${snap.error}` });
      else setCatalog({ status: "snapshot", rows: snap.rows.map(planRow), note: `${why} Showing the offline snapshot from ${snapshot.snapshotDate}.` });
    };
    fetch(CATALOG_URL, { signal: ac.signal, cache: "no-cache" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((md) => {
        const live = parseDatasetTable(md);
        if (live.error) useSnapshot(`The live catalog couldn't be read (${live.error})`);
        else setCatalog({ status: "live", rows: live.rows.map(planRow), note: live.skipped ? `${live.skipped} malformed row(s) skipped.` : "" });
      })
      .catch(() => useSnapshot("The live catalog is unreachable (offline?)."))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ac.abort(); };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = useMemo(() => filterRows(catalog.rows, { query, tier, format }), [catalog.rows, query, tier, format]);
  const handoff = (row, file) => onImport(file, {
    attribution: sourceAttribution(row, file.name),
    suggestedSubjectId: suggestSubjectId(row.subjectPrefix, file.name),
  });

  const select = { padding: "7px 8px", background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 0, color: "#ddd", fontSize: 12, fontFamily: MONO };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Dataset Browser" onClick={(e) => e.stopPropagation()}
        style={{ background: "#111", border: "1px solid #2a2a2a", width: 980, maxWidth: "calc(100vw - 48px)", height: "86vh", display: "flex", flexDirection: "column" }}>

        {/* Header */}
        <div style={{ padding: "18px 24px 12px", borderBottom: "1px solid #1f1f1f" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <div>
              <div style={{ fontFamily: HEAD, fontSize: 22, fontWeight: 700, color: "#e8e8e8", letterSpacing: "0.04em" }}>DATASET BROWSER</div>
              <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>Open EEG/BCI datasets from the neoxai catalog. Load open-access EDF recordings straight into your library for review.</div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ ...btn(false), padding: "4px 10px" }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search datasets, descriptions, citations…" aria-label="Search datasets"
              style={{ ...select, flex: "1 1 260px", padding: "8px 10px" }} />
            <select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Access tier" style={select}>
              <option value="all">All access tiers</option>
              <option value={TIER.OPEN}>Open access</option>
              <option value={TIER.TERMS}>Check terms</option>
              <option value={TIER.RESTRICTED}>Registration / DUA</option>
            </select>
            <select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format" style={select}>
              <option value="all">All formats</option>
              <option value="EDF">EDF only</option>
              <option value="other">Other formats</option>
            </select>
          </div>
          {catalog.note && <div style={{ marginTop: 10, fontSize: 11, color: catalog.status === "error" ? "#f87171" : "#c9a54a" }}>{catalog.note}</div>}
        </div>

        {/* Rows */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 24px 16px" }}>
          {catalog.status === "loading" && <div style={{ color: "#777", fontSize: 12, padding: 24 }}>Loading the neoxai catalog…</div>}
          {catalog.status === "error" && <div style={{ color: "#f87171", fontSize: 12, padding: 24 }}>The dataset catalog is unavailable right now.</div>}
          {(catalog.status === "live" || catalog.status === "snapshot") && visible.length === 0 && (
            <div style={{ color: "#777", fontSize: 12, padding: 24 }}>No datasets match these filters.</div>
          )}
          {visible.map((row) => <DatasetRow key={row.name} row={row} onHandoff={handoff} />)}
        </div>

        {/* Attribution footer — always visible */}
        <div style={{ borderTop: "1px solid #1f1f1f", padding: "10px 24px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", fontSize: 11, color: "#777" }}>
          <span>
            <a href={CATALOG_REPO_URL} onClick={(e) => { e.preventDefault(); openExternal(CATALOG_REPO_URL); }} style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}>{CATALOG_ATTRIBUTION}</a>
            {" · "}{catalog.status === "live" ? "live catalog" : catalog.status === "snapshot" ? `offline snapshot ${snapshot.snapshotDate}` : ""}
          </span>
          <span>Files come straight from each dataset's official host, only when you load them. Nothing is cached, mirrored or uploaded.</span>
        </div>
      </div>
    </div>
  );
}

function DatasetRow({ row, onHandoff }) {
  const badge = TIER_BADGE[row.tier];
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState({ status: "idle", list: [], error: "" });
  const [job, setJob] = useState(null);          // { name, received, total, controller }
  const [pendingLarge, setPendingLarge] = useState(null); // a file awaiting the size confirmation
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);
  const controllerRef = useRef(null);
  // Cancel an in-flight download only when the browser is closed (not on each progress update).
  useEffect(() => () => controllerRef.current?.abort(), []);

  const toggleFiles = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || files.status !== "idle") return;
    setFiles({ status: "loading", list: [], error: "" });
    fetch(zenodoRecordApiUrl(row.zenodoRecord))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => setFiles({ status: "ready", list: parseZenodoFiles(json), error: "" }))
      .catch((e) => setFiles({ status: "error", list: [], error: `Couldn't list files (${e.message}).` }));
  };

  // Download one file on demand, with progress, then hand it to the import form.
  const download = async (f) => {
    setError(""); setPendingLarge(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    setJob({ name: f.name, received: 0, total: f.size, controller });
    try {
      const res = await fetch(f.url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || f.size;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        setJob((j) => j && { ...j, received, total });
      }
      setJob(null);
      onHandoff(row, new File(chunks, f.name, { type: "application/octet-stream" }));
    } catch (e) {
      setJob(null);
      if (e.name !== "AbortError") setError(`Download failed (${e.message}). You can also get the file from the official page.`);
    }
  };

  const requestLoad = (f) => (f.size > LARGE_FILE_BYTES ? setPendingLarge({ kind: "remote", file: f }) : download(f));

  const onLocalFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/\.edf$/i.test(f.name)) { setError("Please choose an .edf file."); return; }
    setError("");
    if (f.size > LARGE_FILE_BYTES) setPendingLarge({ kind: "local", file: f });
    else onHandoff(row, f);
  };

  const confirmLarge = () => {
    const p = pendingLarge;
    setPendingLarge(null);
    if (p.kind === "remote") download(p.file);
    else onHandoff(row, p.file);
  };

  return (
    <div style={{ borderBottom: "1px solid #1c1c1c", padding: "14px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: "#e8e8e8", fontSize: 14, fontWeight: 700 }}>{row.name}</span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: badge.color, background: badge.bg, border: `1px solid ${badge.color}40`, padding: "2px 6px" }}>{badge.label}</span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", color: row.format === "EDF" ? ACCENT : "#888", border: "1px solid #2a2a2a", padding: "2px 6px", fontFamily: MONO }}>{row.format}</span>
          </div>
          <div style={{ color: "#aaa", fontSize: 12, marginTop: 4 }}>{row.description}</div>
          <div style={{ color: "#888", fontSize: 11, marginTop: 6 }}><span style={{ color: "#666" }}>License / access:</span> {row.licenseText || "—"}</div>
          <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}><span style={{ color: "#666" }}>Cite:</span> {row.citation || "—"}</div>
          {row.correctionNote && <div style={{ color: "#c9a54a", fontSize: 11, marginTop: 4 }}>Note: {row.correctionNote}</div>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
          {row.action === ACTION.LOAD && (
            <button style={btn(true)} onClick={toggleFiles}>{expanded ? "HIDE FILES" : "BROWSE FILES"}</button>
          )}
          {row.action === ACTION.DOWNLOAD_THEN_OPEN && (<>
            <input ref={fileInputRef} type="file" accept=".edf,.EDF" onChange={onLocalFile} style={{ display: "none" }} />
            <button style={btn(true)} onClick={() => fileInputRef.current?.click()}>OPEN DOWNLOADED FILE…</button>
          </>)}
          <ExtLink url={row.officialUrl} strong={row.action !== ACTION.LOAD}>
            {row.action === ACTION.DOWNLOAD_THEN_OPEN ? `Get files on ${row.host === "physionet.org" ? "PhysioNet" : "the official site"}` : "Official access page"}
          </ExtLink>
        </div>
      </div>

      {row.action === ACTION.DOWNLOAD_THEN_OPEN && (
        <div style={{ fontSize: 11, color: "#777", marginTop: 6 }}>
          This host doesn't allow apps to download files directly. Download an .edf from the official page, then use <b style={{ color: "#aaa" }}>Open downloaded file</b>. Credit for the dataset stays attached to the recording.
        </div>
      )}

      {pendingLarge && (
        <div style={{ marginTop: 10, padding: "10px 12px", border: "1px solid #c9a54a60", background: "#c9a54a10", fontSize: 12, color: "#e6cf8f", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span>{pendingLarge.file.name} is {formatBytes(pendingLarge.file.size)}. Files over {formatBytes(LARGE_FILE_BYTES)} are decoded fully into memory and may make the app run out of memory.</span>
          <button style={btn(true)} onClick={confirmLarge}>LOAD ANYWAY</button>
          <button style={btn(false)} onClick={() => setPendingLarge(null)}>CANCEL</button>
        </div>
      )}

      {job && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: MONO }}>Downloading {job.name} — {formatBytes(job.received)} / {formatBytes(job.total)}</span>
          <div style={{ flex: 1, maxWidth: 260, height: 4, background: "#222" }}>
            <div style={{ height: 4, width: `${job.total ? Math.min(100, (job.received / job.total) * 100) : 0}%`, background: ACCENT }} />
          </div>
          <button style={btn(false)} onClick={() => job.controller.abort()}>CANCEL</button>
        </div>
      )}

      {error && <div style={{ marginTop: 8, fontSize: 11, color: "#f87171" }}>{error}</div>}

      {expanded && row.action === ACTION.LOAD && (
        <div style={{ marginTop: 10, border: "1px solid #1f1f1f", background: "#0c0c0c", maxHeight: 260, overflow: "auto" }}>
          {files.status === "loading" && <div style={{ padding: 12, fontSize: 11, color: "#777" }}>Listing files…</div>}
          {files.status === "error" && <div style={{ padding: 12, fontSize: 11, color: "#f87171" }}>{files.error}</div>}
          {files.status === "ready" && files.list.length === 0 && <div style={{ padding: 12, fontSize: 11, color: "#777" }}>No EDF files in this record.</div>}
          {files.list.map((f) => (
            <div key={f.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", borderBottom: "1px solid #161616", fontFamily: MONO, fontSize: 11 }}>
              <span style={{ color: "#ccc" }}>{f.name} <span style={{ color: "#666" }}>· {formatBytes(f.size)}</span></span>
              <button style={btn(true)} disabled={!!job} onClick={() => requestLoad(f)}>LOAD INTO REVIEW</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
