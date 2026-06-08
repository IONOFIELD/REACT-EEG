#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// REACT EEG — mock live-acquisition bridge  (zero dependencies)
// ══════════════════════════════════════════════════════════════
// Replays a real .edf file over the WebSocket bridge protocol (bridge/PROTOCOL.md) so the
// Acquire tab's live path can be exercised end-to-end WITHOUT a piEEG. Speaks the same
// frames the real Python/BrainFlow bridge will, so the browser client is identical.
//
//   node bridge/mock-bridge.mjs [--edf <path>] [--port 8765] [--channels 16]
//                               [--rate <Hz override>] [--binary] [--device piEEG-16]
//
// Implements just enough RFC 6455 (handshake + text/binary/close/ping) by hand using only
// Node's `net` + `crypto`, so it runs with `node` and nothing installed.

import net from "node:net";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

// ── args ──
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);
const EDF_PATH = arg("--edf", "public/seed-edfs/S001R01-eyes-open.edf");
const PORT = parseInt(arg("--port", "8765"), 10);
const MAX_CH = parseInt(arg("--channels", "16"), 10);
const RATE_OVERRIDE = arg("--rate", null);
const BINARY = has("--binary");
const DEVICE = arg("--device", "piEEG (mock)");
const BATCH_MS = 50;  // send a batch of frames every 50 ms (~20 msgs/s)

// ── minimal EDF reader (µV) ──
function parseEDF(path) {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const dec = new TextDecoder("ascii");
  const s = (o, l) => dec.decode(bytes.slice(o, o + l)).trim();
  const numRecords = parseInt(s(236, 8), 10);
  const recDur = parseFloat(s(244, 8));
  const ns = parseInt(s(252, 4), 10);
  let p = 256;
  const labels = []; for (let i = 0; i < ns; i++) labels.push(s(p + i * 16, 16).replace(/\.+$/, "")); p += ns * 16;
  p += ns * 80; p += ns * 8;
  const pmin = []; for (let i = 0; i < ns; i++) pmin.push(parseFloat(s(p + i * 8, 8))); p += ns * 8;
  const pmax = []; for (let i = 0; i < ns; i++) pmax.push(parseFloat(s(p + i * 8, 8))); p += ns * 8;
  const dmin = []; for (let i = 0; i < ns; i++) dmin.push(parseFloat(s(p + i * 8, 8))); p += ns * 8;
  const dmax = []; for (let i = 0; i < ns; i++) dmax.push(parseFloat(s(p + i * 8, 8))); p += ns * 8;
  p += ns * 80;
  const nsamp = []; for (let i = 0; i < ns; i++) nsamp.push(parseInt(s(p + i * 8, 8), 10)); p += ns * 8;
  p += ns * 32;
  const dataStart = p, recSamps = nsamp.reduce((a, b) => a + b, 0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  // keep scalp-EEG-ish channels (skip an "EDF Annotations" channel if present)
  const keep = [];
  for (let c = 0; c < ns && keep.length < MAX_CH; c++) { if (/annotation/i.test(labels[c])) continue; keep.push(c); }
  const sr = nsamp[keep[0]] / recDur;
  const chans = keep.map((c) => {
    const out = new Float32Array(numRecords * nsamp[c]);
    const scale = (pmax[c] - pmin[c]) / (dmax[c] - dmin[c]);
    let oi = 0;
    for (let r = 0; r < numRecords; r++) {
      let off = dataStart + r * recSamps * 2;
      for (let k = 0; k < c; k++) off += nsamp[k] * 2;
      for (let i = 0; i < nsamp[c]; i++) { const d = dv.getInt16(off + i * 2, true); out[oi++] = (d - dmin[c]) * scale + pmin[c]; }
    }
    return out;
  });
  return { labels: keep.map((c) => labels[c]), sr: RATE_OVERRIDE ? +RATE_OVERRIDE : sr, data: chans };
}

const edf = parseEDF(EDF_PATH);
const N = edf.data.length, SR = edf.sr, TOTAL = edf.data[0].length;
console.log(`[mock-bridge] ${EDF_PATH} → ${N} ch @ ${SR} Hz, ${(TOTAL / SR).toFixed(1)} s  (${BINARY ? "binary" : "JSON"} frames)`);
console.log(`[mock-bridge] labels: ${edf.labels.join(", ")}`);

// ── tiny WebSocket framing (RFC 6455) ──
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
const sendText = (sock, str) => { if (!sock.destroyed) sock.write(encodeFrame(Buffer.from(str, "utf8"), 0x1)); };
const sendBin = (sock, buf) => { if (!sock.destroyed) sock.write(encodeFrame(buf, 0x2)); };

// Parse 0+ complete frames out of a client buffer; returns {messages, rest}.
function drainFrames(buf) {
  const messages = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const payload = buf.slice(p, p + len);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    messages.push({ opcode, payload });
    off = p + len;
  }
  return { messages, rest: buf.slice(off) };
}

// NOTE: this mock replays a static .edf and therefore has NO real electrode impedance to
// report. It honestly declares impedanceSupported:false and never sends a fabricated value —
// real hardware (the piEEG bridge reading the ADS1299 lead-off) is what flips this on.
const HELLO = { type: "hello", protocol: 1, device: DEVICE, sampleRate: SR, channels: N,
  labels: edf.labels, units: "uV", gain: 1, impedanceSupported: false };

const server = net.createServer((sock) => {
  let buffered = Buffer.alloc(0), handshook = false, timer = null, pos = 0;
  const cleanup = () => { if (timer) clearInterval(timer); timer = null; };

  const startStreaming = () => {
    if (timer) return;
    const framesPerBatch = Math.max(1, Math.round(SR * BATCH_MS / 1000));
    let seq = 0;
    timer = setInterval(() => {
      if (BINARY) {
        const flat = new Float32Array(framesPerBatch * N);
        for (let f = 0; f < framesPerBatch; f++) { const idx = (pos + f) % TOTAL; for (let c = 0; c < N; c++) flat[f * N + c] = edf.data[c][idx]; }
        sendBin(sock, Buffer.from(flat.buffer));
      } else {
        const rows = new Array(framesPerBatch);
        for (let f = 0; f < framesPerBatch; f++) { const idx = (pos + f) % TOTAL; const row = new Array(N); for (let c = 0; c < N; c++) row[c] = Math.round(edf.data[c][idx] * 100) / 100; rows[f] = row; }
        sendText(sock, JSON.stringify({ type: "samples", seq: seq++, data: rows }));
      }
      pos = (pos + framesPerBatch) % TOTAL;
    }, BATCH_MS);
  };

  sock.on("data", (chunk) => {
    if (!handshook) {
      buffered = Buffer.concat([buffered, chunk]);
      const text = buffered.toString("utf8");
      if (text.includes("\r\n\r\n")) {
        const key = (text.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i) || [])[1];
        const accept = crypto.createHash("sha1").update((key || "").trim() + GUID).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        handshook = true; buffered = Buffer.alloc(0);
        console.log("[mock-bridge] client connected");
        // hello immediately, then start streaming (no impedance — see note above)
        sendText(sock, JSON.stringify(HELLO));
        startStreaming();
      }
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const { messages, rest } = drainFrames(buffered); buffered = rest;
    for (const { opcode, payload } of messages) {
      if (opcode === 0x8) { cleanup(); sock.end(); return; }                 // close
      if (opcode === 0x9) { sock.write(encodeFrame(payload, 0xA)); continue; } // ping → pong
      if (opcode === 0x1) {
        let msg; try { msg = JSON.parse(payload.toString("utf8")); } catch { continue; }
        if (msg.cmd === "impedance") { /* no impedance: this mock can't measure it (see note) */ }
        else if (msg.cmd === "hello") sendText(sock, JSON.stringify(HELLO));
        else if (msg.cmd === "stop") cleanup();
        else if (msg.cmd === "start") startStreaming();
      }
    }
  });
  sock.on("close", () => { cleanup(); console.log("[mock-bridge] client disconnected"); });
  sock.on("error", () => cleanup());
});

server.listen(PORT, () => console.log(`[mock-bridge] listening on ws://localhost:${PORT}`));
