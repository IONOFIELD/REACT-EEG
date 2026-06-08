// ══════════════════════════════════════════════════════════════
// REACT EEG — live acquisition stream parser
// ══════════════════════════════════════════════════════════════
// Pure, side-effect-free decoding of the WebSocket bridge protocol (see
// bridge/PROTOCOL.md). Extracted from the Acquire tab so the frame handling can be
// unit-tested (test/live-stream.test.js) without a browser, a socket, or hardware.
//
// The browser client feeds raw WebSocket message payloads (string | ArrayBuffer |
// Float32Array | Node Buffer) to decodeMessage() and acts on the typed result; the mock
// and Python bridges emit exactly these frames.

export const LIVE_PROTOCOL = 1;

// ── Impedance ──
// kΩ thresholds, shared by the client readout and the bridges.
export function impedanceStatus(kOhm) {
  if (!(kOhm >= 0)) return "poor";
  if (kOhm <= 5) return "good";
  if (kOhm <= 10) return "fair";
  return "poor";
}

// Convert a unit string to a microvolt scale factor. EDF stores µV, so everything is
// normalised on ingest. Unknown units pass through as 1 (treated as already-µV).
export function unitToMicrovolts(units) {
  switch (String(units || "uV").toLowerCase()) {
    case "v": case "volt": case "volts": return 1e6;
    case "mv": return 1e3;
    case "uv": case "µv": case "microvolt": case "microvolts": return 1;
    default: return 1;
  }
}

// ── Handshake ──
// Normalise a raw `hello` object into the config the client adopts. Tolerant of missing
// fields; `channels`/`labels` are reconciled (labels win when both present and disagree).
export function normalizeHello(msg) {
  const m = msg || {};
  let labels = Array.isArray(m.labels) ? m.labels.map(String) : null;
  let channels = Number.isFinite(m.channels) ? Math.max(0, Math.floor(m.channels)) : (labels ? labels.length : 0);
  if (labels && labels.length !== channels) channels = labels.length; // labels are authoritative
  if (!labels && channels > 0) labels = Array.from({ length: channels }, (_, i) => `Ch${i + 1}`);
  const sampleRate = Number.isFinite(m.sampleRate) && m.sampleRate > 0 ? m.sampleRate : 250;
  const gain = Number.isFinite(m.gain) && m.gain !== 0 ? m.gain : 1;
  const units = typeof m.units === "string" ? m.units : "uV";
  return {
    protocol: Number.isFinite(m.protocol) ? m.protocol : 1,
    device: typeof m.device === "string" ? m.device : "Live device",
    sampleRate, channels, labels: labels || [],
    units, gain,
    // µV-per-raw-unit: combine the declared unit scale with the gain multiplier.
    uvScale: unitToMicrovolts(units) * gain,
    impedanceSupported: m.impedanceSupported !== false,
  };
}

// Map raw kΩ values to the client's impedance rows.
export function decodeImpedance(values, labels) {
  const vals = Array.isArray(values) ? values : [];
  return vals.map((v, i) => {
    const value = Math.round((Number(v) || 0) * 10) / 10;
    return { name: (labels && labels[i]) || `Ch${i + 1}`, value, status: impedanceStatus(value) };
  });
}

// Deinterleave a flat channel-interleaved Float32 sequence into frame-major rows:
// [f0c0,f0c1,…,f1c0,…] → [[f0c0,f0c1,…],[f1c0,…],…]. Trailing partial frames are dropped.
export function deinterleave(flat, channels) {
  const ch = Math.max(1, channels | 0);
  const rows = [];
  for (let i = 0; i + ch <= flat.length; i += ch) {
    const row = new Array(ch);
    for (let c = 0; c < ch; c++) row[c] = flat[i + c];
    rows.push(row);
  }
  return rows;
}

// Scale sample rows to µV in place-free fashion (returns new rows) using a µV scale.
export function scaleRows(rows, uvScale) {
  if (!(uvScale && uvScale !== 1)) return rows;
  return rows.map(r => r.map(v => v * uvScale));
}

// Number of dropped sample-batches between two seq counters. 0 when unknown (no/!seq) or
// in-order. A backward/equal seq returns 0 (treated as a benign restart, not a gap).
export function gapBatches(prevSeq, seq) {
  if (!Number.isFinite(prevSeq) || !Number.isFinite(seq)) return 0;
  const d = seq - prevSeq - 1;
  return d > 0 ? d : 0;
}

// ── Central decoder ──
// data : string | ArrayBuffer | Float32Array | Buffer  (a raw WS message payload)
// ctx  : { channels, labels, uvScale }  (from the adopted hello; uvScale optional)
// → one of:
//   { kind:"hello",     config }              (normalised, also carries uvScale)
//   { kind:"samples",   rows, seq }           (rows scaled to µV when ctx.uvScale set)
//   { kind:"impedance", impedances }
//   { kind:"ignore" }                         (unparseable / unknown / empty)
export function decodeMessage(data, ctx = {}) {
  // Binary high-rate path: interpret as channel-interleaved Float32.
  if (data && typeof data !== "string") {
    let f32;
    if (data instanceof Float32Array) f32 = data;
    else if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) f32 = new Float32Array(data);
    else if (data && data.buffer instanceof ArrayBuffer) {
      // Node Buffer / typed-array view → reinterpret its bytes as Float32.
      f32 = new Float32Array(data.buffer, data.byteOffset || 0, Math.floor((data.byteLength || 0) / 4));
    } else return { kind: "ignore" };
    const rows = deinterleave(f32, ctx.channels || ctx.labels?.length || 1);
    return rows.length ? { kind: "samples", rows: scaleRows(rows, ctx.uvScale), seq: null } : { kind: "ignore" };
  }

  // Text JSON path.
  if (typeof data === "string") {
    let msg; try { msg = JSON.parse(data); } catch { return { kind: "ignore" }; }
    const type = msg && (msg.type || msg.cmd);
    if (type === "hello") return { kind: "hello", config: normalizeHello(msg) };
    if (type === "impedance") {
      return { kind: "impedance", impedances: decodeImpedance(msg.values || msg.impedances, ctx.labels) };
    }
    if (type === "samples" && Array.isArray(msg.data)) {
      const rows = msg.data.filter(Array.isArray).map(r => r.map(Number));
      return { kind: "samples", rows: scaleRows(rows, ctx.uvScale), seq: Number.isFinite(msg.seq) ? msg.seq : null };
    }
    return { kind: "ignore" };
  }
  return { kind: "ignore" };
}
