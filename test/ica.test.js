// FastICA (src/ica.js) — determinism + artifact-removal correctness.
//
// ICA can't be exercised against the seed recordings (they carry no EOG/EKG reference
// channels), so it's validated here on synthetic mixtures of known sources. The key
// regression this guards: the weight init is now seeded (mulberry32), so the decomposition
// must be reproducible run-to-run — previously it used Math.random() and was not.
import { describe, it, expect } from "vitest";
import { trainICA, applyTrainedICA, mulberry32 } from "../src/ica.js";

// ── Synthetic generator: 4 EEG channels = linear mix of a 10 Hz "brain" sine (sub-Gaussian)
// and a sparse-bump "blink" source (super-Gaussian), plus a little noise. An EOG aux channel
// carries the blink source (so ICA should flag + remove the blink component). Deterministic
// (fixed sines + a seeded noise stream) so the test itself is reproducible. ──
function makeMixture(N = 512, sr = 128) {
  const noise = mulberry32(12345);
  const brain = new Float64Array(N);
  const blink = new Float64Array(N);
  for (let t = 0; t < N; t++) {
    brain[t] = Math.sin(2 * Math.PI * 10 * t / sr);
    // sparse super-Gaussian bumps ~ eye blinks
    blink[t] = 0;
  }
  for (const center of [60, 190, 330, 450]) {
    for (let t = 0; t < N; t++) {
      const d = t - center;
      blink[t] += 3.5 * Math.exp(-(d * d) / (2 * 12 * 12));
    }
  }
  // Mixing: frontal channels (0,1) dominated by blink; posterior (2,3) mostly brain.
  const mix = [
    { b: 0.3, k: 1.0 }, // ch0 — frontal
    { b: 0.4, k: 0.9 }, // ch1 — frontal
    { b: 1.0, k: 0.15 }, // ch2 — posterior
    { b: 0.9, k: 0.10 }, // ch3 — posterior
  ];
  const channels = mix.map(({ b, k }) => {
    const ch = new Float32Array(N);
    for (let t = 0; t < N; t++) ch[t] = b * brain[t] + k * blink[t] + (noise() - 0.5) * 0.05;
    return ch;
  });
  // EOG reference = blink source + tiny noise (strongly correlated with the blink component).
  const aux = new Float32Array(N);
  for (let t = 0; t < N; t++) aux[t] = blink[t] + (noise() - 0.5) * 0.05;
  return { channels, aux, blink, brain, sr };
}

function pearson(a, b) {
  const N = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < N; i++) { ma += a[i]; mb += b[i]; }
  ma /= N; mb /= N;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < N; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da * db > 0 ? num / Math.sqrt(da * db) : 0;
}

describe("mulberry32", () => {
  it("is deterministic for a given seed and varies across seeds", () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    const seqC = Array.from({ length: 5 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("trainICA — reproducibility", () => {
  it("is deterministic: identical input → identical spatial filters (was Math.random)", () => {
    const { channels, aux, sr } = makeMixture();
    const t1 = trainICA(channels, [aux], sr);
    const t2 = trainICA(channels, [aux], sr);
    expect(t1).not.toBeNull();
    expect(t1.artifacts.length).toBe(t2.artifacts.length);
    expect(t1.artifacts.length).toBeGreaterThan(0);
    for (let a = 0; a < t1.artifacts.length; a++) {
      expect(Array.from(t1.artifacts[a].filter)).toEqual(Array.from(t2.artifacts[a].filter));
      expect(Array.from(t1.artifacts[a].proj)).toEqual(Array.from(t2.artifacts[a].proj));
    }
    // component diagnostics (correlations/variances) are identical too
    expect(t1.log.components).toEqual(t2.log.components);
  });

  it("returns null on too-small input (< 2 channels or < 16 samples)", () => {
    expect(trainICA([new Float32Array(64)], [], 128)).toBeNull();
    expect(trainICA([new Float32Array(8), new Float32Array(8)], [], 128)).toBeNull();
  });
});

describe("trainICA + applyTrainedICA — artifact removal", () => {
  it("flags a component correlated with the EOG aux and removes it", () => {
    const { channels, aux, sr } = makeMixture();
    const trained = trainICA(channels, [aux], sr);
    expect(trained).not.toBeNull();
    // At least one component was flagged as an artifact (correlated with the aux blink ref).
    expect(trained.artifacts.length).toBeGreaterThan(0);
    expect(trained.log.artifactComponentsRemoved).toBe(trained.artifacts.length);

    const cleaned = applyTrainedICA(channels, trained);
    // On the frontal channels (blink-dominated), correlation with the EOG reference should
    // drop substantially after removal.
    for (const ch of [0, 1]) {
      const before = Math.abs(pearson(channels[ch], aux));
      const after = Math.abs(pearson(cleaned[ch], aux));
      expect(before).toBeGreaterThan(0.4);           // blink is clearly present beforehand
      expect(after).toBeLessThan(before * 0.6);      // and materially reduced afterwards
    }
  });

  it("preserves channel shape and returns copies (originals untouched)", () => {
    const { channels, aux, sr } = makeMixture();
    const trained = trainICA(channels, [aux], sr);
    const snapshot = channels.map(ch => Float32Array.from(ch));
    const cleaned = applyTrainedICA(channels, trained);
    expect(cleaned.length).toBe(channels.length);
    expect(cleaned[0].length).toBe(channels[0].length);
    // input channels are not mutated
    for (let c = 0; c < channels.length; c++) {
      expect(Array.from(channels[c])).toEqual(Array.from(snapshot[c]));
    }
  });

  it("is a no-op passthrough when no artifacts were flagged (no aux → nothing to remove)", () => {
    const { channels, sr } = makeMixture();
    const trained = trainICA(channels, [], sr); // no reference channels → no component flagged
    expect(trained.artifacts.length).toBe(0);
    const cleaned = applyTrainedICA(channels, trained);
    expect(cleaned).toBe(channels); // returns the same array reference (early-out)
  });
});
