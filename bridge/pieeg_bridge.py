#!/usr/bin/env python3
# ══════════════════════════════════════════════════════════════
# REACT EEG — piEEG live-acquisition bridge  (Python)
# ══════════════════════════════════════════════════════════════
# Reads a piEEG / BrainFlow board (or a synthetic/replay source) and streams it to the REACT
# browser over the WebSocket bridge protocol (see bridge/PROTOCOL.md). It speaks the exact
# same frames as the Node mock (bridge/mock-bridge.mjs), which is validated end-to-end in the
# app's test suite — so the browser client is identical for mock and real hardware.
#
# Modes (pick one source):
#   --synthetic                 generate band-limited fake EEG (no deps, for wiring/dev)
#   --replay  path/to/file.edf  loop a real .edf (no deps; great for demos)
#   --board   pieeg|<id>        read a real board via BrainFlow (pip install brainflow)
#
# Examples:
#   python bridge/pieeg_bridge.py --synthetic --channels 16 --rate 250
#   python bridge/pieeg_bridge.py --replay public/seed-edfs/S001R01-eyes-open.edf
#   python bridge/pieeg_bridge.py --board pieeg --serial-port /dev/spidev0.0
#
# The WebSocket server is implemented with the standard library only (socket + threading +
# hashlib + struct), so synthetic/replay need NOTHING installed. Only --board pulls in
# brainflow, and only when used.
#
# Status: synthetic + replay are runnable and protocol-correct today. The --board path is
# written against BrainFlow's API and is the piece to verify on the Pi (see PIEEG NOTES).

import argparse, base64, hashlib, json, math, socket, struct, threading, time
from pathlib import Path

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# piEEG default electrode order (16ch HAT) — overridable with --labels.
PIEEG16 = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "P3", "P4",
           "O1", "O2", "F7", "F8", "T3", "T4", "T5", "T6"]


# ── minimal EDF reader (returns channels in µV) ──
def parse_edf(path, max_ch):
    b = Path(path).read_bytes()
    s = lambda o, l: b[o:o + l].decode("ascii", "replace").strip()
    num_records = int(s(236, 8)); rec_dur = float(s(244, 8)); ns = int(s(252, 4))
    p = 256
    labels = [s(p + i * 16, 16).rstrip(".") for i in range(ns)]; p += ns * 16
    p += ns * 80; p += ns * 8
    pmin = [float(s(p + i * 8, 8)) for i in range(ns)]; p += ns * 8
    pmax = [float(s(p + i * 8, 8)) for i in range(ns)]; p += ns * 8
    dmin = [float(s(p + i * 8, 8)) for i in range(ns)]; p += ns * 8
    dmax = [float(s(p + i * 8, 8)) for i in range(ns)]; p += ns * 8
    p += ns * 80
    nsamp = [int(s(p + i * 8, 8)) for i in range(ns)]; p += ns * 8
    p += ns * 32
    data_start = p; rec_samps = sum(nsamp)
    keep = [c for c in range(ns) if "annotation" not in labels[c].lower()][:max_ch]
    sr = nsamp[keep[0]] / rec_dur
    chans = []
    for c in keep:
        out = [0.0] * (num_records * nsamp[c]); oi = 0
        scale = (pmax[c] - pmin[c]) / (dmax[c] - dmin[c])
        for r in range(num_records):
            off = data_start + r * rec_samps * 2
            for k in range(c):
                off += nsamp[k] * 2
            for i in range(nsamp[c]):
                d = struct.unpack_from("<h", b, off + i * 2)[0]
                out[oi] = (d - dmin[c]) * scale + pmin[c]; oi += 1
        chans.append(out)
    return [labels[c] for c in keep], sr, chans


# ── sample sources: each yields successive frames (one value per channel) ──
class SyntheticSource:
    """Band-limited fake EEG: a per-channel alpha sinusoid + pink-ish noise, in µV."""
    def __init__(self, labels, sr):
        self.labels, self.sr, self.n = labels, sr, 0
    def frame(self):
        t = self.n / self.sr; self.n += 1
        row = []
        for i in range(len(self.labels)):
            alpha = 18 * math.sin(2 * math.pi * (9 + i * 0.1) * t)
            noise = 6 * math.sin(2 * math.pi * (23 + i) * t + i) + 4 * math.sin(2 * math.pi * (1.5 + i * 0.05) * t)
            row.append(alpha + noise)
        return row


class ReplaySource:
    """Loop a parsed EDF, frame by frame."""
    def __init__(self, chans):
        self.chans, self.total, self.pos = chans, len(chans[0]), 0
    def frame(self):
        idx = self.pos % self.total; self.pos += 1
        return [c[idx] for c in self.chans]


class BoardSource:
    """Real BrainFlow board (e.g. piEEG). Pulls buffered samples and emits them frame-major."""
    def __init__(self, board_id, serial_port, labels):
        from brainflow.board_shim import BoardShim, BrainFlowInputParams  # lazy import
        self.BoardShim = BoardShim
        params = BrainFlowInputParams()
        if serial_port:
            params.serial_port = serial_port
        self.board = BoardShim(board_id, params)
        self.board.prepare_session()
        self.board.start_stream()
        self.eeg_rows = BoardShim.get_eeg_channels(board_id)[:len(labels)]
        self._pending = []
    def frame(self):
        if not self._pending:
            data = self.board.get_board_data()           # shape: [channels][samples]
            if data is not None and len(data) and len(data[0]):
                cols = len(data[0])
                # BrainFlow EEG is already in µV for most boards; verify per board (see notes).
                self._pending = [[data[ch][j] for ch in self.eeg_rows] for j in range(cols)]
        return self._pending.pop(0) if self._pending else None
    def close(self):
        try:
            self.board.stop_stream(); self.board.release_session()
        except Exception:
            pass


# ── tiny WebSocket framing (RFC 6455), stdlib only ──
def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()

def encode_frame(payload: bytes, opcode: int) -> bytes:
    n = len(payload)
    if n < 126:
        hdr = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        hdr = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        hdr = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return hdr + payload

def send_text(sock, s):
    try: sock.sendall(encode_frame(s.encode("utf8"), 0x1))
    except OSError: pass

def send_binary(sock, data: bytes):
    try: sock.sendall(encode_frame(data, 0x2))
    except OSError: pass

def read_client_frames(buf: bytearray):
    """Pull complete (masked) client frames out of buf; returns list[(opcode, payload)]."""
    msgs, off = [], 0
    while off + 2 <= len(buf):
        b0, b1 = buf[off], buf[off + 1]
        opcode = b0 & 0x0F; masked = (b1 & 0x80) != 0; ln = b1 & 0x7F; p = off + 2
        if ln == 126:
            if p + 2 > len(buf): break
            ln = struct.unpack_from("!H", buf, p)[0]; p += 2
        elif ln == 127:
            if p + 8 > len(buf): break
            ln = struct.unpack_from("!Q", buf, p)[0]; p += 8
        mask = b"\0\0\0\0"
        if masked:
            if p + 4 > len(buf): break
            mask = buf[p:p + 4]; p += 4
        if p + ln > len(buf): break
        payload = bytearray(buf[p:p + ln])
        if masked:
            for i in range(ln): payload[i] ^= mask[i & 3]
        msgs.append((opcode, bytes(payload))); off = p + ln
    del buf[:off]
    return msgs


def read_impedances(labels):
    """Real per-channel impedance in kΩ, or None if this source can't measure it.

    Synthetic/replay sources have no electrodes, so they return None and the bridge declares
    impedanceSupported:false — REACT then shows "not available" rather than a fabricated value.
    For a real piEEG board, implement the ADS1299 lead-off / impedance read here and return the
    measured kΩ list (and set IMPEDANCE_SUPPORTED below to True)."""
    return None


def serve_client(sock, labels, sr, source, device, binary, close_source, impedance_supported):
    buf = bytearray()
    # handshake
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk: sock.close(); return
        buf += chunk
    req = bytes(buf).decode("latin1"); buf.clear()
    key = ""
    for line in req.split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Accept: " + ws_accept(key) + "\r\n\r\n").encode())
    print("[pieeg-bridge] client connected")

    hello = {"type": "hello", "protocol": 1, "device": device, "sampleRate": sr,
             "channels": len(labels), "labels": labels, "units": "uV", "gain": 1.0,
             "impedanceSupported": bool(impedance_supported)}
    send_text(sock, json.dumps(hello))
    if impedance_supported:
        vals = read_impedances(labels)
        if vals is not None:
            send_text(sock, json.dumps({"type": "impedance", "values": vals}))

    stop = threading.Event()
    n = len(labels)
    batch = max(1, round(sr * 0.05))           # ~20 messages/sec
    interval = batch / sr

    def stream():
        seq = 0; next_t = time.perf_counter()
        while not stop.is_set():
            rows = []
            for _ in range(batch):
                fr = source.frame()
                if fr is None: break
                rows.append(fr)
            if rows:
                if binary:
                    flat = bytearray()
                    for r in rows:
                        for c in range(n): flat += struct.pack("<f", float(r[c]))
                    send_binary(sock, bytes(flat))
                else:
                    send_text(sock, json.dumps({"type": "samples", "seq": seq,
                              "data": [[round(v, 2) for v in r] for r in rows]}))
                    seq += 1
            next_t += interval
            time.sleep(max(0, next_t - time.perf_counter()))

    t = threading.Thread(target=stream, daemon=True); t.start()
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk: break
            buf += chunk
            for opcode, payload in read_client_frames(buf):
                if opcode == 0x8: raise ConnectionError      # close
                if opcode == 0x9: sock.sendall(encode_frame(payload, 0xA)); continue  # ping→pong
                if opcode == 0x1:
                    try: msg = json.loads(payload.decode("utf8"))
                    except ValueError: continue
                    cmd = msg.get("cmd")
                    if cmd == "impedance":
                        vals = read_impedances(labels) if impedance_supported else None
                        if vals is not None:
                            send_text(sock, json.dumps({"type": "impedance", "values": vals}))
                    elif cmd == "hello": send_text(sock, json.dumps(hello))
    except (OSError, ConnectionError):
        pass
    finally:
        stop.set()
        if close_source: close_source()
        try: sock.close()
        except OSError: pass
        print("[pieeg-bridge] client disconnected")


def main():
    ap = argparse.ArgumentParser(description="REACT EEG piEEG WebSocket bridge")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--channels", type=int, default=16)
    ap.add_argument("--rate", type=float, default=None, help="sample rate override (Hz)")
    ap.add_argument("--labels", default=None, help="comma-separated electrode labels")
    ap.add_argument("--binary", action="store_true", help="stream Float32 binary frames")
    ap.add_argument("--device", default=None)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--synthetic", action="store_true")
    src.add_argument("--replay", metavar="EDF")
    src.add_argument("--board", metavar="pieeg|<brainflow-id>")
    ap.add_argument("--serial-port", default=None, help="board serial/SPI port (BrainFlow)")
    args = ap.parse_args()

    close_source = None
    if args.replay:
        labels, sr, chans = parse_edf(args.replay, args.channels)
        if args.rate: sr = args.rate
        source = ReplaySource(chans)
        device = args.device or f"EDF replay ({Path(args.replay).name})"
    elif args.board:
        # Resolve the BrainFlow board id. piEEG → BoardIds.PIEEG_BOARD when available.
        from brainflow.board_shim import BoardIds
        if args.board.lower() == "pieeg":
            board_id = getattr(BoardIds, "PIEEG_BOARD", None)
            if board_id is None:
                raise SystemExit("This BrainFlow build has no PIEEG_BOARD; pass a numeric --board id "
                                 "or update brainflow. See PIEEG NOTES in this file.")
            board_id = int(board_id)
        else:
            board_id = int(args.board)
        labels = (args.labels.split(",") if args.labels else PIEEG16)[:args.channels]
        from brainflow.board_shim import BoardShim
        sr = args.rate or BoardShim.get_sampling_rate(board_id)
        source = BoardSource(board_id, args.serial_port, labels)
        close_source = source.close
        device = args.device or f"piEEG (BrainFlow {board_id})"
    else:  # synthetic default
        labels = (args.labels.split(",") if args.labels else PIEEG16)[:args.channels]
        sr = args.rate or 250.0
        source = SyntheticSource(labels, sr)
        device = args.device or "piEEG (synthetic)"

    # No source measures impedance yet (synthetic/replay can't; the real board needs the
    # ADS1299 lead-off read implemented in read_impedances). Set True only once that lands —
    # the bridge will not emit a fabricated value, and REACT shows "not available" until then.
    impedance_supported = False

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", args.port)); srv.listen(1)
    print(f"[pieeg-bridge] {device}: {len(labels)} ch @ {sr:g} Hz "
          f"({'binary' if args.binary else 'JSON'} frames)")
    print(f"[pieeg-bridge] labels: {', '.join(labels)}")
    print(f"[pieeg-bridge] listening on ws://localhost:{args.port}")
    try:
        while True:
            sock, _ = srv.accept()
            # one client at a time (a single board) — handle inline
            serve_client(sock, labels, sr, source, device, args.binary, close_source, impedance_supported)
    except KeyboardInterrupt:
        print("\n[pieeg-bridge] shutting down")
    finally:
        srv.close()


# ── PIEEG NOTES (verify on the Raspberry Pi) ───────────────────────────────────────────────
# • Install: `pip install brainflow`. piEEG ships a BrainFlow integration; confirm your
#   brainflow version exposes BoardIds.PIEEG_BOARD (else pass the numeric id with --board).
# • Transport: the piEEG HAT talks over SPI on the Pi. Pass the device node via --serial-port
#   if your BrainFlow build expects one; otherwise BrainFlowInputParams defaults may suffice.
# • Units: most BrainFlow EEG channels are already µV — if your board returns ADC counts,
#   set the bridge to scale (or send units/gain in `hello`); REACT normalises to µV on ingest.
# • Impedance: this bridge sends NO impedance (impedanceSupported:false) — REACT shows "not
#   available" rather than a guess. To enable it, implement the ADS1299 lead-off / impedance
#   read in read_impedances() and set impedance_supported = True. Return real kΩ per channel.
# • Channel order: --labels must match the board's channel order so REACT's montages line up.
if __name__ == "__main__":
    main()
