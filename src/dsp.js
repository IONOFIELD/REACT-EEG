// ══════════════════════════════════════════════════════════════
// REACT EEG — pure DSP kernel
// ══════════════════════════════════════════════════════════════
// These are the deterministic, side-effect-free signal-processing primitives extracted
// verbatim from App.jsx so they can be unit-tested (see test/dsp.golden.test.js) without
// pulling in React or the browser DOM. BEHAVIOUR IS UNCHANGED — this file is a move, not a
// rewrite. App.jsx imports every function from here, so there is one implementation only.
//
// Determinism notes (for the test harness):
//   • All functions below are pure given their arguments EXCEPT applyWaveletDenoise, whose
//     returned `log.timestamp` is Date.now(). The `.data` output is fully deterministic;
//     tests assert on `.data` only.
//   • ICA (Math.random init) deliberately stays in App.jsx — it is not deterministic and is
//     not part of the golden-vector suite.
import { PIPELINE_VERSION } from "./version.js";

// ── Butterworth biquad design (bilinear transform, pre-warped) ──
export function butterworthCoeffs(cutoff, sr, order, type) {
  if (cutoff <= 0 || cutoff >= sr / 2) return [];
  const wc = Math.tan(Math.PI * cutoff / sr); // pre-warped cutoff
  const wc2 = wc * wc;
  const sections = [];
  const nPairs = Math.floor(order / 2);
  for (let k = 0; k < nPairs; k++) {
    const theta = Math.PI * (2 * k + 1) / (2 * order);
    const gamma = 2 * Math.sin(theta); // damping factor for this pole pair
    if (type === "low") {
      const a0 = 1 + gamma * wc + wc2;
      sections.push({
        b0: wc2 / a0, b1: 2 * wc2 / a0, b2: wc2 / a0,
        a1: 2 * (wc2 - 1) / a0, a2: (1 - gamma * wc + wc2) / a0
      });
    } else {
      const a0 = 1 + gamma * wc + wc2;
      sections.push({
        b0: 1 / a0, b1: -2 / a0, b2: 1 / a0,
        a1: 2 * (wc2 - 1) / a0, a2: (1 - gamma * wc + wc2) / a0
      });
    }
  }
  if (order % 2 === 1) {
    if (type === "low") {
      const a0 = 1 + wc;
      sections.push({ b0: wc / a0, b1: wc / a0, b2: 0, a1: (wc - 1) / a0, a2: 0 });
    } else {
      const a0 = 1 + wc;
      sections.push({ b0: 1 / a0, b1: -1 / a0, b2: 0, a1: (wc - 1) / a0, a2: 0 });
    }
  }
  return sections;
}

// Apply cascaded biquad filter sections
export function applyBiquadCascade(data, sections) {
  let buf = data;
  for (const s of sections) {
    const N = buf.length;
    const out = new Float32Array(N);
    // Initialize with steady-state to reduce transient
    out[0] = s.b0 * buf[0];
    if (N > 1) out[1] = s.b0 * buf[1] + s.b1 * buf[0] - s.a1 * out[0];
    for (let i = 2; i < N; i++)
      out[i] = s.b0 * buf[i] + s.b1 * buf[i-1] + s.b2 * buf[i-2] - s.a1 * out[i-1] - s.a2 * out[i-2];
    buf = out;
  }
  return buf;
}

// Forward-backward (zero-phase) Butterworth filter with edge padding
export function applyButterworthFilter(data, cutoff, sr, order, type) {
  const sections = butterworthCoeffs(cutoff, sr, order, type);
  if (sections.length === 0) return data;
  const N = data.length;
  if (N < 4) return data;
  // Pad length scales with filter time constant: ~3 cycles at cutoff frequency
  const cycleLen = Math.ceil(sr / Math.max(cutoff, 0.1));
  const padLen = Math.min(cycleLen * 3, Math.floor(N / 2) - 1);
  if (padLen < 2) return applyBiquadCascade(data, sections);
  const totalLen = N + 2 * padLen;
  const padded = new Float32Array(totalLen);
  // Reflect-pad start: mirror around data[0]
  for (let i = 0; i < padLen; i++) {
    const srcIdx = Math.min(padLen - i, N - 1);
    padded[i] = 2 * data[0] - data[srcIdx];
  }
  for (let i = 0; i < N; i++) padded[padLen + i] = data[i];
  // Reflect-pad end: mirror around data[N-1]
  for (let i = 0; i < padLen; i++) {
    const srcIdx = Math.max(N - 2 - i, 0);
    padded[padLen + N + i] = 2 * data[N - 1] - data[srcIdx];
  }
  let result = applyBiquadCascade(padded, sections);
  result.reverse();
  result = applyBiquadCascade(result, sections);
  result.reverse();
  return result.slice(padLen, padLen + N);
}

export function applyHighPass(data, cutoff, sr, order = 3) {
  if (cutoff <= 0) return data;
  // Zero-phase (forward-backward), matching the low-pass path so HPF and LPF do
  // not introduce inconsistent phase distortion — important for reading waveform
  // morphology and event timing. applyButterworthFilter's reflect-padding damps
  // the forward-backward edge transient that motivated the old single-pass code.
  // Effective order = 2 × `order` (filtfilt doubling).
  return applyButterworthFilter(data, cutoff, sr, order, "high");
}
export function applyLowPass(data, cutoff, sr, order = 3) {
  if (cutoff <= 0) return data;
  return applyButterworthFilter(data, cutoff, sr, order, "low");
}
export function applyNotch(data, freq, sr, q = 30) {
  if (freq <= 0) return data;
  const w0 = (2 * Math.PI * freq) / sr, alpha = Math.sin(w0) / (2 * q);
  const b0 = 1, b1 = -2 * Math.cos(w0), b2 = 1, a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  const out = new Float32Array(data.length); out[0] = data[0]; out[1] = data[1];
  for (let i = 2; i < data.length; i++)
    out[i] = (b0/a0)*data[i] + (b1/a0)*data[i-1] + (b2/a0)*data[i-2] - (a1/a0)*out[i-1] - (a2/a0)*out[i-2];
  return out;
}

// ── Discrete Wavelet Transform (Daubechies-4) denoising ──
export function applyWaveletDenoise(data, levels = 4) {
  const N = data.length;
  if (N < 16) return { data, log: null };
  // Db4 (orthonormal) filter coefficients. Analysis is decimated correlation
  // a[i]=Σ_j h[j]·x[2i+j]; the perfect-reconstruction inverse is its transpose,
  // which scatter-adds with the SAME h/g (not time-reversed). The previous code
  // used reversed filters in synthesis, which broke reconstruction — a clean
  // signal came back distorted. (g is the QMF highpass: g[n]=(-1)^n·h[3-n].)
  const h = [0.4829629131445341, 0.8365163037378079, 0.2241438680420134, -0.1294095225512604];
  const g = [h[3], -h[2], h[1], -h[0]];

  // Symmetric (mirror) boundary handling. The transform itself uses fast periodic
  // (circular) convolution, which wraps the end of the epoch onto the start and
  // creates edge artifacts when the two ends differ in level. To avoid that we
  // mirror-extend the signal by `pad` samples on each side, run the perfect-
  // reconstruction periodic transform on the padded signal, then crop back — so
  // the wrap-around discontinuity lives in the discarded padding, not the data.
  const pad = Math.min(Math.floor(N / 2), Math.max(16, (1 << levels) * 2));
  const M = N + 2 * pad;
  const work = new Float32Array(M);
  // whole-sample mirror with no edge repeat (period 2N-2): …c b a b c…
  const reflect = (i) => {
    if (N === 1) return 0;
    const period = 2 * N - 2;
    let k = ((i % period) + period) % period;
    return k < N ? k : period - k;
  };
  for (let j = 0; j < M; j++) work[j] = data[reflect(j - pad)];

  // Forward DWT — multi-level decomposition (on the mirror-padded signal)
  const details = [];
  let approx = new Float32Array(work);
  for (let lev = 0; lev < levels; lev++) {
    const len = approx.length;
    if (len < 8) break;
    const halfLen = Math.floor(len / 2);
    const newApprox = new Float32Array(halfLen);
    const detail = new Float32Array(halfLen);
    for (let i = 0; i < halfLen; i++) {
      let lo = 0, hi = 0;
      for (let j = 0; j < 4; j++) {
        const idx = (2 * i + j) % len;
        lo += h[j] * approx[idx];
        hi += g[j] * approx[idx];
      }
      newApprox[i] = lo;
      detail[i] = hi;
    }
    details.push(detail);
    approx = newApprox;
  }

  // Estimate noise from finest detail level via MAD
  const finest = details[0];
  const sorted = Array.from(finest).map(Math.abs).sort((a, b) => a - b);
  const mad = sorted[Math.floor(sorted.length / 2)] / 0.6745;
  const threshold = mad * Math.sqrt(2 * Math.log(M)); // universal threshold on padded length

  // Soft thresholding on detail coefficients + logging
  let totalCoeffs = 0, zeroedCoeffs = 0, energyBefore = 0, energyAfter = 0;
  const perLevel = [];
  for (let lev = 0; lev < details.length; lev++) {
    const d = details[lev];
    let levZeroed = 0;
    for (let i = 0; i < d.length; i++) {
      totalCoeffs++;
      energyBefore += d[i] * d[i];
      const abs = Math.abs(d[i]);
      d[i] = abs > threshold ? Math.sign(d[i]) * (abs - threshold) : 0;
      energyAfter += d[i] * d[i];
      if (d[i] === 0) { levZeroed++; zeroedCoeffs++; }
    }
    perLevel.push({ level: lev, coefficients: d.length, zeroed: levZeroed });
  }

  // Inverse DWT — multi-level reconstruction
  let recon = approx;
  for (let lev = details.length - 1; lev >= 0; lev--) {
    const detail = details[lev];
    const outLen = detail.length * 2;
    const out = new Float32Array(outLen);
    for (let i = 0; i < detail.length; i++) {
      for (let j = 0; j < 4; j++) {
        const idx = (2 * i + j) % outLen;
        out[idx] += h[j] * recon[i] + g[j] * detail[i]; // transpose synthesis (same h/g)
      }
    }
    recon = out;
  }

  // Crop the central region back to the original length (discarding the mirror
  // padding, where the periodic wrap-around artifact now lives).
  const result = new Float32Array(N);
  for (let i = 0; i < N; i++) { const k = pad + i; result[i] = k < recon.length ? recon[k] : 0; }
  return {
    data: result,
    log: {
      method: "wavelet-db4-soft", pipelineVersion: PIPELINE_VERSION,
      levels: details.length, threshold: +threshold.toFixed(4),
      noiseEstimateMAD: +mad.toFixed(4),
      energyRemovedPct: energyBefore > 0 ? +((1 - energyAfter / energyBefore) * 100).toFixed(2) : 0,
      totalCoefficients: totalCoeffs, zeroedCoefficients: zeroedCoeffs,
      perLevel, timestamp: Date.now(),
    }
  };
}

// ── Per-band spectral power via direct DFT (Δ Θ α β γ + total) ──
export function computeBands(data, sr) {
  if (!data || data.length < 64) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
  const N = Math.min(512, data.length);
  const fR = sr / N;
  const bands = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
  const powers = {};
  let total = 0;
  Object.entries(bands).forEach(([name, [fL, fH]]) => {
    let bp = 0;
    const kL = Math.max(1, Math.round(fL / fR));
    const kH = Math.min(Math.floor(N / 2), Math.round(fH / fR));
    for (let k = kL; k <= kH; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        re += data[n] * Math.cos(angle);
        im -= data[n] * Math.sin(angle);
      }
      bp += (re * re + im * im) / (N * N);
    }
    powers[name] = bp;
    total += bp;
  });
  powers.total = total;
  return powers;
}

// Replace artifact-flagged samples with boundary-respecting LINEAR INTERPOLATION between the
// nearest clean samples on each side — instead of zeroing them. Zeroing injects sharp 0-edges,
// which spread BROADBAND spectral energy into the very signal whose band power is being measured
// (a known defect). Interpolation preserves continuity and keeps the length (so DFT resolution is
// unchanged), so a short artifact (blink/movement) no longer contaminates the estimate. Runs at the
// signal edges hold the single available clean side. Returns a NEW Float32Array; input untouched.
// mask[i] === true marks an artifact sample.
export function interpolateArtifacts(data, mask) {
  const N = data.length;
  const out = new Float32Array(data);
  if (!mask || mask.length < N) return out;
  let i = 0;
  while (i < N) {
    if (!mask[i]) { i++; continue; }
    let j = i; while (j < N && mask[j]) j++;          // contiguous artifact run [i, j)
    const hasL = i - 1 >= 0, hasR = j < N;
    const L = hasL ? out[i - 1] : (hasR ? out[j] : 0);
    const R = hasR ? out[j] : L;
    if (hasL && hasR) {
      const denom = j - (i - 1);                       // run length + 1
      for (let k = i; k < j; k++) out[k] = L + (R - L) * ((k - (i - 1)) / denom);
    } else {
      const fill = hasL ? L : R;                       // edge run → hold the one clean side
      for (let k = i; k < j; k++) out[k] = fill;
    }
    i = j;
  }
  return out;
}
