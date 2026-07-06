// ══════════════════════════════════════════════════════════════
// PiEEG hardened-demo authentication (wss + shared token)
// ══════════════════════════════════════════════════════════════
// The Pi's HARDENED DEMO endpoint (pieeg_server/demo_stream.py, e.g. wss://192.168.77.1:1621)
// requires the client's FIRST WebSocket message to be a JSON auth object. No/wrong token, or a
// malformed first message, and the server closes the socket with code 4401 BEFORE any EEG is sent
// (a full client is also capped — a second viewer is closed with 4409).
//
// EXACT wire format — confirmed against the Pi source, NOT guessed:
//   • pieeg_server/demo_stream.py `_token_ok`  → requires  data["type"] == "auth"  and compares
//     data["token"] with hmac.compare_digest.
//   • tests/test_demo_stream.py `_auth`         → ws.send(json.dumps({"type":"auth","token":token}))
//   • docs/DEMO_STREAM.md                       → same object.
//   ⇒ first message MUST be:  {"type":"auth","token":"<shared secret>"}   (a JSON object, not a
//     bare string).
//
// The token is a SECRET. It is loaded at RUNTIME from a gitignored local file, and is never placed
// in source, the built bundle, the URL query string, or any log line. See docs/DEMO_CONNECT.md.
//
// This module is additive and only used by the pieeg connect path when the URL is wss:// — the
// plaintext localhost kiosk (ws://…:1616) and the legacy bridge are untouched.

// The exact first-message the Pi expects. Pure + unit-tested so this wire format cannot drift.
export function authMessage(token) {
  return JSON.stringify({ type: "auth", token: String(token ?? "") });
}

// The hardened demo is wss-ONLY (the server refuses plaintext); the local kiosk needs no token.
// Gate the token-send on a TLS URL so the kiosk / legacy paths keep their exact current behavior.
export function shouldAuthenticate(url) {
  return /^wss:\/\//i.test(String(url || "").trim());
}

// Where the operator drops the shared token on the LAPTOP: a gitignored file under public/, so vite
// serves it from the app's own origin at runtime and it never enters git, the JS bundle, or a URL.
export const DEMO_TOKEN_FILE = "pieeg-demo-token";

// Build the base-relative URL the token file is served at (respects the app's BASE_URL, e.g.
// "/REACT-EEG/"). Pure + testable.
export function demoTokenUrl(base = "/") {
  const b = String(base || "/");
  return `${b.endsWith("/") ? b : b + "/"}${DEMO_TOKEN_FILE}`;
}

// Load the token at runtime. Returns the trimmed token, or "" if unavailable (the caller then
// surfaces a clear "no token configured" message rather than connecting blind). Never logged here.
//   • Desktop (Tauri): read it from an EXTERNAL file (<Documents>/REACT EEG/demo_token) via the
//     Rust `load_demo_token` command, so the secret is never baked into the .exe bundle.
//   • Browser (dev / preview): fetch the gitignored file served from public/.
export async function loadDemoToken(base = "/") {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    try { return String((await tauri.core.invoke("load_demo_token")) || "").trim(); }
    catch { return ""; }
  }
  try {
    const res = await fetch(demoTokenUrl(base), { cache: "no-store" });
    if (!res.ok) return "";
    return (await res.text()).trim();
  } catch {
    return "";
  }
}
