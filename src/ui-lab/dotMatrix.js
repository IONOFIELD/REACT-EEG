// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// Canvas dot-matrix field. Filled area is a grid of small discs: bright on the
// ridge, fading down to the dim grid colour. A second series (the selected
// band, or the span of a selected mark) is drawn in the blue accent with the
// same fade. The field is an ImageData buffer so a frame is one blit.

export const BG = [0x11, 0x11, 0x11];
export const GRID = [0x26, 0x26, 0x26];
export const WHITE = [255, 255, 255];
export const BLUE = [0x3b, 0x82, 0xf6];

export const DOT_PITCH = 4;
export const DOT_RADIUS = 1.15;

export function mix(top, fade) {
  const t = fade < 0 ? 0 : fade > 1 ? 1 : fade;
  return [
    Math.round(top[0] + (GRID[0] - top[0]) * t),
    Math.round(top[1] + (GRID[1] - top[1]) * t),
    Math.round(top[2] + (GRID[2] - top[2]) * t),
  ];
}

/** t = 0 on the ridge, 1 at the baseline. */
export function ridgeFade(t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.pow(u, 0.55);
}

function stamp(data, width, height, cx, cy, r2, rgb) {
  const r = Math.ceil(Math.sqrt(r2));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const o = (row + x) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
}

/**
 * @param {Uint8ClampedArray} data RGBA, length width*height*4
 * @param {{x:number,y:number,w:number,h:number}} plot device pixels
 * @param {number} pitch device pixels between dot centres
 * @param {number} radius device pixels
 * @param {(u:number)=>number} sample data value for u in 0..1 across the plot
 * @param {(u:number)=>number} contrib selected series, same units; 0 where absent
 */
export function paintDotField(data, width, height, { plot, yMax, pitch, radius, sample, contrib }) {
  data.fill(0);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG[0];
    data[i + 1] = BG[1];
    data[i + 2] = BG[2];
    data[i + 3] = 255;
  }
  const ymax = yMax > 0 ? yMax : 1;
  const r2 = radius * radius;
  const bottom = plot.y + plot.h;
  const xEnd = plot.x + plot.w;
  for (let cy = plot.y + pitch * 0.5; cy < bottom; cy += pitch) {
    for (let cx = plot.x + pitch * 0.5; cx < xEnd; cx += pitch) {
      const u = (cx - plot.x) / plot.w;
      const yVal = sample(u);
      const yPx = bottom - (yVal / ymax) * plot.h;
      const cVal = contrib ? contrib(u) : 0;
      const under = cy + 0.01 >= yPx;
      let rgb = GRID;
      if (under) {
        const fade = ridgeFade((cy - yPx) / Math.max(1, bottom - yPx));
        const yCon = bottom - (Math.max(0, cVal) / ymax) * plot.h;
        if (cVal > 0 && cy + 0.01 >= yCon) {
          const fb = ridgeFade((cy - yCon) / Math.max(1, bottom - yCon));
          rgb = mix(BLUE, fb);
        } else {
          rgb = mix(WHITE, fade);
        }
      }
      stamp(data, width, height, cx, cy, r2, rgb);
    }
  }
}

/**
 * Raw multi-channel dot fill, for the performance comparison only.
 * Each lane is filled from its own baseline up to the sample. This is the
 * treatment the lab recommends NOT using on clinical traces; it exists so
 * the frame cost can be measured.
 */
export function paintRawDotLanes(data, width, height, { channels, pitch, radius }) {
  data.fill(0);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG[0]; data[i + 1] = BG[1]; data[i + 2] = BG[2]; data[i + 3] = 255;
  }
  const n = channels.length || 1;
  const laneH = height / n;
  const r2 = radius * radius;
  for (let c = 0; c < n; c++) {
    const src = channels[c];
    const len = src.length || 1;
    const top = c * laneH;
    const base = top + laneH * 0.5;
    let peak = 1e-6;
    const step = Math.max(1, Math.floor(len / (width / pitch)));
    for (let i = 0; i < len; i += step) {
      const a = Math.abs(src[i]);
      if (a > peak) peak = a;
    }
    const amp = (laneH * 0.42) / peak;
    for (let cx = pitch * 0.5; cx < width; cx += pitch) {
      const i = Math.min(len - 1, Math.floor((cx / width) * len));
      const yTrace = base - src[i] * amp;
      const yLo = Math.min(base, yTrace);
      const yHi = Math.max(base, yTrace);
      for (let cy = top + pitch * 0.5; cy < top + laneH; cy += pitch) {
        let rgb = GRID;
        if (cy >= yLo && cy <= yHi) {
          const fade = ridgeFade(Math.abs(cy - yTrace) / Math.max(1, Math.abs(base - yTrace)));
          rgb = mix(WHITE, fade);
        }
        stamp(data, width, height, cx, cy, r2, rgb);
      }
    }
  }
}

export function summarize(samples) {
  if (!samples.length) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

export function bench(frames, paint) {
  const samples = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    paint();
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}
