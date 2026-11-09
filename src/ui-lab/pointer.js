// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// Pointer math for the UI-lab dot-matrix charts.
// Dragging maps the pointer to a data value in a straight line. There is no
// easing, smoothing, or dead-zone beyond a 3 px click-vs-drag threshold.

export const DRAG_THRESHOLD_PX = 3;

export function clamp01(t) {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Linear map from a pointer x to the data domain. 1:1 with the pointer. */
export function valueFromClientX(clientX, plotLeft, plotWidth, x0, x1) {
  const width = plotWidth || 1;
  const t = clamp01((clientX - plotLeft) / width);
  return x0 + t * (x1 - x0);
}

export function clientXFromValue(value, plotLeft, plotWidth, x0, x1) {
  const span = (x1 - x0) || 1;
  const t = clamp01((value - x0) / span);
  return plotLeft + t * plotWidth;
}

/**
 * What a pointer-up means.
 * A move past the threshold is a drag and never also a click, so a drag
 * cannot delete the mark it was moving. Locked marks (file events) select
 * but never remove.
 */
export function pointerAction({ marker, selectedId, moved, inLane }) {
  if (moved) return marker && !marker.locked ? { type: "move", id: marker.id } : { type: "none" };
  if (marker) {
    if (marker.locked) return { type: "select", id: marker.id };
    if (marker.id === selectedId) return { type: "remove", id: marker.id };
    return { type: "select", id: marker.id };
  }
  if (inLane) return { type: "add" };
  return { type: "none" };
}

export function hitMarker(points, x, y, radius = 12) {
  let best = null;
  let bestD = radius;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best ? best.marker : null;
}

/** mm:ss.ss — fixed width so a readout does not change length as it counts. */
export function formatClock(sec) {
  if (!Number.isFinite(sec)) return "——:——.——";
  const sign = sec < 0 ? "−" : "";
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const frac = Math.min(99, Math.floor((r - whole) * 100 + 1e-6));
  return `${sign}${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
}
