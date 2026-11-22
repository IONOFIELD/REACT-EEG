// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildEDFFile, parseEDFWindow } from "../src/edf.js";
import {
  valueFromClientX, pointerAction, formatClock, DRAG_THRESHOLD_PX,
} from "../src/ui-lab/pointer.js";
import { readEdfAnnotations, eventsFromAnnotations } from "../src/ui-lab/annotations.js";
import { buildTrend, pickChannels, sampleAt } from "../src/ui-lab/series.js";
import { paintDotField, ridgeFade, mix, BLUE, WHITE, GRID } from "../src/ui-lab/dotMatrix.js";

describe("ui lab pointer", () => {
  it("maps the pointer 1:1 onto the time axis", () => {
    expect(valueFromClientX(100, 100, 200, 0, 60)).toBeCloseTo(0);
    expect(valueFromClientX(300, 100, 200, 0, 60)).toBeCloseTo(60);
    expect(valueFromClientX(200, 100, 200, 0, 60)).toBeCloseTo(30);
    // A second reading is the pointer's position, not a step toward it.
    const a = valueFromClientX(150, 100, 200, 0, 60);
    const b = valueFromClientX(250, 100, 200, 0, 60);
    expect(b - a).toBeCloseTo(30);
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
  });

  it("click selects, click-again removes, drag does not remove, locked marks stay", () => {
    const user = { id: "n", locked: false };
    const file = { id: "e", locked: true };
    expect(pointerAction({ marker: user, selectedId: null, moved: false, inLane: true }).type).toBe("select");
    expect(pointerAction({ marker: user, selectedId: "n", moved: false, inLane: true }).type).toBe("remove");
    expect(pointerAction({ marker: user, selectedId: "n", moved: true, inLane: true }).type).toBe("move");
    expect(pointerAction({ marker: null, selectedId: null, moved: false, inLane: true }).type).toBe("add");
    expect(pointerAction({ marker: file, selectedId: "e", moved: false, inLane: true }).type).toBe("select");
    expect(pointerAction({ marker: file, selectedId: "e", moved: true, inLane: true }).type).toBe("none");
    expect(pointerAction({ marker: null, selectedId: null, moved: false, inLane: false }).type).toBe("none");
  });

  it("formats clock times at a fixed width", () => {
    expect(formatClock(0)).toBe("00:00.00");
    expect(formatClock(65.2)).toBe("01:05.20");
    expect(formatClock(65.2).length).toBe(formatClock(5).length);
  });
});

describe("ui lab series", () => {
  it("puts a 10 Hz sine in alpha, above the other bands", () => {
    const sr = 160;
    const n = sr * 6;
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = 40 * Math.sin(2 * Math.PI * 10 * i / sr);
    const edf = parseEDFWindow(buildEDFFile({
      channelLabels: ["O1", "Cz"],
      channelData: [data, data],
      sampleRate: sr,
    }));
    expect(edf.error).toBeUndefined();
    const trend = buildTrend(edf, pickChannels(edf.channelLabels, ["O1"]), { windowSec: 2, hopSec: 1 });
    expect(trend.total.length).toBeGreaterThan(2);
    expect(trend.bands.alpha.length).toBe(trend.total.length);
    const a = trend.bands.alpha[1];
    expect(a).toBeGreaterThan(trend.bands.delta[1]);
    expect(a).toBeGreaterThan(trend.bands.theta[1]);
    expect(a).toBeGreaterThan(trend.bands.beta[1]);
    expect(a).toBeLessThanOrEqual(trend.total[1] + 1e-6);
    const mid = sampleAt(trend.times, trend.total, trend.times[1]);
    expect(mid).toBeCloseTo(trend.total[1]);
  });
});

describe("ui lab annotations", () => {
  it("reads EEGMMIDB T0/T1/T2 marks as locked events", () => {
    const buf = readFileSync(fileURLToPath(new URL("../public/seed-edfs/S010R03-left-right-fist.edf", import.meta.url)));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const events = eventsFromAnnotations(readEdfAnnotations(ab));
    const codes = new Set(events.map((e) => e.code));
    expect(codes.has("T0")).toBe(true);
    expect(codes.has("T1")).toBe(true);
    expect(codes.has("T2")).toBe(true);
    expect(events.every((e) => e.locked && e.source === "edf")).toBe(true);
    expect(events.some((e) => e.code === "T1" && Math.abs(e.dur - 4.1) < 0.05)).toBe(true);
    for (let i = 1; i < events.length; i++) expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
  });
});

describe("ui lab dot field", () => {
  it("fades the ridge from white down to the grid, and paints a selection in blue", () => {
    expect(ridgeFade(0)).toBe(0);
    expect(ridgeFade(1)).toBe(1);
    const top = mix(WHITE, 0);
    const bot = mix(WHITE, 1);
    expect(top).toEqual(WHITE);
    expect(bot).toEqual(GRID);
    expect(mix(BLUE, 0)).toEqual(BLUE);

    const w = 80;
    const h = 60;
    const data = new Uint8ClampedArray(w * h * 4);
    paintDotField(data, w, h, {
      plot: { x: 4, y: 4, w: 72, h: 52 },
      yMax: 1,
      pitch: 4,
      radius: 1.2,
      sample: () => 1,
      contrib: (u) => (u < 0.5 ? 1 : 0),
    });
    const pixel = (x, y) => {
      const o = (y * w + x) * 4;
      return [data[o], data[o + 1], data[o + 2]];
    };
    // Dot centres start half a pitch inside the plot. Left of centre is the selection.
    const left = pixel(6, 6);
    const right = pixel(62, 6);
    const low = pixel(62, 54);
    expect(left[2]).toBeGreaterThan(left[0]); // blue channel leads
    expect(right[0]).toBeGreaterThan(180);    // white ridge
    expect(right[2]).toBeGreaterThan(180);
    const lum = (p) => p[0] + p[1] + p[2];
    expect(lum(right)).toBeGreaterThan(lum(low));
  });
});
