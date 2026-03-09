import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ══════════════════════════════════════════════════════════════
// REACT EEG — Unified Platform
// LIBRARY | REVIEW | ACQUIRE
// ══════════════════════════════════════════════════════════════

// ── Utility: deterministic hash for de-identification ──
function hashSubjectId(id, salt = "REACT-EEG-2026") {
  let h = 0;
  const str = salt + id;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).toUpperCase().padStart(8, "0").slice(0, 4);
}

// ── Study type codes ──
const STUDY_TYPES = {
  BL: { label: "Baseline", color: "#3B82F6" },
  PI: { label: "Post-Injury", color: "#EF4444" },
  PS: { label: "Post-Season", color: "#F59E0B" },
  FU: { label: "Follow-Up", color: "#10B981" },
  RT: { label: "Routine EEG", color: "#8B5CF6" },
  LT: { label: "Long-Term", color: "#6366F1" },
  NCV: { label: "NCV", color: "#EC4899" },
  TCD: { label: "TCD", color: "#14B8A6" },
  AUTO: { label: "Autonomic", color: "#F97316" },
};

function generateFilename(subjectId, studyType, date, seq = 1) {
  const hash = hashSubjectId(subjectId);
  const d = date.replace(/-/g, "");
  return `REACT-${studyType}-${hash}-${d}-${String(seq).padStart(3, "0")}.edf`;
}

// ── Electrode sets per EEG system ──
const ELECTRODE_SETS = {
  "10-20": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"],
  "hd-40": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","FT9","FT10","TP9","TP10","AF3","AF4","PO3","PO4","POz","Oz","Iz"],
  "10-10": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","FT9","FT10","TP9","TP10","AF3","AF4","AF7","AF8","PO3","PO4","POz","Oz","Iz",
    "F1","F2","F5","F6","C1","C2","C5","C6","P1","P2","P5","P6","CPz","FCz","FPz","TP7","TP8","PO7","PO8","P9","P10",
    "F9","F10","FT7","FT8","CP3","CP4","T9","T10","P7","P8","O9","O10"],
};

// ── Montage definitions per EEG system ──
const MONTAGE_DEFS = {
  "bipolar-longitudinal": {
    label: "Bipolar Longitudinal (Double Banana)",
    "10-20": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz","EKG"],
    "hd-40": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-FC1","FC1-CP1","CP1-PO3","AF4-FC2","FC2-CP2","CP2-PO4","FC5-CP5","FC6-CP6","EKG"],
    "10-10": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-F1","F1-FC1","FC1-C1","C1-CP1","CP1-P1","AF4-F2","F2-FC2","FC2-C2","C2-CP2","CP2-P2",
      "AF7-F5","F5-FC5","FC5-C5","C5-CP5","AF8-F6","F6-FC6","FC6-C6","C6-CP6","POz-Oz","EKG"],
  },
  "bipolar-transverse": {
    label: "Bipolar Transverse",
    "10-20": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2","EKG"],
    "hd-40": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "FC5-FC1","FC1-FC2","FC2-FC6","CP5-CP1","CP1-CP2","CP2-CP6","PO3-POz","POz-PO4","EKG"],
    "10-10": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "AF7-AF3","AF3-AF4","AF4-AF8","F5-F1","F1-F2","F2-F6","FC5-FC1","FC1-FCz","FCz-FC2","FC2-FC6",
      "C5-C1","C1-C2","C2-C6","CP5-CP1","CP1-CPz","CPz-CP2","CP2-CP6","P5-P1","P1-P2","P2-P6","PO3-POz","POz-PO4","EKG"],
  },
  referential: {
    label: "Referential (Cz Ref)",
    "10-20": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz","EKG"],
    "hd-40": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","EKG"],
    "10-10": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "F1-Cz","F2-Cz","F5-Cz","F6-Cz","FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","C1-Cz","C2-Cz","C5-Cz","C6-Cz",
      "CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","P1-Cz","P2-Cz","P5-Cz","P6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","EKG"],
  },
  "average-reference": {
    label: "Average Reference",
    "10-20": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg","EKG"],
    "hd-40": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "FC1-Avg","FC2-Avg","FC5-Avg","FC6-Avg","CP1-Avg","CP2-Avg","CP5-Avg","CP6-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","EKG"],
    "10-10": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "F1-Avg","F2-Avg","FC1-Avg","FC2-Avg","C1-Avg","C2-Avg","CP1-Avg","CP2-Avg","P1-Avg","P2-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","EKG"],
  },
};

// Helper: get channels for a montage + system combination
function getMontageChannels(montage, eegSystem) {
  const def = MONTAGE_DEFS[montage];
  if (!def) return [];
  return def[eegSystem] || def["10-20"] || [];
}

// Helper: check if a recording's system can display in a given target system
// A 10-20 recording CAN view in 10-20. It CANNOT view in hd-40 or 10-10.
// An hd-40 recording CAN view in 10-20 and hd-40. It CANNOT view in 10-10.
// A 10-10 recording CAN view in anything.
const SYSTEM_HIERARCHY = { "10-20": 1, "hd-40": 2, "10-10": 3 };
function canViewInSystem(recordingSystem, viewSystem) {
  return (SYSTEM_HIERARCHY[recordingSystem] || 1) >= (SYSTEM_HIERARCHY[viewSystem] || 1);
}

// Legacy compat — MONTAGES object keyed by montage name, returns 10-20 channels by default
const MONTAGES = {};
Object.keys(MONTAGE_DEFS).forEach(k => {
  MONTAGES[k] = { label: MONTAGE_DEFS[k].label, channels: MONTAGE_DEFS[k]["10-20"] };
});

// ── Annotation types ──
const ANNOTATION_COLORS = [
  { name: "Spike", color: "#EF4444" },
  { name: "Sharp Wave", color: "#F59E0B" },
  { name: "Seizure", color: "#DC2626" },
  { name: "Artifact", color: "#6B7280" },
  { name: "Arousal", color: "#8B5CF6" },
  { name: "Sleep Spindle", color: "#3B82F6" },
  { name: "K-Complex", color: "#14B8A6" },
  { name: "Eye Movement", color: "#EC4899" },
  { name: "Note", color: "#10B981" },
];

// ── EEG Signal Generator ──
function generateEEGSignal(channelIndex, sampleRate, durationSec, seed = 0) {
  const samples = sampleRate * durationSec;
  const data = new Float32Array(samples);
  const s = channelIndex * 1000 + seed;
  const rand = (n) => { const x = Math.sin(n * 9301 + s * 4973) * 49297; return x - Math.floor(x); };
  const isEKG = channelIndex >= 18;
  const isOccipital = (channelIndex >= 2 && channelIndex <= 3) || (channelIndex >= 6 && channelIndex <= 7);
  const isFrontal = channelIndex <= 1 || channelIndex === 4 || channelIndex === 5;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    if (isEKG) {
      const beatPhase = (t * 72 / 60) % 1;
      const qrs = beatPhase < 0.02 ? -30 : beatPhase < 0.04 ? 120 : beatPhase < 0.06 ? -20 : 0;
      const pWave = beatPhase > 0.85 ? 8 * Math.sin((beatPhase - 0.85) * Math.PI / 0.15) : 0;
      const tWave = beatPhase > 0.12 && beatPhase < 0.35 ? 15 * Math.sin((beatPhase - 0.12) * Math.PI / 0.23) : 0;
      data[i] = qrs + pWave + tWave + (rand(i) - 0.5) * 5;
    } else {
      const delta = 15 * Math.sin(2 * Math.PI * (1.5 + rand(1) * 2) * t + rand(channelIndex * 7) * Math.PI * 2);
      const theta = 10 * Math.sin(2 * Math.PI * (5 + rand(2) * 3) * t + rand(channelIndex * 13) * Math.PI * 2);
      const alphaAmp = isOccipital ? 30 : isFrontal ? 5 : 12;
      const alpha = alphaAmp * Math.sin(2 * Math.PI * (9.5 + rand(3) * 2.5) * t + rand(channelIndex * 19) * Math.PI * 2);
      const beta = 5 * Math.sin(2 * Math.PI * (18 + rand(4) * 10) * t + rand(channelIndex * 23) * Math.PI * 2);
      const muscle = isFrontal ? (rand(i * 3 + 1) - 0.5) * 8 : (rand(i * 3 + 1) - 0.5) * 3;
      const drift = 3 * Math.sin(2 * Math.PI * 0.1 * t + channelIndex);
      data[i] = delta + theta + alpha + beta + muscle + drift + (rand(i) - 0.5) * 6;
      if (rand(i * 7 + channelIndex) > 0.998) {
        const spike = (rand(i) > 0.5 ? 1 : -1) * (60 + rand(i * 11) * 40);
        for (let j = 0; j < Math.min(15, samples - i); j++) data[i + j] += spike * Math.exp(-j / 3);
      }
    }
  }
  return data;
}

// ── EDF File Parser ──
function parseEDFFile(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const decoder = new TextDecoder("ascii");
    const readStr = (o, l) => decoder.decode(bytes.slice(o, o + l)).trim();
    const readInt = (o, l) => parseInt(readStr(o, l)) || 0;
    const readFloat = (o, l) => parseFloat(readStr(o, l)) || 0;

    const patientId = readStr(8, 80);
    const recordingId = readStr(88, 80);
    const startDate = readStr(168, 8);
    const startTime = readStr(176, 8);
    const headerBytes = readInt(184, 8);
    const numRecords = readInt(236, 8);
    const recordDuration = readFloat(244, 8);
    const numSignals = readInt(252, 4);

    if (numSignals <= 0 || numSignals > 512 || numRecords <= 0) return { error: "Invalid EDF" };

    const sigs = [];
    const b = 256;
    for (let i = 0; i < numSignals; i++) sigs.push({ label: readStr(b + i*16, 16), physMin:0, physMax:0, digMin:0, digMax:0, numSamples:0 });
    let off = b + numSignals*16 + numSignals*80 + numSignals*8;
    for (let i = 0; i < numSignals; i++) sigs[i].physMin = readFloat(off + i*8, 8);
    off += numSignals*8;
    for (let i = 0; i < numSignals; i++) sigs[i].physMax = readFloat(off + i*8, 8);
    off += numSignals*8;
    for (let i = 0; i < numSignals; i++) sigs[i].digMin = readInt(off + i*8, 8);
    off += numSignals*8;
    for (let i = 0; i < numSignals; i++) sigs[i].digMax = readInt(off + i*8, 8);
    off += numSignals*8 + numSignals*80;
    for (let i = 0; i < numSignals; i++) sigs[i].numSamples = readInt(off + i*8, 8);

    sigs.forEach(s => {
      const dr = s.digMax - s.digMin; const pr = s.physMax - s.physMin;
      s.scale = dr !== 0 ? pr / dr : 1;
      s.offset = s.physMin - s.digMin * s.scale;
    });

    const bytesPerRec = sigs.reduce((sum, s) => sum + s.numSamples, 0) * 2;
    const channelData = sigs.map(s => new Float32Array(s.numSamples * numRecords));
    const dv = new DataView(arrayBuffer);

    for (let rec = 0; rec < numRecords; rec++) {
      let rOff = headerBytes + rec * bytesPerRec;
      for (let si = 0; si < numSignals; si++) {
        const ns = sigs[si].numSamples;
        const dest = rec * ns;
        for (let s = 0; s < ns; s++) {
          if (rOff + 1 < arrayBuffer.byteLength) {
            channelData[si][dest + s] = dv.getInt16(rOff, true) * sigs[si].scale + sigs[si].offset;
          }
          rOff += 2;
        }
      }
    }

    const sampleRate = recordDuration > 0 ? Math.round(sigs[0].numSamples / recordDuration) : 256;
    return {
      patientId, recordingId, startDate, startTime, numRecords, recordDuration, numSignals,
      totalDuration: numRecords * recordDuration, sampleRate,
      signals: sigs.map(s => ({ label: s.label, numSamples: s.numSamples, sampleRate: recordDuration > 0 ? Math.round(s.numSamples / recordDuration) : 256 })),
      channelData, channelLabels: sigs.map(s => s.label),
    };
  } catch (e) { return { error: e.message }; }
}

function getEDFEpochData(edfData, channelIndex, epochStart, epochSec, targetSr) {
  if (!edfData?.channelData || channelIndex >= edfData.channelData.length) return null;
  const sigSr = edfData.signals[channelIndex]?.sampleRate || edfData.sampleRate;
  const start = Math.floor(epochStart * sigSr);
  const raw = edfData.channelData[channelIndex];
  if (start >= raw.length) return null;
  const slice = raw.slice(start, Math.min(start + Math.floor(epochSec * sigSr), raw.length));
  if (sigSr !== targetSr && targetSr > 0) {
    const tgt = Math.floor(epochSec * targetSr);
    const out = new Float32Array(tgt);
    const ratio = slice.length / tgt;
    for (let i = 0; i < tgt; i++) { const si = i * ratio; const lo = Math.floor(si); const hi = Math.min(lo+1, slice.length-1); out[i] = slice[lo]*(1-(si-lo)) + slice[hi]*(si-lo); }
    return out;
  }
  return slice;
}

// ── Filters ──
function applyHighPass(data, cutoff, sr) {
  if (cutoff <= 0) return data;
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / sr, a = rc / (rc + dt);
  const out = new Float32Array(data.length); out[0] = data[0];
  for (let i = 1; i < data.length; i++) out[i] = a * (out[i-1] + data[i] - data[i-1]);
  return out;
}
function applyLowPass(data, cutoff, sr) {
  if (cutoff <= 0) return data;
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / sr, a = dt / (rc + dt);
  const out = new Float32Array(data.length); out[0] = data[0];
  for (let i = 1; i < data.length; i++) out[i] = out[i-1] + a * (data[i] - out[i-1]);
  return out;
}
function applyNotch(data, freq, sr, q = 30) {
  if (freq <= 0) return data;
  const w0 = (2 * Math.PI * freq) / sr, alpha = Math.sin(w0) / (2 * q);
  const b0 = 1, b1 = -2 * Math.cos(w0), b2 = 1, a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  const out = new Float32Array(data.length); out[0] = data[0]; out[1] = data[1];
  for (let i = 2; i < data.length; i++)
    out[i] = (b0/a0)*data[i] + (b1/a0)*data[i-1] + (b2/a0)*data[i-2] - (a1/a0)*out[i-1] - (a2/a0)*out[i-2];
  return out;
}

// ── Icons ──
const I = {
  Search: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>,
  Upload: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Download: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Brain: (s=20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9.5 2a3.5 3.5 0 0 0-3.2 4.8A3.5 3.5 0 0 0 4 10.5a3.5 3.5 0 0 0 1 6.8A3.5 3.5 0 0 0 8.5 22h1V2Z"/><path d="M14.5 2a3.5 3.5 0 0 1 3.2 4.8 3.5 3.5 0 0 1 2.3 3.7 3.5 3.5 0 0 1-1 6.8 3.5 3.5 0 0 1-3.5 4.7h-1V2Z"/></svg>,
  Shield: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Check: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  Alert: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Clock: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Filter: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  Grid: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  List: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  X: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Plus: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Database: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Zap: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  ChevLeft: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>,
  ChevRight: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
  ZoomIn: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>,
  ZoomOut: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>,
  Bookmark: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>,
  Trash: (s=12) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Save: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  Record: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>,
  Square: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/></svg>,
  Pause: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>,
  Activity: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  Eye: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Radio: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>,
  MoreVert: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>,
  Folder: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  Edit: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Package: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m16.5 9.4-9-5.19"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>,
  BarChart: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
};

// ── Seed data — 5 test records ──
function generateSeedData() {
  const tests = [
    { studyType: "BL", date: "2026-03-01", subjectId: "FB-001", sport: "Football", position: "QB", channels: 21, sampleRate: 256, duration: 30, montage: "10-20" },
    { studyType: "RT", date: "2026-03-03", subjectId: "FB-002", sport: "Football", position: "LB", channels: 21, sampleRate: 256, duration: 20, montage: "10-20" },
    { studyType: "PI", date: "2026-03-05", subjectId: "FB-001", sport: "Football", position: "QB", channels: 21, sampleRate: 256, duration: 30, montage: "10-20" },
    { studyType: "FU", date: "2026-03-07", subjectId: "FB-003", sport: "Football", position: "WR", channels: 19, sampleRate: 256, duration: 40, montage: "10-20" },
    { studyType: "PS", date: "2026-03-09", subjectId: "FB-002", sport: "Football", position: "LB", channels: 21, sampleRate: 256, duration: 30, montage: "10-20" },
  ];
  return tests.map((t, i) => ({
    id: `TEST-${i+1}`,
    subjectHash: hashSubjectId(t.subjectId),
    subjectId: t.subjectId,
    sport: t.sport,
    position: t.position,
    studyType: t.studyType,
    date: t.date,
    filename: generateFilename(t.subjectId, t.studyType, t.date),
    channels: t.channels,
    duration: t.duration,
    sampleRate: t.sampleRate,
    fileSize: Math.round(t.channels * t.sampleRate * t.duration * 60 * 2 / 1024 / 1024 * 10) / 10,
    montage: t.montage,
    status: "pending",
    isTest: true,
    notes: "",
    uploadedAt: new Date(t.date + "T09:00:00").toISOString(),
  }));
}

// ── Shared styles ──
const controlBtn = (active = false) => ({
  padding: "4px 10px", background: active ? "#1a2a30" : "#111",
  border: `1px solid ${active ? "#4a9bab" : "#222"}`, borderRadius: 0,
  color: active ? "#7ec8d9" : "#888", fontSize: 11, cursor: "pointer",
  fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, transition: "all 0.1s",
});
const selectStyle = {
  background: "#111", border: "1px solid #222", borderRadius: 0,
  color: "#ccc", fontSize: 11, padding: "4px 6px", outline: "none",
  fontFamily: "'IBM Plex Mono', monospace",
};
const microLabel = {
  fontSize: 9, color: "#555", fontWeight: 700, letterSpacing: "0.1em",
  textTransform: "uppercase", marginBottom: 2,
};

// ── StatusBadge ──
function StatusBadge({ status }) {
  const cfg = {
    verified: { icon: I.Check(), bg: "#0a2a30", border: "#1a4a54", text: "#7ec8d9", label: "Verified" },
    pending: { icon: I.Clock(), bg: "#1a1a0a", border: "#854d0e", text: "#facc15", label: "Pending" },
    flagged: { icon: I.Alert(), bg: "#2a0a0a", border: "#991b1b", text: "#f87171", label: "Flagged" },
  }[status] || { icon: null, bg: "#1a1a1a", border: "#333", text: "#999", label: status };
  return (
    <span style={{ display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:0,
      fontSize:11,fontWeight:600,background:cfg.bg,border:`1px solid ${cfg.border}`,color:cfg.text }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ── Tauri bridge — calls Rust backend when available, graceful fallback otherwise ──
const tauriBridge = {
  async invoke(cmd, args = {}) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke(cmd, args);
    }
    // Browser fallback for development
    console.log(`[Tauri stub] ${cmd}`, args);
    if (cmd === "initialize_app") return "Browser Mode — no local storage";
    if (cmd === "get_data_directory") return "Documents/REACT EEG (Tauri required)";
    if (cmd === "load_library_index") return "[]";
    if (cmd === "load_config") return "{}";
    return null;
  },
  async showInExplorer(studyType, filename) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("show_in_explorer", { studyType, filename });
    }
    alert(`File location:\nDocuments/REACT EEG/data/${studyType}/${filename}\n\n(Run as desktop app to open in Explorer)`);
  },
  async deleteFiles(studyType, filename) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("delete_record_files", { studyType, filename });
    }
  },
  async saveLibrary(records) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_library_index", { recordsJson: JSON.stringify(records) });
    }
  },
  async saveAnnotations(filename, annotations) {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("save_annotations", { filename, annotationsJson: JSON.stringify(annotations) });
    }
  },
  async loadAnnotations(filename) {
    if (window.__TAURI__) {
      const json = await window.__TAURI__.invoke("load_annotations", { filename });
      return JSON.parse(json);
    }
    return [];
  },
  async openDataDirectory() {
    if (window.__TAURI__) {
      return window.__TAURI__.invoke("open_data_directory");
    }
    alert("Documents/REACT EEG/\n\n(Run as desktop app to open folder)");
  },
};

// ── TypeBadge — study type label with optional test file indicator ──
function TypeBadge({ record }) {
  const st = STUDY_TYPES[record.studyType] || { label: "?", color: "#666" };
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5}}>
      {record.isTest && (
        <span title="Test file" style={{
          width:7,height:7,borderRadius:"50%",background:"#7ec8d9",flexShrink:0,
          cursor:"help",
        }}/>
      )}
      <span style={{display:"inline-flex",alignItems:"center",padding:"2px 8px",borderRadius:0,fontSize:10,fontWeight:700,
        background:st.color+"18",color:st.color,border:`1px solid ${st.color}30`}}>
        {st.label}
      </span>
    </span>
  );
}

// ── RecordActions — edit menu with delete + open location ──
function RecordActions({ record, onDelete, onOpenReview }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setConfirmDelete(false); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const menuItem = (icon, label, color, onClick) => (
    <button onClick={(e)=>{e.stopPropagation();onClick();}} style={{
      display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 12px",
      background:"transparent",border:"none",color,fontSize:11,fontWeight:500,
      cursor:"pointer",textAlign:"left",fontFamily:"'IBM Plex Mono', monospace",
      transition:"background 0.1s",
    }}
      onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      {icon} {label}
    </button>
  );

  return (
    <div ref={wrapRef} style={{position:"relative",zIndex:open?30:1}}>
      <button onClick={(e)=>{e.stopPropagation();setOpen(!open);setConfirmDelete(false);}} style={{
        padding:"4px 6px",background:open?"#1a1a1a":"transparent",border:"1px solid transparent",
        borderRadius:0,cursor:"pointer",color:open?"#ccc":"#555",transition:"all 0.15s",
        display:"flex",alignItems:"center",
      }}
        onMouseEnter={e=>{if(!open)e.currentTarget.style.color="#aaa";}}
        onMouseLeave={e=>{if(!open)e.currentTarget.style.color="#555";}}>
        {I.MoreVert(16)}
      </button>

      {open && (
        <div style={{
          position:"absolute",right:0,top:"100%",marginTop:4,
          width:200,background:"#111",border:"1px solid #2a2a2a",borderRadius:0,
          overflow:"hidden",
        }}>
          {!confirmDelete ? (<>
            {menuItem(I.Eye(13), "Open in Review", "#ccc", () => { onOpenReview(record); setOpen(false); })}
            {menuItem(I.Folder(13), "Open File Location", "#ccc", () => {
              tauriBridge.showInExplorer(record.studyType, record.filename);
              setOpen(false);
            })}
            <div style={{borderTop:"1px solid #1a1a1a",margin:"2px 0"}}/>
            {menuItem(I.Trash(13), "Delete Record", "#f87171", () => setConfirmDelete(true))}
          </>) : (
            <div style={{padding:12}}>
              <div style={{fontSize:11,color:"#f87171",fontWeight:600,marginBottom:4}}>Delete this record?</div>
              <div style={{fontSize:10,color:"#555",marginBottom:10,lineHeight:1.4,fontFamily:"'IBM Plex Mono', monospace"}}>
                {record.filename}
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={(e)=>{e.stopPropagation();setConfirmDelete(false);setOpen(false);}} style={{
                  flex:1,padding:"5px 0",background:"#111",border:"1px solid #333",borderRadius:0,
                  color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
                }}>Cancel</button>
                <button onClick={(e)=>{e.stopPropagation();tauriBridge.deleteFiles(record.studyType,record.filename);onDelete(record.id);setOpen(false);setConfirmDelete(false);}} style={{
                  flex:1,padding:"5px 0",background:"#7f1d1d",border:"1px solid #EF444440",borderRadius:0,
                  color:"#f87171",cursor:"pointer",fontSize:10,fontWeight:700,
                }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── StatusControl — clickable status setter ──
function StatusControl({ status, onSetStatus, size = "normal" }) {
  const statuses = [
    { key: "pending",  icon: I.Clock(),  color: "#facc15", border: "#854d0e", bg: "#1a1a0a", label: "Pending" },
    { key: "verified", icon: I.Check(),  color: "#7ec8d9", border: "#1a4a54", bg: "#0a2a30", label: "Verified" },
    { key: "flagged",  icon: I.Alert(),  color: "#f87171", border: "#991b1b", bg: "#2a0a0a", label: "Flagged" },
  ];
  const compact = size === "compact";
  return (
    <div style={{display:"flex",gap:compact?3:4,alignItems:"center"}}>
      {statuses.map(s => {
        const active = status === s.key;
        return (
          <button key={s.key} onClick={(e)=>{e.stopPropagation();onSetStatus(s.key);}} title={s.label}
            style={{
              display:"flex",alignItems:"center",gap:compact?3:5,
              padding:compact?"2px 6px":"4px 10px",
              background:active?s.bg:"transparent",
              border:`1px solid ${active?s.border:"#222"}`,
              borderRadius:0,cursor:"pointer",transition:"all 0.15s",
              color:active?s.color:"#555",fontSize:compact?9:10,fontWeight:active?700:500,
            }}
            onMouseEnter={e=>{if(!active){e.currentTarget.style.borderColor=s.border;e.currentTarget.style.color=s.color;}}}
            onMouseLeave={e=>{if(!active){e.currentTarget.style.borderColor="#222";e.currentTarget.style.color="#555";}}}>
            {s.icon}
            {!compact && <span>{s.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// WAVEFORM CANVAS — shared between REVIEW and ACQUIRE
// ══════════════════════════════════════════════════════════════
function WaveformCanvas({ channels, waveformData, epochSec, epochStart, epochEnd, sampleRate,
  sensitivity, channelSensitivity = {}, annotations = [], annotationDraft, selectedAnnotationType, hoveredTime,
  isAddingAnnotation, onMouseMove, onMouseLeave, onClick, onContextMenu, containerRef, canvasRef, children }) {

  const drawEEG = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, W, H);

    const labelWidth = 72, plotW = W - labelWidth - 16, plotX = labelWidth;
    const chCount = channels.length, chHeight = H / chCount;
    const samplesPerEpoch = sampleRate * epochSec;
    const scale = sensitivity * 1.5;

    // Grid
    ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 0.5;
    for (let t = 0; t <= epochSec; t++) {
      const x = plotX + (t / epochSec) * plotW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    // Annotations
    const epochAnns = annotations.filter(a => a.time >= epochStart && a.time < epochEnd);
    epochAnns.forEach(ann => {
      const x1 = plotX + ((ann.time - epochStart) / epochSec) * plotW;
      const x2 = x1 + (ann.duration / epochSec) * plotW;
      ctx.fillStyle = ann.color + "15"; ctx.fillRect(x1, 0, Math.max(x2-x1, 2), H);
      ctx.strokeStyle = ann.color + "60"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.stroke();
      ctx.fillStyle = ann.color; ctx.font = "bold 9px 'IBM Plex Mono', monospace";
      ctx.fillText(ann.type, x1 + 3, 12);
    });

    // Draft annotation
    if (annotationDraft) {
      const x = plotX + ((annotationDraft.time - epochStart) / epochSec) * plotW;
      ctx.strokeStyle = ANNOTATION_COLORS[selectedAnnotationType || 0].color + "AA";
      ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Hover
    if (hoveredTime !== null) {
      const x = plotX + ((hoveredTime - epochStart) / epochSec) * plotW;
      ctx.strokeStyle = "#ffffff20"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = "#ffffff90"; ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillText(hoveredTime.toFixed(2) + "s", x + 4, H - 6);
    }

    // Channels
    channels.forEach((ch, i) => {
      const yCenter = chHeight * i + chHeight / 2;
      const data = waveformData[i];
      if (!data) return;
      const chSensOffset = channelSensitivity[ch] || 0;
      const chScale = Math.max(1, (sensitivity - chSensOffset)) * 1.5;
      ctx.strokeStyle = "#151515"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(plotX, chHeight * (i + 1)); ctx.lineTo(W, chHeight * (i + 1)); ctx.stroke();
      ctx.fillStyle = ch === "EKG" ? "#EC4899" : "#666";
      ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(ch, labelWidth - 8, yCenter);
      ctx.strokeStyle = ch === "EKG" ? "#FF3333" : "#1a8fff";
      ctx.lineWidth = ch === "EKG" ? 1.2 : 0.9;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(data.length / plotW / 2));
      for (let j = 0; j < data.length; j += step) {
        const x = plotX + (j / samplesPerEpoch) * plotW;
        const y = yCenter - (data[j] / chScale);
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // Time axis
    ctx.textAlign = "center"; ctx.fillStyle = "#444"; ctx.font = "10px 'IBM Plex Mono', monospace";
    for (let t = 0; t <= epochSec; t++) {
      const x = plotX + (t / epochSec) * plotW;
      const tv = epochStart + t;
      ctx.fillText(`${Math.floor(tv/60)}:${String(Math.floor(tv%60)).padStart(2,"0")}`, x, H - 2);
    }
    ctx.textAlign = "left";
  }, [waveformData, channels, epochSec, epochStart, epochEnd, sampleRate, sensitivity, channelSensitivity, annotations, annotationDraft, hoveredTime, selectedAnnotationType, canvasRef, containerRef]);

  useEffect(() => {
    drawEEG();
    const h = () => drawEEG();
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [drawEEG]);

  return (
    <div ref={containerRef}
      style={{ flex: 1, position: "relative", cursor: isAddingAnnotation ? "crosshair" : "default" }}
      onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} onClick={onClick} onContextMenu={onContextMenu}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EEG CONTROLS BAR — shared between REVIEW and ACQUIRE
// ══════════════════════════════════════════════════════════════
function EEGControls({ montage, setMontage, eegSystem, setEegSystem, recordingSystem, hpf, setHpf, lpf, setLpf, notch, setNotch,
  epochSec, setEpochSec, sensitivity, setSensitivity, rightContent }) {
  return (
    <div style={{ display:"flex",alignItems:"flex-end",gap:16,padding:"8px 16px",
      borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexWrap:"wrap",flexShrink:0 }}>
      {eegSystem !== undefined && setEegSystem && (
        <div><div style={microLabel}>EEG System</div>
          <select value={eegSystem} onChange={e=>setEegSystem(e.target.value)} style={{...selectStyle,width:140}}>
            {Object.entries(EEG_SYSTEMS).map(([k,v])=>{
              const disabled = recordingSystem && !canViewInSystem(recordingSystem, k);
              return <option key={k} value={k} disabled={disabled}>{v.label}{disabled?" (insufficient data)":""}</option>;
            })}
          </select></div>
      )}
      <div><div style={microLabel}>Montage</div>
        <select value={montage} onChange={e=>setMontage(e.target.value)} style={{...selectStyle,width:220}}>
          {Object.entries(MONTAGE_DEFS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select></div>
      <div><div style={microLabel}>LFF (Hz)</div>
        <select value={hpf} onChange={e=>setHpf(parseFloat(e.target.value))} style={selectStyle}>
          {[0,0.1,0.3,0.5,1,1.6,5,10].map(v=><option key={v} value={v}>{v===0?"Off":v}</option>)}
        </select></div>
      <div><div style={microLabel}>HFF (Hz)</div>
        <select value={lpf} onChange={e=>setLpf(parseFloat(e.target.value))} style={selectStyle}>
          {[15,30,35,40,50,70,100,0].map(v=><option key={v} value={v}>{v===0?"Off":v}</option>)}
        </select></div>
      <div><div style={microLabel}>Notch</div>
        <select value={notch} onChange={e=>setNotch(parseFloat(e.target.value))} style={selectStyle}>
          <option value={0}>Off</option><option value={50}>50 Hz</option><option value={60}>60 Hz</option>
        </select></div>
      <div><div style={microLabel}>Epoch (sec)</div>
        <select value={epochSec} onChange={e=>setEpochSec(parseInt(e.target.value))} style={selectStyle}>
          {[5,10,15,20,30].map(v=><option key={v} value={v}>{v}s</option>)}
        </select></div>
      <div><div style={microLabel}>Sensitivity</div>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <button onClick={()=>setSensitivity(p=>Math.min(p+1,30))} style={controlBtn()}>{I.ZoomOut()}</button>
          <span style={{fontSize:11,color:"#888",minWidth:24,textAlign:"center"}}>{sensitivity}</span>
          <button onClick={()=>setSensitivity(p=>Math.max(p-1,1))} style={controlBtn()}>{I.ZoomIn()}</button>
        </div></div>
      <div style={{flex:1}}/>
      {rightContent}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// QUANTITATIVE EEG ANALYSIS PANEL — floating overlay
// ══════════════════════════════════════════════════════════════
function QuantAnalysisPanel({ waveformData, channels, sampleRate, epochSec, epochStart, onClose, panelPos, setPanelPos }) {
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [activeView, setActiveView] = useState("bands");
  const panelRef = useRef(null);

  useEffect(() => {
    if (panelPos.x === null) {
      setPanelPos({ x: 20, y: Math.round(window.innerHeight * 0.15) });
    }
  }, []);

  const onMouseDown = (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
    setDragging(true);
    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => setPanelPos({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, dragOffset]);

  // Compute spectral power per channel using simple FFT approximation
  const computeBandPower = (data, sr) => {
    if (!data || data.length === 0) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const N = data.length;
    const freqRes = sr / N;

    // Simple DFT magnitude for band ranges
    const bandRanges = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
    const powers = {};
    let total = 0;

    Object.entries(bandRanges).forEach(([band, [fLow, fHigh]]) => {
      let bandPow = 0;
      const kLow = Math.max(1, Math.round(fLow / freqRes));
      const kHigh = Math.min(Math.floor(N / 2), Math.round(fHigh / freqRes));
      for (let k = kLow; k <= kHigh; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
          const angle = (2 * Math.PI * k * n) / N;
          re += data[n] * Math.cos(angle);
          im -= data[n] * Math.sin(angle);
        }
        bandPow += (re * re + im * im) / (N * N);
      }
      powers[band] = bandPow;
      total += bandPow;
    });
    powers.total = total;
    return powers;
  };

  // Analyze all visible channels for current epoch
  const analysis = useMemo(() => {
    if (!waveformData || waveformData.length === 0) return null;

    // Subsample for performance (use first 512 samples max for FFT)
    const maxSamples = Math.min(512, waveformData[0]?.length || 0);

    const channelData = channels.map((ch, i) => {
      const raw = waveformData[i];
      if (!raw) return { channel: ch, bands: { delta:0, theta:0, alpha:0, beta:0, gamma:0, total:0 } };
      const sub = raw.slice(0, maxSamples);
      const bands = computeBandPower(sub, sampleRate);
      return { channel: ch, bands };
    });

    // Compute averages
    const avgBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const eegChannels = channelData.filter(c => c.channel !== "EKG");
    eegChannels.forEach(c => {
      Object.keys(avgBands).forEach(b => { avgBands[b] += c.bands[b]; });
    });
    if (eegChannels.length > 0) {
      Object.keys(avgBands).forEach(b => { avgBands[b] /= eegChannels.length; });
    }

    // Alpha peak frequency (find max power in 7-14Hz range)
    let peakAlphaFreq = 10;
    if (eegChannels.length > 0) {
      const testData = waveformData[Math.floor(channels.length / 2)]?.slice(0, maxSamples);
      if (testData) {
        const N = testData.length;
        const freqRes = sampleRate / N;
        let maxPow = 0;
        for (let f = 7; f <= 14; f += 0.25) {
          const k = Math.round(f / freqRes);
          let re = 0, im = 0;
          for (let n = 0; n < N; n++) {
            const angle = (2 * Math.PI * k * n) / N;
            re += testData[n] * Math.cos(angle);
            im -= testData[n] * Math.sin(angle);
          }
          const pow = re * re + im * im;
          if (pow > maxPow) { maxPow = pow; peakAlphaFreq = f; }
        }
      }
    }

    // Hemispheric asymmetry (compare left vs right channel pairs)
    const leftChannels = channelData.filter(c => /^(Fp1|F3|C3|P3|O1|F7|T3|T5)/.test(c.channel.split("-")[0]));
    const rightChannels = channelData.filter(c => /^(Fp2|F4|C4|P4|O2|F8|T4|T6)/.test(c.channel.split("-")[0]));
    const leftAlpha = leftChannels.length > 0 ? leftChannels.reduce((s, c) => s + c.bands.alpha, 0) / leftChannels.length : 0;
    const rightAlpha = rightChannels.length > 0 ? rightChannels.reduce((s, c) => s + c.bands.alpha, 0) / rightChannels.length : 0;
    const asymmetryIndex = (leftAlpha + rightAlpha) > 0 ? ((rightAlpha - leftAlpha) / (rightAlpha + leftAlpha) * 100) : 0;

    // Theta/Beta ratio (frontal)
    const frontalChannels = channelData.filter(c => /^(Fp1|Fp2|F3|F4|Fz)/.test(c.channel.split("-")[0]));
    const frontalTheta = frontalChannels.length > 0 ? frontalChannels.reduce((s, c) => s + c.bands.theta, 0) / frontalChannels.length : 0;
    const frontalBeta = frontalChannels.length > 0 ? frontalChannels.reduce((s, c) => s + c.bands.beta, 0) / frontalChannels.length : 0;
    const thetaBetaRatio = frontalBeta > 0 ? frontalTheta / frontalBeta : 0;

    // Flag epochs with excessive slow activity
    const flags = [];
    channelData.forEach(c => {
      if (c.channel === "EKG") return;
      const total = c.bands.total || 1;
      const deltaPct = (c.bands.delta / total) * 100;
      const thetaPct = (c.bands.theta / total) * 100;
      if (deltaPct > 60) flags.push({ channel: c.channel, type: "Elevated Delta", value: `${deltaPct.toFixed(0)}%`, severity: "high" });
      else if (deltaPct > 45) flags.push({ channel: c.channel, type: "Moderate Delta", value: `${deltaPct.toFixed(0)}%`, severity: "med" });
      if (thetaPct > 40) flags.push({ channel: c.channel, type: "Elevated Theta", value: `${thetaPct.toFixed(0)}%`, severity: "high" });
    });

    return { channelData, avgBands, peakAlphaFreq, asymmetryIndex, thetaBetaRatio, flags };
  }, [waveformData, channels, sampleRate]);

  if (!analysis) return null;

  const bandColors = { delta: "#6366F1", theta: "#F59E0B", alpha: "#10B981", beta: "#3B82F6", gamma: "#EC4899" };
  const bandLabels = { delta: "Delta (0.5-4Hz)", theta: "Theta (4-8Hz)", alpha: "Alpha (8-13Hz)", beta: "Beta (13-30Hz)", gamma: "Gamma (30-50Hz)" };

  // Bar renderer
  const PowerBar = ({ value, max, color, label, pct }) => (
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
      <span style={{fontSize:9,color:"#666",width:50,textAlign:"right",fontFamily:"'IBM Plex Mono', monospace"}}>{label}</span>
      <div style={{flex:1,height:10,background:"#0a0a0a",border:"1px solid #1a1a1a",position:"relative"}}>
        <div style={{height:"100%",background:color,width:`${Math.min(100, (value/max)*100)}%`,transition:"width 0.2s"}}/>
      </div>
      <span style={{fontSize:9,color:"#888",width:36,textAlign:"right",fontFamily:"'IBM Plex Mono', monospace"}}>{pct}%</span>
    </div>
  );

  const views = [
    { id: "bands", label: "Band Power" },
    { id: "channels", label: "By Channel" },
    { id: "metrics", label: "Metrics" },
    { id: "flags", label: `Flags (${analysis.flags.length})` },
  ];

  return (
    <div ref={panelRef} style={{
      position:"fixed", left:panelPos.x, top:panelPos.y, width:360, maxHeight:"75vh",
      background:"#0c0c0c", border:"1px solid #2a2a2a", borderRadius:0,
      display:"flex", flexDirection:"column", zIndex:80,
      cursor: dragging ? "grabbing" : "default",
      userSelect: dragging ? "none" : "auto",
    }}>
      {/* Header */}
      <div onMouseDown={onMouseDown} style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",cursor:"grab",
        display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <span style={{fontSize:10,fontWeight:700,color:"#666",letterSpacing:"0.1em"}}>qEEG ANALYSIS</span>
          <span style={{fontSize:9,color:"#444",marginLeft:8}}>Epoch {Math.floor(epochStart / (waveformData[0]?.length / sampleRate || 10)) + 1}</span>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#555",cursor:"pointer",padding:2}}>{I.X()}</button>
      </div>

      {/* View tabs */}
      <div style={{display:"flex",borderBottom:"1px solid #1a1a1a"}}>
        {views.map(v => (
          <button key={v.id} onClick={()=>setActiveView(v.id)} style={{
            flex:1,padding:"6px 4px",background:activeView===v.id?"#1a1a1a":"transparent",
            border:"none",borderBottom:activeView===v.id?"2px solid #7ec8d9":"2px solid transparent",
            color:activeView===v.id?"#ccc":"#555",fontSize:9,fontWeight:600,cursor:"pointer",
          }}>{v.label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{flex:1,overflow:"auto",padding:"10px 12px"}}>

        {/* Band Power View */}
        {activeView === "bands" && (<>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>GLOBAL AVERAGE BAND POWER</div>
            {Object.entries(bandColors).map(([band, color]) => {
              const val = analysis.avgBands[band];
              const total = analysis.avgBands.total || 1;
              const pct = ((val / total) * 100).toFixed(1);
              return <PowerBar key={band} value={val} max={total * 0.6} color={color} label={band.charAt(0).toUpperCase() + band.slice(1, 3)} pct={pct}/>;
            })}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:12}}>
            <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"8px 10px"}}>
              <div style={{fontSize:8,color:"#555",letterSpacing:"0.08em"}}>PEAK ALPHA</div>
              <div style={{fontSize:16,fontWeight:700,color:"#10B981",fontFamily:"'IBM Plex Mono', monospace"}}>{analysis.peakAlphaFreq.toFixed(1)} Hz</div>
            </div>
            <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"8px 10px"}}>
              <div style={{fontSize:8,color:"#555",letterSpacing:"0.08em"}}>THETA/BETA</div>
              <div style={{fontSize:16,fontWeight:700,color:analysis.thetaBetaRatio>3?"#F59E0B":"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{analysis.thetaBetaRatio.toFixed(2)}</div>
            </div>
            <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"8px 10px"}}>
              <div style={{fontSize:8,color:"#555",letterSpacing:"0.08em"}}>ASYMMETRY (R-L)</div>
              <div style={{fontSize:16,fontWeight:700,color:Math.abs(analysis.asymmetryIndex)>15?"#F59E0B":"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{analysis.asymmetryIndex>0?"+":""}{analysis.asymmetryIndex.toFixed(1)}%</div>
            </div>
            <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"8px 10px"}}>
              <div style={{fontSize:8,color:"#555",letterSpacing:"0.08em"}}>CHANNELS</div>
              <div style={{fontSize:16,fontWeight:700,color:"#888",fontFamily:"'IBM Plex Mono', monospace"}}>{channels.filter(c=>c!=="EKG").length}</div>
            </div>
          </div>
        </>)}

        {/* Per-Channel View */}
        {activeView === "channels" && (
          <div>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>BAND POWER BY CHANNEL</div>
            {analysis.channelData.filter(c => c.channel !== "EKG").map(c => {
              const total = c.bands.total || 1;
              return (
                <div key={c.channel} style={{marginBottom:8}}>
                  <div style={{fontSize:10,color:"#aaa",fontFamily:"'IBM Plex Mono', monospace",marginBottom:3}}>{c.channel}</div>
                  <div style={{display:"flex",height:8,background:"#0a0a0a",border:"1px solid #111"}}>
                    {Object.entries(bandColors).map(([band, color]) => (
                      <div key={band} title={`${band}: ${((c.bands[band]/total)*100).toFixed(1)}%`}
                        style={{height:"100%",background:color,width:`${(c.bands[band]/total)*100}%`}}/>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
              {Object.entries(bandColors).map(([band, color]) => (
                <div key={band} style={{display:"flex",alignItems:"center",gap:3,fontSize:8,color:"#555"}}>
                  <div style={{width:8,height:8,background:color}}/>{band}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metrics View */}
        {activeView === "metrics" && (
          <div>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>QUANTITATIVE METRICS</div>

            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:"#aaa",marginBottom:6}}>Band Power Distribution (Global)</div>
              {Object.entries(bandLabels).map(([band, label]) => {
                const total = analysis.avgBands.total || 1;
                const pct = ((analysis.avgBands[band] / total) * 100).toFixed(1);
                return (
                  <div key={band} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid #111"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:8,height:8,background:bandColors[band]}}/>
                      <span style={{fontSize:10,color:"#888"}}>{label}</span>
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:bandColors[band],fontFamily:"'IBM Plex Mono', monospace"}}>{pct}%</span>
                  </div>
                );
              })}
            </div>

            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:"#aaa",marginBottom:6}}>Key Indices</div>
              {[
                { label: "Peak Alpha Frequency", value: `${analysis.peakAlphaFreq.toFixed(2)} Hz`, note: "Normal range: 9-11 Hz" },
                { label: "Frontal Theta/Beta Ratio", value: analysis.thetaBetaRatio.toFixed(3), note: "Elevated >3.0 may indicate attentional variance" },
                { label: "Alpha Asymmetry Index (R-L)", value: `${analysis.asymmetryIndex>0?"+":""}${analysis.asymmetryIndex.toFixed(2)}%`, note: "Values >15% indicate hemispheric difference" },
                { label: "Dominant Frequency", value: `${analysis.peakAlphaFreq > 8 ? "Alpha" : analysis.peakAlphaFreq > 4 ? "Theta" : "Delta"} range`, note: `${analysis.peakAlphaFreq.toFixed(1)} Hz` },
              ].map((m, i) => (
                <div key={i} style={{padding:"6px 0",borderBottom:"1px solid #111"}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:"#888"}}>{m.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}</span>
                  </div>
                  <div style={{fontSize:8,color:"#444",marginTop:2}}>{m.note}</div>
                </div>
              ))}
            </div>

            <div style={{fontSize:8,color:"#333",padding:"8px 0",borderTop:"1px solid #1a1a1a",lineHeight:1.5}}>
              Quantitative values are computed from the current epoch. These are mathematical observations, not clinical interpretations. All metrics should be reviewed by a qualified professional.
            </div>
          </div>
        )}

        {/* Flags View */}
        {activeView === "flags" && (
          <div>
            <div style={{fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:10}}>EPOCH FLAGS</div>
            {analysis.flags.length === 0 ? (
              <div style={{padding:20,textAlign:"center",color:"#333",fontSize:11}}>No flags for this epoch</div>
            ) : (
              analysis.flags.map((f, i) => (
                <div key={i} style={{
                  display:"flex",alignItems:"center",gap:8,padding:"6px 8px",marginBottom:4,
                  background:f.severity==="high"?"#1a0a0a":"#1a1a0a",
                  border:`1px solid ${f.severity==="high"?"#991b1b30":"#854d0e30"}`,
                }}>
                  <span style={{fontSize:10,fontWeight:700,color:f.severity==="high"?"#f87171":"#facc15",fontFamily:"'IBM Plex Mono', monospace",width:60}}>{f.channel}</span>
                  <span style={{fontSize:10,color:"#aaa",flex:1}}>{f.type}</span>
                  <span style={{fontSize:10,fontWeight:700,color:f.severity==="high"?"#f87171":"#facc15",fontFamily:"'IBM Plex Mono', monospace"}}>{f.value}</span>
                </div>
              ))
            )}
            {analysis.flags.length > 0 && (
              <div style={{fontSize:8,color:"#444",marginTop:10,lineHeight:1.5}}>
                Flags indicate channels where band power exceeds threshold values for the current epoch. Elevated delta ({">"}60%) or theta ({">"}40%) relative power may warrant further review.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{padding:"6px 12px",borderTop:"1px solid #1a1a1a",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:8,color:"#333"}}>qEEG v0.1 - Observational metrics only</span>
        <button onClick={()=>{
          const report = {
            timestamp: new Date().toISOString(),
            epochStart,
            sampleRate,
            channels: channels.length,
            bandPower: analysis.avgBands,
            peakAlphaFrequency: analysis.peakAlphaFreq,
            thetaBetaRatio: analysis.thetaBetaRatio,
            asymmetryIndex: analysis.asymmetryIndex,
            flags: analysis.flags,
            perChannel: analysis.channelData.map(c => ({ channel: c.channel, ...c.bands })),
          };
          const blob = new Blob([JSON.stringify(report, null, 2)], {type:"application/json"});
          const url = URL.createObjectURL(blob); const a = document.createElement("a");
          a.href = url; a.download = `qEEG-report-epoch${Math.floor(epochStart/epochSec)+1}.json`; a.click(); URL.revokeObjectURL(url);
        }} style={{padding:"3px 8px",background:"#111",border:"1px solid #222",color:"#666",cursor:"pointer",fontSize:9,fontWeight:600}}>
          {I.Save(12)} Export
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ANNOTATION PANEL — floating draggable overlay
// ══════════════════════════════════════════════════════════════
function AnnotationPanel({ annotations, setAnnotations, isAddingAnnotation, setIsAddingAnnotation,
  selectedAnnotationType, setSelectedAnnotationType, epochStart, epochEnd, epochSec, setCurrentEpoch, filename, onClose,
  panelPos, setPanelPos }) {
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef(null);

  // Default position: right side, lower on screen
  useEffect(() => {
    if (panelPos.x === null) {
      setPanelPos({ x: window.innerWidth - 290, y: Math.round(window.innerHeight * 0.35) });
    }
  }, []);

  const onMouseDown = (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    setDragging(true);
    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => setPanelPos({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, dragOffset]);

  return (
    <div ref={panelRef} style={{
      position:"fixed", left:panelPos.x, top:panelPos.y, width:260, maxHeight:"70vh",
      background:"#0c0c0c", border:"1px solid #2a2a2a", borderRadius:0,
      display:"flex", flexDirection:"column", zIndex:80,
      cursor: dragging ? "grabbing" : "default",
      userSelect: dragging ? "none" : "auto",
    }}>
      {/* Drag handle header */}
      <div onMouseDown={onMouseDown} style={{ padding:"8px 12px", borderBottom:"1px solid #1a1a1a",
        display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"grab" }}>
        <span style={{fontSize:10,fontWeight:700,color:"#666",letterSpacing:"0.1em"}}>ANNOTATIONS</span>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={()=>setIsAddingAnnotation(!isAddingAnnotation)} style={controlBtn(isAddingAnnotation)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Plus()} ADD</span>
          </button>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#555",cursor:"pointer",padding:2}}>{I.X()}</button>
        </div>
      </div>
      {isAddingAnnotation && (
        <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{...microLabel,marginBottom:6}}>Type</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {ANNOTATION_COLORS.map((ac,i)=>(
              <button key={i} onClick={()=>setSelectedAnnotationType(i)} style={{
                padding:"3px 8px",borderRadius:0,fontSize:9,fontWeight:600,cursor:"pointer",
                background:selectedAnnotationType===i?ac.color+"30":"#111",
                border:`1px solid ${selectedAnnotationType===i?ac.color+"60":"#222"}`,
                color:selectedAnnotationType===i?ac.color:"#666",
              }}>{ac.name}</button>
            ))}
          </div>
          <div style={{fontSize:10,color:"#444",marginTop:6}}>Click on the waveform to place</div>
        </div>
      )}
      <div style={{flex:1,overflow:"auto",padding:"6px 0"}}>
        {annotations.length===0 ? (
          <div style={{padding:20,textAlign:"center",color:"#333",fontSize:11}}>No annotations yet</div>
        ) : annotations.sort((a,b)=>a.time-b.time).map(ann=>(
          <div key={ann.id} onClick={()=>setCurrentEpoch(Math.floor(ann.time/epochSec))} style={{
            padding:"8px 12px",borderBottom:"1px solid #111",cursor:"pointer",transition:"background 0.1s",
            background:(ann.time>=epochStart&&ann.time<epochEnd)?"#111":"transparent",
          }} onMouseEnter={e=>e.currentTarget.style.background="#151515"}
             onMouseLeave={e=>e.currentTarget.style.background=(ann.time>=epochStart&&ann.time<epochEnd)?"#111":"transparent"}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:8,height:8,borderRadius:0,background:ann.color,flexShrink:0}}/>
                <span style={{fontSize:11,fontWeight:600,color:ann.color}}>{ann.type}</span>
              </div>
              <button onClick={e=>{e.stopPropagation();setAnnotations(annotations.filter(a=>a.id!==ann.id));}} style={{
                background:"none",border:"none",color:"#333",cursor:"pointer",padding:2
              }}>{I.Trash()}</button>
            </div>
            <div style={{fontSize:10,color:"#555",marginTop:2}}>
              {Math.floor(ann.time/60)}:{String(Math.floor(ann.time%60)).padStart(2,"0")}.{String(Math.round((ann.time%1)*100)).padStart(2,"0")}
              {ann.duration>0&&<span> — {ann.duration.toFixed(1)}s</span>}
            </div>
            {ann.text&&ann.text!==ann.type&&<div style={{fontSize:10,color:"#444",marginTop:2}}>{ann.text}</div>}
          </div>
        ))}
      </div>
      <div style={{padding:"8px 12px",borderTop:"1px solid #1a1a1a"}}>
        <button onClick={()=>{
          const blob=new Blob([JSON.stringify(annotations,null,2)],{type:"application/json"});
          const url=URL.createObjectURL(blob); const a=document.createElement("a");
          a.href=url; a.download=`${filename||"annotations"}_annotations.json`; a.click(); URL.revokeObjectURL(url);
        }} style={{ width:"100%",padding:"6px 0",background:"#111",border:"1px solid #222",
          borderRadius:0,color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
          display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}>
          {I.Save()} Export
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EPOCH NAV BAR — shared
// ══════════════════════════════════════════════════════════════
function EpochNav({ currentEpoch, setCurrentEpoch, totalEpochs, epochStart, epochEnd }) {
  return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:12,
      padding:"8px 16px",borderTop:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0 }}>
      <button onClick={()=>setCurrentEpoch(0)} style={controlBtn()}>|◀</button>
      <button onClick={()=>setCurrentEpoch(Math.max(0,currentEpoch-1))} style={controlBtn()}>{I.ChevLeft()}</button>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:11,color:"#888"}}>
          Epoch <span style={{color:"#7ec8d9",fontWeight:700}}>{currentEpoch+1}</span>
          <span style={{color:"#444"}}> / {totalEpochs}</span>
        </span>
        <span style={{color:"#333"}}>|</span>
        <span style={{fontSize:11,color:"#555"}}>
          {Math.floor(epochStart/60)}:{String(Math.floor(epochStart%60)).padStart(2,"0")}
          {" — "}
          {Math.floor(epochEnd/60)}:{String(Math.floor(epochEnd%60)).padStart(2,"0")}
        </span>
      </div>
      <input type="range" min={0} max={totalEpochs-1} value={currentEpoch}
        onChange={e=>setCurrentEpoch(parseInt(e.target.value))} style={{width:200,accentColor:"#7ec8d9"}}/>
      <button onClick={()=>setCurrentEpoch(Math.min(totalEpochs-1,currentEpoch+1))} style={controlBtn()}>{I.ChevRight()}</button>
      <button onClick={()=>setCurrentEpoch(totalEpochs-1)} style={controlBtn()}>▶|</button>
      <span style={{color:"#333"}}>|</span>
      <span style={{fontSize:9,color:"#333"}}>← → navigate &nbsp; +/- sensitivity &nbsp; ESC cancel</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ANNOTATION POPUP — at click position
// ══════════════════════════════════════════════════════════════
function AnnotationPopup({ draft, annotationType, text, setText, onConfirm, onCancel, containerRef }) {
  if (!draft) return null;
  const cw = containerRef.current?.getBoundingClientRect().width || 600;
  const ch = containerRef.current?.getBoundingClientRect().height || 400;
  const ac = ANNOTATION_COLORS[annotationType];
  return (
    <div style={{
      position:"absolute",
      left: Math.min(draft.x, cw - 360),
      top: Math.min(draft.y + 12, ch - 60),
      background:"#111", border:`1px solid ${ac.color}40`, borderRadius:0,
      padding:"10px 14px", display:"flex", alignItems:"center", gap:8,
      zIndex:10,
      whiteSpace:"nowrap",
    }}>
      <div style={{width:10,height:10,borderRadius:0,background:ac.color}}/>
      <span style={{fontSize:11,color:"#aaa"}}>{ac.name} @ {draft.time.toFixed(2)}s</span>
      <input value={text} onChange={e=>setText(e.target.value)} placeholder="Add note..."
        style={{ background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
          color:"#e0e0e0",fontSize:11,padding:"4px 8px",width:160,outline:"none" }}
        autoFocus onKeyDown={e=>e.key==="Enter"&&onConfirm()}/>
      <button onClick={onConfirm} style={{
        padding:"4px 10px",background:"#1a4a54",border:"1px solid #4a9bab40",
        borderRadius:0,color:"#7ec8d9",fontSize:10,fontWeight:700,cursor:"pointer"
      }}>SAVE</button>
      <button onClick={onCancel} style={{
        padding:"4px 8px",background:"none",border:"1px solid #333",
        borderRadius:0,color:"#666",fontSize:10,cursor:"pointer"
      }}>ESC</button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EEG SYSTEM TYPES — electrode placement standards
// ══════════════════════════════════════════════════════════════
const EEG_SYSTEMS = {
  "10-20": { label: "10-20 (Standard)", electrodes: ELECTRODE_SETS["10-20"].length },
  "hd-40": { label: "HD-40 (High Density)", electrodes: ELECTRODE_SETS["hd-40"].length },
  "10-10": { label: "10-10 (Extended)", electrodes: ELECTRODE_SETS["10-10"].length },
};

// ══════════════════════════════════════════════════════════════
// CHANNEL CONTEXT MENU — right-click on channel label
// ══════════════════════════════════════════════════════════════
function ChannelContextMenu({ x, y, channelName, isHidden, channelSens, onToggleVisibility, onAdjustSensitivity, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const item = (label, color, onClick) => (
    <button onClick={(e)=>{e.stopPropagation();onClick();}} style={{
      display:"flex",alignItems:"center",gap:8,width:"100%",padding:"6px 12px",
      background:"transparent",border:"none",color,fontSize:11,fontWeight:500,
      cursor:"pointer",fontFamily:"'IBM Plex Mono', monospace",transition:"background 0.1s",
    }} onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
       onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      {label}
    </button>
  );

  return (
    <div ref={menuRef} style={{
      position:"fixed",left:x,top:y,zIndex:100,width:180,
      background:"#111",border:"1px solid #2a2a2a",borderRadius:0,
      overflow:"hidden",
    }}>
      <div style={{padding:"6px 12px",borderBottom:"1px solid #1a1a1a",fontSize:10,color:"#7ec8d9",fontWeight:700}}>
        {channelName}
      </div>
      {item(isHidden ? "Show Channel" : "Hide Channel", isHidden ? "#7ec8d9" : "#888", () => { onToggleVisibility(); onClose(); })}
      <div style={{borderTop:"1px solid #1a1a1a"}}/>
      <div style={{padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontSize:10,color:"#666"}}>Sensitivity</span>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <button onClick={()=>onAdjustSensitivity(-1)} style={{
            width:22,height:22,background:"#0a0a0a",border:"1px solid #333",borderRadius:0,
            color:"#aaa",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",
          }}>−</button>
          <span style={{fontSize:11,color:"#ccc",fontFamily:"'IBM Plex Mono', monospace",minWidth:20,textAlign:"center"}}>
            {channelSens > 0 ? `+${channelSens}` : channelSens}
          </span>
          <button onClick={()=>onAdjustSensitivity(1)} style={{
            width:22,height:22,background:"#0a0a0a",border:"1px solid #333",borderRadius:0,
            color:"#aaa",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",
          }}>+</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// useEEGState — shared hook for viewer state
// ══════════════════════════════════════════════════════════════
function useEEGState(totalDuration = 600, edfData = null) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [montage, setMontage] = useState("bipolar-longitudinal");
  const [eegSystem, setEegSystem] = useState("10-20");
  const [hpf, setHpf] = useState(1);
  const [lpf, setLpf] = useState(70);
  const [notch, setNotch] = useState(60);
  const [epochSec, setEpochSec] = useState(10);
  const [currentEpoch, setCurrentEpoch] = useState(0);
  const [sensitivity, setSensitivity] = useState(7);
  const [sampleRate] = useState(256);
  const [annotations, setAnnotations] = useState([]);
  const [selectedAnnotationType, setSelectedAnnotationType] = useState(0);
  const [isAddingAnnotation, setIsAddingAnnotation] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState(null);
  const [showAnnotationPanel, setShowAnnotationPanel] = useState(true);
  const [hoveredTime, setHoveredTime] = useState(null);
  const [annotationText, setAnnotationText] = useState("");
  const [hiddenChannels, setHiddenChannels] = useState(new Set());
  const [channelSensitivity, setChannelSensitivity] = useState({});
  const [channelHpf, setChannelHpf] = useState({});
  const [channelLpf, setChannelLpf] = useState({});
  const [contextMenu, setContextMenu] = useState(null);

  const allChannels = getMontageChannels(montage, eegSystem);
  const channels = allChannels.filter(ch => !hiddenChannels.has(ch));
  const totalEpochs = Math.ceil(totalDuration / epochSec);
  const epochStart = currentEpoch * epochSec;
  const epochEnd = Math.min(epochStart + epochSec, totalDuration);

  const toggleChannelVisibility = (ch) => {
    setHiddenChannels(prev => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch); else next.add(ch);
      return next;
    });
  };

  const adjustChannelSensitivity = (ch, delta) => {
    setChannelSensitivity(prev => ({ ...prev, [ch]: (prev[ch] || 0) + delta }));
  };

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const chHeight = rect.height / channels.length;
    const chIdx = Math.floor(y / chHeight);
    if (chIdx >= 0 && chIdx < channels.length) {
      setContextMenu({ x: e.clientX, y: e.clientY, channel: channels[chIdx], index: chIdx });
    }
  }, [channels]);

  const waveformData = useMemo(() => {
    return channels.map((ch) => {
      const fullIdx = allChannels.indexOf(ch);
      let raw;

      // Use real EDF data if available
      if (edfData && edfData.channelData) {
        // Try to match channel label from EDF to montage channel
        // For referential/bipolar, the EDF stores raw electrode data
        // Find the best matching EDF channel index
        const chName = ch.split("-")[0]; // First electrode in derivation
        const edfIdx = edfData.channelLabels.findIndex(l =>
          l.toUpperCase().replace(/[\s\-\.]/g, "") === chName.toUpperCase().replace(/[\s\-\.]/g, "")
        );
        if (edfIdx >= 0) {
          raw = getEDFEpochData(edfData, edfIdx, epochStart, epochSec, sampleRate);
        }
        // If channel is a bipolar derivation (e.g., Fp1-F3), compute difference
        if (ch.includes("-") && ch !== "EKG") {
          const parts = ch.split("-");
          const idx1 = edfData.channelLabels.findIndex(l => l.toUpperCase().replace(/[\s\-\.]/g, "") === parts[0].toUpperCase().replace(/[\s\-\.]/g, ""));
          const idx2 = edfData.channelLabels.findIndex(l => l.toUpperCase().replace(/[\s\-\.]/g, "") === parts[1].toUpperCase().replace(/[\s\-\.]/g, ""));
          if (idx1 >= 0 && idx2 >= 0 && parts[1] !== "Avg" && parts[1] !== "Cz") {
            const d1 = getEDFEpochData(edfData, idx1, epochStart, epochSec, sampleRate);
            const d2 = getEDFEpochData(edfData, idx2, epochStart, epochSec, sampleRate);
            if (d1 && d2) {
              raw = new Float32Array(d1.length);
              for (let i = 0; i < d1.length; i++) raw[i] = d1[i] - (i < d2.length ? d2[i] : 0);
            }
          }
        }
      }

      // Fall back to simulated if no EDF data for this channel
      if (!raw) {
        raw = generateEEGSignal(fullIdx, sampleRate, epochSec, currentEpoch * 1000 + fullIdx);
      }

      const chHpf = channelHpf[ch] !== undefined ? channelHpf[ch] : hpf;
      const chLpf = channelLpf[ch] !== undefined ? channelLpf[ch] : lpf;
      if (chHpf > 0) raw = applyHighPass(raw, chHpf, sampleRate);
      if (chLpf > 0) raw = applyLowPass(raw, chLpf, sampleRate);
      if (notch > 0) raw = applyNotch(raw, notch, sampleRate);
      return raw;
    });
  }, [montage, hpf, lpf, notch, epochSec, currentEpoch, sampleRate, channels, allChannels, hiddenChannels, channelHpf, channelLpf, edfData, epochStart]);

  const getTimeFromX = useCallback((clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - 72;
    const plotW = rect.width - 72 - 16;
    if (x < 0 || x > plotW) return null;
    return epochStart + (x / plotW) * epochSec;
  }, [epochStart, epochSec]);

  const handleCanvasMouseMove = (e) => setHoveredTime(getTimeFromX(e.clientX));
  const handleCanvasClick = (e) => {
    if (!isAddingAnnotation) return;
    const time = getTimeFromX(e.clientX);
    if (time === null) return;
    const cRect = containerRef.current.getBoundingClientRect();
    setAnnotationDraft({ time: Math.round(time*100)/100, duration: 0.2, x: e.clientX-cRect.left, y: e.clientY-cRect.top });
  };
  const confirmAnnotation = () => {
    if (!annotationDraft) return;
    const t = ANNOTATION_COLORS[selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), time: annotationDraft.time, duration: annotationDraft.duration,
      type: t.name, color: t.color, text: annotationText || t.name, channel: -1 }]);
    setAnnotationDraft(null); setAnnotationText(""); setIsAddingAnnotation(false);
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "d") setCurrentEpoch(p => Math.min(p+1, totalEpochs-1));
      if (e.key === "ArrowLeft" || e.key === "a") setCurrentEpoch(p => Math.max(p-1, 0));
      if (e.key === "=") setSensitivity(p => Math.max(p-1, 1));
      if (e.key === "-") setSensitivity(p => Math.min(p+1, 30));
      if (e.key === "Escape") { setIsAddingAnnotation(false); setAnnotationDraft(null); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [totalEpochs]);

  return {
    canvasRef, containerRef, montage, setMontage, eegSystem, setEegSystem,
    hpf, setHpf, lpf, setLpf, notch, setNotch,
    epochSec, setEpochSec: (v) => { setEpochSec(v); setCurrentEpoch(0); },
    currentEpoch, setCurrentEpoch, sensitivity, setSensitivity, sampleRate,
    channels, allChannels, totalEpochs, epochStart, epochEnd, waveformData,
    annotations, setAnnotations, selectedAnnotationType, setSelectedAnnotationType,
    isAddingAnnotation, setIsAddingAnnotation, annotationDraft, setAnnotationDraft,
    showAnnotationPanel, setShowAnnotationPanel, hoveredTime, setHoveredTime,
    annotationText, setAnnotationText,
    hiddenChannels, toggleChannelVisibility, channelSensitivity, adjustChannelSensitivity,
    channelHpf, setChannelHpf, channelLpf, setChannelLpf,
    contextMenu, setContextMenu, handleContextMenu,
    handleCanvasMouseMove, handleCanvasClick, confirmAnnotation,
  };
}

// ══════════════════════════════════════════════════════════════
// TAB: LIBRARY
// ══════════════════════════════════════════════════════════════
function LibraryTab({ records, setRecords, onOpenReview, updateRecordStatus, edfFileStore, setEdfFileStore }) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [viewMode, setViewMode] = useState("table");
  const [showIngest, setShowIngest] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [sortField, setSortField] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const filtered = records.filter(r => {
    if (filterType !== "ALL" && r.studyType !== filterType) return false;
    if (filterStatus !== "ALL" && r.status !== filterStatus) return false;
    if (search) { const s = search.toLowerCase();
      return r.filename.toLowerCase().includes(s) || r.subjectHash.toLowerCase().includes(s)
        || r.sport.toLowerCase().includes(s) || r.position.toLowerCase().includes(s); }
    return true;
  }).sort((a, b) => {
    const d = sortDir === "asc" ? 1 : -1;
    if (sortField === "date") return d * a.date.localeCompare(b.date);
    if (sortField === "fileSize") return d * (a.fileSize - b.fileSize);
    if (sortField === "studyType") return d * a.studyType.localeCompare(b.studyType);
    return 0;
  });

  const stats = {
    total: records.length, verified: records.filter(r=>r.status==="verified").length,
    subjects: new Set(records.map(r=>r.subjectHash)).size,
    totalSize: Math.round(records.reduce((s,r)=>s+r.fileSize,0)*10)/10,
  };
  const handleIngest = (nr) => setRecords([nr, ...records]);
  const deleteRecord = (id) => setRecords(records.filter(r => r.id !== id));
  const toggleSort = (f) => { if (sortField===f) setSortDir(sortDir==="asc"?"desc":"asc"); else { setSortField(f); setSortDir("desc"); } };

  const inputStyle = {
    width:"100%",padding:"8px 10px",background:"#0d0d0d",border:"1px solid #2a2a2a",
    borderRadius:0,color:"#e0e0e0",fontSize:13,fontFamily:"'IBM Plex Mono', monospace",outline:"none",boxSizing:"border-box",
  };
  const formLabel = {display:"block",fontSize:11,color:"#777",marginBottom:4,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"};

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:1,background:"#1a1a1a",borderBottom:"1px solid #1a1a1a"}}>
        {[
          {label:"TOTAL RECORDS",value:stats.total,icon:I.Database()},
          {label:"VERIFIED",value:stats.verified,icon:I.Check()},
          {label:"UNIQUE SUBJECTS",value:stats.subjects,icon:I.Shield()},
          {label:"STORAGE",value:`${stats.totalSize} MB`,icon:I.Zap()},
        ].map((s,i)=>(
          <div key={i} style={{background:"#0a0a0a",padding:"14px 20px"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,color:"#555",fontSize:10,fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>{s.icon} {s.label}</div>
            <div style={{fontSize:22,fontWeight:800,color:"#e0e0e0",fontFamily:"'JetBrains Mono', monospace"}}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{padding:"14px 28px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid #1a1a1a",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,padding:"0 10px",flex:"1 1 200px"}}>
          {I.Search()}
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by filename, hash, sport, position..."
            style={{background:"none",border:"none",color:"#e0e0e0",fontSize:13,padding:"8px 0",outline:"none",width:"100%",fontFamily:"'IBM Plex Mono', monospace"}}/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#555",fontSize:10,fontWeight:700}}>{I.Filter()}</span>
          <select value={filterType} onChange={e=>setFilterType(e.target.value)}
            style={{background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,color:"#aaa",fontSize:12,padding:"6px 8px",outline:"none"}}>
            <option value="ALL">All Types</option>
            {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}
            style={{background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,color:"#aaa",fontSize:12,padding:"6px 8px",outline:"none"}}>
            <option value="ALL">All Status</option>
            <option value="verified">Verified</option><option value="pending">Pending</option><option value="flagged">Flagged</option>
          </select>
        </div>
        <div style={{display:"flex",background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,overflow:"hidden"}}>
          {["table","grid"].map(m=>(
            <button key={m} onClick={()=>setViewMode(m)} style={{
              padding:"6px 10px",background:viewMode===m?"#1a1a1a":"transparent",
              border:"none",color:viewMode===m?"#e0e0e0":"#555",cursor:"pointer"
            }}>{m==="table"?I.List():I.Grid()}</button>
          ))}
        </div>
        <span style={{color:"#555",fontSize:12,fontFamily:"'JetBrains Mono', monospace"}}>{filtered.length} records</span>
        <button onClick={()=>setShowIngest(true)} style={{
          padding:"8px 16px",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,
          color:"#7ec8d9",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6
        }}>{I.Plus()} INGEST</button>
        <button onClick={()=>setShowExport(true)} style={{
          padding:"8px 16px",background:"#111",border:"1px solid #3B82F640",borderRadius:0,
          color:"#3B82F6",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6
        }}>{I.Package()} EXPORT</button>
      </div>

      {/* Table */}
      <div style={{flex:1,overflow:"auto"}}>
        {viewMode==="table" ? (
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead><tr style={{borderBottom:"1px solid #1a1a1a"}}>
              {[{key:"filename",label:"FILENAME",w:"26%"},{key:"studyType",label:"TYPE",w:"9%",sort:true},
                {key:"date",label:"DATE",w:"10%",sort:true},{key:null,label:"CH",w:"5%"},
                {key:null,label:"RATE",w:"6%"},{key:null,label:"DUR",w:"5%"},
                {key:"fileSize",label:"SIZE",w:"6%",sort:true},{key:null,label:"STATUS",w:"16%"},
                {key:null,label:"",w:"8%"},
              ].map((col,i)=>(
                <th key={i} onClick={()=>col.sort&&toggleSort(col.key)} style={{
                  textAlign:"left",padding:"10px 12px",color:"#555",fontSize:10,fontWeight:700,
                  letterSpacing:"0.08em",cursor:col.sort?"pointer":"default",width:col.w,userSelect:"none"
                }}>{col.label}{col.sort&&sortField===col.key&&<span style={{marginLeft:4}}>{sortDir==="asc"?"▲":"▼"}</span>}</th>
              ))}
            </tr></thead>
            <tbody>{filtered.map(r=>{
              const st=STUDY_TYPES[r.studyType]||{label:"?",color:"#666"};
              return (
                <tr key={r.id} style={{borderBottom:"1px solid #111",cursor:"pointer",transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#111"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <td style={{padding:"10px 12px",fontFamily:"'IBM Plex Mono', monospace",fontSize:12,color:"#bbb"}}>{r.filename}</td>
                  <td style={{padding:"10px 12px"}}><TypeBadge record={r}/></td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.date}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.channels}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.sampleRate}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.duration}m</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.fileSize}MB</td>
                  <td style={{padding:"10px 12px"}}><StatusControl status={r.status} size="compact" onSetStatus={(s)=>updateRecordStatus(r.id,s)}/></td>
                  <td style={{padding:"10px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <button onClick={()=>onOpenReview(r)} style={{
                        padding:"4px 10px",background:"#111",border:"1px solid #222",borderRadius:0,
                        color:"#7ec8d9",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4
                      }}>{I.Eye(12)} REVIEW</button>
                      <RecordActions record={r} onDelete={deleteRecord} onOpenReview={onOpenReview}/>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,padding:"20px 28px"}}>
            {filtered.map(r=>{
              const st=STUDY_TYPES[r.studyType]||{label:"?",color:"#666"};
              return (
                <div key={r.id} style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:0,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#333"} onMouseLeave={e=>e.currentTarget.style.borderColor="#1a1a1a"}
                  onClick={()=>onOpenReview(r)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <TypeBadge record={r}/>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <StatusControl status={r.status} size="compact" onSetStatus={(s)=>updateRecordStatus(r.id,s)}/>
                      <RecordActions record={r} onDelete={deleteRecord} onOpenReview={onOpenReview}/>
                    </div>
                  </div>
                  <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:"#7ec8d9",marginBottom:10,wordBreak:"break-all"}}>{r.filename}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px",fontSize:11}}>
                    <span style={{color:"#555"}}>Date</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.date}</span>
                    <span style={{color:"#555"}}>Ch</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.channels}</span>
                    <span style={{color:"#555"}}>Rate</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.sampleRate}Hz</span>
                    <span style={{color:"#555"}}>Size</span><span style={{color:"#999",fontFamily:"'IBM Plex Mono', monospace"}}>{r.fileSize}MB</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {filtered.length===0&&<div style={{textAlign:"center",padding:"60px 20px",color:"#444",fontSize:14}}>No records match your filters.</div>}
      </div>

      {/* Ingest Modal */}
      {showIngest && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowIngest(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:28,width:480,maxHeight:"80vh",overflow:"auto"}}>
            <IngestForm onClose={()=>setShowIngest(false)} onIngest={handleIngest} setEdfFileStore={setEdfFileStore}/>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {showExport && (
        <ExportModal records={records} onClose={()=>setShowExport(false)}/>
      )}

      {/* Detail Panel */}
      {selectedRecord && (
        <div style={{position:"fixed",right:0,top:0,bottom:0,width:400,background:"#0d0d0d",borderLeft:"1px solid #2a2a2a",zIndex:999,overflow:"auto",padding:24}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
            <span style={{color:"#888",fontSize:12,fontWeight:600}}>RECORD DETAIL</span>
            <button onClick={()=>setSelectedRecord(null)} style={{background:"none",border:"none",color:"#666",cursor:"pointer"}}>{I.X()}</button>
          </div>
          <div style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:16,fontFamily:"'IBM Plex Mono', monospace",fontSize:13,color:"#7ec8d9",wordBreak:"break-all",marginBottom:20}}>
            <span style={{color:"#555",fontSize:10,display:"block",marginBottom:4}}>FILENAME</span>{selectedRecord.filename}
          </div>
          <button onClick={()=>{onOpenReview(selectedRecord);setSelectedRecord(null);}} style={{
            width:"100%",padding:"10px 0",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,color:"#7ec8d9",
            cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:12
          }}>{I.Eye()} Open in Review</button>
        </div>
      )}
    </div>
  );
}

// ── ExportModal - select individual records, subjects, or study types to export ──
function ExportModal({ records, onClose }) {
  const [selected, setSelected] = useState(new Set());
  const [filterType, setFilterType] = useState("ALL");

  // Group by subject
  const subjects = {};
  records.forEach(r => {
    if (!subjects[r.subjectHash]) subjects[r.subjectHash] = { hash: r.subjectHash, records: [], sport: r.sport };
    subjects[r.subjectHash].records.push(r);
  });

  const filteredRecords = records.filter(r => filterType === "ALL" || r.studyType === filterType);
  const allFilteredIds = new Set(filteredRecords.map(r => r.id));

  const toggleRecord = (id) => {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const toggleSubject = (subj) => {
    const ids = subj.records.filter(r => allFilteredIds.has(r.id)).map(r => r.id);
    const allSelected = ids.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      ids.forEach(id => { if (allSelected) n.delete(id); else n.add(id); });
      return n;
    });
  };
  const selectAll = () => {
    const ids = filteredRecords.map(r => r.id);
    const allSelected = ids.every(id => selected.has(id));
    setSelected(prev => {
      const n = new Set(prev);
      ids.forEach(id => { if (allSelected) n.delete(id); else n.add(id); });
      return n;
    });
  };

  const doExport = () => {
    const toExport = records.filter(r => selected.has(r.id));
    if (toExport.length === 0) return;
    const bySubject = {};
    toExport.forEach(r => {
      if (!bySubject[r.subjectHash]) bySubject[r.subjectHash] = [];
      bySubject[r.subjectHash].push(r);
    });
    const manifest = {
      exportDate: new Date().toISOString(),
      totalRecords: toExport.length,
      subjects: Object.entries(bySubject).map(([hash, recs]) => ({
        subjectHash: hash,
        recordCount: recs.length,
        records: recs.map(r => ({
          filename: r.filename, studyType: r.studyType, date: r.date,
          channels: r.channels, sampleRate: r.sampleRate, duration: r.duration, status: r.status,
          edfPath: `data/${r.studyType}/${r.filename}`,
          annotationPath: `annotations/${r.filename.replace('.edf','_annotations.json')}`,
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `REACT-EXPORT-${toExport.length}files-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const chk = (checked, onClick) => (
    <button onClick={onClick} style={{
      width:16,height:16,borderRadius:0,flexShrink:0,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
      background:checked?"#1a4a54":"#1a1a1a",border:`1px solid ${checked?"#4a9bab50":"#333"}`,color:checked?"#7ec8d9":"#555",fontSize:9,
    }}>{checked?"✓":" "}</button>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:0,width:620,maxHeight:"85vh",overflow:"hidden",display:"flex",flexDirection:"column"}}>

        {/* Header */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <h3 style={{margin:0,color:"#e0e0e0",fontSize:16,fontWeight:700}}>Export Data</h3>
            <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
          </div>

          {/* Filter by study type + select all */}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <select value={filterType} onChange={e=>{setFilterType(e.target.value);setSelected(new Set());}}
              style={{background:"#0a0a0a",border:"1px solid #222",borderRadius:0,color:"#aaa",fontSize:11,padding:"4px 8px",outline:"none",fontFamily:"'IBM Plex Mono', monospace"}}>
              <option value="ALL">All Study Types</option>
              {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
            <button onClick={selectAll} style={{
              padding:"4px 10px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,fontFamily:"'IBM Plex Mono', monospace",
            }}>{filteredRecords.every(r=>selected.has(r.id))&&filteredRecords.length>0?"Deselect All":"Select All"}</button>
            <div style={{flex:1}}/>
            <span style={{fontSize:11,color:selected.size>0?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace"}}>
              {selected.size} selected
            </span>
          </div>
        </div>

        {/* Record list grouped by subject */}
        <div style={{flex:1,overflow:"auto"}}>
          {Object.values(subjects).map(subj => {
            const visible = subj.records.filter(r => allFilteredIds.has(r.id));
            if (visible.length === 0) return null;
            const allSubjSelected = visible.every(r => selected.has(r.id));
            const someSelected = visible.some(r => selected.has(r.id));
            return (
              <div key={subj.hash}>
                {/* Subject header */}
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 20px",background:"#0d0d0d",borderBottom:"1px solid #111"}}>
                  {chk(allSubjSelected, ()=>toggleSubject(subj))}
                  <span style={{fontSize:12,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{subj.hash}</span>
                  <span style={{fontSize:10,color:"#555"}}>{subj.sport}</span>
                  <span style={{fontSize:10,color:"#444"}}>{visible.length} recording{visible.length!==1?"s":""}</span>
                </div>
                {/* Individual records */}
                {visible.map(r => {
                  const st = STUDY_TYPES[r.studyType] || {label:"?",color:"#666"};
                  const isSel = selected.has(r.id);
                  return (
                    <div key={r.id} onClick={()=>toggleRecord(r.id)} style={{
                      display:"flex",alignItems:"center",gap:8,padding:"6px 20px 6px 40px",
                      borderBottom:"1px solid #0a0a0a",cursor:"pointer",
                      background:isSel?"#0a1a20":"transparent",transition:"background 0.1s",
                    }} onMouseEnter={e=>e.currentTarget.style.background=isSel?"#0a1a20":"#0d0d0d"}
                       onMouseLeave={e=>e.currentTarget.style.background=isSel?"#0a1a20":"transparent"}>
                      {chk(isSel, ()=>toggleRecord(r.id))}
                      <span style={{padding:"2px 6px",borderRadius:0,fontSize:9,fontWeight:700,
                        background:st.color+"18",color:st.color,border:`1px solid ${st.color}30`}}>{st.label}</span>
                      <span style={{flex:1,fontSize:11,color:isSel?"#ccc":"#777",fontFamily:"'IBM Plex Mono', monospace"}}>{r.filename}</span>
                      <span style={{fontSize:10,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{r.date}</span>
                      <StatusBadge status={r.status}/>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 20px",borderTop:"1px solid #1a1a1a",background:"#0a0a0a"}}>
          <div style={{fontSize:10,color:"#555"}}>
            {selected.size} of {records.length} records selected
            {selected.size > 0 && (
              <span style={{color:"#444",marginLeft:8}}>
                ({new Set(records.filter(r=>selected.has(r.id)).map(r=>r.subjectHash)).size} subject{new Set(records.filter(r=>selected.has(r.id)).map(r=>r.subjectHash)).size!==1?"s":""})
              </span>
            )}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setSelected(new Set())} style={{
              padding:"6px 14px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:11,fontWeight:600,
            }}>Clear</button>
            <button onClick={doExport} disabled={selected.size===0} style={{
              padding:"6px 18px",background:selected.size>0?"#0a0a2a":"#1a1a1a",
              border:`1px solid ${selected.size>0?"#3B82F640":"#222"}`,borderRadius:0,
              color:selected.size>0?"#3B82F6":"#555",cursor:selected.size>0?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4,
            }}>{I.Package()} Export {selected.size > 0 ? `(${selected.size})` : ""}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IngestForm({ onClose, onIngest, setEdfFileStore }) {
  const [form, setForm] = useState({
    subjectId:"",studyType:"BL",date:new Date().toISOString().split("T")[0],
    channels:21,sampleRate:256,duration:30,montage:"10-20",notes:"",
  });
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);
  const fileInputRef = useRef(null);

  const inputStyle = {width:"100%",padding:"8px 10px",background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:0,color:"#e0e0e0",fontSize:13,fontFamily:"'IBM Plex Mono', monospace",outline:"none",boxSizing:"border-box"};
  const formLabel = {display:"block",fontSize:11,color:"#777",marginBottom:4,fontWeight:600,letterSpacing:"0.05em",textTransform:"uppercase"};

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSelectedFile(file);

    // Extract info from filename and file size
    const name = file.name;
    const sizeMB = Math.round(file.size / 1024 / 1024 * 10) / 10;
    const isEdf = name.toLowerCase().endsWith(".edf") || name.toLowerCase().endsWith(".bdf");

    // Try to parse REACT naming convention if present
    const reactMatch = name.match(/REACT-(\w+)-(\w+)-(\d{4})(\d{2})(\d{2})/);

    // Estimate duration from file size (rough: filesize / (channels * sampleRate * 2 bytes) / 60)
    const estChannels = form.channels || 21;
    const estRate = form.sampleRate || 256;
    const estDuration = Math.round(file.size / (estChannels * estRate * 2) / 60);

    setFileInfo({
      name: name,
      size: sizeMB,
      isEdf: isEdf,
      estDuration: estDuration > 0 ? estDuration : 30,
    });

    // Auto-fill form from file info
    if (reactMatch) {
      const studyType = reactMatch[1];
      const dateStr = `${reactMatch[3]}-${reactMatch[4]}-${reactMatch[5]}`;
      if (STUDY_TYPES[studyType]) setForm(prev => ({...prev, studyType}));
      setForm(prev => ({...prev, date: dateStr}));
    } else {
      // Try to get date from file lastModified
      const fDate = new Date(file.lastModified).toISOString().split("T")[0];
      setForm(prev => ({...prev, date: fDate}));
    }

    if (estDuration > 0) {
      setForm(prev => ({...prev, duration: estDuration}));
    }

    // Read EDF header (first 256 bytes) for channel/sample info
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const header = new Uint8Array(ev.target.result);
        const decoder = new TextDecoder("ascii");
        // EDF spec: bytes 236-244 = number of data records, 244-252 = duration of record
        // bytes 252-256 = number of signals
        const nSignals = parseInt(decoder.decode(header.slice(252, 256)).trim());
        if (nSignals > 0 && nSignals < 200) {
          setForm(prev => ({...prev, channels: nSignals}));
          setFileInfo(prev => ({...prev, detectedChannels: nSignals}));
        }
        // bytes 236-244 = number of data records
        const nRecords = parseInt(decoder.decode(header.slice(236, 244)).trim());
        // bytes 244-252 = duration of a data record in seconds
        const recordDuration = parseFloat(decoder.decode(header.slice(244, 252)).trim());
        if (nRecords > 0 && recordDuration > 0) {
          const totalMin = Math.round(nRecords * recordDuration / 60);
          if (totalMin > 0) {
            setForm(prev => ({...prev, duration: totalMin}));
            setFileInfo(prev => ({...prev, detectedDuration: totalMin}));
          }
        }
        // Patient ID from bytes 8-88
        const patientId = decoder.decode(header.slice(8, 88)).trim();
        if (patientId && patientId !== "X" && patientId.length > 0) {
          setFileInfo(prev => ({...prev, patientField: patientId}));
        }
        // Recording date from bytes 168-176
        const startDate = decoder.decode(header.slice(168, 176)).trim();
        if (startDate) {
          setFileInfo(prev => ({...prev, startDate}));
        }
      } catch (err) {
        // Not a valid EDF, that's fine
      }
    };
    reader.readAsArrayBuffer(file.slice(0, 512));
  };

  const handleSubmit = () => {
    if (!form.subjectId) return;
    const fileSizeMB = selectedFile ? Math.round(selectedFile.size/1024/1024*10)/10 :
      Math.round(form.channels*form.sampleRate*form.duration*60*2/1024/1024*10)/10;
    const deIdFilename = generateFilename(form.subjectId,form.studyType,form.date);
    const record = {
      id:`REC-${Date.now()}`,subjectHash:hashSubjectId(form.subjectId),subjectId:form.subjectId,sport:"",position:"",
      studyType:form.studyType,date:form.date,filename:deIdFilename,
      channels:form.channels,duration:form.duration,sampleRate:form.sampleRate,
      fileSize:fileSizeMB,
      montage:form.montage,status:"pending",isTest:false,notes:form.notes,uploadedAt:new Date().toISOString(),
      sourceFile: selectedFile ? selectedFile.name : null,
      hasEdfData: !!selectedFile,
    };

    if (selectedFile && setEdfFileStore) {
      // Read the full file and parse EDF
      const reader = new FileReader();
      reader.onload = (ev) => {
        const parsed = parseEDFFile(ev.target.result);
        if (!parsed.error) {
          setEdfFileStore(prev => ({ ...prev, [deIdFilename]: parsed }));
        }
      };
      reader.readAsArrayBuffer(selectedFile);
    }

    onIngest(record);
    onClose();
  };

  return (<>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
      <h3 style={{margin:0,color:"#e0e0e0",fontSize:16,fontWeight:700}}>Ingest New Record</h3>
      <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
    </div>

    {/* File picker */}
    <div style={{marginBottom:20}}>
      <input ref={fileInputRef} type="file" accept=".edf,.bdf,.EDF,.BDF" onChange={handleFileSelect}
        style={{display:"none"}}/>
      <button onClick={()=>fileInputRef.current.click()} style={{
        width:"100%",padding:"16px 20px",background:"#0a0a0a",border:"2px dashed #2a2a2a",borderRadius:0,
        color:selectedFile?"#7ec8d9":"#555",cursor:"pointer",fontSize:12,fontWeight:600,
        display:"flex",flexDirection:"column",alignItems:"center",gap:8,transition:"border-color 0.15s",
      }}
        onMouseEnter={e=>e.currentTarget.style.borderColor="#4a9bab"}
        onMouseLeave={e=>e.currentTarget.style.borderColor="#2a2a2a"}>
        {selectedFile ? (<>
          <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Check(14)} File Selected</span>
          <span style={{fontSize:11,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{selectedFile.name}</span>
          <span style={{fontSize:10,color:"#555"}}>{fileInfo?.size} MB{fileInfo?.detectedChannels ? ` - ${fileInfo.detectedChannels} channels detected` : ""}{fileInfo?.detectedDuration ? ` - ${fileInfo.detectedDuration} min` : ""}</span>
        </>) : (<>
          <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Upload(14)} Select EDF / BDF File</span>
          <span style={{fontSize:10,color:"#444"}}>Click to browse, or drag and drop</span>
        </>)}
      </button>
      {fileInfo && !fileInfo.isEdf && (
        <div style={{marginTop:6,fontSize:10,color:"#F59E0B"}}>Warning: file does not have .edf or .bdf extension</div>
      )}
      {fileInfo?.patientField && (
        <div style={{marginTop:6,fontSize:10,color:"#F59E0B"}}>
          EDF header contains patient ID field: "{fileInfo.patientField}" - this will NOT be stored. De-identified filename will be used.
        </div>
      )}
    </div>

    {form.subjectId&&<div style={{background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,padding:"8px 12px",marginBottom:20,fontFamily:"'IBM Plex Mono', monospace",fontSize:12,color:"#7ec8d9"}}>
      <span style={{color:"#555",fontSize:10,display:"block",marginBottom:2}}>DE-IDENTIFIED FILENAME</span>{generateFilename(form.subjectId,form.studyType,form.date)}
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
      <div><label style={formLabel}>Internal Subject ID</label><SubjectIdInput value={form.subjectId} onChange={v=>setForm({...form,subjectId:v})}/></div>
      <div><label style={formLabel}>Study Type</label><select style={inputStyle} value={form.studyType} onChange={e=>setForm({...form,studyType:e.target.value})}>{Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
      <div><label style={formLabel}>Recording Date</label><input style={inputStyle} type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></div>
      <div><label style={formLabel}>Montage</label><select style={inputStyle} value={form.montage} onChange={e=>setForm({...form,montage:e.target.value})}><option value="10-20">10-20</option><option value="10-10">10-10</option><option value="hd-40">HD-40</option><option value="Custom">Custom</option></select></div>
      <div><label style={formLabel}>Channels</label><input style={inputStyle} type="number" value={form.channels} onChange={e=>setForm({...form,channels:parseInt(e.target.value)||0})}/></div>
      <div><label style={formLabel}>Sample Rate (Hz)</label><select style={inputStyle} value={form.sampleRate} onChange={e=>setForm({...form,sampleRate:parseInt(e.target.value)})}><option value={128}>128 Hz</option><option value={256}>256 Hz</option><option value={512}>512 Hz</option><option value={1024}>1024 Hz</option><option value={2048}>2048 Hz</option></select></div>
      <div><label style={formLabel}>Duration (min)</label><input style={inputStyle} type="number" value={form.duration} onChange={e=>setForm({...form,duration:parseInt(e.target.value)||0})}/></div>
      <div><label style={formLabel}>Notes</label><input style={inputStyle} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Optional notes"/></div>
    </div>
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <button onClick={onClose} style={{padding:"8px 16px",background:"transparent",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:13}}>Cancel</button>
      <button onClick={handleSubmit} disabled={!form.subjectId} style={{padding:"8px 20px",background:form.subjectId?"#1a4a54":"#1a1a1a",border:"1px solid "+(form.subjectId?"#4a9bab":"#333"),borderRadius:0,color:form.subjectId?"#7ec8d9":"#555",cursor:form.subjectId?"pointer":"default",fontSize:13,fontWeight:600}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Upload()} Ingest Record</span>
      </button>
    </div>
  </>);
}

// ══════════════════════════════════════════════════════════════
// TAB: REVIEW
// ══════════════════════════════════════════════════════════════
function ReviewTab({ record, updateRecordStatus, records, onSelectRecord, annotationsMap, setAnnotationsMap, edfFileStore }) {
  const filename = record?.filename || "REACT-BL-A7F3-20260308-001.edf";
  const edfData = edfFileStore?.[filename] || null;
  const totalDur = edfData ? edfData.totalDuration : 600;
  const eeg = useEEGState(totalDur, edfData);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisPanelPos, setAnalysisPanelPos] = useState({ x: null, y: null });
  const annotations = annotationsMap[filename] || [];
  const setAnnotations = (newAnns) => {
    const resolved = typeof newAnns === "function" ? newAnns(annotations) : newAnns;
    setAnnotationsMap(prev => ({ ...prev, [filename]: resolved }));
  };

  // Override eeg annotations with app-level ones
  eeg.annotations = annotations;
  eeg.setAnnotations = setAnnotations;
  const origConfirm = eeg.confirmAnnotation;
  eeg.confirmAnnotation = () => {
    if (!eeg.annotationDraft) return;
    const t = ANNOTATION_COLORS[eeg.selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), time: eeg.annotationDraft.time, duration: eeg.annotationDraft.duration,
      type: t.name, color: t.color, text: eeg.annotationText || t.name, channel: -1 }]);
    eeg.setAnnotationDraft(null); eeg.setAnnotationText(""); eeg.setIsAddingAnnotation(false);
  };

  // Auto-verify pending records when opened for review
  useEffect(() => {
    if (record && record.status === "pending") {
      updateRecordStatus(record.id, "verified");
    }
  }, [record?.id]);

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* File info bar */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 16px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",fontSize:10,color:"#555"}}>
        <span onClick={()=>setShowFilePicker(!showFilePicker)} style={{
          color:"#7ec8d9",fontWeight:700,cursor:"pointer",textDecoration:"underline",textDecorationStyle:"dotted",
          textUnderlineOffset:3,transition:"color 0.15s",
        }} title="Click to open another file">{filename}</span>
        <span style={{color:"#333"}}>|</span><span>{eeg.sampleRate}Hz</span>
        <span style={{color:"#333"}}>|</span><span>{eeg.channels.length}ch</span>
        {eeg.hiddenChannels.size > 0 && <span style={{color:"#F59E0B"}}>({eeg.hiddenChannels.size} hidden)</span>}
        <span style={{color:"#333"}}>|</span><span>{edfData ? `${Math.floor(edfData.totalDuration/60)}:${String(Math.floor(edfData.totalDuration%60)).padStart(2,"0")}` : "10:00"}</span>
        <span style={{color:"#333"}}>|</span>
        <span style={{color:edfData?"#10B981":"#555",fontWeight:edfData?700:400}}>{edfData?"LIVE EDF":"SIMULATED"}</span>
        <div style={{flex:1}}/>
        {record && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:9,color:"#444",fontWeight:600,letterSpacing:"0.08em"}}>STATUS</span>
            <StatusControl status={record.status} size="normal"
              onSetStatus={(s) => updateRecordStatus(record.id, s)}/>
          </div>
        )}
      </div>

      {/* File picker dropdown */}
      {showFilePicker && records && (
        <div style={{position:"relative",zIndex:50}}>
          <div style={{position:"absolute",left:16,top:0,width:500,maxHeight:300,overflow:"auto",
            background:"#111",border:"1px solid #2a2a2a",borderRadius:0}}>
            <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",fontSize:10,color:"#666",fontWeight:700,letterSpacing:"0.08em"}}>
              SELECT FILE TO REVIEW
            </div>
            {records.map(r => (
              <button key={r.id} onClick={()=>{onSelectRecord(r);setShowFilePicker(false);}} style={{
                display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",
                padding:"8px 12px",background:r.id===record?.id?"#1a2a30":"transparent",
                border:"none",cursor:"pointer",borderBottom:"1px solid #111",transition:"background 0.1s",
                color:"#ccc",fontFamily:"'IBM Plex Mono', monospace",fontSize:11,
              }} onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
                 onMouseLeave={e=>e.currentTarget.style.background=r.id===record?.id?"#1a2a30":"transparent"}>
                <span style={{color:"#7ec8d9"}}>{r.filename}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <StatusBadge status={r.status}/>
                  <span style={{color:"#555"}}>{r.date}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <EEGControls montage={eeg.montage} setMontage={eeg.setMontage}
        eegSystem={eeg.eegSystem} setEegSystem={eeg.setEegSystem} recordingSystem={record?.eegSystem || "10-20"}
        hpf={eeg.hpf} setHpf={eeg.setHpf}
        lpf={eeg.lpf} setLpf={eeg.setLpf} notch={eeg.notch} setNotch={eeg.setNotch}
        epochSec={eeg.epochSec} setEpochSec={eeg.setEpochSec} sensitivity={eeg.sensitivity} setSensitivity={eeg.setSensitivity}
        rightContent={<>
          {eeg.hiddenChannels.size > 0 && (
            <button onClick={(e)=>{e.stopPropagation();eeg.allChannels.forEach(ch=>{if(eeg.hiddenChannels.has(ch))eeg.toggleChannelVisibility(ch);});}} style={{...controlBtn(),color:"#F59E0B",border:"1px solid #F59E0B40"}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Eye(12)} Show All ({eeg.hiddenChannels.size})</span>
            </button>
          )}
          <button onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
          </button>
          <button onClick={(e)=>{e.stopPropagation();setShowAnalysis(prev => !prev);}} style={controlBtn(showAnalysis)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.BarChart()} qEEG</span>
          </button>
          <button onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
          </button>
        </>}/>
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <WaveformCanvas channels={eeg.channels} waveformData={eeg.waveformData} epochSec={eeg.epochSec}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} sampleRate={eeg.sampleRate}
          sensitivity={eeg.sensitivity} channelSensitivity={eeg.channelSensitivity}
          annotations={annotations} annotationDraft={eeg.annotationDraft}
          selectedAnnotationType={eeg.selectedAnnotationType} hoveredTime={eeg.hoveredTime}
          isAddingAnnotation={eeg.isAddingAnnotation} onMouseMove={eeg.handleCanvasMouseMove}
          onMouseLeave={()=>eeg.setHoveredTime(null)} onClick={eeg.handleCanvasClick}
          onContextMenu={eeg.handleContextMenu}
          containerRef={eeg.containerRef} canvasRef={eeg.canvasRef}>
          <AnnotationPopup draft={eeg.annotationDraft} annotationType={eeg.selectedAnnotationType}
            text={eeg.annotationText} setText={eeg.setAnnotationText} onConfirm={eeg.confirmAnnotation}
            onCancel={()=>{eeg.setAnnotationDraft(null);eeg.setIsAddingAnnotation(false);}} containerRef={eeg.containerRef}/>
        </WaveformCanvas>
      </div>
      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}/>

      {/* Floating annotation panel */}
      {showAnnotations && (
        <AnnotationPanel annotations={annotations} setAnnotations={setAnnotations}
          isAddingAnnotation={eeg.isAddingAnnotation} setIsAddingAnnotation={eeg.setIsAddingAnnotation}
          selectedAnnotationType={eeg.selectedAnnotationType} setSelectedAnnotationType={eeg.setSelectedAnnotationType}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} epochSec={eeg.epochSec}
          setCurrentEpoch={eeg.setCurrentEpoch} filename={filename}
          onClose={()=>setShowAnnotations(false)}
          panelPos={annotationPanelPos} setPanelPos={setAnnotationPanelPos}/>
      )}

      {/* Floating qEEG analysis panel */}
      {showAnalysis && (
        <QuantAnalysisPanel waveformData={eeg.waveformData} channels={eeg.channels}
          sampleRate={eeg.sampleRate} epochSec={eeg.epochSec} epochStart={eeg.epochStart}
          onClose={()=>setShowAnalysis(false)}
          panelPos={analysisPanelPos} setPanelPos={setAnalysisPanelPos}/>
      )}

      {/* Channel context menu */}
      {eeg.contextMenu && (
        <ChannelContextMenu x={eeg.contextMenu.x} y={eeg.contextMenu.y}
          channelName={eeg.contextMenu.channel}
          isHidden={false}
          channelSens={eeg.channelSensitivity[eeg.contextMenu.channel] || 0}
          onToggleVisibility={()=>eeg.toggleChannelVisibility(eeg.contextMenu.channel)}
          onAdjustSensitivity={(d)=>eeg.adjustChannelSensitivity(eeg.contextMenu.channel,d)}
          onClose={()=>eeg.setContextMenu(null)}/>
      )}

      {/* Pattern Table */}
      {showPatternTable && (
        <PatternTable eegSystem={eeg.eegSystem} montage={eeg.montage}
          channels={eeg.channels} allChannels={eeg.allChannels}
          hiddenChannels={eeg.hiddenChannels} toggleChannelVisibility={eeg.toggleChannelVisibility}
          channelSensitivity={eeg.channelSensitivity} adjustChannelSensitivity={eeg.adjustChannelSensitivity}
          channelHpf={eeg.channelHpf} setChannelHpf={eeg.setChannelHpf}
          channelLpf={eeg.channelLpf} setChannelLpf={eeg.setChannelLpf}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          onClose={()=>setShowPatternTable(false)}/>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DEVICE REGISTRY — All supported hardware & protocols
// ══════════════════════════════════════════════════════════════
const DEVICE_PROTOCOLS = {
  brainflow: { label: "BrainFlow", color: "#3B82F6", desc: "Direct board API" },
  lsl: { label: "LSL", color: "#8B5CF6", desc: "Lab Streaming Layer" },
  file: { label: "File Import", color: "#10B981", desc: "EDF/BDF file" },
  simulated: { label: "Simulated", color: "#F59E0B", desc: "Test signals" },
};

const DEVICE_CATALOG = [
  // BrainFlow devices
  { id: "openbci-cyton-8", name: "OpenBCI Cyton", protocol: "brainflow", channels: 8, maxSr: 250, resolution: "24-bit", wireless: false, clinical: false, boardId: 0, port: "COM3" },
  { id: "openbci-cyton-16", name: "OpenBCI Cyton + Daisy", protocol: "brainflow", channels: 16, maxSr: 125, resolution: "24-bit", wireless: false, clinical: false, boardId: 2, port: "COM3" },
  { id: "openbci-ganglion", name: "OpenBCI Ganglion", protocol: "brainflow", channels: 4, maxSr: 200, resolution: "24-bit", wireless: true, clinical: false, boardId: 1, port: "" },
  { id: "ant-eego", name: "ANT Neuro eego", protocol: "brainflow", channels: 64, maxSr: 2048, resolution: "24-bit", wireless: false, clinical: true, boardId: 24, port: "" },
  { id: "gtec-unicorn", name: "g.tec Unicorn Hybrid Black", protocol: "brainflow", channels: 8, maxSr: 250, resolution: "24-bit", wireless: true, clinical: false, boardId: 8, port: "" },
  { id: "neurosity-crown", name: "Neurosity Crown", protocol: "brainflow", channels: 8, maxSr: 256, resolution: "24-bit", wireless: true, clinical: false, boardId: 25, port: "" },
  { id: "muse-2", name: "Muse 2", protocol: "brainflow", channels: 4, maxSr: 256, resolution: "12-bit", wireless: true, clinical: false, boardId: 22, port: "" },
  { id: "brainbit", name: "BrainBit", protocol: "brainflow", channels: 4, maxSr: 250, resolution: "16-bit", wireless: true, clinical: false, boardId: 7, port: "" },
  { id: "enophone", name: "Enophone", protocol: "brainflow", channels: 4, maxSr: 250, resolution: "24-bit", wireless: true, clinical: false, boardId: 26, port: "" },
  // LSL devices (discovered on network)
  { id: "lsl-generic", name: "LSL Stream (Auto-Discover)", protocol: "lsl", channels: 0, maxSr: 0, resolution: "—", wireless: false, clinical: false },
  { id: "lsl-natus", name: "Natus Xltek (via LSL Bridge)", protocol: "lsl", channels: 32, maxSr: 1024, resolution: "24-bit", wireless: false, clinical: true },
  { id: "lsl-nk", name: "Nihon Kohden (via LSL Bridge)", protocol: "lsl", channels: 32, maxSr: 1024, resolution: "24-bit", wireless: false, clinical: true },
  { id: "lsl-biosemi", name: "BioSemi ActiveTwo (via LSL)", protocol: "lsl", channels: 64, maxSr: 2048, resolution: "24-bit", wireless: false, clinical: true },
  // File import
  { id: "file-edf", name: "Import EDF/EDF+ File", protocol: "file", channels: 0, maxSr: 0, resolution: "—", wireless: false, clinical: false },
  { id: "file-bdf", name: "Import BDF/BDF+ File", protocol: "file", channels: 0, maxSr: 0, resolution: "—", wireless: false, clinical: false },
  // Simulated
  { id: "sim-19ch", name: "Simulated 19ch (10-20)", protocol: "simulated", channels: 19, maxSr: 256, resolution: "N/A", wireless: false, clinical: false },
  { id: "sim-32ch", name: "Simulated 32ch (10-10)", protocol: "simulated", channels: 32, maxSr: 512, resolution: "N/A", wireless: false, clinical: false },
];

// ── Connection states ──
const CONN = { disconnected: 0, scanning: 1, found: 2, connecting: 3, connected: 4, impedance: 5, ready: 6, error: -1 };
const CONN_LABELS = {
  [CONN.disconnected]: { text: "Disconnected", color: "#555" },
  [CONN.scanning]: { text: "Scanning...", color: "#F59E0B" },
  [CONN.found]: { text: "Device Found", color: "#3B82F6" },
  [CONN.connecting]: { text: "Connecting...", color: "#F59E0B" },
  [CONN.connected]: { text: "Connected", color: "#7ec8d9" },
  [CONN.impedance]: { text: "Impedance Check", color: "#8B5CF6" },
  [CONN.ready]: { text: "Ready", color: "#7ec8d9" },
  [CONN.error]: { text: "Error", color: "#EF4444" },
};

// ── Impedance simulator ──
function generateImpedances(channelCount) {
  const electrodes = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2",
    "FC1","FC2","FC5","FC6","CP1","CP2","CP5","CP6","TP7","TP8","FT9","FT10","PO3","PO4","POz","Oz","Iz","AF3","AF4","AF7","AF8",
    "F1","F2","F5","F6","C1","C2","C5","C6","P1","P2","P5","P6","CPz","FCz","FPz","TP9","TP10","PO7","PO8","P9","P10","Ref","Gnd"];
  return electrodes.slice(0, channelCount).map(name => ({
    name, value: Math.round((2 + Math.random() * 12) * 10) / 10,
    status: null, // set below
  })).map(e => ({ ...e, status: e.value < 5 ? "good" : e.value < 10 ? "fair" : "poor" }));
}

// ══════════════════════════════════════════════════════════════
// DEVICE SELECTOR PANEL
// ══════════════════════════════════════════════════════════════
function DeviceSelector({ selectedDevice, setSelectedDevice, connectionState, onConnect, onDisconnect, onScan, deviceConfig, setDeviceConfig }) {
  const [filterProtocol, setFilterProtocol] = useState("all");
  const [showAll, setShowAll] = useState(false);

  const filtered = DEVICE_CATALOG.filter(d => filterProtocol === "all" || d.protocol === filterProtocol);
  const grouped = {};
  filtered.forEach(d => { if (!grouped[d.protocol]) grouped[d.protocol] = []; grouped[d.protocol].push(d); });

  const isConnected = connectionState >= CONN.connected;
  const connInfo = CONN_LABELS[connectionState] || CONN_LABELS[CONN.disconnected];

  return (
    <div style={{borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0}}>
      {/* Source selector row */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px"}}>
        {/* Connection status indicator */}
        <div style={{display:"flex",alignItems:"center",gap:6,minWidth:140}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:connInfo.color,
            animation: connectionState===CONN.scanning||connectionState===CONN.connecting ? "pulse 1.5s ease infinite" : "none"}}/>
          <span style={{fontSize:11,fontWeight:700,color:connInfo.color,letterSpacing:"0.05em"}}>{connInfo.text}</span>
        </div>

        {/* Device dropdown — the "sound output" style selector */}
        <div style={{flex:1,position:"relative"}}>
          <div style={microLabel}>Input Source</div>
          <select value={selectedDevice?.id||""} onChange={e=>{
            const dev = DEVICE_CATALOG.find(d=>d.id===e.target.value);
            setSelectedDevice(dev||null);
            setDeviceConfig(prev => ({ ...prev,
              sampleRate: dev?.maxSr ? Math.min(256, dev.maxSr) : 256,
              channels: dev?.channels || 19,
              port: dev?.port || "",
            }));
          }} style={{...selectStyle,width:"100%",maxWidth:400,padding:"6px 8px",fontSize:12}}>
            <option value="">— Select Input Source —</option>
            {Object.entries(grouped).map(([proto, devices]) => (
              <optgroup key={proto} label={`${DEVICE_PROTOCOLS[proto].label} — ${DEVICE_PROTOCOLS[proto].desc}`}>
                {devices.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} {d.channels>0?`(${d.channels}ch, ${d.maxSr}Hz)`:""} {d.clinical?"[Clinical]":""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Device config */}
        {selectedDevice && selectedDevice.protocol !== "file" && (<>
          {selectedDevice.protocol === "brainflow" && !selectedDevice.wireless && (
            <div><div style={microLabel}>Port</div>
              <input value={deviceConfig.port} onChange={e=>setDeviceConfig({...deviceConfig,port:e.target.value})}
                placeholder="COM3" style={{...selectStyle,width:80,padding:"5px 8px"}}/></div>
          )}
          {selectedDevice.maxSr > 0 && (
            <div><div style={microLabel}>Sample Rate</div>
              <select value={deviceConfig.sampleRate} onChange={e=>setDeviceConfig({...deviceConfig,sampleRate:parseInt(e.target.value)})} style={selectStyle}>
                {[128,250,256,500,512,1000,1024,2048].filter(sr=>sr<=selectedDevice.maxSr).map(sr=>(
                  <option key={sr} value={sr}>{sr} Hz</option>
                ))}
              </select></div>
          )}
        </>)}

        {/* Action buttons */}
        <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
          {!isConnected ? (<>
            {selectedDevice && selectedDevice.protocol === "lsl" && (
              <button onClick={onScan} disabled={connectionState===CONN.scanning} style={{
                padding:"6px 14px",background:"#111",border:"1px solid #8B5CF640",borderRadius:0,
                color:"#8B5CF6",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
              }}>{I.Radio()} SCAN</button>
            )}
            <button onClick={onConnect} disabled={!selectedDevice||connectionState===CONN.connecting} style={{
              padding:"6px 14px",background:selectedDevice?"#0a2a0a":"#1a1a1a",
              border:`1px solid ${selectedDevice?"#4a9bab40":"#333"}`,borderRadius:0,
              color:selectedDevice?"#7ec8d9":"#555",cursor:selectedDevice?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Zap()} CONNECT</button>
          </>) : (
            <button onClick={onDisconnect} style={{
              padding:"6px 14px",background:"#111",border:"1px solid #EF444440",borderRadius:0,
              color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.X()} DISCONNECT</button>
          )}
        </div>
      </div>

      {/* Device info strip when connected */}
      {isConnected && selectedDevice && (
        <div style={{display:"flex",alignItems:"center",gap:16,padding:"6px 16px",borderTop:"1px solid #111",background:"#080808",fontSize:10}}>
          <span style={{color:DEVICE_PROTOCOLS[selectedDevice.protocol].color,fontWeight:700}}>
            {DEVICE_PROTOCOLS[selectedDevice.protocol].label}
          </span>
          <span style={{color:"#666"}}>{selectedDevice.name}</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{deviceConfig.sampleRate}Hz</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{selectedDevice.channels || deviceConfig.channels}ch</span>
          <span style={{color:"#444"}}>|</span>
          <span style={{color:"#888"}}>{selectedDevice.resolution}</span>
          {selectedDevice.clinical && (<>
            <span style={{color:"#444"}}>|</span>
            <span style={{color:"#7ec8d9",fontWeight:700}}>FDA-CLEARED DEVICE</span>
          </>)}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SUBJECT ID INPUT — with naming guide dropdown
// ══════════════════════════════════════════════════════════════
function SubjectIdInput({ value, onChange }) {
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setFocused(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const pattern = /^[A-Z]{2,4}-\d{3,5}$/;
  const isValid = pattern.test(value);
  const hasValue = value.length > 0;
  const segments = value.split("-");
  const prefixPart = segments[0] || "";
  const numPart = segments[1] || "";
  const hasHyphen = value.includes("-");
  const prefixDone = prefixPart.length >= 2 && prefixPart.length <= 4 && /^[A-Z]+$/.test(prefixPart);
  const numStarted = hasHyphen && numPart.length > 0;

  const handleChange = (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, "");
    const parts = raw.split("-");
    if (parts.length > 2) return;
    onChange(raw);
    if (!touched) setTouched(true);
  };

  const examples = [
    { prefix: "FB", desc: "Football" },
    { prefix: "SC", desc: "Soccer" },
    { prefix: "BK", desc: "Basketball" },
    { prefix: "HK", desc: "Hockey" },
    { prefix: "BB", desc: "Baseball" },
    { prefix: "TR", desc: "Track & Field" },
    { prefix: "WR", desc: "Wrestling" },
    { prefix: "BX", desc: "Boxing / MMA" },
    { prefix: "SW", desc: "Swimming" },
    { prefix: "VB", desc: "Volleyball" },
    { prefix: "LX", desc: "Lacrosse" },
    { prefix: "RG", desc: "Rugby" },
    { prefix: "OT", desc: "Other / General" },
  ];

  const borderColor = !hasValue ? "#222" : isValid ? "#4a9bab40" : touched ? "#EF444430" : "#222";

  return (
    <div ref={wrapRef} style={{position:"relative",zIndex:40}}>
      <div style={microLabel}>Subject ID</div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input value={value} onChange={handleChange} placeholder="FB-001"
          onFocus={()=>setFocused(true)}
          style={{...selectStyle,width:160,padding:"5px 8px",fontSize:12,border:`1px solid ${borderColor}`,transition:"border-color 0.15s"}}/>
        {hasValue && (
          <span style={{fontSize:9,color:isValid?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace",minWidth:36}}>{hashSubjectId(value)}</span>
        )}
      </div>

      {focused && (
        <div style={{
          position:"absolute",top:"100%",left:0,marginTop:4,
          width:340,background:"#111",border:"1px solid #2a2a2a",borderRadius:0,
          overflow:"hidden",
        }}>
          {/* Format diagram */}
          <div style={{padding:"10px 12px",borderBottom:"1px solid #1a1a1a"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#888",letterSpacing:"0.08em",marginBottom:6}}>NAMING FORMAT</div>
            <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:14,color:"#e0e0e0",marginBottom:8,letterSpacing:"0.05em"}}>
              <span style={{color:prefixDone?"#7ec8d9":hasValue?"#F59E0B":"#555",padding:"2px 4px",background:prefixDone?"#7ec8d910":"transparent",borderRadius:0,transition:"all 0.15s"}}>
                {prefixPart || "XX"}
              </span>
              <span style={{color:hasHyphen?"#666":"#333",margin:"0 1px"}}>-</span>
              <span style={{color:numStarted?(numPart.length>=3?"#7ec8d9":"#F59E0B"):"#555",padding:"2px 4px",background:numPart.length>=3?"#7ec8d910":"transparent",borderRadius:0,transition:"all 0.15s"}}>
                {numPart || "000"}
              </span>
            </div>
            <div style={{display:"flex",gap:16,fontSize:9,color:"#555"}}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:0,background:prefixDone?"#7ec8d9":"#333",transition:"background 0.15s"}}/>
                Sport / subject code (2-4 letters)
              </div>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:6,height:6,borderRadius:0,background:numPart.length>=3?"#7ec8d9":"#333",transition:"background 0.15s"}}/>
                Subject number (3-5 digits)
              </div>
            </div>
          </div>

          {/* Quick-fill sport codes */}
          <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",maxHeight:180,overflow:"auto"}}>
            <div style={{fontSize:9,fontWeight:700,color:"#555",letterSpacing:"0.08em",marginBottom:6}}>SUBJECT CODES — click to apply</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
              {examples.map(ex => (
                <button key={ex.prefix} onClick={()=>onChange(ex.prefix+"-"+(numPart||""))}
                  style={{
                    display:"flex",alignItems:"center",justifyContent:"space-between",
                    padding:"5px 8px",background:prefixPart===ex.prefix?"#1a2a30":"#0a0a0a",
                    border:`1px solid ${prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}`,borderRadius:0,
                    cursor:"pointer",transition:"all 0.1s",
                  }}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#333"}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=prefixPart===ex.prefix?"#4a9bab30":"#1a1a1a"}>
                  <span style={{fontSize:11,fontWeight:700,color:prefixPart===ex.prefix?"#7ec8d9":"#aaa",fontFamily:"'IBM Plex Mono', monospace"}}>{ex.prefix}</span>
                  <span style={{fontSize:10,color:"#555"}}>{ex.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Step-by-step feedback */}
          <div style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:6,minHeight:28}}>
            {!hasValue && <span style={{fontSize:10,color:"#444"}}>Type a sport code or click one above, then add a number</span>}
            {hasValue && !hasHyphen && <span style={{fontSize:10,color:"#F59E0B"}}>Now type a hyphen ( - ) after your sport code</span>}
            {hasHyphen && !numStarted && <span style={{fontSize:10,color:"#F59E0B"}}>Enter a 3-5 digit subject number</span>}
            {hasHyphen && numStarted && numPart.length < 3 && <span style={{fontSize:10,color:"#F59E0B"}}>Need {3 - numPart.length} more digit{3-numPart.length!==1?"s":""}</span>}
            {isValid && (
              <span style={{fontSize:10,color:"#7ec8d9",display:"flex",alignItems:"center",gap:4}}>
                {I.Check(10)} Valid — hashes to <span style={{fontFamily:"'IBM Plex Mono', monospace",fontWeight:700}}>{hashSubjectId(value)}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PATTERN TABLE — NK-style trace configuration for ACQUIRE
// ══════════════════════════════════════════════════════════════
function PatternTable({ eegSystem, montage, channels, allChannels, hiddenChannels, toggleChannelVisibility,
  channelSensitivity, adjustChannelSensitivity, channelHpf, setChannelHpf, channelLpf, setChannelLpf,
  globalHpf, globalLpf, onClose }) {

  const hpfOptions = [0, 0.1, 0.3, 0.5, 1, 1.6, 5, 10];
  const lpfOptions = [15, 30, 35, 40, 50, 70, 100, 0];

  const regions = [
    { label: "LEFT PARASAGITTAL", filter: ch => /^(Fp1|F3|C3|P3|O1|F1|FC1|C1|CP1|P1)/.test(ch.split("-")[0]) },
    { label: "RIGHT PARASAGITTAL", filter: ch => /^(Fp2|F4|C4|P4|O2|F2|FC2|C2|CP2|P2)/.test(ch.split("-")[0]) },
    { label: "LEFT TEMPORAL", filter: ch => /^(F7|T3|T5|FT9|TP9|AF7|F5|FC5|C5|CP5|F9|FT7|T9|P7)/.test(ch.split("-")[0]) },
    { label: "RIGHT TEMPORAL", filter: ch => /^(F8|T4|T6|FT10|TP10|AF8|F6|FC6|C6|CP6|F10|FT8|T10|P8)/.test(ch.split("-")[0]) },
    { label: "MIDLINE", filter: ch => /^(Fz|Cz|Pz|FCz|CPz|POz|Oz|FPz|Iz)/.test(ch.split("-")[0]) },
    { label: "OTHER", filter: ch => ch === "EKG" || /^(AF3|AF4|PO3|PO4)/.test(ch.split("-")[0]) },
  ];

  const tinySelect = { background:"#0a0a0a",border:"1px solid #222",borderRadius:0,color:"#aaa",fontSize:9,padding:"2px 3px",outline:"none",fontFamily:"'IBM Plex Mono', monospace",width:"100%" };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:0,
        width:820,maxHeight:"85vh",overflow:"hidden",display:"flex",flexDirection:"column",
      }}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 20px",borderBottom:"1px solid #1a1a1a"}}>
          <div>
            <h3 style={{margin:0,color:"#e0e0e0",fontSize:14,fontWeight:700}}>Pattern Table</h3>
            <span style={{fontSize:10,color:"#555"}}>{EEG_SYSTEMS[eegSystem]?.label} — {MONTAGE_DEFS[montage]?.label} — {allChannels.length} traces</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer",padding:4}}>{I.X()}</button>
        </div>

        <div style={{display:"flex",alignItems:"center",padding:"8px 20px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",fontSize:9,color:"#555",fontWeight:700,letterSpacing:"0.08em"}}>
          <span style={{width:30,textAlign:"center"}}>ON</span>
          <span style={{width:34,textAlign:"center"}}>#</span>
          <span style={{flex:1}}>CHANNEL</span>
          <span style={{width:56,textAlign:"center"}}>LFF</span>
          <span style={{width:56,textAlign:"center"}}>HFF</span>
          <span style={{width:80,textAlign:"center"}}>SENSITIVITY</span>
          <span style={{width:40,textAlign:"center"}}>COLOR</span>
        </div>

        <div style={{flex:1,overflow:"auto"}}>
          {regions.map((region, ri) => {
            const regionChannels = allChannels.filter(region.filter);
            if (regionChannels.length === 0) return null;
            return (
              <div key={ri}>
                <div style={{padding:"6px 20px",background:"#0d0d0d",borderBottom:"1px solid #111",fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em"}}>{region.label}</div>
                {regionChannels.map(ch => {
                  const globalIdx = allChannels.indexOf(ch);
                  const isHidden = hiddenChannels.has(ch);
                  const sens = channelSensitivity[ch] || 0;
                  const isEKG = ch === "EKG";
                  const chHpfVal = channelHpf[ch];
                  const chLpfVal = channelLpf[ch];
                  return (
                    <div key={ch} style={{
                      display:"flex",alignItems:"center",padding:"4px 20px",borderBottom:"1px solid #0d0d0d",
                      background:isHidden?"#0a0a0a":"transparent",opacity:isHidden?0.4:1,transition:"all 0.15s",
                    }}>
                      <div style={{width:30,textAlign:"center"}}>
                        <button onClick={()=>toggleChannelVisibility(ch)} style={{
                          width:16,height:16,borderRadius:0,background:isHidden?"#1a1a1a":"#1a4a54",
                          border:`1px solid ${isHidden?"#333":"#4a9bab50"}`,cursor:"pointer",
                          display:"flex",alignItems:"center",justifyContent:"center",color:isHidden?"#555":"#7ec8d9",fontSize:9,
                        }}>{isHidden?" ":"✓"}</button>
                      </div>
                      <span style={{width:34,textAlign:"center",fontSize:9,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{globalIdx+1}</span>
                      <span style={{flex:1,fontSize:11,fontWeight:600,color:isEKG?"#EC4899":isHidden?"#444":"#ccc",fontFamily:"'IBM Plex Mono', monospace"}}>{ch}</span>

                      {/* LFF (per-channel high-pass) */}
                      <div style={{width:56,display:"flex",justifyContent:"center"}}>
                        <select value={chHpfVal !== undefined ? chHpfVal : ""} onChange={e=>{
                          const v = e.target.value;
                          if (v === "") { const next = {...channelHpf}; delete next[ch]; setChannelHpf(next); }
                          else setChannelHpf({...channelHpf, [ch]: parseFloat(v)});
                        }} style={{...tinySelect, color: chHpfVal !== undefined ? "#7ec8d9" : "#555"}}>
                          <option value="">—</option>
                          {hpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                        </select>
                      </div>

                      {/* HFF (per-channel low-pass) */}
                      <div style={{width:56,display:"flex",justifyContent:"center"}}>
                        <select value={chLpfVal !== undefined ? chLpfVal : ""} onChange={e=>{
                          const v = e.target.value;
                          if (v === "") { const next = {...channelLpf}; delete next[ch]; setChannelLpf(next); }
                          else setChannelLpf({...channelLpf, [ch]: parseFloat(v)});
                        }} style={{...tinySelect, color: chLpfVal !== undefined ? "#7ec8d9" : "#555"}}>
                          <option value="">—</option>
                          {lpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                        </select>
                      </div>

                      {/* Sensitivity */}
                      <div style={{width:80,display:"flex",alignItems:"center",justifyContent:"center",gap:2}}>
                        <button onClick={()=>adjustChannelSensitivity(ch,-1)} style={{
                          width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                          color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                        }}>−</button>
                        <span style={{fontSize:9,color:sens!==0?"#7ec8d9":"#555",fontFamily:"'IBM Plex Mono', monospace",
                          minWidth:22,textAlign:"center"}}>{sens>0?`+${sens}`:sens}</span>
                        <button onClick={()=>adjustChannelSensitivity(ch,1)} style={{
                          width:18,height:18,background:"#0a0a0a",border:"1px solid #222",borderRadius:0,
                          color:"#888",cursor:"pointer",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center",
                        }}>+</button>
                      </div>

                      <div style={{width:40,display:"flex",justifyContent:"center"}}>
                        <div style={{width:20,height:3,borderRadius:0,background:isEKG?"#EC4899":"#7ec8d9",opacity:isHidden?0.2:0.6}}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 20px",borderTop:"1px solid #1a1a1a",background:"#0a0a0a"}}>
          <div style={{fontSize:10,color:"#555"}}>
            {channels.length} visible / {allChannels.length} total — {hiddenChannels.size} hidden
            {Object.keys(channelHpf).length > 0 || Object.keys(channelLpf).length > 0 ? (
              <span style={{color:"#F59E0B",marginLeft:8}}>{Object.keys(channelHpf).length + Object.keys(channelLpf).length} custom filters</span>
            ) : null}
          </div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{setChannelHpf({});setChannelLpf({});}} style={{
              padding:"5px 12px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
            }}>Reset Filters</button>
            <button onClick={()=>{allChannels.forEach(ch=>{if(hiddenChannels.has(ch))toggleChannelVisibility(ch);});}} style={{
              padding:"5px 12px",background:"#111",border:"1px solid #222",borderRadius:0,
              color:"#888",cursor:"pointer",fontSize:10,fontWeight:600,
            }}>Show All</button>
            <button onClick={onClose} style={{
              padding:"5px 12px",background:"#1a4a54",border:"1px solid #4a9bab40",borderRadius:0,
              color:"#7ec8d9",cursor:"pointer",fontSize:10,fontWeight:700,
            }}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// IMPEDANCE CHECK PANEL
// ══════════════════════════════════════════════════════════════
function ImpedancePanel({ impedances, onClose, onAccept }) {
  const allGood = impedances.every(e => e.status !== "poor");
  return (
    <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:20}}>
      <div style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:24,width:560,maxHeight:"80vh",overflow:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <h3 style={{margin:0,color:"#e0e0e0",fontSize:14,fontWeight:700}}>Impedance Check</h3>
            <span style={{fontSize:10,color:"#555"}}>All electrodes should be below 10 kΩ for quality recording</span>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#666",cursor:"pointer"}}>{I.X()}</button>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:6,marginBottom:20}}>
          {impedances.map((e,i) => (
            <div key={i} style={{
              background:"#0a0a0a",border:`1px solid ${e.status==="good"?"#1a4a5440":e.status==="fair"?"#854d0e40":"#991b1b40"}`,
              borderRadius:0,padding:"8px 10px",display:"flex",alignItems:"center",justifyContent:"space-between",
            }}>
              <span style={{fontSize:11,fontWeight:600,color:"#ccc",fontFamily:"'IBM Plex Mono', monospace"}}>{e.name}</span>
              <span style={{fontSize:12,fontWeight:700,fontFamily:"'IBM Plex Mono', monospace",
                color:e.status==="good"?"#7ec8d9":e.status==="fair"?"#facc15":"#f87171"
              }}>{e.value}kΩ</span>
            </div>
          ))}
        </div>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:16,fontSize:10}}>
            <span style={{color:"#7ec8d9"}}>● &lt;5kΩ Good</span>
            <span style={{color:"#facc15"}}>● 5-10kΩ Fair</span>
            <span style={{color:"#f87171"}}>● &gt;10kΩ Poor</span>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onClose} style={{padding:"6px 14px",background:"#111",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:11,fontWeight:600}}>Re-check</button>
            <button onClick={onAccept} style={{
              padding:"6px 18px",background:allGood?"#1a4a54":"#7f1d1d",
              border:`1px solid ${allGood?"#4a9bab50":"#EF444450"}`,borderRadius:0,
              color:allGood?"#7ec8d9":"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700
            }}>{allGood?"Accept & Ready":"Accept Anyway"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// TAB: ACQUIRE (Live Recording) — with Device Manager
// ══════════════════════════════════════════════════════════════
function AcquireTab({ annotationsMap, setAnnotationsMap }) {
  const eeg = useEEGState(600);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [subjectId, setSubjectId] = useState("");
  const [studyType, setStudyType] = useState("BL");
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const timerRef = useRef(null);

  // Use app-level annotations keyed by acquire filename
  const acqFilename = subjectId ? generateFilename(subjectId, studyType, new Date().toISOString().split("T")[0]) : "acquire-session";
  const annotations = annotationsMap[acqFilename] || [];
  const setAnnotations = (newAnns) => {
    const resolved = typeof newAnns === "function" ? newAnns(annotations) : newAnns;
    setAnnotationsMap(prev => ({ ...prev, [acqFilename]: resolved }));
  };
  eeg.annotations = annotations;
  eeg.setAnnotations = setAnnotations;
  eeg.confirmAnnotation = () => {
    if (!eeg.annotationDraft) return;
    const t = ANNOTATION_COLORS[eeg.selectedAnnotationType];
    setAnnotations([...annotations, { id: Date.now(), time: eeg.annotationDraft.time, duration: eeg.annotationDraft.duration,
      type: t.name, color: t.color, text: eeg.annotationText || t.name, channel: -1 }]);
    eeg.setAnnotationDraft(null); eeg.setAnnotationText(""); eeg.setIsAddingAnnotation(false);
  };

  // Device state
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [connectionState, setConnectionState] = useState(CONN.disconnected);
  const [deviceConfig, setDeviceConfig] = useState({ sampleRate: 256, channels: 19, port: "COM3" });
  const [impedances, setImpedances] = useState(null);
  const [showImpedance, setShowImpedance] = useState(false);

  // Simulated connection flow
  const handleConnect = useCallback(() => {
    if (!selectedDevice) return;
    if (selectedDevice.protocol === "simulated") {
      setConnectionState(CONN.connecting);
      setTimeout(() => { setConnectionState(CONN.connected); setTimeout(() => setConnectionState(CONN.ready), 500); }, 800);
      return;
    }
    if (selectedDevice.protocol === "file") {
      setConnectionState(CONN.ready);
      return;
    }
    // BrainFlow / LSL simulated connection
    setConnectionState(CONN.connecting);
    setTimeout(() => {
      setConnectionState(CONN.connected);
      // Auto-trigger impedance check for real devices
      setTimeout(() => {
        setConnectionState(CONN.impedance);
        const imp = generateImpedances(selectedDevice.channels || deviceConfig.channels);
        setImpedances(imp);
        setShowImpedance(true);
      }, 1200);
    }, 1500);
  }, [selectedDevice, deviceConfig]);

  const handleDisconnect = () => {
    setConnectionState(CONN.disconnected);
    setImpedances(null);
    setShowImpedance(false);
    if (isRecording) { setIsRecording(false); setIsPaused(false); }
  };

  const handleScan = () => {
    setConnectionState(CONN.scanning);
    setTimeout(() => setConnectionState(CONN.found), 2000);
  };

  const handleAcceptImpedance = () => {
    setShowImpedance(false);
    setConnectionState(CONN.ready);
  };

  // Recording
  useEffect(() => {
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => {
        setElapsedSec(p => { const next = p+1; eeg.setCurrentEpoch(Math.floor(next/eeg.epochSec)); return next; });
      }, 1000);
      return () => clearInterval(timerRef.current);
    } else { clearInterval(timerRef.current); }
  }, [isRecording, isPaused, eeg.epochSec]);

  const startRecording = () => {
    if (!subjectId || connectionState < CONN.ready) return;
    setIsRecording(true); setIsPaused(false); setElapsedSec(0); eeg.setCurrentEpoch(0);
  };
  const stopRecording = () => { setIsRecording(false); setIsPaused(false); };
  const togglePause = () => setIsPaused(!isPaused);

  const elapsed = `${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,"0")}`;
  const hash = subjectId ? hashSubjectId(subjectId) : "----";
  const canRecord = connectionState >= CONN.ready && subjectId;

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden",position:"relative"}}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* Device Selector */}
      <DeviceSelector selectedDevice={selectedDevice} setSelectedDevice={setSelectedDevice}
        connectionState={connectionState} onConnect={handleConnect} onDisconnect={handleDisconnect}
        onScan={handleScan} deviceConfig={deviceConfig} setDeviceConfig={setDeviceConfig}/>

      {/* Recording controls bar */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"8px 16px",borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexShrink:0}}>
        {!isRecording ? (<>
          <SubjectIdInput value={subjectId} onChange={setSubjectId}/>
          <div><div style={microLabel}>Study Type</div>
            <select value={studyType} onChange={e=>setStudyType(e.target.value)} style={selectStyle}>
              {Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select></div>
          {subjectId && (
            <div style={{padding:"6px 12px",background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,fontFamily:"'IBM Plex Mono', monospace",fontSize:11,color:"#7ec8d9"}}>
              <span style={{color:"#555",fontSize:9}}>FILE → </span>
              {generateFilename(subjectId, studyType, new Date().toISOString().split("T")[0])}
            </div>
          )}
          <div style={{flex:1}}/>
          {connectionState >= CONN.ready && (
            <button onClick={()=>{setShowImpedance(true);setImpedances(generateImpedances(selectedDevice?.channels||19));}} style={{
              padding:"6px 14px",background:"#111",border:"1px solid #8B5CF640",borderRadius:0,
              color:"#8B5CF6",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Activity()} IMPEDANCE</button>
          )}
          <button onClick={startRecording} disabled={!canRecord} style={{
            padding:"8px 20px",background:canRecord?"#7f1d1d":"#1a1a1a",border:`1px solid ${canRecord?"#EF444450":"#333"}`,
            borderRadius:0,color:canRecord?"#EF4444":"#555",cursor:canRecord?"pointer":"default",
            fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6
          }}>{I.Record()} START RECORDING</button>
        </>) : (<>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:isPaused?"#F59E0B":"#EF4444",
              animation:isPaused?"none":"pulse 1.5s ease infinite"}}/>
            <span style={{fontSize:12,fontWeight:800,color:isPaused?"#F59E0B":"#EF4444",letterSpacing:"0.1em"}}>
              {isPaused?"PAUSED":"RECORDING"}</span>
          </div>
          <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:18,fontWeight:800,color:"#e0e0e0",minWidth:60}}>{elapsed}</div>
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{hash}</span>
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#888"}}>{STUDY_TYPES[studyType]?.label}</span>
          {selectedDevice && (<>
            <span style={{fontSize:10,color:"#555"}}>|</span>
            <span style={{fontSize:10,color:DEVICE_PROTOCOLS[selectedDevice.protocol].color}}>{selectedDevice.name}</span>
          </>)}
          <div style={{flex:1}}/>
          <button onClick={togglePause} style={{
            padding:"6px 14px",background:"#111",border:"1px solid #F59E0B40",borderRadius:0,
            color:"#F59E0B",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{isPaused?I.Record():I.Pause()} {isPaused?"RESUME":"PAUSE"}</button>
          <button onClick={stopRecording} style={{
            padding:"6px 14px",background:"#111",border:"1px solid #EF444440",borderRadius:0,
            color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{I.Square()} STOP</button>
        </>)}
      </div>

      <EEGControls montage={eeg.montage} setMontage={eeg.setMontage}
        eegSystem={eeg.eegSystem} setEegSystem={eeg.setEegSystem}
        hpf={eeg.hpf} setHpf={eeg.setHpf}
        lpf={eeg.lpf} setLpf={eeg.setLpf} notch={eeg.notch} setNotch={eeg.setNotch}
        epochSec={eeg.epochSec} setEpochSec={eeg.setEpochSec} sensitivity={eeg.sensitivity} setSensitivity={eeg.setSensitivity}
        rightContent={<>
          {eeg.hiddenChannels.size > 0 && (
            <button onClick={(e)=>{e.stopPropagation();eeg.allChannels.forEach(ch=>{if(eeg.hiddenChannels.has(ch))eeg.toggleChannelVisibility(ch);});}} style={{...controlBtn(),color:"#F59E0B",border:"1px solid #F59E0B40"}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Eye(12)} Show All ({eeg.hiddenChannels.size})</span>
            </button>
          )}
          <button onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
          </button>
          <button onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
            <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
          </button>
        </>}/>

      <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
        <WaveformCanvas channels={eeg.channels} waveformData={eeg.waveformData} epochSec={eeg.epochSec}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} sampleRate={eeg.sampleRate}
          sensitivity={eeg.sensitivity} channelSensitivity={eeg.channelSensitivity}
          annotations={annotations} annotationDraft={eeg.annotationDraft}
          selectedAnnotationType={eeg.selectedAnnotationType} hoveredTime={eeg.hoveredTime}
          isAddingAnnotation={eeg.isAddingAnnotation} onMouseMove={eeg.handleCanvasMouseMove}
          onMouseLeave={()=>eeg.setHoveredTime(null)} onClick={eeg.handleCanvasClick}
          onContextMenu={eeg.handleContextMenu}
          containerRef={eeg.containerRef} canvasRef={eeg.canvasRef}>
          <AnnotationPopup draft={eeg.annotationDraft} annotationType={eeg.selectedAnnotationType}
            text={eeg.annotationText} setText={eeg.setAnnotationText} onConfirm={eeg.confirmAnnotation}
            onCancel={()=>{eeg.setAnnotationDraft(null);eeg.setIsAddingAnnotation(false);}} containerRef={eeg.containerRef}/>

          {/* Overlay states */}
          {connectionState < CONN.ready && !isRecording && (
            <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
              {connectionState === CONN.disconnected && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #2a2a2a",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#444"}}>{I.Radio(20)}</div>
                  <div style={{color:"#555",fontSize:14,fontWeight:600}}>No Input Source Connected</div>
                  <div style={{color:"#333",fontSize:11,maxWidth:300,textAlign:"center",lineHeight:1.5}}>
                    Select a device from the Input Source dropdown above, then click CONNECT
                  </div>
                </>
              )}
              {(connectionState === CONN.scanning || connectionState === CONN.connecting) && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #F59E0B30",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#F59E0B",
                    animation:"pulse 1.5s ease infinite"}}>{I.Radio(20)}</div>
                  <div style={{color:"#F59E0B",fontSize:14,fontWeight:600}}>
                    {connectionState===CONN.scanning?"Scanning for LSL streams...":"Connecting to device..."}
                  </div>
                </>
              )}
              {connectionState === CONN.found && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #3B82F630",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#3B82F6"}}>{I.Radio(20)}</div>
                  <div style={{color:"#3B82F6",fontSize:14,fontWeight:600}}>Stream found — click CONNECT</div>
                </>
              )}
              {connectionState === CONN.connected && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #7ec8d930",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#7ec8d9"}}>{I.Check(20)}</div>
                  <div style={{color:"#7ec8d9",fontSize:14,fontWeight:600}}>Connected — running impedance check...</div>
                </>
              )}
              {connectionState === CONN.error && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #EF444430",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#EF4444"}}>{I.Alert(20)}</div>
                  <div style={{color:"#EF4444",fontSize:14,fontWeight:600}}>Connection Failed</div>
                  <div style={{color:"#666",fontSize:11}}>Check device power and port settings, then retry</div>
                </>
              )}
            </div>
          )}

          {/* Ready but not recording */}
          {connectionState >= CONN.ready && !isRecording && (
            <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,color:"#7ec8d9"}}>
                {I.Check(18)} <span style={{fontSize:14,fontWeight:700}}>Device Ready</span>
              </div>
              <div style={{color:"#555",fontSize:12}}>
                {subjectId ? "Click START RECORDING to begin acquisition" : "Enter a Subject ID to begin"}
              </div>
            </div>
          )}
        </WaveformCanvas>
      </div>

      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}/>

      {/* Floating annotation panel */}
      {showAnnotations && (
        <AnnotationPanel annotations={annotations} setAnnotations={setAnnotations}
          isAddingAnnotation={eeg.isAddingAnnotation} setIsAddingAnnotation={eeg.setIsAddingAnnotation}
          selectedAnnotationType={eeg.selectedAnnotationType} setSelectedAnnotationType={eeg.setSelectedAnnotationType}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} epochSec={eeg.epochSec}
          setCurrentEpoch={eeg.setCurrentEpoch} filename={acqFilename}
          onClose={()=>setShowAnnotations(false)}
          panelPos={annotationPanelPos} setPanelPos={setAnnotationPanelPos}/>
      )}

      {/* Impedance modal */}
      {showImpedance && impedances && (
        <ImpedancePanel impedances={impedances} onClose={()=>setShowImpedance(false)} onAccept={handleAcceptImpedance}/>
      )}

      {/* Channel context menu */}
      {eeg.contextMenu && (
        <ChannelContextMenu x={eeg.contextMenu.x} y={eeg.contextMenu.y}
          channelName={eeg.contextMenu.channel}
          isHidden={false}
          channelSens={eeg.channelSensitivity[eeg.contextMenu.channel] || 0}
          onToggleVisibility={()=>eeg.toggleChannelVisibility(eeg.contextMenu.channel)}
          onAdjustSensitivity={(d)=>eeg.adjustChannelSensitivity(eeg.contextMenu.channel,d)}
          onClose={()=>eeg.setContextMenu(null)}/>
      )}

      {/* Pattern Table */}
      {showPatternTable && (
        <PatternTable eegSystem={eeg.eegSystem} montage={eeg.montage}
          channels={eeg.channels} allChannels={eeg.allChannels}
          hiddenChannels={eeg.hiddenChannels} toggleChannelVisibility={eeg.toggleChannelVisibility}
          channelSensitivity={eeg.channelSensitivity} adjustChannelSensitivity={eeg.adjustChannelSensitivity}
          channelHpf={eeg.channelHpf} setChannelHpf={eeg.setChannelHpf}
          channelLpf={eeg.channelLpf} setChannelLpf={eeg.setChannelLpf}
          globalHpf={eeg.hpf} globalLpf={eeg.lpf}
          onClose={()=>setShowPatternTable(false)}/>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN APP — Tab Controller
// ══════════════════════════════════════════════════════════════
export default function ReactEEGApp() {
  const [activeTab, setActiveTab] = useState("library");
  const [records, setRecords] = useState([]);
  const [reviewRecord, setReviewRecord] = useState(null);
  const [annotationsMap, setAnnotationsMap] = useState({});
  const [edfFileStore, setEdfFileStore] = useState({});
  const [initialized, setInitialized] = useState(false);
  const [dataDir, setDataDir] = useState("");

  // ── Initialize on first launch ──
  useEffect(() => {
    (async () => {
      try {
        const dir = await tauriBridge.invoke("initialize_app");
        setDataDir(dir || "");
      } catch (e) { console.log("Init:", e); }

      // Load saved library or fall back to seed data
      try {
        const json = await tauriBridge.invoke("load_library_index");
        const saved = JSON.parse(json || "[]");
        if (saved.length > 0) {
          setRecords(saved);
        } else {
          setRecords(generateSeedData());
        }
      } catch (e) {
        setRecords(generateSeedData());
      }
      setInitialized(true);
    })();

    // Listen for EDF file open events (double-click .edf in Explorer)
    if (window.__TAURI__) {
      const unlisten = window.__TAURI__.event.listen("open-edf-file", (event) => {
        const filePath = event.payload;
        console.log("Opening EDF file:", filePath);
        // Extract filename from path
        const parts = filePath.replace(/\\/g, "/").split("/");
        const filename = parts[parts.length - 1];
        // Switch to review tab with this file
        setReviewRecord({ filename, status: "pending", id: "ext-" + Date.now() });
        setActiveTab("review");
      });
      return () => { unlisten.then(fn => fn()); };
    }
  }, []);

  // ── Auto-save library to disk when records change ──
  useEffect(() => {
    if (initialized && records.length > 0) {
      tauriBridge.saveLibrary(records);
    }
  }, [records, initialized]);

  const openReview = (record) => {
    setReviewRecord(record);
    setActiveTab("review");
  };

  const updateRecordStatus = (recordId, newStatus) => {
    setRecords(prev => prev.map(r => r.id === recordId ? { ...r, status: newStatus } : r));
    if (reviewRecord && reviewRecord.id === recordId) {
      setReviewRecord(prev => ({ ...prev, status: newStatus }));
    }
  };

  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 2800);
    return () => clearTimeout(timer);
  }, []);

  const tabs = [
    { id: "library", label: "LIBRARY", icon: I.Database(18), desc: "File Repository" },
    { id: "review",  label: "REVIEW",  icon: I.Eye(18),      desc: "Waveform Viewer" },
    { id: "acquire", label: "ACQUIRE", icon: I.Activity(18),  desc: "Live Recording" },
  ];

  // ── Splash Screen ──
  if (showSplash) {
    return (
      <div style={{
        height:"100vh",background:"#000",display:"flex",flexDirection:"column",
        alignItems:"center",justifyContent:"center",position:"relative",
        fontFamily:"'IBM Plex Mono','JetBrains Mono',monospace",
      }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap');
          @keyframes splashFadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
          @keyframes splashFadeOut { from { opacity:1; } to { opacity:0; } }
        `}</style>
        <div style={{
          animation: "splashFadeIn 0.8s ease forwards, splashFadeOut 0.6s ease 2.2s forwards",
          display:"flex",flexDirection:"column",alignItems:"center",gap:0,
        }}>
          <div style={{
            fontSize:72,fontWeight:700,color:"#fff",letterSpacing:"0.08em",
            lineHeight:1,fontFamily:"'Rajdhani', sans-serif",
          }}>REACT <span style={{color:"#7ec8d9"}}>EEG</span></div>
          <div style={{
            fontSize:13,fontWeight:500,color:"#ccc",letterSpacing:"0.12em",
            marginTop:14,textAlign:"center",lineHeight:1.5,fontFamily:"'Rajdhani', sans-serif",
          }}>Rapid Electroencephalographic Audit of Cortical Trends</div>
        </div>
        <div style={{
          position:"absolute",bottom:32,
          fontSize:11,color:"#444",fontWeight:400,letterSpacing:"0.06em",
          animation: "splashFadeIn 1s ease 0.4s both, splashFadeOut 0.6s ease 2.2s forwards",
        }}>REACT EEG, LLC &mdash; 2026</div>
      </div>
    );
  }

  return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#080808",color:"#e0e0e0",fontFamily:"'IBM Plex Mono','JetBrains Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=Rajdhani:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 0; }
        select:focus, input:focus, textarea:focus { border-color: #333 !important; outline: none; }
      `}</style>

      {/* ══ Header ══ */}
      <header style={{padding:"12px 24px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:36,height:36,borderRadius:0,background:"#1a4a54",
              border:"1px solid #4a9bab40",display:"flex",alignItems:"center",justifyContent:"center",color:"#7ec8d9"}}>
              {I.Brain()}
            </div>
            <div>
              <div style={{fontSize:18,fontWeight:700,letterSpacing:"0.04em",color:"#e0e0e0",fontFamily:"'Rajdhani', sans-serif"}}>
                REACT <span style={{color:"#7ec8d9"}}>EEG</span>
              </div>
              <div style={{fontSize:9,color:"#555",letterSpacing:"0.12em",fontWeight:600,fontFamily:"'Rajdhani', sans-serif",textTransform:"uppercase"}}>BIOMETRIC DATA ACQUISITION & STORAGE</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,color:"#7ec8d9",fontSize:11,fontWeight:600,fontFamily:"'Rajdhani', sans-serif",letterSpacing:"0.08em"}}>
            {I.Shield()} PHI PROTECTED
          </div>
        </div>

        {/* ── Tab Bar ── */}
        <div style={{display:"flex",gap:0}}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              flex:1, padding:"14px 20px", borderRadius:0,
              background: activeTab === tab.id ? "#1a1a1a" : "transparent",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid #7ec8d9" : "2px solid transparent",
              color: activeTab === tab.id ? "#e0e0e0" : "#555",
              cursor: "pointer", transition: "all 0.1s",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}>
              <span style={{color: activeTab === tab.id ? "#7ec8d9" : "#444"}}>{tab.icon}</span>
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:15,fontWeight:700,letterSpacing:"0.1em",fontFamily:"'Rajdhani', sans-serif"}}>{tab.label}</div>
                <div style={{fontSize:9,color: activeTab === tab.id ? "#666" : "#333",fontWeight:500,fontFamily:"'Rajdhani', sans-serif"}}>{tab.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </header>

      {/* ══ Tab Content ══ */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",borderTop:"1px solid #2a2a2a"}}>
        {activeTab === "library" && <LibraryTab records={records} setRecords={setRecords} onOpenReview={openReview} updateRecordStatus={updateRecordStatus} edfFileStore={edfFileStore} setEdfFileStore={setEdfFileStore}/>}
        {activeTab === "review" && <ReviewTab record={reviewRecord} updateRecordStatus={updateRecordStatus} records={records} onSelectRecord={openReview} annotationsMap={annotationsMap} setAnnotationsMap={setAnnotationsMap} edfFileStore={edfFileStore}/>}
        {activeTab === "acquire" && <AcquireTab annotationsMap={annotationsMap} setAnnotationsMap={setAnnotationsMap}/>}
      </div>
    </div>
  );
}
