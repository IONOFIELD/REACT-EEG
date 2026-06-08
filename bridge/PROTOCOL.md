# REACT EEG — Live Acquisition Bridge Protocol

**Version: 1**

The browser cannot talk to a Raspberry Pi HAT / BrainFlow board directly, so a small
local **bridge** process (Python/BrainFlow, or the Node mock in this folder) reads the
device and streams frames to REACT over a **WebSocket**.

- **Server** = the bridge (`ws://localhost:8765` by default)
- **Client** = the REACT browser app (Acquire tab → device `protocol: "websocket"`)

The wire format is intentionally tiny: JSON text frames for control/metadata/low-rate
data, plus an optional raw `Float32` binary frame for high-rate sample streaming. The
single source of truth for parsing on the client is [`src/live-stream.js`](../src/live-stream.js),
which is unit-tested in [`test/live-stream.test.js`](../test/live-stream.test.js).

---

## Handshake

On connection the bridge **MUST** send a `hello` frame immediately (the client also
sends `{"cmd":"hello"}` on open in case the bridge waits to be asked). The client adopts
the `hello` values — it does **not** assume sample rate, channel count, or labels.

### `hello` (bridge → client, once)

```json
{
  "type": "hello",
  "protocol": 1,
  "device": "piEEG-16",
  "sampleRate": 250,
  "channels": 16,
  "labels": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6"],
  "units": "uV",
  "gain": 1.0,
  "impedanceSupported": true
}
```

| field | meaning |
|---|---|
| `protocol` | protocol version (this doc = `1`). Client warns on mismatch. |
| `device` | human label for the source. |
| `sampleRate` | Hz. Written verbatim into the recorded EDF. |
| `channels` | channel count. Must equal `labels.length`. |
| `labels` | electrode names, in the **same order** as every sample row. |
| `units` | physical unit of the sample values. `"uV"` (default) or `"V"`/`"mV"` (scaled to µV on ingest). |
| `gain` | multiplier applied to raw values to reach `units` (use when the board streams ADC counts). Default `1.0`. |
| `impedanceSupported` | whether `{"cmd":"impedance"}` will yield real values. |

If `channels` / `labels` are missing the client falls back to the device catalog's
`PIEEG_CHANNEL_MAP`, but a conformant bridge always provides them.

---

## Sample streaming (bridge → client)

The bridge streams continuously once connected. The client only **records** samples to
the EDF while a recording is active (Record button); otherwise frames drive the live
preview and are discarded.

### `samples` (JSON, frame-major)

```json
{ "type": "samples", "seq": 42, "data": [[c0,c1,…,cN], [c0,c1,…,cN], …] }
```

- `data` is an array of **time-frames**; each inner array holds one sample per channel,
  in `labels` order.
- `seq` (optional, recommended) is a monotonically increasing **batch counter**. The
  client uses it only to detect dropped batches and log a gap — it never reorders.

### Binary samples (high rate)

A raw `Float32Array` (little-endian) frame, **channel-interleaved**:

```
[ f0_c0, f0_c1, … f0_cN,  f1_c0, f1_c1, … f1_cN,  … ]
```

The client deinterleaves using `channels` from `hello`. Use this path above a few
hundred Hz to avoid JSON overhead. (Binary frames carry no `seq`.)

All sample values are interpreted as `units` after multiplying by `gain`, then converted
to µV for the EDF.

---

## Impedance

### `impedance` (bridge → client)

```json
{ "type": "impedance", "values": [4.2, 5.1, 6.0, …] }
```

- `values` are **real measured kΩ per channel**, in `labels` order.
- Status thresholds (client side): `≤ 5 kΩ` good · `≤ 10 kΩ` fair · `> 10 kΩ` poor.

**Honesty rule:** REACT only ever displays a *measured* impedance. A bridge that cannot
measure it MUST set `impedanceSupported: false` in `hello` and send no `impedance` frame —
the client then shows "not available" and never fabricates a value. The client requests a
measurement with `{"cmd":"impedance"}` only when `impedanceSupported` is true (after the
handshake) and when the Impedance check is opened.

---

## Client → bridge commands

| command | effect |
|---|---|
| `{"cmd":"hello"}` | request the `hello` frame (sent automatically on open). |
| `{"cmd":"impedance"}` | run/report a per-channel impedance measurement. |
| `{"cmd":"start"}` | (optional) tell the bridge to begin streaming, if it gates on this. |
| `{"cmd":"stop"}` | (optional) pause streaming. |

A bridge MAY stream regardless of `start`/`stop`; the client is robust to both.

---

## Reference implementations

- **`mock-bridge.mjs`** (Node, zero-dependency) — replays a real `.edf` over this
  protocol so the whole live path is testable with no hardware:
  `node bridge/mock-bridge.mjs --edf public/seed-edfs/S001R01-eyes-open.edf`
- **`pieeg_bridge.py`** (Python/BrainFlow) — the real device bridge, with `--synthetic`
  and `--replay file.edf` modes for development and a documented piEEG board path for
  on-hardware use.
