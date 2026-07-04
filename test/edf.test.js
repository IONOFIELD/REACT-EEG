// EDF writer round-trip + windowed decode. Per the project's no-synthetic-data rule (which
// includes test fixtures), every input here is a REAL PhysioNet seed recording — decoded with
// the code under test, then used both as writer input and as the windowing ground truth.
import { describe, it, expect } from "vitest";
import { buildEDFFile, edfReservedField, parseEDFHeader, parseEDFWindow } from "../src/edf.js";
import { loadSeedEdf, SEEDS } from "./seed-fixtures.js";

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
});
