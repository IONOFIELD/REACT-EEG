import { describe, it, expect } from "vitest";
import {
  LIVE_PROTOCOL, impedanceStatus, unitToMicrovolts, normalizeHello,
  decodeImpedance, deinterleave, scaleRows, gapBatches, decodeMessage,
  normalizePieegWelcome, decodePieegMessage, normalizePieegLeadoff, normalizePieegContactState,
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

// ── pieeg-server protocol (vendor Raspberry-Pi server) ──
describe("normalizePieegWelcome", () => {
  const welcome = {
    status: "connected", sample_rate: 250, channels: 8,
    filter: true, notch_filter: false, notch_freq: 60.0, mock: false,
  };
  it("adopts sample_rate + channels and synthesizes labels (server sends none)", () => {
    const c = normalizePieegWelcome(welcome);
    expect(c.protocol).toBe("pieeg-server");
    expect(c.sampleRate).toBe(250);
    expect(c.channels).toBe(8);
    expect(c.labels).toEqual(["Ch1", "Ch2", "Ch3", "Ch4", "Ch5", "Ch6", "Ch7", "Ch8"]);
    expect(c.uvScale).toBe(1);            // already µV
    expect(c.impedanceSupported).toBe(false);
  });
  it("surfaces server filter / notch / mock state", () => {
    expect(normalizePieegWelcome(welcome).filter).toBe(true);        // server filters by default
    expect(normalizePieegWelcome(welcome).notchFilter).toBe(false);
    expect(normalizePieegWelcome({ ...welcome, mock: true }).mock).toBe(true);
    expect(normalizePieegWelcome(welcome).mock).toBe(false);
    expect(normalizePieegWelcome(welcome).notchFreq).toBe(60);
  });
  it("defaults sample_rate to 250 and channels to 0 when absent", () => {
    const c = normalizePieegWelcome({ status: "connected" });
    expect(c.sampleRate).toBe(250);
    expect(c.channels).toBe(0);
  });
});

describe("decodePieegMessage", () => {
  it("decodes the welcome frame", () => {
    const r = decodePieegMessage(JSON.stringify({ status: "connected", sample_rate: 250, channels: 16, mock: false }));
    expect(r.kind).toBe("welcome");
    expect(r.config.channels).toBe(16);
    expect(r.config.mock).toBe(false);
  });
  it("also treats the kiosk/demo hello ({type:'hello'}) as a welcome, adopting rate + channels", () => {
    // ws_server.py (kiosk) and demo_stream.py (hardened) send {type:'hello',sample_rate,channels}
    // instead of {status:'connected'}; adopt it the same way so sr/channels come from the stream.
    const r = decodePieegMessage(JSON.stringify({ type: "hello", sample_rate: 250, decimate: 1, effective_rate: 250, channels: 8, mode: "wifi" }));
    expect(r.kind).toBe("welcome");
    expect(r.config.sampleRate).toBe(250);
    expect(r.config.channels).toBe(8);
    expect(r.config.mock).toBe(false);   // no mock field in the demo hello → not refused
  });
  it("flags mock mode via the welcome so the client can refuse it", () => {
    const r = decodePieegMessage(JSON.stringify({ status: "connected", channels: 8, mock: true }));
    expect(r.kind).toBe("welcome");
    expect(r.config.mock).toBe(true);
  });
  // The hardened demo (demo_stream.py --mock) now advertises its synthetic mode in the
  // {type:'hello'} welcome; REACT must honor that flag the same way it honors the vendor's.
  it("honors mock:true carried by the {type:'hello'} demo welcome (refusable synthetic stream)", () => {
    const r = decodePieegMessage(JSON.stringify({ type: "hello", sample_rate: 250, channels: 8, mock: true }));
    expect(r.kind).toBe("welcome");
    expect(r.config.mock).toBe(true);
  });
  it("treats a {type:'hello'} welcome with no mock field as real hardware (mock:false)", () => {
    const r = decodePieegMessage(JSON.stringify({ type: "hello", sample_rate: 250, channels: 8 }));
    expect(r.kind).toBe("welcome");
    expect(r.config.mock).toBe(false);
  });
  it("does NOT accept a stringy 'true' as the mock flag — the Pi contract is a JSON boolean", () => {
    // Strict `mock === true` guard: a truthy string must neither fabricate a mock refusal nor
    // (were the sense inverted) downgrade a real one. Only a JSON boolean true refuses a stream.
    const r = decodePieegMessage(JSON.stringify({ type: "hello", sample_rate: 250, channels: 8, mock: "true" }));
    expect(r.kind).toBe("welcome");
    expect(r.config.mock).toBe(false);
  });
  it("decodes a per-sample {t,n,channels} frame into a single-row batch, carrying n", () => {
    const r = decodePieegMessage(JSON.stringify({ t: 1711234567.123, n: 42, channels: [1.5, -2.5, 3] }));
    expect(r.kind).toBe("samples");
    expect(r.rows).toEqual([[1.5, -2.5, 3]]);
    expect(r.n).toBe(42);
    expect(r.t).toBe(1711234567.123);
  });
  it("also decodes a frame delivered as a UTF-8 binary payload", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ t: 1, n: 7, channels: [4, 5] }));
    const r = decodePieegMessage(bytes.buffer);
    expect(r.kind).toBe("samples");
    expect(r.rows).toEqual([[4, 5]]);
    expect(r.n).toBe(7);
  });
  it("ignores the server's other status messages and malformed frames", () => {
    for (const m of [
      { record_status: { recording: false } },
      { lsl_status: { running: false } },
      { spike_config: { threshold: 1 } },
      { hampel_config: {} },
      { t: 1, channels: [1, 2] },          // missing n
      { n: 5 },                             // missing channels
      { n: "5", channels: [1] },           // n not a number
    ]) {
      expect(decodePieegMessage(JSON.stringify(m)).kind).toBe("ignore");
    }
    expect(decodePieegMessage("{bad json").kind).toBe("ignore");
    expect(decodePieegMessage(null).kind).toBe("ignore");
    expect(decodePieegMessage(42).kind).toBe("ignore");
  });
  it("per-sample drop detection uses gapBatches on the monotonic n", () => {
    expect(gapBatches(41, 42)).toBe(0);   // in order
    expect(gapBatches(41, 45)).toBe(3);   // 42,43,44 dropped
    expect(gapBatches(41, 41)).toBe(0);   // duplicate / restart
  });
});

// ── pieeg lead-off / electrode-contact detection (ADS1299 LOFF) ──
describe("normalizePieegLeadoff", () => {
  it("maps [{ch,off}] to a 0-indexed boolean array (ch is 1-based)", () => {
    expect(normalizePieegLeadoff([{ ch: 1, off: true }, { ch: 2, off: false }])).toEqual([true, false]);
  });
  it("handles sparse + unordered channels, filling gaps with false", () => {
    expect(normalizePieegLeadoff([{ ch: 3, off: true }, { ch: 1, off: false }])).toEqual([false, false, true]);
  });
  it("treats off strictly (only boolean true = off) and skips junk / out-of-range entries", () => {
    // "true"/1 are NOT off — an electrode is only reported off on a real boolean true.
    expect(normalizePieegLeadoff([{ ch: 1, off: "true" }, { ch: 2, off: 1 }, { ch: 3, off: true }])).toEqual([false, false, true]);
    expect(normalizePieegLeadoff([{ off: true }, null, { ch: 0, off: true }, { ch: 2, off: true }])).toEqual([false, true]);
  });
  it("returns [] for a non-array", () => {
    for (const x of [null, undefined, {}, "leadoff", 5]) expect(normalizePieegLeadoff(x)).toEqual([]);
  });
});

describe("decodePieegMessage — lead-off + contact detection", () => {
  it("decodes a {status:'leadoff'} frame to a per-channel off array + timestamp", () => {
    const r = decodePieegMessage(JSON.stringify({ status: "leadoff", channels: [{ ch: 1, off: true }, { ch: 2, off: false }], ts: 1711234567.5 }));
    expect(r.kind).toBe("leadoff");
    expect(r.off).toEqual([true, false]);
    expect(r.t).toBe(1711234567.5);
  });
  it("a lead-off frame has no numeric n → is never mistaken for a sample batch (ts absent → t null)", () => {
    const r = decodePieegMessage(JSON.stringify({ status: "leadoff", channels: [{ ch: 1, off: false }] }));
    expect(r.kind).toBe("leadoff");
    expect(r.t).toBe(null);
  });
  it("a malformed lead-off frame (no / non-array channels) is ignored, not decoded", () => {
    expect(decodePieegMessage(JSON.stringify({ status: "leadoff" })).kind).toBe("ignore");
    expect(decodePieegMessage(JSON.stringify({ status: "leadoff", channels: "nope" })).kind).toBe("ignore");
  });
  it("welcome advertises contact detection only when impedance_supported === true (strict boolean)", () => {
    expect(decodePieegMessage(JSON.stringify({ status: "connected", channels: 8, impedance_supported: true })).config.impedanceSupported).toBe(true);
    expect(decodePieegMessage(JSON.stringify({ status: "connected", channels: 8 })).config.impedanceSupported).toBe(false);
    expect(decodePieegMessage(JSON.stringify({ status: "connected", channels: 8, impedance_supported: "true" })).config.impedanceSupported).toBe(false);
  });
  it("decodes the green/amber/red contact state alongside the off flags", () => {
    const r = decodePieegMessage(JSON.stringify({ status: "leadoff", channels: [{ ch: 1, off: false, state: "green" }, { ch: 2, off: true, state: "red" }], ts: 100 }));
    expect(r.kind).toBe("leadoff");
    expect(r.off).toEqual([false, true]);
    expect(r.state).toEqual(["green", "red"]);
  });
});

describe("normalizePieegContactState", () => {
  it("maps the green/amber/red verdict per channel (0-indexed, ch 1-based)", () => {
    expect(normalizePieegContactState([{ ch: 1, state: "green" }, { ch: 2, state: "amber" }, { ch: 3, state: "red" }]))
      .toEqual(["green", "amber", "red"]);
  });
  it("nulls unknown / missing state and fills gaps with null", () => {
    expect(normalizePieegContactState([{ ch: 2, state: "red" }, { ch: 1 }, { ch: 3, state: "bogus" }]))
      .toEqual([null, "red", null]);
  });
  it("returns [] for a non-array (older servers omit state entirely)", () => {
    for (const x of [undefined, null, "red", 3]) expect(normalizePieegContactState(x)).toEqual([]);
  });
});
