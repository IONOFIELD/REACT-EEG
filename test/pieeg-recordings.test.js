// Contract tests for the PiEEG recording-download client (pure URL + response helpers).
// These pin the wire contract against pieeg_server/server.py (/api/recordings, /download/edf)
// so the import path can be trusted without a live device.
import { describe, it, expect } from "vitest";
import { httpBaseFromWs, recordingsUrl, downloadUrl, parseRecordings } from "../src/pieeg-recordings.js";

describe("httpBaseFromWs (WS bridge URL → HTTP origin for the download API)", () => {
  it("maps ws→http and wss→https, keeping host:port", () => {
    expect(httpBaseFromWs("ws://10.0.0.47:1616")).toBe("http://10.0.0.47:1616");
    expect(httpBaseFromWs("wss://pi.local:1616")).toBe("https://pi.local:1616");
  });
  it("passes http/https through and strips any path/query/trailing slash", () => {
    expect(httpBaseFromWs("http://10.0.0.47:1616/")).toBe("http://10.0.0.47:1616");
    expect(httpBaseFromWs("ws://10.0.0.47:1616/stream?x=1")).toBe("http://10.0.0.47:1616");
  });
  it("accepts a bare host[:port] (defaults to http)", () => {
    expect(httpBaseFromWs("10.0.0.47:1616")).toBe("http://10.0.0.47:1616");
  });
  it("returns '' for empty / unusable input", () => {
    expect(httpBaseFromWs("")).toBe("");
    expect(httpBaseFromWs(null)).toBe("");
    expect(httpBaseFromWs("   ")).toBe("");
  });
});

describe("recordingsUrl / downloadUrl", () => {
  it("builds the /api/recordings URL, tolerating a trailing slash on the base", () => {
    expect(recordingsUrl("http://10.0.0.47:1616")).toBe("http://10.0.0.47:1616/api/recordings");
    expect(recordingsUrl("http://10.0.0.47:1616/")).toBe("http://10.0.0.47:1616/api/recordings");
  });
  it("defaults to EDF and URL-encodes the session", () => {
    expect(downloadUrl("http://10.0.0.47:1616", "sess 01")).toBe(
      "http://10.0.0.47:1616/download/edf?session=sess%2001");
  });
  it("supports bdf/journal and falls back to edf on an unknown format", () => {
    expect(downloadUrl("http://h:1", "s", "bdf")).toBe("http://h:1/download/bdf?session=s");
    expect(downloadUrl("http://h:1", "s", "journal")).toBe("http://h:1/download/journal?session=s");
    expect(downloadUrl("http://h:1", "s", "exe")).toBe("http://h:1/download/edf?session=s");
  });
});

describe("parseRecordings (/api/recordings normalization)", () => {
  it("normalizes sessions and reads hasEdf from either legacy flag or formats block", () => {
    const json = { recordings: [
      { session: "20260705-A", has_edf: true, has_bdf: true, journal_bytes: 12345, has_sidecar: true },
      { session: "20260705-B", formats: { edf: { present: true }, bdf: { present: false } } },
    ] };
    const out = parseRecordings(json);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ session: "20260705-A", hasEdf: true, hasBdf: true, hasSidecar: true, journalBytes: 12345 });
    expect(out[1].session).toBe("20260705-B");
    expect(out[1].hasEdf).toBe(true);   // from formats.edf.present
    expect(out[1].hasBdf).toBe(false);
    expect(out[1].journalBytes).toBe(0); // missing → 0
  });
  it("drops entries without a string session name", () => {
    const out = parseRecordings({ recordings: [{ journal_bytes: 5 }, { session: 42 }, { session: "ok" }] });
    expect(out.map(r => r.session)).toEqual(["ok"]);
  });
  it("returns [] for a missing/malformed payload", () => {
    expect(parseRecordings(null)).toEqual([]);
    expect(parseRecordings({})).toEqual([]);
    expect(parseRecordings({ recordings: "nope" })).toEqual([]);
  });
});
