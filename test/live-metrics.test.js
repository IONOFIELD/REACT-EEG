// Live per-channel verification metrics — the rules behind the Record-tab bring-up panel.
import { describe, it, expect } from "vitest";
import { acPower, goertzelPower, mainsRatio, classifyChannel, channelQuality } from "../src/live-metrics.js";

const f32 = (a) => Float32Array.from(a);
const sine = (freq, sr, N, amp = 1, dc = 0) =>
  f32(Array.from({ length: N }, (_, n) => dc + amp * Math.sin(2 * Math.PI * freq * n / sr)));

describe("acPower", () => {
  it("is the mean-removed variance (ignores DC)", () => {
    expect(acPower(f32([5, 5, 5, 5]))).toBe(0);              // flat, any offset
    expect(acPower(sine(10, 256, 512, 4))).toBeCloseTo(8, 1); // A²/2 = 16/2 = 8
    expect(acPower(sine(10, 256, 512, 4, 1000))).toBeCloseTo(8, 1); // DC doesn't change it
  });
  it("handles empty input", () => {
    expect(acPower(null)).toBe(0);
    expect(acPower(f32([]))).toBe(0);
  });
});

describe("goertzelPower", () => {
  it("returns ≈A²/2 (mean-square units) for a pure tone at the target bin", () => {
    const p = goertzelPower(sine(60, 250, 500, 3), 60, 250); // A=3 → A²/2 = 4.5
    expect(p).toBeCloseTo(4.5, 1);
  });
  it("is ~0 for a tone far from the target frequency", () => {
    expect(goertzelPower(sine(10, 250, 500, 3), 60, 250)).toBeLessThan(0.05);
  });
  it("rejects invalid frequencies / empty input", () => {
    expect(goertzelPower(sine(10, 250, 500), 0, 250)).toBe(0);
    expect(goertzelPower(sine(10, 250, 500), 125, 250)).toBe(0); // Nyquist
    expect(goertzelPower(f32([]), 60, 250)).toBe(0);
  });
});

describe("mainsRatio", () => {
  it("≈1 for a pure 60 Hz hum, ≈0 for clean 10 Hz", () => {
    expect(mainsRatio(sine(60, 250, 500, 5), 250, 60)).toBeGreaterThan(0.85);
    expect(mainsRatio(sine(10, 250, 500, 5), 250, 60)).toBeLessThan(0.1);
  });
  it("~0.5 for an equal 10 Hz + 60 Hz mix", () => {
    const mix = f32(Array.from({ length: 500 }, (_, n) =>
      5 * Math.sin(2 * Math.PI * 10 * n / 250) + 5 * Math.sin(2 * Math.PI * 60 * n / 250)));
    const r = mainsRatio(mix, 250, 60);
    expect(r).toBeGreaterThan(0.35);
    expect(r).toBeLessThan(0.65);
  });
  it("honours a 50 Hz mains setting", () => {
    expect(mainsRatio(sine(50, 250, 500, 5), 250, 50)).toBeGreaterThan(0.85);
    expect(mainsRatio(sine(50, 250, 500, 5), 250, 60)).toBeLessThan(0.2);
  });
  it("is 0 for a flat channel", () => {
    expect(mainsRatio(f32(new Array(500).fill(3)), 250, 60)).toBe(0);
  });
});

describe("classifyChannel", () => {
  it("flatline when σ is below the floor", () => {
    expect(classifyChannel({ stdUv: 0.2, mainsRatio: 0 })).toBe("flatline");
    expect(classifyChannel({ stdUv: 0, mainsRatio: 0 })).toBe("flatline");
  });
  it("noisy when mains dominates or σ is railed", () => {
    expect(classifyChannel({ stdUv: 30, mainsRatio: 0.7 })).toBe("noisy");
    expect(classifyChannel({ stdUv: 5000, mainsRatio: 0 })).toBe("noisy");
  });
  it("live for a plausible fluctuating EEG-range signal", () => {
    expect(classifyChannel({ stdUv: 25, mainsRatio: 0.1 })).toBe("live");
  });
  it("thresholds are configurable", () => {
    expect(classifyChannel({ stdUv: 25, mainsRatio: 0.3 }, { mainsThresh: 0.25 })).toBe("noisy");
    expect(classifyChannel({ stdUv: 2, mainsRatio: 0 }, { flatUv: 5 })).toBe("flatline");
  });
});

describe("channelQuality", () => {
  it("clean EEG-like alpha → live, low mains", () => {
    const q = channelQuality(sine(10, 250, 500, 20), 250);
    expect(q.status).toBe("live");
    expect(q.stdUv).toBeCloseTo(Math.sqrt(200), 0); // A²/2=200 → σ≈14.1
    expect(q.mains60).toBe(false);
  });
  it("60 Hz-dominated channel → noisy + mains60 flag", () => {
    const q = channelQuality(sine(60, 250, 500, 20), 250);
    expect(q.status).toBe("noisy");
    expect(q.mains60).toBe(true);
    expect(q.mainsRatio).toBeGreaterThan(0.85);
  });
  it("flat/floating channel → flatline", () => {
    const q = channelQuality(f32(new Array(500).fill(0)), 250);
    expect(q.status).toBe("flatline");
    expect(q.stdUv).toBe(0);
  });
});
