// qEEG pipeline golden — locks the EXACT numeric output of the qEEG analysis so kernel
// optimizations (e.g. twiddle-table DFTs) can be proven byte-identical, not merely "close".
// Fills the coverage gap that dsp.golden.test.js leaves: it covers computeBands + the filters,
// but NOT computeQeegAnalysis / removeLineNoiseSpectral / hanningPowerSpectrum / WPLI / IRASA.
//
// Two layers:
//   1. SNAPSHOT — computeQeegAnalysis vs a committed fixture (catches any end-to-end drift).
//   2. REFERENCE EQUIVALENCE — the optimized kernels vs the ORIGINAL per-sample-trig implementations
//      reproduced verbatim below. This is the real proof: the snapshot alone cannot see a sub-rounding
//      perturbation (the aperiodic slope is rounded to 2 decimals, which once hid a Float32-vs-Float64
//      window regression that changed 454/487 spectrum bins).
//
// To regenerate the fixture after an INTENTIONAL output change: recompute
// computeQeegAnalysis(buildQeegInput()) + removeLineNoiseSpectral(buildLineNoiseSignal()) and
// overwrite test/fixtures/qeeg-golden.json. A performance-only change must NEVER require that.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeQeegAnalysis, removeLineNoiseSpectral, hanningPowerSpectrum } from "../src/qeeg.js";
import { buildQeegInput, buildLineNoiseSignal } from "./qeeg-golden-fixture.js";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/qeeg-golden.json", import.meta.url)), "utf8"));

// ── Reference implementations: the ORIGINAL inline-trig kernels, verbatim ────────────────────
function refRemoveLineNoiseSpectral(data, sr, lineFreq = 60, bandwidth = 2) {
  if (!data || data.length < 16 || sr < lineFreq * 2) return data;
  const N = data.length;
  const freqRes = sr / N;
  const reArr = new Float32Array(N), imArr = new Float32Array(N);
  for (let k = 0; k <= Math.floor(N / 2); k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += data[n] * Math.cos(angle);
      im -= data[n] * Math.sin(angle);
    }
    reArr[k] = re; imArr[k] = im;
    if (k > 0 && k < Math.floor(N / 2)) { reArr[N - k] = re; imArr[N - k] = -im; }
  }
  const kCenter = Math.round(lineFreq / freqRes);
  const kBand = Math.ceil(bandwidth / freqRes);
  const kLow = Math.max(1, kCenter - kBand);
  const kHigh = Math.min(Math.floor(N / 2) - 1, kCenter + kBand);
  const flankWidth = Math.max(2, kBand);
  const flankLow = Math.max(1, kLow - flankWidth);
  const flankHigh = Math.min(Math.floor(N / 2), kHigh + flankWidth);
  let flankMagSum = 0, flankCount = 0;
  for (let k = flankLow; k < kLow; k++) { flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]); flankCount++; }
  for (let k = kHigh + 1; k <= flankHigh; k++) { flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]); flankCount++; }
  const avgFlankMag = flankCount > 0 ? flankMagSum / flankCount : 0;
  for (let k = kLow; k <= kHigh; k++) {
    const mag = Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    if (mag > 0) {
      const scale = avgFlankMag / mag;
      reArr[k] *= scale; imArr[k] *= scale;
      if (k > 0 && k < Math.floor(N / 2)) { reArr[N - k] = reArr[k]; imArr[N - k] = -imArr[k]; }
    }
  }
  const cleaned = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const angle = (2 * Math.PI * k * n) / N;
      sum += reArr[k] * Math.cos(angle) + imArr[k] * Math.sin(angle);
    }
    cleaned[n] = sum / N;
  }
  return cleaned;
}

function refHanningPowerSpectrum(sig) {
  const M = sig.length;
  const half = Math.floor(M / 2);
  const spec = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < M; n++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (M - 1)));
      const angle = (2 * Math.PI * k * n) / M;
      re += sig[n] * w * Math.cos(angle);
      im -= sig[n] * w * Math.sin(angle);
    }
    spec[k] = (re * re + im * im) / (M * M);
  }
  return spec;
}

const ramp = (M) => {
  const a = new Float32Array(M);
  for (let i = 0; i < M; i++) a[i] = 30 * Math.sin(2 * Math.PI * 10 * i / M) + ((i * 11) % 13 - 6);
  return a;
};

describe("qEEG pipeline golden — snapshot", () => {
  it("computeQeegAnalysis output is byte-identical to the golden snapshot", () => {
    const { waveformData, channels, sr } = buildQeegInput();
    expect(computeQeegAnalysis(waveformData, channels, sr)).toEqual(golden.analysis);
  });

  it("removeLineNoiseSpectral output is byte-identical to the golden snapshot", () => {
    const { data, sr } = buildLineNoiseSignal();
    expect(Array.from(removeLineNoiseSpectral(data, sr, 60, 2))).toEqual(golden.cleaned);
  });
});

describe("qEEG kernels — byte-identical to the original inline-trig implementations", () => {
  it("removeLineNoiseSpectral matches the reference bit-for-bit", () => {
    const { data, sr } = buildLineNoiseSignal();
    expect(Array.from(removeLineNoiseSpectral(data, sr, 60, 2)))
      .toEqual(Array.from(refRemoveLineNoiseSpectral(data, sr, 60, 2)));
  });

  // Covers the real IRASA resampled lengths (floor(512*h) and floor(512/h)) — these are the sizes
  // computeAperiodicSlope actually feeds it, and an odd length exercises the (M-1) window divisor.
  for (const M of [512, 563, 465, 269]) {
    it(`hanningPowerSpectrum matches the reference bit-for-bit (M=${M})`, () => {
      const sig = ramp(M);
      expect(Array.from(hanningPowerSpectrum(sig))).toEqual(Array.from(refHanningPowerSpectrum(sig)));
    });
  }
});
