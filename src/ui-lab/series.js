// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// Build band-power and RMS trends from a parsed EDF for the UI lab.
// Uses the app's own computeBands / acPower so the numbers are the same
// maths as review, not a sketch.

import { computeBands } from "../dsp.js";
import { acPower } from "../live-metrics.js";

export const BANDS = ["delta", "theta", "alpha", "beta", "gamma"];

export const DATASETS = [
  {
    id: "eyes",
    file: "S001R02-eyes-closed.edf",
    task: "Eyes closed",
    source: "PhysioNet EEGMMIDB S001 R02",
    channels: ["O1", "Oz", "O2"],
    band: "alpha",
    blurb: "Occipital electrodes. Eyes closed, so alpha is the band to read.",
  },
  {
    id: "fist",
    file: "S010R03-left-right-fist.edf",
    task: "Left / right fist",
    source: "PhysioNet EEGMMIDB S010 R03",
    channels: ["C3", "Cz", "C4"],
    band: "beta",
    blurb: "Sensorimotor electrodes with the file's own T0 / T1 / T2 task marks.",
  },
];

export function electrodeName(label) {
  return String(label || "")
    .replace(/\./g, "")
    .replace(/^EEG\s+/i, "")
    .replace(/\s+/g, "")
    .trim();
}

export function pickChannels(labels, names) {
  const el = labels.map(electrodeName);
  const idxs = [];
  for (const name of names) {
    const i = el.findIndex((e) => e === name);
    if (i >= 0) idxs.push(i);
  }
  return idxs.length ? idxs : [0];
}

/** Linear sample of a series whose x positions are `times` (seconds). */
export function sampleAt(times, values, t) {
  const n = times.length;
  if (!n) return 0;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  const u = (t - times[lo]) / span;
  return values[lo] + (values[hi] - values[lo]) * u;
}

export function argMax(values) {
  let i = 0;
  for (let k = 1; k < values.length; k++) if (values[k] > values[i]) i = k;
  return i;
}

/**
 * Windowed trend. Each point is the mean of the chosen channels over
 * `windowSec`, stepped by `hopSec`. No extra smoothing — the dots show
 * the analysis windows themselves.
 */
export function buildTrend(edf, channelIdxs, { windowSec = 2, hopSec = 0.5 } = {}) {
  const sr = edf.sampleRate || 160;
  const n = edf.channelData[0].length;
  const win = Math.max(64, Math.round(windowSec * sr));
  const hop = Math.max(1, Math.round(hopSec * sr));
  const use = channelIdxs.length ? channelIdxs : [0];
  const times = [];
  const total = [];
  const rms = [];
  const bands = { delta: [], theta: [], alpha: [], beta: [], gamma: [] };
  const buf = new Float32Array(win);
  for (let start = 0; start + win <= n; start += hop) {
    buf.fill(0);
    for (const i of use) {
      const src = edf.channelData[i];
      for (let k = 0; k < win; k++) buf[k] += src[start + k] || 0;
    }
    const inv = 1 / use.length;
    for (let k = 0; k < win; k++) buf[k] *= inv;
    const b = computeBands(buf, sr);
    times.push((start + win / 2) / sr);
    total.push(b.total || 0);
    rms.push(Math.sqrt(acPower(buf)));
    for (const name of BANDS) bands[name].push(b[name] || 0);
  }
  return {
    times, total, bands, rms, sr, windowSec, hopSec,
    duration: n / sr,
    nCh: edf.channelLabels.length,
  };
}

/** A round scale tick under the max, so the guide is a ruler and not a threshold. */
export function scaleTick(max) {
  if (!(max > 0)) return 1;
  const want = max * 0.5;
  const exp = Math.pow(10, Math.floor(Math.log10(want)));
  const steps = [1, 2, 2.5, 5, 10];
  let best = exp;
  let bestD = Infinity;
  for (const s of steps) {
    const v = s * exp;
    if (v >= max * 0.9) continue;
    const d = Math.abs(v - want);
    if (d < bestD) { best = v; bestD = d; }
  }
  return best;
}

export function formatPower(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 100) return Math.round(v).toLocaleString("en-US");
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export function formatUv(v) {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

/** Percentile of a numeric list. p in 0..1. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i];
}
