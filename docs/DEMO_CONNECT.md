# Laptop demo runbook — connecting REACT EEG to the Pi's hardened stream

This is the **laptop side** of the demo. The Pi side (cert + token generation, starting the stream)
is in the PiEEG-server repo: `docs/DEMO_STREAM.md`. The Pi serves an **encrypted, token-gated**
WebSocket at **`wss://192.168.77.1:1621`** (wired Ethernet demo) or `wss://<pi-wifi-ip>:1621`
(Wi-Fi fallback).

REACT connects to it with the **exact same** live path it already uses — the only additions are
(1) it sends the shared token as the first message, and (2) it speaks `wss` (TLS). The EDF recorder
and frame parser are unchanged.

---

## One-time laptop setup

### 1. Trust the Pi's certificate (self-signed)
Browsers/WebView **forbid** bypassing TLS validation from JavaScript — the supported way to trust a
self-signed cert is to import it into the **Windows trust store**. WebView2 (the Tauri/desktop
runtime), Edge, and Chrome all use this store.

1. Copy **`demo-cert.pem`** from the Pi (the certificate only — *never* the `.pem` key):
   `scp pi@192.168.77.1:~/PiEEG-server/certs/demo/demo-cert.pem .`  (or via USB).
2. Import it as a **Trusted Root** for your user:
   - **GUI:** double-click `demo-cert.pem` → *Install Certificate* → *Current User* → *Place all
     certificates in the following store* → **Trusted Root Certification Authorities** → Finish.
   - **or PowerShell/cmd:** `certutil -addstore -user Root demo-cert.pem`
3. The cert lists the exact IPs it's valid for (`192.168.77.1` + the Pi's Wi-Fi IP). You must dial
   an IP that's in the cert. If it changed, re-run `gen_demo_cert.sh` on the Pi and re-copy.

> Firefox keeps its own trust store — if you demo in Firefox, import the cert there too. The
> `REACT EEG` desktop shortcut uses WebView2/Chrome, which use the Windows store above.

### 2. Drop in the shared token
The token is a **secret**. Put it in a gitignored file the app reads at runtime — it is never
committed, never baked into the build, never placed in the URL, and never logged.

1. Get the token from the Pi (`config/demo_token`) over a **private channel** (same `scp`, USB).
2. Create the file **`public/pieeg-demo-token`** in this REACT-EEG folder and paste the token as its
   only contents (no quotes, no newline needed). `.gitignore` already excludes it.

### 3. (Ethernet demo only) set the wired IP
For the point-to-point cable link, set the laptop's **wired** adapter to a static IP:
`192.168.77.2`, mask `255.255.255.0`, **no gateway**. (Wi-Fi mode needs nothing here.)

---

## Connecting (demo day)

1. Start REACT EEG (the desktop shortcut) and open the **Record** tab.
2. In **Input Source**, pick **“piEEG (Pi HAT, 8ch)”**. *(This matters — see the note below.)*
3. In the device **bridge URL** field, enter `wss://192.168.77.1:1621`
   (or `wss://<pi-wifi-ip>:1621` in Wi-Fi mode).
4. Click **Connect**. The app sends the token, the Pi replies with its hello, and the live trace
   starts. Record as usual — the EDF is written exactly as for any live capture.

### If it won't connect
- **“authentication failed (4401)”** → the token is missing or wrong. Check `public/pieeg-demo-token`
  against the Pi's `config/demo_token`.
- **“stream busy (4409)”** → another client is already connected (the demo allows one at a time).
- **Browser/console “certificate verify failed” / connection refused on `wss`** → the cert isn't
  trusted or doesn't list the IP you dialed. Re-do step 1, and confirm the Pi regenerated the cert
  for the current IP.
- **“no token configured”** toast → you skipped step 2.

---

## ⚠️ Known review item — select the 8-channel device

The hardened demo sends its handshake as `{"type":"hello", …}` (the kiosk/`ws_server` shape). REACT's
pieeg parser recognizes the **vendor** welcome `{"status":"connected", …}` and therefore **ignores**
the demo's `type:"hello"` — so it does **not** adopt the stream's declared sample-rate/channel-count
from that message. Instead it uses the values pre-set when you pick the device: **“piEEG (Pi HAT,
8ch)” pre-sets 8 channels @ 250 Hz, which matches the demo stream**, so the recording is correct.

**Do not pick the 16-channel entry for this demo** — the counts would disagree and the EDF would be
mis-shaped. Adopting the `type:"hello"` welcome directly is a small, additive parser change we have
intentionally **not** made without review (it must not disturb the working recorder). The data
frames themselves (`{"type":"frame","seq","n","t","channels"}`) are handled unchanged — REACT reads
`n` and the µV `channels` as before.

---

## Security notes
- TLS validation is **never** weakened in app code; trust is established only via the OS store import.
- The token is sent only over `wss`, only as the first WebSocket message, and only from
  `public/pieeg-demo-token` (gitignored) — not in source, the bundle, the URL, or any log.
- The plaintext localhost kiosk (`ws://…:1616`) and the legacy bridge path are unchanged.
