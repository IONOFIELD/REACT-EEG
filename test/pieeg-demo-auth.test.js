// Contract tests for the hardened-demo auth helpers. These pin the EXACT first-message wire format
// against the Pi (pieeg_server/demo_stream.py `_token_ok`, tests/test_demo_stream.py `_auth`): the
// server accepts ONLY {"type":"auth","token":<secret>} and closes 4401 otherwise.
import { describe, it, expect } from "vitest";
import { authMessage, shouldAuthenticate, demoTokenUrl, DEMO_TOKEN_FILE } from "../src/pieeg-demo-auth.js";

describe("authMessage (exact first-message the Pi requires)", () => {
  it("produces {\"type\":\"auth\",\"token\":<token>} — a JSON object, not a bare string", () => {
    expect(authMessage("correct-horse-battery-staple-42")).toBe(
      '{"type":"auth","token":"correct-horse-battery-staple-42"}');
    // round-trips to the shape demo_stream.py._token_ok checks
    const parsed = JSON.parse(authMessage("tok"));
    expect(parsed).toEqual({ type: "auth", token: "tok" });
    expect(parsed.type).toBe("auth");
  });
  it("coerces a missing token to an empty string without throwing", () => {
    expect(authMessage(undefined)).toBe('{"type":"auth","token":""}');
    expect(authMessage(null)).toBe('{"type":"auth","token":""}');
  });
});

describe("shouldAuthenticate (token is sent ONLY over wss)", () => {
  it("true for wss://, false for ws:// and everything else", () => {
    expect(shouldAuthenticate("wss://192.168.77.1:1621")).toBe(true);
    expect(shouldAuthenticate("WSS://pi.local:1621")).toBe(true);   // case-insensitive
    expect(shouldAuthenticate("ws://localhost:1616")).toBe(false);   // kiosk: unchanged, no token
    expect(shouldAuthenticate("http://x")).toBe(false);
    expect(shouldAuthenticate("")).toBe(false);
    expect(shouldAuthenticate(null)).toBe(false);
  });
});

describe("demoTokenUrl (base-relative, gitignored served file)", () => {
  it("respects the app BASE_URL and never embeds the token in the path", () => {
    expect(demoTokenUrl("/REACT-EEG/")).toBe("/REACT-EEG/pieeg-demo-token");
    expect(demoTokenUrl("/REACT-EEG")).toBe("/REACT-EEG/pieeg-demo-token");   // adds the slash
    expect(demoTokenUrl("/")).toBe("/pieeg-demo-token");
    expect(demoTokenUrl(undefined)).toBe("/pieeg-demo-token");
    expect(DEMO_TOKEN_FILE).toBe("pieeg-demo-token");
  });
});
