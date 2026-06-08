import { describe, it, expect } from "vitest";
import {
  LIVE_PROTOCOL, impedanceStatus, unitToMicrovolts, normalizeHello,
  decodeImpedance, deinterleave, scaleRows, gapBatches, decodeMessage,
} from "../src/live-stream.js";

describe("impedanceStatus", () => {
  it("applies the 5/10 kΩ thresholds", () => {
    expect(impedanceStatus(0)).toBe("good");
    expect(impedanceStatus(5)).toBe("good");
    expect(impedanceStatus(5.1)).toBe("fair");
    expect(impedanceStatus(10)).toBe("fair");
    expect(impedanceStatus(10.1)).toBe("poor");
    expect(impedanceStatus(-1)).toBe("poor");   // invalid → poor, never silently "good"
  });
});

describe("unitToMicrovolts", () => {
  it("scales V/mV/uV to microvolts", () => {
    expect(unitToMicrovolts("V")).toBe(1e6);
    expect(unitToMicrovolts("mV")).toBe(1e3);
    expect(unitToMicrovolts("uV")).toBe(1);
    expect(unitToMicrovolts("µV")).toBe(1);
    expect(unitToMicrovolts(undefined)).toBe(1); // default already-µV
    expect(unitToMicrovolts("weird")).toBe(1);
  });
});

describe("normalizeHello", () => {
  it("adopts provided fields and derives uvScale", () => {
    const c = normalizeHello({ type: "hello", protocol: 1, device: "piEEG-16", sampleRate: 250,
      channels: 2, labels: ["Fp1", "Fp2"], units: "uV", gain: 1, impedanceSupported: true });
    expect(c.sampleRate).toBe(250);
    expect(c.channels).toBe(2);
    expect(c.labels).toEqual(["Fp1", "Fp2"]);
    expect(c.uvScale).toBe(1);
    expect(c.impedanceSupported).toBe(true);
  });
  it("treats labels as authoritative when channels disagree", () => {
    const c = normalizeHello({ channels: 5, labels: ["A", "B", "C"] });
    expect(c.channels).toBe(3);
    expect(c.labels).toEqual(["A", "B", "C"]);
  });
  it("synthesizes labels when only channels given", () => {
    const c = normalizeHello({ channels: 3 });
    expect(c.labels).toEqual(["Ch1", "Ch2", "Ch3"]);
  });
  it("defaults sane values and combines unit+gain into uvScale", () => {
    const c = normalizeHello({ channels: 1, units: "mV", gain: 2 });
    expect(c.sampleRate).toBe(250);
    expect(c.protocol).toBe(1);
    expect(c.uvScale).toBe(2000); // mV(×1000) × gain(2)
    expect(c.impedanceSupported).toBe(true); // only false when explicitly false
    expect(normalizeHello({ impedanceSupported: false }).impedanceSupported).toBe(false);
  });
});

describe("decodeImpedance", () => {
  it("rounds to 0.1 kΩ, names by label, and statuses", () => {
    const imp = decodeImpedance([4.23, 7.99, 12.5], ["Fp1", "Fp2", "C3"]);
    expect(imp).toEqual([
      { name: "Fp1", value: 4.2, status: "good" },
      { name: "Fp2", value: 8.0, status: "fair" },
      { name: "C3", value: 12.5, status: "poor" },
    ]);
  });
  it("falls back to Ch<n> when labels missing", () => {
    expect(decodeImpedance([3], [])[0].name).toBe("Ch1");
  });
});

describe("deinterleave", () => {
  it("splits channel-interleaved flat data into frame rows", () => {
    expect(deinterleave([1, 2, 3, 4, 5, 6], 2)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
  it("drops a trailing partial frame", () => {
    expect(deinterleave([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("scaleRows", () => {
  it("is a no-op at scale 1 (same reference)", () => {
    const rows = [[1, 2]];
    expect(scaleRows(rows, 1)).toBe(rows);
  });
  it("multiplies every value by the µV scale", () => {
    expect(scaleRows([[1, -2], [3, 4]], 1000)).toEqual([[1000, -2000], [3000, 4000]]);
  });
});

describe("gapBatches", () => {
  it("returns 0 for in-order, unknown, or restart; positive for drops", () => {
    expect(gapBatches(10, 11)).toBe(0);
    expect(gapBatches(10, 14)).toBe(3);     // 11,12,13 missed
    expect(gapBatches(undefined, 5)).toBe(0);
    expect(gapBatches(10, 10)).toBe(0);     // duplicate/restart, not a gap
    expect(gapBatches(10, 4)).toBe(0);      // backward restart
  });
});

describe("decodeMessage", () => {
  const ctx = { channels: 2, labels: ["Fp1", "Fp2"], uvScale: 1 };

  it("decodes a hello frame", () => {
    const r = decodeMessage(JSON.stringify({ type: "hello", channels: 2, labels: ["Fp1", "Fp2"], sampleRate: 250 }), {});
    expect(r.kind).toBe("hello");
    expect(r.config.channels).toBe(2);
    expect(r.config.sampleRate).toBe(250);
  });

  it("decodes JSON samples with seq", () => {
    const r = decodeMessage(JSON.stringify({ type: "samples", seq: 7, data: [[1, 2], [3, 4]] }), ctx);
    expect(r.kind).toBe("samples");
    expect(r.rows).toEqual([[1, 2], [3, 4]]);
    expect(r.seq).toBe(7);
  });

  it("scales JSON samples to µV when uvScale set", () => {
    const r = decodeMessage(JSON.stringify({ type: "samples", data: [[1, 2]] }), { ...ctx, uvScale: 1000 });
    expect(r.rows).toEqual([[1000, 2000]]);
    expect(r.seq).toBeNull();
  });

  it("decodes an impedance frame", () => {
    const r = decodeMessage(JSON.stringify({ type: "impedance", values: [4, 11] }), ctx);
    expect(r.kind).toBe("impedance");
    expect(r.impedances).toEqual([
      { name: "Fp1", value: 4, status: "good" },
      { name: "Fp2", value: 11, status: "poor" },
    ]);
  });

  it("decodes binary Float32 (ArrayBuffer), deinterleaved by channels", () => {
    const f = new Float32Array([1, 2, 3, 4]);
    const r = decodeMessage(f.buffer, ctx);
    expect(r.kind).toBe("samples");
    expect(r.rows).toEqual([[1, 2], [3, 4]]);
    expect(r.seq).toBeNull();
  });

  it("decodes binary Float32 from a Node Buffer view", () => {
    const f = new Float32Array([10, 20, 30, 40, 50, 60]);
    const buf = Buffer.from(f.buffer, f.byteOffset, f.byteLength); // shares memory, byteOffset 0
    const r = decodeMessage(buf, { channels: 3, labels: ["a", "b", "c"] });
    expect(r.kind).toBe("samples");
    expect(r.rows).toEqual([[10, 20, 30], [40, 50, 60]]);
  });

  it("ignores bad JSON, unknown types, and empty binary", () => {
    expect(decodeMessage("{not json", ctx).kind).toBe("ignore");
    expect(decodeMessage(JSON.stringify({ type: "whatever" }), ctx).kind).toBe("ignore");
    expect(decodeMessage(new Float32Array([]).buffer, ctx).kind).toBe("ignore");
    expect(decodeMessage(null, ctx).kind).toBe("ignore");
  });

  it("exports the protocol version", () => {
    expect(LIVE_PROTOCOL).toBe(1);
  });
});
