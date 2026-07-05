# REACT EEG — De-identification & Export Audit (v19.0)

**Scope:** HIPAA **Safe Harbor** posture (user-confirmed). Every identifier must be
*removed* (not pseudonymized); dates generalized to year; ages > 89 → "90+".
**Method:** static re-read of the v19 source, verifying every finding of the prior
`AUDIT-deid-export.md` (pinned to v18.5 @ `062dc38`) against current code. Read-only —
**no fixes applied**, no source modified.

> ⚠️ **Which "v19" this audits — read this first.**
> The locally checked-out branch tip (`5a5b796`, "v19.0: sourceType provenance…") is a
> strict **ancestor** of the true v19 line and does **not** contain the windowed-loading
> or F1 work the task asks about. The F1 / windowed-loading commits live on **`origin/main`
> (tip `832d461`)**, 15 commits ahead:
> `41cbbec` lazy load → `92b0461` windowed decode primitive → `1e732b8` F1-S0 →
> `67b962f` F1-S1+S2 windowed loading → **`832d461` F1: surface patientId/recordingId on
> windowed parse**.
> **All `src/App.jsx:line` and `src/edf.js:line` citations below are against `origin/main`
> (`832d461`).** In that tree `src/App.jsx` is **11 822** lines and `src/edf.js` is **227**
> lines. The working-tree files (11 637 / 114 lines) have different line numbers and lack
> the windowed code entirely — do not reconcile the two by line number. The prior audit's
> chokepoint (v18.5 `App.jsx:437`) is now `saveEdfToDB` at **`App.jsx:491`**, scrub at
> **`App.jsx:498`**.

> ✅ **REMEDIATION UPDATE (2026-07-05) — N1 FIXED (post-audit).** After this read-only audit,
> the library-backup export was gated: `handleBackupExport` now runs
> `scanLibraryForPHI(records, clinicalNotesMap, annotationsMap)` — a new pure, null-tolerant
> helper in `src/deid.js` — and shows the same content-aware `window.confirm` as the `.zip` /
> `.reegb` exports before writing (only category names shown, never the raw matched value).
> Covered by `test/deid.test.js` (`scanLibraryForPHI` block, 6 cases). An export-path
> completeness sweep confirmed the library backup was the **only** ungated free-text export, so
> **G4 is now warn-gated on every free-text egress path.** Full suite 205/205; production build
> clean. **N2** (windowed impedance reported "unknown") remains open (LOW). See §7 / N1 below.

---

## 0. Changes since v18.5

The v18.5 audit found the whole de-id story sitting in one 11.6 k-line `App.jsx` with **no**
scrub. v19 refactored de-id into a pure, unit-tested module and closed the central gap:

| Area | v18.5 | v19 |
|---|---|---|
| **De-id logic** | inline in `App.jsx` | extracted to **`src/deid.js`** (pure, golden-vector tested) — `scrubEdfHeader`, `scrubEdfHeaderForFilename`, `generalizeDateToYear`, `capAge`, `scanTextForPHI`, `hashSubjectId`, `parseHashYearFromFilename` |
| **Stored EDF bytes** | raw buffer persisted verbatim | **scrubbed at the `saveEdfToDB` chokepoint** (`App.jsx:498`) before every persist (IndexedDB `App.jsx:506`, and the Tauri filesystem write `App.jsx:501`) |
| **Dates / ages** | full `record.date`, uncapped age | `generalizeDateToYear` + `capAge` at all record-creation sites and all displays/exports |
| **Free-text at export** | notes/annotations exported unscanned | **`scanTextForPHI` gate** on the .zip, .reegb, and annotation-sidecar exports (warn-not-strip) |
| **Import UI copy** | "will NOT be stored" (false) | rewritten to describe the actual scrub (`App.jsx:8581`) |
| **Hash salt** | hardcoded | per-deployment via `VITE_HASH_SALT` → `setHashSalt(import.meta.env.VITE_HASH_SALT)` (`App.jsx:29`) |
| **Loading** *(new)* | whole file parsed into memory | **lazy + windowed** loading for imports > 1 h (`parseEDFHeader` / `parseEDFWindow` in `edf.js`; `ensureEdfLoaded`/`loadWindow` `App.jsx:11315`/`11354`) |
| **F1** *(new)* | — | windowed parse now surfaces `patientId`/`recordingId` so the runtime compliance PHI scan works on windowed files (`edf.js:129`,`171`,`210`) |
| **Library backup** *(new)* | — | whole-library JSON backup export (`buildLibraryBackup`, `App.jsx:7201`) — **new export surface, see N1** |

Net: **G1 is fixed** (scrub chokepoint, both leaking exports read scrubbed bytes). **G5, G3,
G7 fixed; G4 mitigated (warn-gate); G2 partially; G6 still a documented residual.** Two new
v19 observations (N1, N2) below, both LOW/MEDIUM — the windowed-loading design does **not**
open a new persistent PHI leak.

---

## 1. The two EDF provenance classes (unchanged shape; PHI risk now closed at rest)

| Class | How it's made | PHI risk (v19) |
|---|---|---|
| **REACT-generated** (Acquire, seeds) | `buildEDFFile({ patientId: hashSubjectId(subjectId), recordingId: "REACT-<type>" })` — writer `edf.js:26`, call site `App.jsx:10691`/`10700` | **Clean by construction** — header holds only the salted hash + study type. Unchanged. |
| **Imported** (user EDF, package, bundle) | Source bytes → **scrubbed on store** (`saveEdfToDB` → `scrubEdfHeaderForFilename`, `App.jsx:498`) | **Clean at rest** — the raw PHI-bearing header is overwritten (offsets 8/88/168/176) *before* IndexedDB/disk. This is what closes G1. |

---

## 2. CENTRAL GAP — G1: imported EDF headers are never scrubbed → **FIXED**

**Status: FIXED.** `saveEdfToDB` now scrubs before persisting — `App.jsx:491`:

```js
async function saveEdfToDB(filename, arrayBuffer) {
  const scrubbed = scrubEdfHeaderForFilename(arrayBuffer, filename);   // App.jsx:498
  ...
  if (window.__TAURI__) await window.__TAURI__.invoke("save_edf",
      { filename, edfBase64: arrayBufferToBase64(scrubbed) });         // App.jsx:501 (desktop fs)
  tx.objectStore(EDF_DB_STORE).put(scrubbed, filename);                // App.jsx:506 (IndexedDB)
}
```

`scrubEdfHeader` (`deid.js:133`) overwrites every PHI-bearing fixed-offset field on a **copy**
(input never mutated):
- offset **8** (80 B, patient id) → `"<hash> X X X"` — name / MRN / DOB / sex dropped (`deid.js:143`)
- offset **88** (80 B, recording id) → `"Startdate X X X X"` — start date / technician / hospital dropped (`deid.js:144`)
- offset **168** (8 B, start date) → `"01.01.yy"` year-only (`deid.js:145–147`)
- offset **176** (8 B, start time) → `"00.00.00"` (`deid.js:148`)

**Every import path routes through this chokepoint** (verified — no bypass):
seed loader `App.jsx:1902`, package-import `App.jsx:7253`, bundle-import `App.jsx:8320`,
IngestForm `App.jsx:8530`/`8538`, acquire writer `App.jsx:10705`. The **only** raw-EDF-byte
write in the codebase is `App.jsx:506`, and the only Tauri fs write is `App.jsx:501` — both
write `scrubbed`. No other `EDF_DB_STORE.put` or `idbPut` writes raw EDF binary.

**Both formerly-leaking exports are now PHI-free by construction** because they read the
scrubbed bytes back out of IndexedDB via `getEdfRawFromDB` (`App.jsx:511`):
patient-package `.zip` (`App.jsx:738`) and `.reegb` bundle (`App.jsx:8858`).

**Residual on G1 (narrow, LOW):** the date field (offset 168) is only rewritten when a **year**
is recoverable from the filename (`deid.js:145`, guarded by `/^\d{4}$/`). `scrubEdfHeaderForFilename`
derives hash+year from the REACT filename convention (`parseHashYearFromFilename`, `deid.js:119`).
Offsets 8/88/176 are **always** wiped regardless; only offset-168's date survives if a caller
passes a **non-REACT-convention filename** (→ `year=null`). All in-app import paths generate
conforming filenames, and `.reegb` re-imports already carry scrubbed bytes, so this is only
reachable with a hand-crafted bundle whose header still holds PHI *and* whose filename is
non-conforming. Folds into G6 (same "scrub keyed on structure" residual class).

---

## 3. The 18 HIPAA Safe Harbor identifiers — handling (v19)

| # | Identifier | v18.5 | v19 status |
|---|---|---|---|
| 1 | Names | header verbatim (G1) | **Removed at rest** — offset 8/88 scrubbed (`deid.js:143–144`). Free-text names still user's responsibility (regex can't catch names — `deid.js:99`). |
| 3 | Dates (birth/admission/start) | header + full `record.date` survive | **Generalized** — header 168/176 scrubbed; `record.date`→`generalizeDateToYear` at all creation sites (`App.jsx:1926,7276,8474,10717`) and displays/Data-Sheet (`App.jsx:968`,`7662`). |
| 4/6/7/8 | Phone/Email/SSN/MRN | detect-only in header | **Removed at rest** from header; still **detect-and-warn** in free-text before export (`scanTextForPHI`, `deid.js:101`). |
| 13 | Device IDs / serials | recording-id field, verbatim | **Removed at rest** — offset 88 scrubbed. |
| 18 | Other unique id (notes/annotations) | exported unscanned | **Warn-gated** at .zip/.reegb/sidecar export (§4); **not gated** on the new library-backup export (**N1**). |
| — | Ages > 89 | uncapped | **Capped** — `capAge`→90 at creation (`App.jsx:1932,8476,7281`), rendered "90+" by `fmtAge` (`App.jsx:43`). |

Nonstandard placement (signal labels @256+, EDF+ TAL text) — see G6.

---

## 4. Export formats — what each can carry (v19)

| Export | EDF data source | Free-text PHI gate | Verdict |
|---|---|---|---|
| **Patient package `.zip`** (`App.jsx:727`) | `getEdfRawFromDB` → **scrubbed bytes** (`App.jsx:738`) | `scanTextForPHI` on notes + record-notes + annotation labels, `window.confirm` before write (`App.jsx:7845–7864`) | **Header PHI closed (G1).** Free-text warn-gated (G4). |
| **Bundle `.reegb`** (`App.jsx:8858`) | `getEdfRawFromDB` → **scrubbed bytes** | same 3-way `scanTextForPHI` gate (`App.jsx:8842–8856`) | **Header PHI closed (G1).** Free-text warn-gated (G4). |
| **Annotation sidecar (per-file Export)** (`App.jsx:5810`) | none | `scanTextForPHI` on annotation labels, confirm (`App.jsx:5811–5820`) | Clean; free-text warn-gated (G4). |
| **ExportModal JSON manifest** (`buildExportManifest`, `manifests.js:33`) | none (paths only) | n/a — emits `date` (already year-only), no age | Clean. Adds `sourceType`/`nonClinical` (`manifests.js:52`) — non-PHI. |
| **Printable Data Sheet** (`generateDataSheetHTML`, HTML built from `record` + head window `App.jsx:9258`) | parsed content only | date via `generalizeDateToYear`, age via `fmtAge`→"90+" (`App.jsx:968`) | **Clean** (G5 closed for the Data Sheet). |
| **Whole-library backup JSON** *(NEW, `buildLibraryBackup` `manifests.js:105`, handler `App.jsx:7198`)* | **no EDF** (`includesEdf:false`) | **static warning only, NO `scanTextForPHI`** (`App.jsx:7199–7200`) | **New surface — N1.** Notes + annotations embedded **verbatim**. |

Crucially, **no export serializes the in-memory header fields** (`edfData.patientId /
recordingId / startDate / startTime`) into any JSON — verified by search. Those fields exist
only to drive the runtime PHI scan; the sole header-PHI vector was ever the raw bytes, now
scrubbed. So the v18.5 "in-memory only, not serialized" note still holds.

---

## 5. F1 windowed-loading PHI analysis (the core new question)

**Does the F1 compliance PHI scan cover the whole file, or only the loaded window?**

The concern is legitimate in principle (a window holds only part of the file), but in this
design the scan targets are **not** window-limited:

1. **Header identity (offsets 8/88).** The runtime scan reads `edfData.patientId` /
   `edfData.recordingId` (`checkProtocolCompliance`, `App.jsx:1155`). `parseEDFWindow` obtains
   these from `parseEDFHeader`, which reads the **first 256 bytes** (`edf.js:129–130`) — the
   header is **always** fully in memory for **every** window (a window is `header + a slice of
   records`). So the scan sees the complete header regardless of which record-window is loaded.
   This is exactly what F1 (`832d461`) fixed: before it, `parseEDFWindow` omitted these fields
   and the check reported **"unknown"** (never a false *pass*); now it reports **"pass"** on the
   scrubbed values. Confirmed present at `edf.js:171` (header return) and `edf.js:210` (window
   return). **No window-scoped PHI miss in the header scan.**

2. **The header PHI it scans is already scrubbed.** The windowed reader reads the raw blob via
   `getEdfRawFromDB` (`App.jsx:11319`,`11362`), which returns the **scrubbed** bytes (G1). So the
   scan is confirming absence on already-clean data, by design.

3. **File EDF+ TAL annotations are captured at import, not at window-load.** `parseEDFWindow`
   **skips** annotation signals entirely and does **not** extract `edfAnnotations` (`edf.js:200`;
   no `edfAnnotations`/`impedances` produced by the window path — verified). But every **import**
   uses the **full** `parseEDFFile` (`App.jsx:7251`,`8317`,`8451`,`8535`), which *does* extract
   TAL annotations into `annotationsMap` up front. The export gates scan **`annotationsMap`**
   (`App.jsx:7855`,`8849`,`5813`) — not the live window — so **windowing does not shrink the
   annotation PHI scan**. Windowing only defers *signal* decode, never *annotation capture*.

4. **Persistence is scrubbed once, on the full buffer.** The scrub runs at store time on the
   whole `arrayBuffer` (`saveEdfToDB`, `App.jsx:498`), long before any windowing. Windowed
   *reads* never call `saveEdfToDB` and never re-persist — `ensureEdfLoaded`/`loadWindow` are
   read-only (`App.jsx:11315`,`11354`). **Windowed loading introduces no new persistent PHI
   path.**

**Genuine windowing caveat (not a PHI leak) — N2, LOW:** on a windowed load the **impedance**
compliance check reports **"unknown"**, because `parseEDFWindow` doesn't compute impedances
(that logic lives only in `parseEDFFile`; the check falls through to
`record?.impedances`/`acquiredImpedances`, `App.jsx:1125–1127`). Documented in the F1 commit as
accepted ("never a false pass"). Completeness gap, not a disclosure gap.

**Verdict on F1/windowing: no new PHI/export leak.** The one real windowing side-effect (N2) is
a compliance-*completeness* "unknown," which cannot mark a non-compliant file compliant.

---

## 6. Failure modes / residuals (v19)

- **G6 — nonstandard header PHI still uncovered (LOW–MED, open/documented).** The scrub touches
  only offsets 8/88/168/176 (`deid.js:143–148`). PHI in **signal labels / transducer /
  prefiltering** (offset 256+) or inside **EDF+ TAL annotation text** is **not** removed from the
  bytes. TAL/annotation free-text is instead caught by the export **warn-gate** (`scanTextForPHI`),
  not by the byte scrub. Signal-label PHI (e.g. `EEG Fp1 (J.Smith)`) is neither scrubbed nor
  scanned. Also folds in the "non-REACT filename ⇒ offset-168 date survives" edge from §2.
- **G2 — compliance "De-identification verified" is still detect-only (MEDIUM, partial).** It now
  reuses the shared `scanTextForPHI` (6 patterns: SSN/MRN/email/phone/date/long-digit-run,
  `deid.js:103–110`) over header fields **+ `record.notes`** (`App.jsx:1155`), a real improvement
  over v18.5's 4 header-only regexes. But it verifies *pattern-absence*, not that a scrub ran, and
  a plain typed name/address passes. Post-scrub this is low-risk for header PHI; the check remains
  advisory for free-text.
- **Free-text notes persisted verbatim (unchanged).** `STORE_NOTES` holds clinical notes as typed
  (`idbPut(STORE_NOTES, …)`). This is the persistent side of G4; export is warn-gated, but the
  new library-backup export bypasses that gate — **N1**.

---

## 7. Gap status summary (severity)

| ID | Gap | v18.5 sev | **v19 status** | Proof |
|---|---|---|---|---|
| **G1** | Raw EDF header persisted & exported verbatim | Critical | **FIXED** | scrub at `App.jsx:498`, persisted at `:506`/`:501`; exports read scrubbed bytes `App.jsx:738`/`8858`. Narrow offset-168 residual → G6. |
| **G5** | Dates not generalized; ages > 89 not capped | High | **FIXED** | `generalizeDateToYear` + `capAge` at creation (`App.jsx:1926/1932,7276/7281,8474/8476,10717`) and displays (`App.jsx:43,968,7662`). |
| **G4** | Free-text notes/annotations exported unscanned | High | **MITIGATED (warn-gate)** | `scanTextForPHI` confirm-gates on `.zip` (`App.jsx:7845`), `.reegb` (`8842`), sidecar (`5811`). **Not** on library-backup → **N1**. Warn-not-strip by design. |
| **G3** | UI claims header "will NOT be stored" (false) | Medium | **FIXED** | copy rewritten to describe the scrub — `App.jsx:8581`. |
| **G2** | "De-id verified" detect-only, header-only | Medium | **PARTIAL** | broadened to shared `scanTextForPHI` + record-notes (`App.jsx:1155`); still absence-detection, misses names. |
| **G6** | PHI in nonstandard header fields / TAL text | Low–Med | **OPEN (documented)** | scrub limited to 8/88/168/176 (`deid.js:143–148`); labels@256+ & TAL text not byte-scrubbed. |
| **G7** | Hardcoded hash salt | Low | **FIXED** | per-deploy `VITE_HASH_SALT` → `setHashSalt` (`App.jsx:29`, `deid.js:18–20`). |

### New in v19

| ID | Finding | Severity | Proof |
|---|---|---|---|
| **N1** | **Library-backup export skips the free-text PHI scan.** `handleBackupExport` embeds all clinical notes + annotations **verbatim** into a downloadable JSON with only a **static** warning — unlike the .zip/.reegb/sidecar paths, it does **not** call `scanTextForPHI`. (No EDF bytes, so no header-PHI; free-text notes/annotations only.) | **MEDIUM** | `App.jsx:7198–7209`; envelope `buildLibraryBackup` `manifests.js:105–129` (`includesEdf:false`, embeds `notes`/`annotations`). |
| **N2** | **Windowed loads report impedance compliance as "unknown."** `parseEDFWindow` doesn't compute impedances, so the check can't evaluate them on long imports. Completeness gap, **not** a PHI/disclosure leak; cannot cause a false "compliant." | **LOW** | `edf.js` window path emits no `impedances`; check falls through `App.jsx:1125–1127`. Accepted in F1 commit `832d461`. |

**Clean (no de-id action):** REACT-generated EDFs (`edf.js:26`), ExportModal JSON manifest
(paths only, `manifests.js:33`), Data Sheet (`App.jsx:968`), and — for header PHI — the `.zip`
and `.reegb` exports now that they read scrubbed bytes.

---

## 8. Recommended follow-ups (post-review, not applied)

1. **N1** — route `handleBackupExport` through the same `scanTextForPHI` confirm-gate the other
   three exports use (or reuse the .zip gate helper). Highest new-risk item.
2. **G6** — extend the scrub to scan **signal labels** (offset 256+) and add offset-168 date
   handling that doesn't depend on the filename convention; document the residual.
3. **G2** — after-scrub, assert PHI *absence* on the persisted bytes (verify the scrub ran),
   rather than pattern-detecting on possibly-clean fields.
4. **N2** — carry a persisted impedance summary on the record (or compute from the head window)
   so long imports don't degrade to "unknown."

> The v18.5 doc's forward-looking notes (portable `deid.js` from the v16.6 backup, test-gated
> G1) have **landed** — `src/deid.js` + `test/deid.test.js` exist and are the basis for the
> fixes verified above.
