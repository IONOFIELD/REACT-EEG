# AUDIT — Live Acquire (PiEEG / pieeg-server) · v19 re-verification

**Date:** 2026-07-05 · **Target:** v19.0 (`src/version.js:40`) · **Prior audit:** `AUDIT-live-acquire.md` (v18.5)
**Scope:** consume the vendor `pieeg-server` stream, render it live for verification, capture raw
sessions to EDF that load through REACT's existing import path. Acquire role only.
**Method:** static read of current v19 `src/` + vendor server under
`C:/Users/III/Desktop/CODE PROJECTS/PiEEG-server-main-extract/PiEEG-server-main/`. Read-only; no fixes.
Citations are `path:line`.

> Bottom line: **the v18.5 gaps are closed.** The wire protocol now MATCHES pieeg-server, the
> capture→EDF→save→library path is wired for the pieeg-server source end-to-end, and every
> "must change" phase (2–5) from the prior audit has landed. There is no "v19 lazy/windowed EDF
> loading" work in this tree — that feature does not exist here, so it has **no impact** on the
> live-capture save path (see §Changes / Q3).

> 🔀 **FORK UPDATE (2026-07-05) — reconciled against the user's fork `IONOFIELD/PiEEG-server`.**
> This audit was written against the locally extracted vendor server (v0.45.0). The user's fork
> carries additional device work on branch **`fix/spi-register-readback`** (2 commits, +2602
> lines, **not merged to `main`**): (1) `fix(hardware)` — reliable ADS1299 SPI RREG/WREG register
> access; (2) `feat:` **Pi-authoritative recorder** — a crash-safe journal (`journal.py`, `.eegj`)
> plus **BDF+ 24-bit (default, lossless) / EDF+ 16-bit (fallback)** export (`edf_export.py`),
> exposed to REACT as new HTTP endpoints: `GET /api/recordings`,
> `GET /download/bdf|edf|journal?session=<base>` (+ a unified `GET /download?format=bdf|edf`), with
> path-traversal guards on the session id.
>
> **Impact on this audit's verdict:**
> - ✅ **The streaming wire protocol is UNCHANGED** — the `{t,n,channels}` sample frame and
>   `{status:"connected"}` welcome are untouched (the branch's only `server.py` additions are the
>   new download routes). The **MATCHED** verdict in §Protocol comparison still holds; the fork
>   only *adds* pull-based download endpoints alongside the existing WS stream.
> - ⚠️ **NEW integration finding — the recorder's default output is incompatible with REACT's
>   parser.** It defaults to **BDF+ 24-bit**, but REACT's EDF parser *rejects BDF* (`0xFF` magic
>   byte, `App.jsx:1512`). To consume Pi-authoritative recordings, REACT must either request the
>   **EDF+ 16-bit** fallback (`/download/edf`) or add BDF+ 24-bit parse support. This Pi-side
>   recorder is the clean fix for the durability gaps in §Remaining gaps (in-memory-only capture,
>   ~2 h cap, lossy 16-bit) and warrants its own integration task.

---

## Changes since v18.5

| v18.5 finding | v19 status | Evidence |
|---|---|---|
| Wire protocol MISMATCHED — decoder had no `{t,n,channels}` branch | **FIXED** | New `decodePieegMessage` + `normalizePieegWelcome` in `src/live-stream.js:149-192`; wired at `App.jsx:10461-10507` |
| Default URL wrong (`ws://localhost:8765` vs `1616`) | **FIXED** | pieeg-server device entries default `bridgeUrl:"ws://localhost:1616"` (`App.jsx:1409-1410`); connect uses it (`:10522`) |
| Streaming filter not implemented | **FIXED** | `makeCascadeState` / `applyBiquadCascadeStateful` / `createStreamingFilter` in `dsp.js:150,159,188`; used per-channel in `allocLiveBuffers` (`App.jsx:10387`) and `appendSamples` (`:10415`) |
| Per-channel verification panel missing | **FIXED** | New `src/live-metrics.js` (`acPower`, `mainsRatio`, `classifyChannel`, `channelQuality` `:14-70`); panel gated at `App.jsx:10931` |
| Version stamp not in EDF bytes | **FIXED** | `buildEDFFile` extracted to `src/edf.js` with a `versionStamp` arg → reserved offset 192 (`edf.js:12,26`); stopRecording passes it (`App.jsx:10686`) |
| Gaps counted but not reconciled into capture | **FIXED** | `n`-gap → capped zero-fill into the capture timeline (`App.jsx:10496-10501`) |
| `mock` not refused | **FIXED** | Welcome surfaces `mock` (`live-stream.js:164`); client refuses + banners + closes (`App.jsx:10467-10473`) |
| No `sourceType` provenance | **FIXED** | SCHEMA v16.0 added `sourceType`/`nonClinical` (`version.js:24-25`); stamped `sourceType:"pieeg"`, `nonClinical:true` (`App.jsx:10718-10720`) |
| `buildEDFFile` lived in App.jsx | **CHANGED** | Now imported from `./edf.js` (`App.jsx:35`); `parseEDFFile` still in App.jsx (`:1503`) |
| Auto-reconnect / connection state missing | **FIXED** | Capped-backoff reconnect + visible `connectionState` (`App.jsx:10542-10562`) |

Version bumped correctly: `APP_VERSION="v19.0"`, `SCHEMA_VERSION="v16.0"` (`version.js:40-42`); v19 CHANGELOG entry present (`App.jsx:82-87`).

---

## 0. Headline findings (v19)

1. **The live-acquire path is now COMPLETE for pieeg-server**, not ~70%. A distinct
   pieeg-server decoder, per-sample drop detection, streaming display filter, per-channel
   verification metrics, raw-µV capture, version-stamped EDF, and provenance-tagged library
   record are all present and wired.
2. **The wire protocol MATCHES the vendor server** — verified against the server source, not
   just the README. See §Protocol comparison.
3. **The pieeg-server decoder is kept SEPARATE from the legacy bridge decoder.** `decodeMessage`
   (`hello`+frame-major/Float32, `live-stream.js:101-130`) is untouched and still used by the
   `protocol:"websocket"` path (`App.jsx:10566+`); the pieeg-server path uses the new
   `decodePieegMessage` (`:10461`). Coexistence, as the prior audit recommended.
4. **No lazy/windowed EDF loader exists in this tree.** `parseEDFFile` is fully eager
   (`App.jsx:1503-1611+`) and the save path parses the whole captured buffer back synchronously
   (`:10688`). The live-capture save path is therefore unaffected by any windowing work.

---

## Protocol comparison — decoder vs current vendor server ★

### Vendor server (ground truth), read from source

Source: `PiEEG-server-main/pieeg_server/server.py`.

- **Module docstring pins the exact frames** (`server.py:4-16`):
  - data frame: `{"t": 1711234567.123456, "n": 42, "channels": [ch1, ..., ch16]}`
  - welcome: `{"status": "connected", "sample_rate": 250, "channels": 16}`
  - client commands: `{"cmd":"set_filter","enabled":…}`, `{"cmd":"set_notch","enabled":…}`
- **Welcome sent automatically on connect** (`server.py:244-260`), with the extra fields the
  client relies on: `filter` (`:249`), `notch_filter` (`:250`), `notch_freq` (`:251`),
  `mock` (`:252` ← `self._acq._mock`), plus `engine`/`lsl_status`/`spike_config`/`hampel_config`
  and `record_status` (`:253-259`).
- **Server filters ON BY DEFAULT** — `enable_filter()` called unconditionally in `__init__`
  with the comment "filter on by default" (`server.py:66`). The broadcast loop applies the
  bandpass/notch to each frame before sending (`server.py:451-458`). So a default run streams
  **filtered** data and `welcome.filter === true`. Notch is off unless enabled.
- **Broadcast is one JSON object per queued frame** (`server.py:442-484`): `payload =
  json.dumps(frame)` where `frame` carries `t`/`n`/`channels` — confirms **one-sample-per-frame**.
- **`set_filter`/`set_notch` handlers exist and honor `enabled:false`** (`server.py:283-298`
  for filter, `:299-319` for notch) → the client CAN force raw.

### REACT decoder (current)

`decodePieegMessage` (`live-stream.js:174-192`):
- welcome iff `status === "connected"` → `normalizePieegWelcome` (`:187`)
- sample iff `typeof n === "number" && Array.isArray(channels)` → `{kind:"samples",
  rows:[channels], n, t}` (`:188-189`)
- everything else (record_status, lsl_status, spike_config, …) → `{kind:"ignore"}` (`:191`)
- `normalizePieegWelcome` (`:149-167`) adopts `sample_rate`+`channels`, sets `uvScale:1`
  (already µV, `:160`), surfaces `filter`/`notchFilter`/`notchFreq`/`mock` (`:162-164`),
  `impedanceSupported:false` (`:165`).

### Verdict: **MATCHED.** 

Every field the decoder keys on is present in the vendor source at the cited lines. Proof by
field:

| Decoder expectation | Vendor source | Match |
|---|---|---|
| welcome `status:"connected"` (`live-stream.js:187`) | `server.py:246` | ✓ |
| welcome `sample_rate` (`:155`) | `server.py:247` | ✓ |
| welcome `channels` (`:151`) | `server.py:248` | ✓ |
| welcome `filter` (`:162`) | `server.py:249` | ✓ |
| welcome `notch_filter` / `notch_freq` (`:163`) | `server.py:250-251` | ✓ |
| welcome `mock` (`:164`) | `server.py:252` | ✓ |
| sample `{t,n,channels}` (`:188-189`) | `server.py:6`, broadcast `:484` | ✓ |
| `set_filter{enabled:false}` accepted (`App.jsx:10485`) | `server.py:283,296-297` | ✓ |
| `set_notch{enabled:false}` accepted (`App.jsx:10486`) | `server.py:299,317-318` | ✓ |

Note: pieeg-server sends **no channel labels**; REACT synthesizes `Ch1..ChN`
(`live-stream.js:154`) and the Acquire tab overrides with `PIEEG_CHANNEL_MAP` when the count
is known (`App.jsx:10476-10477`). Correct handling of a real server behavior.

---

## Plumbing inventory (current, all confirmed)

| Concern | Location | Notes |
|---|---|---|
| Device entries | `App.jsx:1409-1410` | `pieeg-8`/`pieeg-16`, `protocol:"pieeg-server"`, `bridgeUrl:"ws://localhost:1616"` |
| Connect | `App.jsx:10511-10564` | pieeg-server branch `:10520-10563`; 4 s open timeout `:10537`; auto-reconnect `:10542-10562` |
| Welcome handling | `App.jsx:10463-10489` | mock refuse `:10467-10473`; adopt SR/ch `:10478`; force raw via `set_filter/set_notch` `:10484-10486` |
| Sample handling | `App.jsx:10490-10505` | per-sample `n` gap via `gapBatches` `:10492`; capped zero-fill `:10496-10501`; `appendSamples` `:10504` |
| Buffers | `App.jsx:10381-10389` | raw capture `liveBufRef`, raw preview ring `liveViewRef`, **filtered** ring `liveFiltViewRef`, per-ch `createStreamingFilter` |
| Append | `App.jsx:10391-10421` | capture is RAW & recording-gated `:10404`; filtered ring display-only `:10412-10419`; cap guard `:10397-10401` |
| Live filter rebuild on setting change | `App.jsx:10425-10429` | fresh coeffs + delay state on hpf/lpf/notch change |
| Streaming filter (DSP) | `dsp.js:150,159,188-199` | `makeCascadeState` / `applyBiquadCascadeStateful` / `createStreamingFilter`; additive to golden filters |
| Verification metrics | `live-metrics.js:14-70` | `acPower`, `goertzelPower`, `mainsRatio`, `classifyChannel` (live/flatline/noisy), `channelQuality` |
| Verification panel | `App.jsx:10931` | gated on pieeg-server/websocket + `liveVerifyOn` + connected |
| Impedance honesty | `App.jsx:10480,10833` | `impedanceSupported=false`; button shows "not available" rather than fabricating |
| EDF writer | `src/edf.js:26` | extracted from App.jsx; `versionStamp` → reserved offset 192 (`edf.js:12`) |
| EDF reader | `App.jsx:1503` | fully eager; ignores reserved field |
| Capture → save | `App.jsx:10651-10731` | see §Capture path below |
| Decoder unit tests | `test/live-stream.test.js:162-238` | welcome, `{t,n,channels}`, UTF-8 binary, status-message ignore, `n`-gap |

---

## Capture path: live → EDF → save → library (traced)

`stopRecording` (`App.jsx:10651-10731`):
1. Guard: needs `subjectId` and ≥1 s elapsed (`:10654`).
2. Selects the live buffer when the protocol is pieeg-server/websocket AND real samples streamed
   (`isLiveProto`+`hasLive`, `:10664-10665`). `channelData = liveBuf.data.map(Float32Array.from)`
   (`:10669`), `sr = liveBuf.sr` (`:10670`). Falls back to a flat/zero EDF otherwise (`:10671-10675`).
3. `buildEDFFile({… versionStamp:`REACT ${PIPELINE_VERSION} ${SCHEMA_VERSION}` })` (`:10679-10687`)
   → writes provenance to reserved offset 192 (`edf.js:12`), survives the de-id scrub.
4. `parseEDFFile(edfBuffer)` (`:10688`) — parses the freshly written bytes back (round-trip).
5. On success: `setEdfFileStore` + `saveEdfToDB(acqFile, edfBuffer)` (`:10691-10693`) — the same
   persistence + de-id header scrub path any imported EDF takes.
6. Library record created (`:10698-10731`) with `isAcquired:true` (`:10715`),
   `sourceType:"pieeg"` / `nonClinical:true` for pieeg-server (`:10718-10719`), non-diagnostic
   note (`:10720`), and `pipelineVersion`/`schemaVersion` (`:10724-10725`).

**No breakage found.** The path is coherent and flows through the normal import/de-id pipeline.

### Minor observations (not breakage)

- **`recordDurationSec: 1` is hardcoded** (`App.jsx:10683`). `buildEDFFile` then produces
  `numRecords = ceil(totalSamples / (sr·1))` (`edf.js:29-30`) — one record per second. Correct,
  but note a long capture creates many records; fine for EDF, and `parseEDFFile` reads them all.
- **Capture is memory-bound, not lazy.** `liveBufRef.data` is plain append-only JS arrays
  (`App.jsx:10404`); the 2 h cap (`MAX_LIVE_REC_SEC`, guard at `:10397-10401`) is the only bound.
  At 250 Hz × 16 ch × 2 h ≈ 29 M floats — large but capped. No windowing/streaming write.
- **Zero-fill fallback for a no-data session persists** (`:10671-10675`) — still writes a flat
  EDF when nothing streamed. Honest placeholder; v19 now surfaces it in the Library as a red
  no-data flag (CHANGELOG `App.jsx:86`), which mitigates the prior audit's concern.

---

## v19 "lazy/windowed EDF loading" — impact on the save path

**No such loader exists in this tree.** A full-tree search for lazy/windowed EDF byte-loading
(`lazy`, `loadWindow`, `readWindow`, `WindowedEDF`, `streamEdf`, `chunkedParse`, `byteRange`,
`edfWindow`) returns only the **display/epoch** window (guard-banded epoch rendering,
`App.jsx:104,1687,370`) and the `recordDurationSec` EDF-record parameter — not a demand-paged
reader. `parseEDFFile` allocates every channel's full `Float32Array` up front
(`App.jsx:1584`) and decodes every record eagerly (`:1588-1611`).

**Consequence:** the live-capture save path (`stopRecording` → `buildEDFFile` → `parseEDFFile`
→ `saveEdfToDB`) is entirely eager and self-contained; there is **no interaction** with any
windowed loader because none is present. If windowed loading is added later, the write side
(`edf.js`) and the synchronous re-parse in `stopRecording` (`:10688`) would need re-checking,
but as of v19 there is nothing to reconcile.

---

## Tests — do they reflect the real protocol?

`test/live-stream.test.js:162-238` — **YES, matches the vendor source:**
- `normalizePieegWelcome` block (`:163-189`): adopts `sample_rate`+`channels`, synthesizes
  `Ch1..N`, `uvScale===1`, `impedanceSupported===false`, surfaces `filter`/`notch_filter`/
  `mock`/`notch_freq` — all keyed on the real welcome fields (`server.py:247-252`).
- `decodePieegMessage` block (`:191-238`): decodes the welcome (`:192-197`), flags mock
  (`:198-202`), decodes a `{t,n,channels}` frame carrying `n`+`t` (`:203-209`), decodes a
  UTF-8 **binary** payload (`:210-216`), and ignores the exact non-sample status messages the
  server broadcasts — `record_status`, `lsl_status`, `spike_config`, `hampel_config` — plus
  malformed frames (missing `n`, missing `channels`, non-numeric `n`) (`:217-232`).
- Per-sample `n` drop detection reuses `gapBatches` and is tested (`:233-237`).

The status-message names in the ignore test correspond to real server broadcasts
(`server.py:484` samples; record/lsl/spike/hampel status objects elsewhere in server.py).
Coverage is faithful. One small gap: no test asserts the client actually **sends**
`set_filter{enabled:false}` on a `filter:true` welcome — that logic lives in `App.jsx:10485`
(untested React wiring), but the decode contract it depends on is covered.

---

## Remaining gaps (v19)

All are minor / by-design; none block the acquire role.

1. **`recordDurationSec:1` hardcoded** (`App.jsx:10683`) — fine, but not derived from the
   stream; a note only.
2. **No EDF+ TAL annotation for gaps** — dropouts are zero-filled into the timeline
   (`App.jsx:10500`, honest, capped at 2 s) but not additionally marked as an annotated interval.
   The prior audit's "zero-fill AND/OR TAL" — the zero-fill half shipped, the TAL half did not.
3. **`set_filter`-off is fire-and-forget** — the client sends `set_filter{enabled:false}` on a
   filtered welcome (`App.jsx:10485`) but does not re-read a later status to CONFIRM the server
   went raw before allowing capture; it trusts the command. Low risk (server honors it,
   `server.py:296-297`) but not verified in-band.
4. **Auth path untested/unwired** — `?token=` auth exists server-side (`server.py:235-239`);
   REACT connects tokenless, correct for the loopback appliance, but LAN `--auth` is unhandled.
5. **Capture is fully in-memory** (no windowed/streamed write); bounded only by the 2 h cap.
