// Golden-vector regression tests for the pure DSP kernel (src/dsp.js).
//
// These lock the signal-processing pipeline against accidental change. Inputs are tiny,
// fully deterministic synthetic signals (sine sums, impulse, pure tones); expected outputs
// were captured from the known-good implementation and are asserted within a fixed numeric
// tolerance. Each block pairs a hard golden value (regression lock) with an analytic
// property (sanity that the golden is physically right), so a real DSP change fails loudly
// while floating-point noise across machines does not.
import { describe, it, expect } from "vitest";
import {
  butterworthCoeffs, applyBiquadCascade, applyButterworthFilter,
  applyHighPass, applyLowPass, applyNotch, applyWaveletDenoise, computeBands,
  interpolateArtifacts,
  notchCoeffs, makeCascadeState, applyBiquadCascadeStateful, createStreamingFilter,
} from "../src/dsp.js";

// ── helpers ──
const f32 = (a) => Float32Array.from(a);
const rms = (a) => Math.sqrt([...a].reduce((s, v) => s + v * v, 0) / a.length);
const sine = (freq, sr, N, amp = 1) => f32(Array.from({ length: N }, (_, n) => amp * Math.sin(2 * Math.PI * freq * n / sr)));
const TOL = 1e-4;          // sample-value tolerance
const close = (actual, expected, tol = TOL) => expect(Math.abs(actual - expected)).toBeLessThan(tol);

describe("butterworthCoeffs", () => {
  it("designs a 4th-order low-pass as two biquad sections (golden coeffs)", () => {
    const sec = butterworthCoeffs(30, 128, 4, "low");
    expect(sec).toHaveLength(2);
    close(sec[0].b0, 0.326606);
    close(sec[0].b1, 0.653213);
    close(sec[0].b2, 0.326606);
    close(sec[0].a1, -0.141967);
    close(sec[0].a2, 0.448393);
  });
  it("returns no sections for an out-of-range cutoff (≥ Nyquist)", () => {
    expect(butterworthCoeffs(70, 128, 4, "low")).toEqual([]); // 70 ≥ 64 Hz Nyquist
    expect(butterworthCoeffs(0, 128, 4, "low")).toEqual([]);
  });
});

describe("applyBiquadCascade", () => {
  const sec = butterworthCoeffs(30, 128, 4, "low");
  const impulse = f32(Array.from({ length: 64 }, (_, n) => (n === 0 ? 1 : 0)));
  const ir = applyBiquadCascade(impulse, sec);
  it("impulse response matches the golden vector", () => {
    const golden = [0.07674, 0.325691, 0.501196, 0.268841, -0.095263];
    golden.forEach((g, i) => close(ir[i], g));
  });
  it("has unity DC gain (Σ impulse-response ≈ 1 for a low-pass)", () => {
    const dcGain = [...ir].reduce((s, v) => s + v, 0);
    close(dcGain, 1, 1e-3);
  });
});

describe("applyLowPass / applyHighPass (zero-phase Butterworth)", () => {
  const sr = 256, N = 512;
  // 5 Hz (passes LP) + half-amplitude 45 Hz (passes HP), split by a 15 Hz cutoff.
  const sig = f32(Array.from({ length: N }, (_, n) =>
    Math.sin(2 * Math.PI * 5 * n / sr) + 0.5 * Math.sin(2 * Math.PI * 45 * n / sr)));
  const lp = applyLowPass(sig, 15, sr);
  const hp = applyHighPass(sig, 15, sr);

  it("input RMS is the golden baseline", () => close(rms(sig), 0.790569, 1e-3));

  it("low-pass keeps the 5 Hz tone, drops the 45 Hz (golden RMS + sample)", () => {
    close(rms(lp), 0.70694, 1e-3);     // ≈ RMS of a unit sine (0.707)
    close(lp[200], -0.554538);
  });
  it("high-pass keeps the 45 Hz tone, drops the 5 Hz (golden RMS + sample)", () => {
    close(rms(hp), 0.353086, 1e-3);    // ≈ RMS of a 0.5-amp sine (0.354)
    close(hp[200], 0.414702);
  });
  it("the two complementary halves carry less energy than the original", () => {
    expect(rms(lp)).toBeLessThan(rms(sig));
    expect(rms(hp)).toBeLessThan(rms(sig));
  });
  it("a disabled cutoff (≤ 0) is a pass-through", () => {
    expect(applyLowPass(sig, 0, sr)).toBe(sig);
    expect(applyHighPass(sig, 0, sr)).toBe(sig);
  });
});

describe("applyNotch", () => {
  const sr = 256, N = 512;
  const tone = sine(60, sr, N);
  const out = applyNotch(tone, 60, sr);
  it("strongly attenuates the notch frequency (golden RMS)", () => {
    close(rms(tone), 0.707107, 1e-3);
    close(rms(out), 0.174423, 1e-3);
    expect(rms(out)).toBeLessThan(0.3 * rms(tone)); // clear attenuation
  });
  it("a disabled notch (≤ 0) is a pass-through", () => {
    expect(applyNotch(tone, 0, sr)).toBe(tone);
  });
});

describe("applyWaveletDenoise", () => {
  const sr = 256, N = 512;
  const tone = sine(10, sr, N);
  const result = applyWaveletDenoise(tone, 4);

  it("returns { data, log } and stamps pipeline provenance (timestamp is non-deterministic)", () => {
    expect(result.data).toBeInstanceOf(Float32Array);
    expect(result.log).toBeTruthy();
    expect(result.log.method).toBe("wavelet-db4-soft");
    expect(typeof result.log.pipelineVersion).toBe("string");
    expect(typeof result.log.timestamp).toBe("number"); // present, value not asserted
  });
  it("denoised .data matches golden samples and preserves the dominant rhythm", () => {
    const d = result.data;
    expect(d).toHaveLength(N);
    close(d[64], 0.077614);
    close(d[200], -0.832043);
    // correlation with the clean input stays very high (structure preserved, not destroyed)
    let s = 0, a = 0, b = 0;
    for (let i = 0; i < N; i++) { s += d[i] * tone[i]; a += d[i] * d[i]; b += tone[i] * tone[i]; }
    close(s / Math.sqrt(a * b), 0.994059, 1e-3);
  });
  it("returns the input untouched when too short to transform (N < 16)", () => {
    const tiny = f32([1, 2, 3, 4]);
    const r = applyWaveletDenoise(tiny, 4);
    expect(r.data).toBe(tiny);
    expect(r.log).toBeNull();
  });
});

describe("computeBands", () => {
  const sr = 256, N = 512;
  it("a pure 10 Hz tone puts all power in alpha (golden)", () => {
    const b = computeBands(sine(10, sr, N), sr);
    close(b.alpha, 0.25, 1e-4);
    close(b.total, 0.25, 1e-4);
    close(b.alpha / b.total, 1, 1e-3);
    close(b.delta, 0, 1e-4);
    close(b.theta, 0, 1e-4);
    close(b.beta, 0, 1e-4);
    close(b.gamma, 0, 1e-4);
  });
  it("a pure 2 Hz tone puts all power in delta", () => {
    const b = computeBands(sine(2, sr, N), sr);
    expect(b.delta).toBeGreaterThan(0.9 * b.total);
  });
  it("returns zeros for sub-threshold input length (< 64 samples)", () => {
    expect(computeBands(f32([1, 2, 3]), sr)).toEqual({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 });
  });
});

describe("interpolateArtifacts (P3 — replaces zeroing; no broadband injection)", () => {
  it("leaves the signal byte-for-byte unchanged when nothing is flagged", () => {
    const x = sine(10, 256, 512, 20);
    const out = interpolateArtifacts(x, new Array(512).fill(false));
    for (let i = 0; i < x.length; i++) close(out[i], x[i], 1e-6);
    // band power is therefore identical
    const a = computeBands(x, 256), b = computeBands(out, 256);
    close(b.alpha, a.alpha, 1e-6); close(b.total, a.total, 1e-6);
  });

  it("a short artifact burst no longer inflates broadband power (interp ≈ clean ≪ zeroed)", () => {
    const sr = 256, N = 512;
    const clean = sine(10, sr, N, 20);                 // pure 10 Hz alpha — no broadband content
    const dirty = f32(clean), mask = new Array(N).fill(false);
    for (let i = 240; i < 262; i++) { dirty[i] = 500; mask[i] = true; }   // big spike, flagged
    const zeroed = f32(dirty); for (let i = 0; i < N; i++) if (mask[i]) zeroed[i] = 0;
    const interp = interpolateArtifacts(dirty, mask);

    const bClean = computeBands(clean, sr);
    const bZero  = computeBands(zeroed, sr);
    const bInterp = computeBands(interp, sr);

    // The clean alpha tone has essentially no broadband (beta+gamma) content.
    const broadband = (b) => b.beta + b.gamma;
    // Zeroing's hard 0-edges spread energy across the spectrum → real broadband injection;
    // interpolation keeps the trace continuous, so it injects far less.
    expect(broadband(bZero)).toBeGreaterThan(broadband(bClean) + 1e-3); // zeroing demonstrably adds broadband
    expect(broadband(bInterp)).toBeLessThan(broadband(bZero) * 0.5);    // interp injects < half of zeroing's
    expect(bInterp.gamma).toBeLessThan(bZero.gamma);
    // And the flagged spike itself is gone from the interpolated trace.
    for (let i = 240; i < 262; i++) expect(Math.abs(interp[i])).toBeLessThan(100);
  });

  it("holds the clean side for an artifact run at the signal edge", () => {
    const x = f32([5, 5, 5, 9, 9, 9]);
    const mask = [true, true, false, false, true, true];
    const out = interpolateArtifacts(x, mask);
    expect(out[0]).toBeCloseTo(5, 6); expect(out[1]).toBeCloseTo(5, 6); // start run holds right-clean (x[2]=5)
    expect(out[4]).toBeCloseTo(9, 6); expect(out[5]).toBeCloseTo(9, 6); // end run holds left-clean (x[3]=9)
  });
});

// ── Phase 2: streaming (stateful, causal) biquad cascade ──
// The gate for the live-acquire filter: the stateful cascade must (a) reproduce the static
// applyBiquadCascade EXACTLY with fresh zero state, and (b) give the same result whether a
// signal is filtered in one pass or split into arbitrary chunks with the state threaded.
// The existing static-window blocks above remain the proof that review filtering is unchanged.
describe("streaming biquad cascade (Phase 2)", () => {
  const sr = 256, N = 500;
  const sig = f32(Array.from({ length: N }, (_, n) =>
    Math.sin(2 * Math.PI * 6 * n / sr) + 0.4 * Math.sin(2 * Math.PI * 40 * n / sr) + 0.2));
  const sections = [
    ...butterworthCoeffs(1, sr, 3, "high"),   // odd order → includes a 1st-order section (b2=a2=0)
    ...butterworthCoeffs(40, sr, 4, "low"),
    notchCoeffs(60, sr, 30),
  ];

  const runStatefulChunked = (data, secs, splits) => {
    const st = makeCascadeState(secs);
    const out = new Float32Array(data.length);
    let off = 0;
    for (const len of splits) {
      const part = applyBiquadCascadeStateful(data.slice(off, off + len), secs, st);
      out.set(part, off);
      off += len;
    }
    return out;
  };

  it("fresh zero-state stateful pass reproduces applyBiquadCascade EXACTLY (single section)", () => {
    const sec = butterworthCoeffs(30, 128, 4, "low");
    const a = applyBiquadCascade(sig, sec);
    const b = applyBiquadCascadeStateful(sig, sec, makeCascadeState(sec));
    for (let i = 0; i < N; i++) expect(b[i]).toBe(a[i]); // bit-for-bit
  });

  it("fresh zero-state stateful pass reproduces applyBiquadCascade EXACTLY (full HPF+LPF+notch cascade)", () => {
    const a = applyBiquadCascade(sig, sections);
    const b = applyBiquadCascadeStateful(sig, sections, makeCascadeState(sections));
    for (let i = 0; i < N; i++) expect(b[i]).toBe(a[i]);
  });

  it("chunked processing equals the one-pass result for several chunk splittings", () => {
    const onePass = applyBiquadCascadeStateful(sig, sections, makeCascadeState(sections));
    const splittings = [
      [N],
      [1, N - 1],                       // tiny first chunk exercises the N===1 carry path
      [250, 250],
      [7, 13, 31, 199, N - 250],
      Array.from({ length: N }, () => 1), // one sample per chunk (worst case)
    ];
    for (const splits of splittings) {
      const chunked = runStatefulChunked(sig, sections, splits);
      for (let i = 0; i < N; i++) expect(chunked[i]).toBe(onePass[i]); // exact
    }
  });

  it("notchCoeffs section attenuates the notch tone and passes an off-notch tone", () => {
    const at = (f) => f32(Array.from({ length: 1024 }, (_, n) => Math.sin(2 * Math.PI * f * n / sr)));
    const sec = [notchCoeffs(60, sr, 30)];
    const settle = (y) => y.slice(512); // ignore the causal start-up transient
    const rms60 = rms(settle(applyBiquadCascade(at(60), sec)));
    const rms10 = rms(settle(applyBiquadCascade(at(10), sec)));
    expect(rms60).toBeLessThan(0.1);   // 60 Hz strongly attenuated
    expect(rms10).toBeGreaterThan(0.6); // 10 Hz largely passes
  });

  it("notchCoeffs rejects out-of-range frequencies", () => {
    expect(notchCoeffs(0, sr)).toBeNull();
    expect(notchCoeffs(sr / 2, sr)).toBeNull();
  });

  it("createStreamingFilter: chunked == one-pass, and reset() re-zeros the delay line", () => {
    const mk = () => createStreamingFilter({ sampleRate: sr, hpf: 1, lpf: 40, notch: 60, order: 3 });
    const whole = mk().process(sig);
    // stream it in ragged chunks through one filter instance
    const f = mk();
    const streamed = new Float32Array(N);
    let off = 0;
    for (const len of [10, 1, 33, 200, N - 244]) { const p = f.process(sig.slice(off, off + len)); streamed.set(p, off); off += len; }
    for (let i = 0; i < N; i++) expect(streamed[i]).toBe(whole[i]);
    // after reset, the same first chunk yields the same first-chunk output as a fresh filter
    f.reset();
    const again = f.process(sig.slice(0, 50));
    const fresh = mk().process(sig.slice(0, 50));
    for (let i = 0; i < 50; i++) expect(again[i]).toBe(fresh[i]);
  });

  it("createStreamingFilter with no active filters is a pass-through (copy)", () => {
    const f = createStreamingFilter({ sampleRate: sr });
    const out = f.process(sig);
    expect(Array.from(out)).toEqual(Array.from(sig));
  });
});
