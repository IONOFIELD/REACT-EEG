# REACT EEG — Live Acquisition Bridge

REACT records live EEG by connecting (Acquire tab → a `websocket` device like **piEEG**) to a
small local **bridge** that reads the hardware and streams it over WebSocket. This folder holds
the protocol and two bridge implementations.

| File | What it is |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | The wire format (handshake + sample/impedance frames). Single source of truth. |
| [`mock-bridge.mjs`](mock-bridge.mjs) | **Node, zero-deps.** Replays a real `.edf` so the whole live path works with no hardware. |
| [`pieeg_bridge.py`](pieeg_bridge.py) | **Python.** Real piEEG/BrainFlow board, plus `--synthetic` and `--replay` modes. |

The browser side never assumes anything: it adopts the bridge's `hello` (sample rate, channel
count, labels, units). Frame parsing lives in [`../src/live-stream.js`](../src/live-stream.js)
and is unit-tested in [`../test/live-stream.test.js`](../test/live-stream.test.js).

## Try it now (no hardware)

```bash
# Terminal 1 — stream a real seed EDF over the protocol:
node bridge/mock-bridge.mjs --channels 16 --edf public/seed-edfs/S001R01-eyes-open.edf

# Terminal 2 — run the app, open the Acquire tab, pick "piEEG-16", set the bridge URL to
# ws://localhost:8765, and click CONNECT. You'll see the live trace + impedance; Record → Stop
# writes a real EDF you can open in Review.
```

Or with Python (synthetic, needs only Python 3):

```bash
python bridge/pieeg_bridge.py --synthetic --channels 16 --rate 250
python bridge/pieeg_bridge.py --replay public/seed-edfs/S001R01-eyes-open.edf
```

## On the Raspberry Pi (real piEEG) — for when the hardware arrives

```bash
pip install brainflow
python bridge/pieeg_bridge.py --board pieeg --serial-port /dev/spidev0.0 --channels 16
```

See **PIEEG NOTES** at the bottom of `pieeg_bridge.py` for the things to verify on-device:
the BrainFlow board id (`BoardIds.PIEEG_BOARD`), SPI transport, µV-vs-counts units, channel
order, and swapping the synthetic impedance for a real lead-off read.

## Status

- Protocol, Node mock, and the browser client are **verified end-to-end** against the real
  PhysioNet seed EDFs (connect → adopt hello → live trace → record → EDF).
- **Impedance is shown only when genuinely measured.** The mock and the current Python bridge
  declare `impedanceSupported: false` and send no value; REACT shows "not available" rather
  than an estimate. The real piEEG ADS1299 lead-off read is what turns this on.
- The Python bridge's `--synthetic` / `--replay` modes are protocol-correct (the WebSocket
  framing mirrors the tested Node mock); smoke-test them on a machine with Python, then verify
  the `--board` path on the Pi.
- Deferred to the hardware phase: auto-reconnect with backoff and IDB-chunked buffering for
  multi-hour sessions (today a single recording is capped at 2 h to bound memory).
