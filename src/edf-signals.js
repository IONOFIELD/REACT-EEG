// Pure signal-presence helpers for EDF channels.
//
// A channel "has data" only if it actually VARIES — measured as mean-removed standard
// deviation (AC activity), not raw RMS. Raw RMS includes any DC offset, so a flat/constant
// channel (no real EEG but a nonzero baseline) would falsely read as data. Extracted here so
// the rule is unit-tested (see test/edf-signals.test.js); App.jsx's analyzeEdfSignals uses it.

// A channel must vary by at least this (σ, in µV) to count as carrying signal.
export const EEG_SIGNAL_STD_MIN = 0.5;

// Unit-aware σ floor derived from the EDF physical dimension, so the 0.5 µV threshold scales
// correctly for files stored in mV or V.
export function signalStdFloor(physDim) {
  const d = (physDim || "").toLowerCase();
  if (d.includes("mv")) return EEG_SIGNAL_STD_MIN * 1e-3;          // millivolt
  if (/(^|[^uµm])v$/.test(d)) return EEG_SIGNAL_STD_MIN * 1e-6;    // volt
  return EEG_SIGNAL_STD_MIN;                                       // microvolt (default)
}

// Mean-removed standard deviation + range over a capped window. Returns { std, range, mean, n }.
export function signalStats(arr, cap = 8192) {
  if (!arr || !arr.length) return { std: 0, range: 0, mean: 0, n: 0 };
  const n = Math.min(arr.length, cap);
  let sum = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) { const v = arr[i]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const mean = sum / n;
  let m2 = 0;
  for (let i = 0; i < n; i++) { const dv = arr[i] - mean; m2 += dv * dv; }
  return { std: Math.sqrt(m2 / n), range: mx - mn, mean, n };
}

// True only when a channel carries real, fluctuating signal: σ above the unit-aware floor AND
// the samples actually span a range (not a constant/flat/zero trace).
export function channelHasSignal(arr, physDim, cap = 8192) {
  const { std, range } = signalStats(arr, cap);
  return std > signalStdFloor(physDim) && range > 0;
}

// True if a parsed EDF carries real signal on ANY channel (same per-channel rule as above).
// A file whose channels are all flat/zero — e.g. a session saved with no live samples (the
// acquire zero-fill fallback) or an empty import — returns false. Cheap: channelHasSignal
// caps its scan, so this is a handful of short scans regardless of recording length.
export function edfHasAnySignal(edfData) {
  const cd = edfData?.channelData;
  if (!Array.isArray(cd) || cd.length === 0) return false;
  const sigs = edfData?.signals || [];
  return cd.some((arr, i) => channelHasSignal(arr, sigs[i]?.physDim));
}
