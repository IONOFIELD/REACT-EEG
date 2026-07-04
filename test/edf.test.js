// EDF writer round-trip (Phase 5): a captured raw-µV session must write to a valid EDF whose
// samples decode back within the 16-bit quantization tolerance, and the PIPELINE/SCHEMA version
// stamp must land in the reserved header field (which the de-id scrub leaves intact).
import { describe, it, expect } from "vitest";
import { buildEDFFile, edfReservedField, parseEDFHeader, parseEDFWindow } from "../src/edf.js";

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

const f32 = (a) => Float32Array.from(a);
const N = 250;
const alpha = f32(Array.from({ length: N }, (_, n) => 30 * Math.sin(2 * Math.PI * 10 * n / 250)));   // ±30 µV
const drift = f32(Array.from({ length: N }, (_, n) => 5 * Math.sin(2 * Math.PI * 1 * n / 250) + 0.02 * n)); // small + ramp
const flat = f32(new Array(N).fill(0));                                                               // dead channel

describe("buildEDFFile round-trip", () => {
  const buf = buildEDFFile({
    channelLabels: ["C3", "C4", "O1"],
    channelData: [alpha, drift, flat],
    sampleRate: 250, recordDurationSec: 1,
    versionStamp: "REACT react-pipeline-1.0.0 v15.0",
  });
  const edf = readEdf(buf);

  it("writes the right structure (3 signals, 1 record, 250 Hz)", () => {
    expect(edf.ns).toBe(3);
    expect(edf.numRecords).toBe(1);
    expect(edf.recDur).toBe(1);
    expect(edf.sigs[0].nSamp).toBe(250);
  });

  it("decodes every channel within the 16-bit quantization tolerance (±1 LSB)", () => {
    const inputs = [alpha, drift, flat];
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
    expect(rms(edf.sigs[0].data)).toBeCloseTo(rms(alpha), 2);
  });

  it("stamps PIPELINE/SCHEMA versions into the reserved header field", () => {
    expect(edfReservedField(buf)).toBe("REACT react-pipeline-1.0.0 v15.0");
  });

  it("a flat (dead) channel round-trips as ~0 (min==max expanded to ±1)", () => {
    for (const v of edf.sigs[2].data) expect(Math.abs(v)).toBeLessThan(0.001);
  });

  it("defaults the reserved field to empty when no stamp is given (unchanged behaviour)", () => {
    const plain = buildEDFFile({ channelLabels: ["C3"], channelData: [alpha], sampleRate: 250 });
    expect(edfReservedField(plain)).toBe("");
  });
});

describe("parseEDFWindow — windowed decode (long-study support)", () => {
  // A 10-record (10 s) EDF with a per-sample ramp so every window is uniquely identifiable.
  const SR = 100, RECS = 10, TOTAL = SR * RECS; // 1000 samples/channel
  const rampA = f32(Array.from({ length: TOTAL }, (_, i) => i * 0.1));        // 0 … 99.9 µV
  const rampB = f32(Array.from({ length: TOTAL }, (_, i) => 40 - i * 0.03));  // decreasing
  const buf = buildEDFFile({ channelLabels: ["Fp1", "Fp2"], channelData: [rampA, rampB], sampleRate: SR, recordDurationSec: 1 });

  it("parseEDFHeader reports structure without decoding signals", () => {
    const h = parseEDFHeader(buf);
    expect(h.error).toBeUndefined();
    expect(h.numRecords).toBe(RECS);
    expect(h.recordDuration).toBe(1);
    expect(h.sampleRate).toBe(SR);
    expect(h.totalDuration).toBe(RECS);
    expect(h.channelLabels).toEqual(["Fp1", "Fp2"]);
    expect(h.samplesPerRecord).toBe(2 * SR); // 2 channels × 100
  });

  it("a full window (no range) decodes the whole file", () => {
    const full = parseEDFWindow(buf);
    expect(full.error).toBeUndefined();
    expect(full.channelData.length).toBe(2);
    expect(full.channelData[0].length).toBe(TOTAL);
    expect(full.windowStartRec).toBe(0);
    expect(full.windowRecCount).toBe(RECS);
    expect(full.windowDurSec).toBe(RECS);
    // round-trips the input within the 16-bit quantization tolerance
    const lsb = 100 / 65535;
    for (let i = 0; i < TOTAL; i += 37) expect(Math.abs(full.channelData[0][i] - rampA[i])).toBeLessThanOrEqual(lsb + 1e-6);
  });

  it("a windowed decode extracts EXACTLY the matching slice of the full decode", () => {
    const full = parseEDFWindow(buf);
    const win = parseEDFWindow(buf, 3, 2); // records [3, 5)
    expect(win.windowStartRec).toBe(3);
    expect(win.windowRecCount).toBe(2);
    expect(win.windowStartSec).toBe(3);
    expect(win.windowDurSec).toBe(2);
    expect(win.channelData[0].length).toBe(2 * SR); // 200 samples
    // byte-offset seeking is correct: window == full sliced [300, 500) for both channels
    expect(Array.from(win.channelData[0])).toEqual(Array.from(full.channelData[0].slice(300, 500)));
    expect(Array.from(win.channelData[1])).toEqual(Array.from(full.channelData[1].slice(300, 500)));
    // and still carries whole-file metadata so a window knows its place
    expect(win.numRecords).toBe(RECS);
    expect(win.totalDuration).toBe(RECS);
  });

  it("clamps a range that runs past the end (partial last window)", () => {
    const win = parseEDFWindow(buf, 8, 5); // wants records 8..12, only 8,9 exist
    expect(win.windowStartRec).toBe(8);
    expect(win.windowRecCount).toBe(2);
    expect(win.channelData[0].length).toBe(2 * SR);
    const full = parseEDFWindow(buf);
    expect(Array.from(win.channelData[0])).toEqual(Array.from(full.channelData[0].slice(800, 1000)));
  });

  it("returns an empty window for a start past the end", () => {
    const win = parseEDFWindow(buf, 20, 3);
    expect(win.windowStartRec).toBe(RECS);
    expect(win.windowRecCount).toBe(0);
    expect(win.channelData[0].length).toBe(0);
  });

  it("rejects a malformed buffer without throwing", () => {
    expect(parseEDFHeader(new ArrayBuffer(10)).error).toBeTruthy();
    expect(parseEDFWindow(new ArrayBuffer(10)).error).toBeTruthy();
  });
});
