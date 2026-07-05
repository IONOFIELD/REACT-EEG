// ══════════════════════════════════════════════════════════════
// PiEEG server recording-download client (pure)
// ══════════════════════════════════════════════════════════════
// The Pi's authoritative recorder (fork IONOFIELD/PiEEG-server, branch fix/spi-register-readback)
// serves recorded sessions over HTTP on the SAME host/port as the live WebSocket stream
// (pieeg_server/server.py):
//   GET /api/recordings              → { recordings: [{ session, has_edf, has_bdf, journal_bytes, … }] }
//   GET /download/edf?session=<base> → EDF+ 16-bit bytes  (generated on demand from the journal)
//   GET /download/bdf?session=<base> → BDF+ 24-bit bytes  (REACT's parser rejects BDF — EDF only)
//
// NOTE: the server generates the EDF on demand when /download/edf is requested, so a session is
// importable as EDF even when has_edf === false (that flag only means a .edf is already cached).
//
// These helpers are pure (URL building + response normalization) so the wire contract can be
// unit-tested without a device (test/pieeg-recordings.test.js). The fetch + library import lives
// in App.jsx (mirrors the public-dataset import path).

// ws://host:1616 → http://host:1616  (the download endpoints ride the same server as the WS stream).
// Accepts ws/wss/http/https or a bare host[:port]; returns an origin only (no trailing slash, no
// path/query). Returns "" for unusable input.
export function httpBaseFromWs(url) {
  let s = String(url || "").trim();
  if (!s) return "";
  if (/^wss:\/\//i.test(s)) s = "https://" + s.slice(6);
  else if (/^ws:\/\//i.test(s)) s = "http://" + s.slice(5);
  else if (!/^https?:\/\//i.test(s)) s = "http://" + s; // bare host[:port]
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`; // origin only — drops any path/query/hash
  } catch {
    return "";
  }
}

const trimBase = (b) => String(b || "").replace(/\/+$/, "");

export function recordingsUrl(httpBase) {
  return `${trimBase(httpBase)}/api/recordings`;
}

// format: "edf" (default) | "bdf" | "journal". REACT imports EDF; bdf/journal are exposed for
// completeness. The session is URL-encoded; the server also strips any path components server-side.
export function downloadUrl(httpBase, session, format = "edf") {
  const fmt = ["edf", "bdf", "journal"].includes(String(format)) ? String(format) : "edf";
  return `${trimBase(httpBase)}/download/${fmt}?session=${encodeURIComponent(String(session ?? ""))}`;
}

// Normalize the /api/recordings payload into a stable, defensively-typed list. Tolerant of the
// server's additive shape (legacy has_edf/edf_url plus the newer formats{} block). We build our OWN
// download URLs (downloadUrl) rather than trusting server-supplied *_url strings. Sessions without a
// string name are dropped.
export function parseRecordings(json) {
  const arr = json && Array.isArray(json.recordings) ? json.recordings : [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r.session !== "string" || !r.session) continue;
    const fmts = r.formats && typeof r.formats === "object" ? r.formats : {};
    out.push({
      session: r.session,
      hasEdf: r.has_edf === true || !!(fmts.edf && fmts.edf.present),
      hasBdf: r.has_bdf === true || !!(fmts.bdf && fmts.bdf.present),
      hasSidecar: r.has_sidecar === true,
      journalBytes: Number.isFinite(r.journal_bytes) ? r.journal_bytes : 0,
    });
  }
  return out;
}
