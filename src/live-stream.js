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

// ══════════════════════════════════════════════════════════════
// pieeg-server protocol (the vendor Raspberry-Pi server, github.com/pieeg-club/PiEEG-server)
// ══════════════════════════════════════════════════════════════
// A DISTINCT protocol from the bridge `hello`/Float32 one above — kept separate so the
// existing decodeMessage (and its tests) are untouched. pieeg-server is JSON TEXT only:
//   welcome (on connect):  {"status":"connected","sample_rate":250,"channels":8|16,
//                           "filter":bool,"notch_filter":bool,"notch_freq":60.0,"mock":bool, …}
//   data frame (per sample): {"t":<unix_s>,"n":<monotonic_int>,"channels":[<uV>…]}
// It also broadcasts many other status objects (record_status/lsl_status/spike_config/…) that
// we must ignore. Values are already µV (no scaling). Drop detection uses the per-sample `n`
// (reuse gapBatches: n − prevN − 1). See AUDIT-live-acquire.md and the server source under
// ../PiEEG-server-main-extract/ (pieeg_server/server.py:245).

// Normalize a pieeg-server welcome into the config the client adopts. pieeg-server sends NO
// channel labels, so synthesize Ch1..ChN (the Acquire tab overrides these with the electrode
// map for the known channel counts). `mock` and `filter`/`notch_filter` are surfaced so the
// client can refuse synthetic data and force a raw stream.
export function normalizePieegWelcome(msg) {
  const m = msg || {};
  let channels = Number.isFinite(m.channels) ? Math.max(0, Math.floor(m.channels)) : 0;
  let labels = Array.isArray(m.labels) ? m.labels.map(String) : null;
  if (labels && !channels) channels = labels.length;
  if (!labels && channels > 0) labels = Array.from({ length: channels }, (_, i) => `Ch${i + 1}`);
  const sampleRate = Number.isFinite(m.sample_rate) && m.sample_rate > 0 ? m.sample_rate : 250;
  return {
    protocol: "pieeg-server",
    device: typeof m.device === "string" ? m.device : "PiEEG",
    sampleRate, channels, labels: labels || [],
    units: "uV", uvScale: 1,                 // pieeg-server streams µV already
    filter: m.filter === true,               // server-side bandpass state (on by default!)
    notchFilter: m.notch_filter === true,
    notchFreq: Number.isFinite(m.notch_freq) ? m.notch_freq : 60,
    mock: m.mock === true,                    // synthetic-data mode — client must refuse
    impedanceSupported: false,               // pieeg-server has no impedance frame
  };
}

// Decode one pieeg-server WebSocket message (JSON text; tolerant of a UTF-8 binary payload).
// → { kind:"welcome", config } | { kind:"samples", rows:[[…]], n } | { kind:"ignore" }
// Sample iff `n` is a number AND `channels` is an array; welcome iff status==="connected";
// everything else (record_status, lsl_status, spike_config, …) is ignored. `rows` is a
// single-sample batch so it feeds the same appendSamples path as the bridge decoder.
export function decodePieegMessage(data) {
  let text = null;
  if (typeof data === "string") text = data;
  else if (data && typeof data !== "string") {
    try {
      if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
      else if (data.buffer instanceof ArrayBuffer) text = new TextDecoder().decode(data);
      else return { kind: "ignore" };
    } catch { return { kind: "ignore" }; }
  }
  if (text == null) return { kind: "ignore" };
  let msg; try { msg = JSON.parse(text); } catch { return { kind: "ignore" }; }
  if (!msg || typeof msg !== "object") return { kind: "ignore" };
  if (msg.status === "connected") return { kind: "welcome", config: normalizePieegWelcome(msg) };
  if (typeof msg.n === "number" && Array.isArray(msg.channels)) {
    return { kind: "samples", rows: [msg.channels.map(Number)], n: msg.n, t: typeof msg.t === "number" ? msg.t : null };
  }
  return { kind: "ignore" };
}
