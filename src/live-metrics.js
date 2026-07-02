// ══════════════════════════════════════════════════════════════
// REACT EEG — live per-channel verification metrics
// ══════════════════════════════════════════════════════════════
// Pure, side-effect-free metrics for hardware bring-up: for each PiEEG channel, how strong is
// the signal (RMS), does mains (50/60 Hz) hum dominate, and is the electrode live / flat /
// noisy. Used by the Record tab's per-channel verification panel so a floating or badly-seated
// input is obvious at a glance. Extracted here (like edf-signals.js / dsp.js) so the rules are
// unit-tested (test/live-metrics.test.js) without a browser or hardware.
//
// These run on RAW µV samples (never notch-filtered) — the 60 Hz check needs to SEE the mains
// line, so it must not be applied to a notched trace.

// Mean-removed mean-square power (AC variance). σ = sqrt(acPower).
export function acPower(data) {
  const N = data && data.length ? data.length : 0;
  if (!N) return 0;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += data[i];
  mean /= N;
  let s = 0;
  for (let i = 0; i < N; i++) { const d = data[i] - mean; s += d * d; }
  return s / N;
}

// Mean-square power contained in the frequency bin nearest `freq`, via the Goertzel algorithm
// (one bin, cheaper than a full DFT). Mean-removed to avoid DC leakage. Scaled so a pure tone
// of amplitude A at an exact bin returns ≈ A²/2 — i.e. the same units as acPower — so the two
// combine into a clean ratio. Returns 0 for empty input or a frequency at/above Nyquist.
export function goertzelPower(data, freq, sr) {
  const N = data && data.length ? data.length : 0;
  if (!N || sr <= 0 || freq <= 0 || freq >= sr / 2) return 0;
  const k = Math.round((N * freq) / sr);
  if (k <= 0 || k >= N / 2) return 0;
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += data[i];
  mean /= N;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const s0 = (data[i] - mean) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const mag2 = s1 * s1 + s2 * s2 - coeff * s1 * s2; // |X_k|²
  return (2 * mag2) / (N * N);                       // → mean-square units (matches acPower)
}

// Fraction of a channel's AC power concentrated at the mains frequency (0..1). ~1 for a pure
// hum, ~0 for clean EEG. Robust to DC offset (both terms are mean-removed).
export function mainsRatio(data, sr, mains = 60) {
  const tot = acPower(data);
  if (tot <= 0) return 0;
  return Math.min(1, goertzelPower(data, mains, sr) / tot);
}

// Classify a channel for the bring-up panel from its σ (µV) and mains ratio.
//   flatline — σ below the floor (dead/floating input or a flat/shorted lead)
//   noisy    — mains hum dominates, or σ is implausibly large (railed/broken)
//   live     — a plausible, fluctuating EEG-range signal
export function classifyChannel({ stdUv, mainsRatio: mr }, opts = {}) {
  const flatUv = opts.flatUv ?? 0.5;      // matches EEG_SIGNAL_STD_MIN
  const railUv = opts.railUv ?? 300;      // scalp EEG σ is ~5–70 µV; »this = railed
  const mainsThresh = opts.mainsThresh ?? 0.5;
  if (!(stdUv > flatUv)) return "flatline";
  if (stdUv > railUv || (mr ?? 0) >= mainsThresh) return "noisy";
  return "live";
}

// One-call convenience: RMS (σ), mains ratio + boolean, and status for a channel window.
export function channelQuality(data, sr, opts = {}) {
  const mains = opts.mains ?? 60;
  const stdUv = Math.sqrt(acPower(data));
  const mr = mainsRatio(data, sr, mains);
  const status = classifyChannel({ stdUv, mainsRatio: mr }, opts);
  return { stdUv, mainsRatio: mr, mains60: mr >= (opts.mainsThresh ?? 0.5), status };
}
