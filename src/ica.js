import { PIPELINE_VERSION } from "./version.js";

// ── ICA (FastICA + PCA whitening) — artifact-component identification & removal ──
// Extracted verbatim from App.jsx (same numerics) so the decomposition can be unit-tested
// (it can't be exercised live — the seed recordings carry no EOG/EKG reference channels).
//
// One behavioural change vs. the old inline version: the FastICA weight vectors are seeded
// from a deterministic PRNG (mulberry32) instead of Math.random(), so the same input now
// yields the same decomposition run-to-run. Previously the init was random, making ICA
// output nondeterministic (flagged in the audit backlog). The whitening/contrast math is
// unchanged; only the starting point of the fixed-point iteration is now reproducible.

export const ICA_ARTIFACT_CORR_THRESHOLD = 0.35;
export const ICA_MAX_COMPONENTS = 8;
export const ICA_CONVERGENCE_TOL = 1e-6;
export const ICA_MAX_ITERATIONS = 50;

// Fixed seed for the weight init. The exact stream is irrelevant — only that it is stable
// and reasonably uncorrelated — so ICA becomes reproducible without changing what it means.
const ICA_SEED = 0x1CA5EED;

/**
 * mulberry32 — a small, fast, deterministic PRNG returning floats in [0, 1). Used to seed
 * the FastICA weight vectors so the decomposition is reproducible.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Jacobi eigenvalue algorithm for a small symmetric n×n matrix (row-major).
 * Returns { values: Float64Array(n), vectors: Float64Array(n*n) } where the
 * eigenvector for values[k] is column k: vectors[i*n + k]. Used to build the
 * PCA whitening transform for ICA (n = channel count, ~19–40, so this is cheap).
 */
export function jacobiEigenSym(A, n, maxSweeps = 80) {
  const a = Float64Array.from(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-20) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        // a := Jᵀ a J  (rotate columns p,q then rows p,q)
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values, vectors: V };
}

/**
 * Train a FastICA model from an EEG segment + reference (aux) channels.
 * Uses true PCA whitening (eigendecomposition of the channel covariance) so the
 * tanh-contrast FastICA operates on genuinely decorrelated, unit-variance inputs
 * — fixing the previous diagonal-std-only "whitening" that left cross-channel
 * correlation intact (AUDIT-v13.md §3). Returns precomputed per-artifact spatial
 * filters + back-projections so {@link applyTrainedICA} is a cheap linear pass.
 * Returns null if the input is too small (< 2 channels or < 16 samples).
 *
 * @param {Float32Array[]} channelData — EEG channels to train on
 * @param {Float32Array[]} auxChannels — EOG/EKG references used to identify artifact ICs
 * @param {number} sr — sample rate (Hz)
 */
export function trainICA(channelData, auxChannels, sr) {
  const nCh = channelData.length;
  const N = channelData[0]?.length || 0;
  if (nCh < 2 || N < 16) return null;

  // 1. Center; capture per-channel means for the apply step.
  const channelMeans = channelData.map(ch => { let s = 0; for (let i = 0; i < N; i++) s += ch[i]; return s / N; });
  const centered = channelData.map((ch, ci) => {
    const c = new Float64Array(N);
    for (let i = 0; i < N; i++) c[i] = ch[i] - channelMeans[ci];
    return c;
  });

  // 2. Channel covariance (symmetric nCh×nCh) → eigendecomposition → PCA whitening.
  const cov = new Float64Array(nCh * nCh);
  for (let i = 0; i < nCh; i++) {
    for (let j = i; j < nCh; j++) {
      let s = 0; for (let t = 0; t < N; t++) s += centered[i][t] * centered[j][t];
      const v = s / N; cov[i * nCh + j] = v; cov[j * nCh + i] = v;
    }
  }
  const { values, vectors } = jacobiEigenSym(cov, nCh);
  let maxEv = 0; for (let k = 0; k < nCh; k++) if (values[k] > maxEv) maxEv = values[k];
  const floor = 1e-8 * (maxEv || 1);
  // Whitening Vw (white-dim × channel): z_k = Σ_i Vw[k][i]·centered[i]
  // Un-whitening Vinv (channel × white-dim): channel_i = Σ_k Vinv[i][k]·z_k
  const Vw = new Float64Array(nCh * nCh);
  const Vinv = new Float64Array(nCh * nCh);
  for (let k = 0; k < nCh; k++) {
    const ev = Math.max(values[k], floor);
    const invSqrt = 1 / Math.sqrt(ev), sq = Math.sqrt(ev);
    for (let i = 0; i < nCh; i++) {
      const e = vectors[i * nCh + k];
      Vw[k * nCh + i] = invSqrt * e;
      Vinv[i * nCh + k] = e * sq;
    }
  }
  // Whitened data z (nCh × N): identity covariance, unit variance.
  const z = Array.from({ length: nCh }, () => new Float64Array(N));
  for (let k = 0; k < nCh; k++) {
    const row = Vw, base = k * nCh, zk = z[k];
    for (let t = 0; t < N; t++) {
      let s = 0; for (let i = 0; i < nCh; i++) s += row[base + i] * centered[i][t];
      zk[t] = s;
    }
  }

  // 3. FastICA — tanh (logcosh) contrast, deflation with Gram–Schmidt orthogonalization.
  // Weight vectors seeded from a deterministic PRNG (was Math.random) → reproducible output.
  const rand = mulberry32(ICA_SEED);
  const nComp = Math.min(nCh, ICA_MAX_COMPONENTS);
  const W = Array.from({ length: nComp }, () => {
    const w = new Float64Array(nCh);
    for (let i = 0; i < nCh; i++) w[i] = rand() - 0.5;
    return w;
  });
  const normalize = (w) => {
    let norm = 0;
    for (let i = 0; i < w.length; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < w.length; i++) w[i] /= norm;
  };
  for (let comp = 0; comp < nComp; comp++) {
    const w = W[comp];
    normalize(w);
    for (let iter = 0; iter < ICA_MAX_ITERATIONS; iter++) {
      const wNew = new Float64Array(nCh);
      let gPrimeSum = 0;
      for (let t = 0; t < N; t++) {
        let wx = 0;
        for (let i = 0; i < nCh; i++) wx += w[i] * z[i][t];
        const gx = Math.tanh(wx);
        const gPrime = 1 - gx * gx;
        for (let i = 0; i < nCh; i++) wNew[i] += z[i][t] * gx;
        gPrimeSum += gPrime;
      }
      for (let i = 0; i < nCh; i++) wNew[i] = wNew[i] / N - (gPrimeSum / N) * w[i];
      for (let p = 0; p < comp; p++) {
        let dot = 0;
        for (let i = 0; i < nCh; i++) dot += wNew[i] * W[p][i];
        for (let i = 0; i < nCh; i++) wNew[i] -= dot * W[p][i];
      }
      normalize(wNew);
      let conv = 0;
      for (let i = 0; i < nCh; i++) conv += Math.abs(Math.abs(wNew[i]) - Math.abs(w[i]));
      for (let i = 0; i < nCh; i++) w[i] = wNew[i];
      if (conv < ICA_CONVERGENCE_TOL) break;
    }
  }

  // 4. Sources s_c(t) = Σ_i W[c][i]·z[i][t]
  const S = W.map(w => {
    const ic = new Float32Array(N);
    for (let t = 0; t < N; t++) { let s = 0; for (let i = 0; i < nCh; i++) s += w[i] * z[i][t]; ic[t] = s; }
    return ic;
  });

  // 5. Flag artifact components by |Pearson r| with any aux reference channel.
  const artifactMask = new Array(nComp).fill(false);
  const componentLog = [];
  for (let c = 0; c < nComp; c++) {
    let icVar = 0;
    for (let t = 0; t < N; t++) icVar += S[c][t] * S[c][t];
    icVar /= N;
    let maxCorr = 0, triggered = false;
    for (const aux of auxChannels) {
      if (!aux || aux.length < N) continue;
      let sumIC = 0, sumAux = 0;
      for (let i = 0; i < N; i++) { sumIC += S[c][i]; sumAux += aux[i]; }
      const mIC = sumIC / N, mAux = sumAux / N;
      let num = 0, dIC = 0, dAux = 0;
      for (let i = 0; i < N; i++) {
        const a = S[c][i] - mIC, b = aux[i] - mAux;
        num += a * b; dIC += a * a; dAux += b * b;
      }
      const r = Math.sqrt(dIC * dAux) > 0 ? Math.abs(num / Math.sqrt(dIC * dAux)) : 0;
      if (r > maxCorr) maxCorr = r;
      if (r > ICA_ARTIFACT_CORR_THRESHOLD) { artifactMask[c] = true; triggered = true; break; }
    }
    componentLog.push({ component: c, rejected: triggered, maxCorrelation: +maxCorr.toFixed(4), variance: +icVar.toFixed(4) });
  }

  // 6. Precompute, in CHANNEL space, each artifact's spatial filter + back-projection:
  //    source:   s_c(t)      = Σ_i filter_c[i]·centered[i](t),   filter_c = W[c]·Vw
  //    projection: channel_i -= proj_c[i]·s_c(t),                proj_c[i] = Σ_k Vinv[i][k]·W[c][k]
  const artifacts = [];
  for (let c = 0; c < nComp; c++) {
    if (!artifactMask[c]) continue;
    const filter = new Float64Array(nCh), proj = new Float64Array(nCh);
    for (let i = 0; i < nCh; i++) {
      let f = 0; for (let k = 0; k < nCh; k++) f += W[c][k] * Vw[k * nCh + i];
      let p = 0; for (let k = 0; k < nCh; k++) p += Vinv[i * nCh + k] * W[c][k];
      filter[i] = f; proj[i] = p;
    }
    artifacts.push({ filter, proj });
  }

  return {
    channelMeans, artifacts, nCh,
    log: {
      method: "fastica-pca-whitened", pipelineVersion: PIPELINE_VERSION,
      nComponents: nComp, nChannels: nCh,
      artifactComponentsRemoved: artifacts.length,
      components: componentLog, timestamp: Date.now(),
    }
  };
}

/**
 * Apply a pre-trained FastICA model to a new segment of EEG data. For each
 * flagged artifact component it reconstructs the source from the (centered)
 * channels via the precomputed spatial filter, then subtracts that source's
 * back-projection from every channel. O(nArtifacts · N · nCh), no re-training.
 *
 * @param {Float32Array[]} channelData — EEG channels to clean
 * @param {object} trained — output of {@link trainICA}
 */
export function applyTrainedICA(channelData, trained) {
  const { channelMeans, artifacts, nCh } = trained;
  if (channelData.length !== nCh) return channelData; // shape mismatch — bail
  const N = channelData[0]?.length || 0;
  if (N < 1 || !artifacts || artifacts.length === 0) return channelData;

  // Start from a copy of the originals.
  const cleaned = channelData.map((ch) => {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = ch[i];
    return out;
  });
  // Subtract each artifact source's channel-space projection. The source is
  // reconstructed from the ORIGINAL centered channels (linear, so subtracting
  // multiple artifacts sequentially is order-independent).
  for (const { filter, proj } of artifacts) {
    for (let t = 0; t < N; t++) {
      let s = 0;
      for (let i = 0; i < nCh; i++) s += filter[i] * (channelData[i][t] - channelMeans[i]);
      for (let i = 0; i < nCh; i++) cleaned[i][t] -= proj[i] * s;
    }
  }
  return cleaned;
}
