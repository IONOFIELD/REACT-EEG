// Signal-presence detection: a channel "has data" only if it actually varies.
//
// This locks the fix for the false-positive bug where raw RMS (which includes a DC offset)
// made flat/constant channels read as "has data". The rule is now mean-removed σ + a
// require-it-varies check.
import { describe, it, expect } from "vitest";
import { signalStats, channelHasSignal, signalStdFloor, EEG_SIGNAL_STD_MIN } from "../src/edf-signals.js";

const f32 = (a) => Float32Array.from(a);
const sine = (freq, sr, N, amp) => f32(Array.from({ length: N }, (_, n) => amp * Math.sin(2 * Math.PI * freq * n / sr)));

describe("signalStats", () => {
  it("computes mean-removed std and range", () => {
    const s = signalStats(f32([1, 2, 3, 4, 5]));
    expect(s.mean).toBeCloseTo(3, 6);
    expect(s.range).toBeCloseTo(4, 6);
    expect(s.std).toBeCloseTo(Math.sqrt(2), 4); // population std of 1..5
  });
  it("a constant signal has zero std and zero range regardless of offset", () => {
    const s = signalStats(f32(new Array(100).fill(42)));
    expect(s.std).toBe(0);
    expect(s.range).toBe(0);
  });
  it("handles empty input", () => {
    expect(signalStats(null)).toEqual({ std: 0, range: 0, mean: 0, n: 0 });
    expect(signalStats(f32([]))).toEqual({ std: 0, range: 0, mean: 0, n: 0 });
  });
});

describe("channelHasSignal", () => {
  it("real fluctuating EEG (tens of µV) → has signal", () => {
    expect(channelHasSignal(sine(10, 256, 512, 30))).toBe(true);
  });
  it("flat all-zero channel → no signal", () => {
    expect(channelHasSignal(f32(new Array(512).fill(0)))).toBe(false);
  });
  it("flat channel with a large DC offset → no signal (the RMS-bug case)", () => {
    // Raw RMS would be ~100 here and falsely pass; σ is 0 so this is correctly rejected.
    expect(channelHasSignal(f32(new Array(512).fill(100)))).toBe(false);
  });
  it("a tiny-jitter near-flat channel below the floor → no signal", () => {
    const jitter = f32(Array.from({ length: 512 }, (_, i) => 50 + (i % 2 ? 0.05 : -0.05))); // σ≈0.05 µV
    expect(channelHasSignal(jitter)).toBe(false);
  });
  it("respects unit scaling — same waveform in mV is still detected", () => {
    const mvSine = sine(10, 256, 512, 0.03); // 30 µV expressed in mV
    expect(channelHasSignal(mvSine, "mV")).toBe(true);
    // …but would be (correctly) rejected if mislabelled µV, since 0.03 < 0.5 µV floor
    expect(channelHasSignal(mvSine, "uV")).toBe(false);
  });
  it("empty / missing channel → no signal", () => {
    expect(channelHasSignal(null)).toBe(false);
    expect(channelHasSignal(f32([]))).toBe(false);
  });
});

describe("signalStdFloor", () => {
  it("defaults to the µV floor", () => {
    expect(signalStdFloor("uV")).toBe(EEG_SIGNAL_STD_MIN);
    expect(signalStdFloor("µV")).toBe(EEG_SIGNAL_STD_MIN);
    expect(signalStdFloor("")).toBe(EEG_SIGNAL_STD_MIN);
  });
  it("scales down for mV and V", () => {
    expect(signalStdFloor("mV")).toBeCloseTo(EEG_SIGNAL_STD_MIN * 1e-3, 12);
    expect(signalStdFloor("V")).toBeCloseTo(EEG_SIGNAL_STD_MIN * 1e-6, 15);
  });
});
