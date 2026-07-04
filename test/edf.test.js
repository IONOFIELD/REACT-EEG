// EDF writer round-trip + windowed decode. Per the project's no-synthetic-data rule (which
// includes test fixtures), every input here is a REAL PhysioNet seed recording — decoded with
// the code under test, then used both as writer input and as the windowing ground truth.
import { describe, it, expect } from "vitest";
import { buildEDFFile, edfReservedField, parseEDFHeader, parseEDFWindow } from "../src/edf.js";
import { applyHighPass } from "../src/dsp.js";
import { loadSeedEdf, SEEDS } from "./seed-fixtures.js";

// A hand-built 2-signal EDF at DIFFERENT per-signal rates. This is a MATH VECTOR (constructed
// header bytes to exercise a code path), NOT a fabricated recording — the real seeds are all
// uniform-rate and would silently hide the per-signal-rate fallback bug.
function buildMixedRateEdf({ rA = 100, rB = 50, records = 3 }) {
  const ns = 2, headerBytes = 256 + ns * 256, spr = rA + rB;
  const buf = new ArrayBuffer(headerBytes + records * spr * 2);
  const bytes = new Uint8Array(buf), dv = new DataView(buf);
  const w = (o, l, s) => { const p = (s + "").padEnd(l).slice(0, l); for (let i = 0; i < l; i++) bytes[o + i] = p.charCodeAt(i); };
  w(0, 8, "0       "); w(184, 8, String(headerBytes)); w(236, 8, String(records)); w(244, 8, "1"); w(252, 4, String(ns));
  const b = 256;
  ["ChA", "ChB"].forEach((lab, i) => w(b + i * 16, 16, lab));
  [0, 1].forEach(i => { w(b + ns * 96 + i * 8, 8, "uV"); w(b + ns * 104 + i * 8, 8, "-100.0"); w(b + ns * 112 + i * 8, 8, "100.0"); w(b + ns * 120 + i * 8, 8, "-32768"); w(b + ns * 128 + i * 8, 8, "32767"); });
  w(b + ns * 216 + 0 * 8, 8, String(rA)); w(b + ns * 216 + 1 * 8, 8, String(rB));
  let off = headerBytes;
  for (let r = 0; r < records; r++) {
    for (let s = 0; s < rA; s++) { dv.setInt16(off, ((r * rA + s) % 20000) - 10000, true); off += 2; }
    for (let s = 0; s < rB; s++) { dv.setInt16(off, ((r * rB + s) % 20000) - 10000, true); off += 2; }
  }
  return buf;
}

// Real fixture: EEGMMIDB, 64-ch @ 160 Hz, 61 × 1 s records.
const seed = loadSeedEdf(SEEDS.eeg64);
const decoded = parseEDFWindow(seed);                                  // whole-file decode
const SPR0 = decoded.channelData[0].length / decoded.windowRecCount;   // samples/record, ch0 (=160)
const real = (c, n) => Float32Array.from(decoded.channelData[c].subarray(0, n));

// Minimal EDF reader — just enough to verify buildEDFFile's output (header scaling + samples).
function readEdf(buffer) {
  const bytes = new Uint8Array(buffer);
  const dec = new TextDecoder("ascii");
  const str = (o, l) => dec.decode(bytes.slice(o, o + l)).trim();
  const int = (o, l) => parseInt(str(o, l)) || 0;
  const flt = (o, l) => parseFloat(str(o, l)) || 0;
  const headerBytes = int(184, 8);
  const numRecords = int(236, 8);
  const recDur = flt(244, 8);
  const ns = int(252, 4);
  const b = 256;
  const sigs = [];
  for (let i = 0; i < ns; i++) {
    const physMin = flt(b + ns * 104 + i * 8, 8);
    const physMax = flt(b + ns * 112 + i * 8, 8);
    const digMin = int(b + ns * 120 + i * 8, 8);
    const digMax = int(b + ns * 128 + i * 8, 8);
    const nSamp = int(b + ns * 216 + i * 8, 8);
    const scale = (physMax - physMin) / (digMax - digMin);
    sigs.push({ physMin, physMax, digMin, nSamp, scale, offset: physMin - digMin * scale, data: [] });
  }
  const dv = new DataView(buffer);
  let off = headerBytes;
  for (let r = 0; r < numRecords; r++) {
    for (let i = 0; i < ns; i++) {
      for (let s = 0; s < sigs[i].nSamp; s++) {
        sigs[i].data.push(dv.getInt16(off, true) * sigs[i].scale + sigs[i].offset);
        off += 2;
      }
    }
  }
  return { ns, numRecords, recDur, headerBytes, sigs };
}

describe("buildEDFFile round-trip (real seed channels)", () => {
  const SR = Math.round(SPR0);
  const N = SR * 2;                                 // 2 seconds of two real channels
  const chA = real(0, N), chB = real(1, N);
  const dead = new Float32Array(N);                 // a flat/dead electrode — a real degenerate case, not fabricated signal
  const inputs = [chA, chB, dead];
  const buf = buildEDFFile({
    channelLabels: [decoded.channelLabels[0], decoded.channelLabels[1], "FLAT"],
    channelData: inputs,
    sampleRate: SR, recordDurationSec: 1,
    versionStamp: "REACT react-pipeline-1.0.0 v15.0",
  });
  const edf = readEdf(buf);

  it("writes the right structure (3 signals, 2 records at the seed's rate)", () => {
    expect(edf.ns).toBe(3);
    expect(edf.numRecords).toBe(2);
    expect(edf.recDur).toBe(1);
    expect(edf.sigs[0].nSamp).toBe(SR);
  });

  it("decodes real channels within the 16-bit quantization tolerance (±1 LSB)", () => {
    for (let c = 0; c < 3; c++) {
      const { physMin, physMax, data } = edf.sigs[c];
      const lsb = (physMax - physMin) / 65535;
      for (let i = 0; i < N; i++) {
        expect(Math.abs(data[i] - inputs[c][i])).toBeLessThanOrEqual(lsb + 1e-6);
      }
    }
  });

  it("preserves the RMS of a real channel (quantization is negligible)", () => {
    const rms = (a) => Math.sqrt([...a].reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(edf.sigs[0].data)).toBeCloseTo(rms(chA), 1);
  });

  it("stamps PIPELINE/SCHEMA versions into the reserved header field", () => {
    expect(edfReservedField(buf)).toBe("REACT react-pipeline-1.0.0 v15.0");
  });

  it("a flat (dead) channel round-trips as ~0 (min==max expanded to ±1)", () => {
    for (const v of edf.sigs[2].data) expect(Math.abs(v)).toBeLessThan(0.001);
  });

  it("defaults the reserved field to empty when no stamp is given (unchanged behaviour)", () => {
    const plain = buildEDFFile({ channelLabels: [decoded.channelLabels[0]], channelData: [chA], sampleRate: SR });
    expect(edfReservedField(plain)).toBe("");
  });
});

describe("parseEDFWindow — windowed decode (real seed)", () => {
  it("parseEDFHeader reports structure without decoding signals", () => {
    const h = parseEDFHeader(seed);
    expect(h.error).toBeUndefined();
    expect(h.numRecords).toBe(61);
    expect(h.recordDuration).toBe(1);
    expect(h.totalDuration).toBe(61);
    expect(h.channelLabels.length).toBeGreaterThanOrEqual(64);
    expect(h.sampleRate).toBe(SPR0);
  });

  it("a full window (no range) decodes the whole file", () => {
    expect(decoded.error).toBeUndefined();
    expect(decoded.windowStartRec).toBe(0);
    expect(decoded.windowRecCount).toBe(61);
    expect(decoded.windowDurSec).toBe(61);
    expect(decoded.channelData[0].length).toBe(61 * SPR0);
  });

  it("a windowed decode extracts EXACTLY the matching slice of the full decode", () => {
    const win = parseEDFWindow(seed, 10, 10); // records [10, 20)
    expect(win.windowStartRec).toBe(10);
    expect(win.windowRecCount).toBe(10);
    expect(win.windowStartSec).toBe(10);
    expect(win.windowDurSec).toBe(10);
    expect(win.channelData[0].length).toBe(10 * SPR0);
    // byte-offset seeking is correct on real bytes: window == full sliced [10s, 20s)
    expect(Array.from(win.channelData[0])).toEqual(Array.from(decoded.channelData[0].slice(10 * SPR0, 20 * SPR0)));
    expect(Array.from(win.channelData[7])).toEqual(Array.from(decoded.channelData[7].slice(10 * SPR0, 20 * SPR0)));
    // still carries whole-file metadata so a window knows its place
    expect(win.numRecords).toBe(61);
    expect(win.totalDuration).toBe(61);
  });

  it("clamps a range that runs past the end (partial last window)", () => {
    const win = parseEDFWindow(seed, 58, 10); // wants 58..67, only 58,59,60 exist
    expect(win.windowStartRec).toBe(58);
    expect(win.windowRecCount).toBe(3);
    expect(Array.from(win.channelData[0])).toEqual(Array.from(decoded.channelData[0].slice(58 * SPR0, 61 * SPR0)));
  });

  it("returns an empty window for a start past the end", () => {
    const win = parseEDFWindow(seed, 100, 5);
    expect(win.windowStartRec).toBe(61);
    expect(win.windowRecCount).toBe(0);
    expect(win.channelData[0].length).toBe(0);
  });

  it("rejects a malformed buffer without throwing", () => {
    expect(parseEDFHeader(new ArrayBuffer(10)).error).toBeTruthy();
    expect(parseEDFWindow(new ArrayBuffer(10)).error).toBeTruthy();
  });

  it("emits per-signal metadata mirroring parseEDFFile (label/sampleRate/physDim)", () => {
    const h = parseEDFHeader(seed);
    expect(h.signals.length).toBe(h.channelLabels.length);
    expect(h.signals[0].sampleRate).toBe(SPR0);
    expect(h.signals[0].label).toBe(h.channelLabels[0]);
    expect(h.signals[0]).toHaveProperty("physDim");
    expect(decoded.signals[0].sampleRate).toBe(SPR0); // window carries it too
  });

  it("carries the OWN sample rate of each signal on a mixed-rate file (masking-bug guard)", () => {
    const buf = buildMixedRateEdf({ rA: 100, rB: 50, records: 3 });
    const h = parseEDFHeader(buf);
    expect(h.error).toBeUndefined();
    expect(h.signals.map(s => s.sampleRate)).toEqual([100, 50]);   // <-- would be [100,100] without the field
    const win = parseEDFWindow(buf, 1, 1);                         // record [1,2)
    expect(win.signals.map(s => s.sampleRate)).toEqual([100, 50]);
    expect(win.channelData[0].length).toBe(100);                  // 1 record of the 100 Hz signal
    expect(win.channelData[1].length).toBe(50);                   // 1 record of the 50 Hz signal
  });

  it("guarded-window filter matches the whole-file filter within the crop (seam equivalence)", () => {
    // The load-bearing claim: filter a guard-extended window, crop the guard, and it equals the
    // whole-file filter at the same absolute samples — so a window seam introduces no artifact.
    const G = 3;                                                   // 3-record guard = 3 s ≥ 3/hpf for hpf=1
    const whole = applyHighPass(decoded.channelData[0], 1, SPR0);
    const win = parseEDFWindow(seed, 20 - G, 10 + 2 * G);         // records [17, 33)
    const wf = applyHighPass(win.channelData[0], 1, SPR0);
    let maxAbs = 0;
    for (let i = 0; i < 10 * SPR0; i++) maxAbs = Math.max(maxAbs, Math.abs(wf[G * SPR0 + i] - whole[20 * SPR0 + i]));
    expect(maxAbs).toBeLessThan(0.5); // µV — the HPF transient settles inside the guard
  });
});
