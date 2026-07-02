// EDF writer round-trip (Phase 5): a captured raw-µV session must write to a valid EDF whose
// samples decode back within the 16-bit quantization tolerance, and the PIPELINE/SCHEMA version
// stamp must land in the reserved header field (which the de-id scrub leaves intact).
import { describe, it, expect } from "vitest";
import { buildEDFFile, edfReservedField } from "../src/edf.js";

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
