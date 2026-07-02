// ══════════════════════════════════════════════════════════════
// REACT EEG — EDF writer
// ══════════════════════════════════════════════════════════════
// 16-bit EDF writer, extracted from App.jsx so the round-trip is unit-testable
// (test/edf.test.js) without React/DOM. Behaviour is unchanged except for a new optional
// `versionStamp`, written into the EDF main-header RESERVED field (offset 192, 44 bytes).
// That field is NOT touched by the de-identification header scrub (which only overwrites
// offsets 8/88/168/176, see deid.js), so provenance stamped here survives de-id round-trips —
// unlike recordingId (offset 88), which the scrub wipes. The app's parseEDFFile ignores the
// reserved field, so stamping it never affects normal import.

const EDF_RESERVED_OFFSET = 192;
const EDF_RESERVED_LEN = 44;

/**
 * Build a valid 16-bit EDF ArrayBuffer from per-channel µV data.
 * @param {object} a
 * @param {string[]} a.channelLabels
 * @param {Array<Float32Array|number[]>} a.channelData  one array per channel (equal length)
 * @param {number} a.sampleRate
 * @param {number} [a.recordDurationSec=1]
 * @param {string} [a.patientId]
 * @param {string} [a.recordingId]
 * @param {string} [a.versionStamp]  free-text provenance for the reserved header field (≤44 chars kept)
 */
export function buildEDFFile({ channelLabels, channelData, sampleRate, recordDurationSec = 1, patientId = "", recordingId = "", versionStamp = "" }) {
  const ns = channelLabels.length;
  const totalSamples = channelData[0].length;
  const samplesPerRecord = sampleRate * recordDurationSec;
  const numRecords = Math.ceil(totalSamples / samplesPerRecord);
  const headerBytes = 256 + ns * 256;
  const dataBytes = numRecords * ns * samplesPerRecord * 2;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeStr = (offset, length, str) => {
    const padded = (str || "").padEnd(length).slice(0, length);
    for (let i = 0; i < length; i++) bytes[offset + i] = padded.charCodeAt(i);
  };

  // Main header (256 bytes)
  writeStr(0, 8, "0       ");
  writeStr(8, 80, patientId);
  writeStr(88, 80, recordingId);
  const now = new Date();
  writeStr(168, 8, `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getFullYear()%100).padStart(2,"0")}`);
  writeStr(176, 8, `${String(now.getHours()).padStart(2,"0")}.${String(now.getMinutes()).padStart(2,"0")}.${String(now.getSeconds()).padStart(2,"0")}`);
  writeStr(184, 8, String(headerBytes));
  writeStr(EDF_RESERVED_OFFSET, EDF_RESERVED_LEN, versionStamp); // provenance (survives de-id scrub)
  writeStr(236, 8, String(numRecords));
  writeStr(244, 8, String(recordDurationSec));
  writeStr(252, 4, String(ns));

  // Per-signal headers. physMin/physMax are stored as 8-char ASCII at 0.1 µV precision, and any
  // reader recovers the scale from those STORED values — so we round here and encode with the
  // SAME rounded values, otherwise encoder/decoder scales disagree and the round-trip drifts by
  // up to the 0.1 µV header rounding (≫ the 16-bit LSB). Rounding-collapsed ranges are widened.
  const b = 256;
  const physMins = [], physMaxs = [];
  for (let i = 0; i < ns; i++) {
    let min = Infinity, max = -Infinity;
    const d = channelData[i];
    for (let j = 0; j < d.length; j++) { if (d[j] < min) min = d[j]; if (d[j] > max) max = d[j]; }
    if (min === max) { min -= 1; max += 1; }
    // Round the range OUTWARD to 0.1 µV (floor min, ceil max) so every sample stays inside the
    // stored physical range — rounding to nearest could push the true min/max just outside it,
    // clamping those samples. (1e-9 nudge absorbs float noise like 30.0000000004.)
    let minR = Math.floor((min - 1e-9) * 10) / 10;
    let maxR = Math.ceil((max + 1e-9) * 10) / 10;
    if (maxR <= minR) maxR = minR + 0.1;   // guard: degenerate collapsed range
    physMins.push(minR);
    physMaxs.push(maxR);
  }
  const digMin = -32768, digMax = 32767;

  for (let i = 0; i < ns; i++) writeStr(b + i * 16, 16, channelLabels[i]);          // label
  for (let i = 0; i < ns; i++) writeStr(b + ns*16 + i*80, 80, "");                  // transducer
  for (let i = 0; i < ns; i++) writeStr(b + ns*96 + i*8, 8, "uV");                  // physDim
  for (let i = 0; i < ns; i++) writeStr(b + ns*104 + i*8, 8, physMins[i].toFixed(1));// physMin
  for (let i = 0; i < ns; i++) writeStr(b + ns*112 + i*8, 8, physMaxs[i].toFixed(1));// physMax
  for (let i = 0; i < ns; i++) writeStr(b + ns*120 + i*8, 8, String(digMin));       // digMin
  for (let i = 0; i < ns; i++) writeStr(b + ns*128 + i*8, 8, String(digMax));       // digMax
  for (let i = 0; i < ns; i++) writeStr(b + ns*136 + i*80, 80, "");                 // prefiltering
  for (let i = 0; i < ns; i++) writeStr(b + ns*216 + i*8, 8, String(samplesPerRecord)); // numSamples
  for (let i = 0; i < ns; i++) writeStr(b + ns*224 + i*32, 32, "");                 // reserved

  // Data records — each record: ns channels × samplesPerRecord × Int16LE
  let offset = headerBytes;
  for (let rec = 0; rec < numRecords; rec++) {
    for (let ch = 0; ch < ns; ch++) {
      const scale = (physMaxs[ch] - physMins[ch]) / (digMax - digMin);
      for (let s = 0; s < samplesPerRecord; s++) {
        const si = rec * samplesPerRecord + s;
        const physVal = si < channelData[ch].length ? channelData[ch][si] : 0;
        const digVal = Math.round((physVal - physMins[ch]) / scale + digMin);
        view.setInt16(offset, Math.max(digMin, Math.min(digMax, digVal)), true);
        offset += 2;
      }
    }
  }

  return buffer;
}

// Read the EDF main-header reserved field (offset 192, 44 bytes), trimmed. Used to recover the
// versionStamp on import and in tests. Returns "" if the buffer is too small.
export function edfReservedField(buffer) {
  if (!buffer || buffer.byteLength < EDF_RESERVED_OFFSET + EDF_RESERVED_LEN) return "";
  const bytes = new Uint8Array(buffer, EDF_RESERVED_OFFSET, EDF_RESERVED_LEN);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
}
