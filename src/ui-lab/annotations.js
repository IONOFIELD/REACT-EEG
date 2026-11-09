// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// EDF+ TAL reader for the UI lab only. Same byte layout as parseEDFAnnotationBlock
// in App.jsx. Kept here so the lab does not import the clinical app.

import { parseEDFHeader } from "../edf.js";

function parseTals(bytes, offset, lengthBytes) {
  const tals = [];
  const end = offset + lengthBytes;
  let pos = offset;
  while (pos < end) {
    if (bytes[pos] === 0) { pos++; continue; }
    if (bytes[pos] !== 0x2B && bytes[pos] !== 0x2D) { pos++; continue; }
    let onsetEnd = pos;
    while (onsetEnd < end && bytes[onsetEnd] !== 0x14 && bytes[onsetEnd] !== 0x15) onsetEnd++;
    if (onsetEnd >= end) break;
    const time = parseFloat(String.fromCharCode(...bytes.slice(pos, onsetEnd)));
    pos = onsetEnd;
    let duration = 0;
    if (bytes[pos] === 0x15) {
      pos++;
      let durEnd = pos;
      while (durEnd < end && bytes[durEnd] !== 0x14) durEnd++;
      if (durEnd >= end) break;
      duration = parseFloat(String.fromCharCode(...bytes.slice(pos, durEnd)));
      pos = durEnd;
    }
    if (bytes[pos] === 0x14) pos++;
    const texts = [];
    while (pos < end && bytes[pos] !== 0) {
      let textEnd = pos;
      while (textEnd < end && bytes[textEnd] !== 0x14 && bytes[textEnd] !== 0) textEnd++;
      if (textEnd > pos) texts.push(String.fromCharCode(...bytes.slice(pos, textEnd)));
      pos = textEnd;
      if (bytes[pos] === 0x14) pos++;
    }
    while (pos < end && bytes[pos] === 0) pos++;
    tals.push({
      time: Number.isFinite(time) ? time : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      text: texts.join(" | "),
    });
  }
  return tals;
}

/** Annotations with non-empty text. Record-start timestamps (empty text) are dropped. */
export function readEdfAnnotations(arrayBuffer) {
  const h = parseEDFHeader(arrayBuffer);
  if (!h || h.error) return [];
  const bytes = new Uint8Array(arrayBuffer);
  const out = [];
  for (let rec = 0; rec < h.numRecords; rec++) {
    let rOff = h.headerBytes + rec * h.samplesPerRecord * 2;
    for (const s of h.sigs) {
      const nbytes = s.numSamples * 2;
      if (s.isAnnotation) {
        for (const t of parseTals(bytes, rOff, nbytes)) {
          if (t.text) out.push(t);
        }
      }
      rOff += nbytes;
    }
  }
  return out;
}

// EEGMMIDB task codes. T0 rest, T1 left fist (or both fists), T2 right fist.
const TASK = { T0: "Rest", T1: "Left fist", T2: "Right fist" };

/** File events become locked marks. They can be selected, not moved or deleted. */
export function eventsFromAnnotations(anns) {
  const out = [];
  anns.forEach((a, i) => {
    const code = (a.text || "").trim();
    if (!TASK[code]) return;
    out.push({
      id: `edf-${i}-${a.time}`,
      t: a.time,
      dur: a.duration > 0 ? a.duration : 0,
      label: TASK[code],
      code,
      locked: true,
      source: "edf",
    });
  });
  return out;
}
