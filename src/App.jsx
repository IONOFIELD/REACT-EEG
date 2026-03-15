import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ══════════════════════════════════════════════════════════════
// REACT EEG — Unified Platform
// LIBRARY | REVIEW | ACQUIRE
// ══════════════════════════════════════════════════════════════

// ── IndexedDB persistence for imported EDF files ──
const EDF_DB_NAME = "ReactEEG_EdfStore";
const EDF_DB_STORE = "edfFiles";

function openEdfDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EDF_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(EDF_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveEdfToDB(filename, arrayBuffer) {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(EDF_DB_STORE, "readwrite");
    tx.objectStore(EDF_DB_STORE).put(arrayBuffer, filename);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("Failed to save EDF to IndexedDB:", e); }
}

async function loadAllEdfsFromDB() {
  try {
    const db = await openEdfDB();
    const tx = db.transaction(EDF_DB_STORE, "readonly");
    const store = tx.objectStore(EDF_DB_STORE);
    return new Promise((resolve) => {
      const results = {};
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const parsed = parseEDFFile(cursor.value);
          if (parsed && !parsed.error) results[cursor.key] = parsed;
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => resolve({});
    });
  } catch (e) { return {}; }
}

// ── Utility: deterministic hash for de-identification ──
function hashSubjectId(id, salt = "REACT-EEG-2026") {
  let h = 0;
  const str = salt + id;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).toUpperCase().padStart(8, "0");
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
  const hash = hashSubjectId(subjectId).slice(0, 4);
  const cleanId = subjectId.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase();
  const d = date.replace(/-/g, "");
  return `${cleanId}-${studyType}-${hash}-${d}-${String(seq).padStart(3, "0")}.edf`;
}

// Extract the subject ID and patient hash from filename
// e.g. "FB001-BL-42C1-20260301-001.edf" → subjectId="FB001", hash="42C1"
function extractPatientHash(filename) {
  const m = filename?.match(/^(.+?)-\w{2,4}-([A-F0-9]{4})-\d{8}-/i);
  return m ? m[2].toUpperCase() : null;
}
function extractSubjectId(filename) {
  const m = filename?.match(/^(.+?)-\w{2,4}-[A-F0-9]{4}-\d{8}-/i);
  return m ? m[1] : null;
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
  "custom": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"],
};

// ── OpenBCI hardware channel-to-electrode mappings ──
const OPENBCI_CHANNEL_MAP = {
  "openbci-cyton-8":  ["Fp1","Fp2","C3","C4","P3","P4","O1","O2"],
  "openbci-cyton-16": ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6"],
};

// ── Montage definitions per EEG system ──
const MONTAGE_DEFS = {
  "bipolar-longitudinal": {
    label: "Bipolar Longitudinal (Double Banana)",
    "10-20": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-FC1","FC1-CP1","CP1-PO3","AF4-FC2","FC2-CP2","CP2-PO4","FC5-CP5","FC6-CP6","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-F3","F3-C3","C3-P3","P3-O1","Fp2-F4","F4-C4","C4-P4","P4-O2","Fp1-F7","F7-T3","T3-T5","T5-O1","Fp2-F8","F8-T4","T4-T6","T6-O2","Fz-Cz","Cz-Pz",
      "AF3-F1","F1-FC1","FC1-C1","C1-CP1","CP1-P1","AF4-F2","F2-FC2","FC2-C2","C2-CP2","CP2-P2",
      "AF7-F5","F5-FC5","FC5-C5","C5-CP5","AF8-F6","F6-FC6","FC6-C6","C6-CP6","POz-Oz","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  "bipolar-transverse": {
    label: "Bipolar Transverse",
    "10-20": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "FC5-FC1","FC1-FC2","FC2-FC6","CP5-CP1","CP1-CP2","CP2-CP6","PO3-POz","POz-PO4","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["F7-Fp1","Fp1-Fp2","Fp2-F8","F7-F3","F3-Fz","Fz-F4","F4-F8","T3-C3","C3-Cz","Cz-C4","C4-T4","T5-P3","P3-Pz","Pz-P4","P4-T6","O1-O2",
      "AF7-AF3","AF3-AF4","AF4-AF8","F5-F1","F1-F2","F2-F6","FC5-FC1","FC1-FCz","FCz-FC2","FC2-FC6",
      "C5-C1","C1-C2","C2-C6","CP5-CP1","CP1-CPz","CPz-CP2","CP2-CP6","P5-P1","P1-P2","P2-P6","PO3-POz","POz-PO4","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  referential: {
    label: "Referential (Cz Ref)",
    "10-20": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-Cz","Fp2-Cz","F3-Cz","F4-Cz","C3-Cz","C4-Cz","P3-Cz","P4-Cz","O1-Cz","O2-Cz","F7-Cz","F8-Cz","T3-Cz","T4-Cz","T5-Cz","T6-Cz","Fz-Cz","Pz-Cz",
      "F1-Cz","F2-Cz","F5-Cz","F6-Cz","FC1-Cz","FC2-Cz","FC5-Cz","FC6-Cz","C1-Cz","C2-Cz","C5-Cz","C6-Cz",
      "CP1-Cz","CP2-Cz","CP5-Cz","CP6-Cz","P1-Cz","P2-Cz","P5-Cz","P6-Cz","AF3-Cz","AF4-Cz","PO3-Cz","PO4-Cz","POz-Cz","Oz-Cz","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
  "average-reference": {
    label: "Average Reference",
    "10-20": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
    "hd-40": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "FC1-Avg","FC2-Avg","FC5-Avg","FC6-Avg","CP1-Avg","CP2-Avg","CP5-Avg","CP6-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
    "10-10": ["Fp1-Avg","Fp2-Avg","F3-Avg","F4-Avg","C3-Avg","C4-Avg","P3-Avg","P4-Avg","O1-Avg","O2-Avg","F7-Avg","F8-Avg","T3-Avg","T4-Avg","T5-Avg","T6-Avg","Fz-Avg","Pz-Avg",
      "F1-Avg","F2-Avg","FC1-Avg","FC2-Avg","C1-Avg","C2-Avg","CP1-Avg","CP2-Avg","P1-Avg","P2-Avg","AF3-Avg","AF4-Avg","PO3-Avg","PO4-Avg","POz-Avg","Oz-Avg","LOC1","LOC2","ROC1","ROC2","EKG"],
  },
};

// Helper: get channels for a montage + system combination
function getMontageChannels(montage, eegSystem, customElectrodes = null) {
  const def = MONTAGE_DEFS[montage];
  if (!def) return [];
  if (eegSystem === "custom" && customElectrodes) {
    const base = def["10-20"] || [];
    const sel = customElectrodes;
    return base.filter(ch => {
      if (ch === "EKG") return false;
      if (ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2") return sel.has(ch);
      if (ch.includes("-")) {
        const parts = ch.split("-");
        const ref = parts[parts.length - 1];
        if (ref === "Avg" || ref === "Cz") return sel.has(parts[0]);
        return sel.has(parts[0]) && sel.has(ref);
      }
      return sel.has(ch);
    });
  }
  return def[eegSystem] || def["10-20"] || [];
}

// Helper: check if a recording's system can display in a given target system
// A 10-20 recording CAN view in 10-20. It CANNOT view in hd-40 or 10-10.
// An hd-40 recording CAN view in 10-20 and hd-40. It CANNOT view in 10-10.
// A 10-10 recording CAN view in anything.
const SYSTEM_HIERARCHY = { "10-20": 1, "hd-40": 2, "10-10": 3, "custom": 1 };
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

// ── EEG Signal Generator — lobe-accurate frequencies ──
// Frontal (Fp1/2,F3/4,F7/8,Fz): dominant beta 18-25Hz
// Temporal (T3/4/5/6,F7/8): slower beta 13-18Hz
// Parietal (P3/4,Pz,C3/4,Cz): high-freq alpha 9-12Hz
// Occipital (O1/2,Oz): fast alpha 8-11Hz + PDR 8-11Hz eyes-closed
function generateEEGSignal(channelIndex, sampleRate, durationSec, seed = 0, channelName = "") {
  const samples = sampleRate * durationSec;
  const data = new Float32Array(samples);
  const s = channelIndex * 1000 + seed;
  const rand = (n) => { const x = Math.sin(n * 9301 + s * 4973) * 49297; return x - Math.floor(x); };

  const isEKG = channelName === "EKG";
  const isEye = channelName === "LOC1" || channelName === "LOC2" || channelName === "ROC1" || channelName === "ROC2";
  const isVertical = channelName === "LOC1" || channelName === "ROC1"; // above-eye electrodes

  // Lobe classification by channel index (10-20 standard order)
  // 0=Fp1-F3, 1=F3-C3, 2=C3-P3, 3=P3-O1, 4=Fp2-F4, 5=F4-C4, 6=C4-P4, 7=P4-O2
  // 8=Fp1-F7, 9=F7-T3, 10=T3-T5, 11=T5-O1, 12=Fp2-F8, 13=F8-T4, 14=T4-T6, 15=T6-O2
  // 16=Fz-Cz, 17=Cz-Pz
  const isFrontal   = channelIndex === 0 || channelIndex === 4 || channelIndex === 8 || channelIndex === 12 || channelIndex === 16;
  const isTemporal  = channelIndex === 9 || channelIndex === 10 || channelIndex === 13 || channelIndex === 14;
  const isParietal  = channelIndex === 2 || channelIndex === 6 || channelIndex === 17;
  const isOccipital = channelIndex === 3 || channelIndex === 7 || channelIndex === 11 || channelIndex === 15;
  const isCentral   = channelIndex === 1 || channelIndex === 5;

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    if (isEye) {
      // Physiologically realistic EOG — corneal-retinal dipole model
      // LOC1/LOC2 = left eye (above/lateral) — should track together
      // ROC1/ROC2 = right eye (above/lateral) — should track together
      // Normal conjugate gaze: both eyes move together
      // Occasional desynchrony events inserted for clinical interest
      const isLeft = channelName === "LOC1" || channelName === "LOC2";

      // ── Blinks — bilateral, simultaneous (seed-locked timing) ──
      const blinkRate = 0.25 + rand(seed + 1) * 0.15;
      const blinkPhase = (t * blinkRate) % 1;
      const blinkDur = 0.12;
      let blink = 0;
      if (blinkPhase < blinkDur) {
        const shape = Math.sin(blinkPhase * Math.PI / blinkDur);
        // Both channels on same eye see the blink: vertical larger, horizontal smaller
        blink = isVertical ? 400 * shape : 180 * shape;
      }

      // ── Conjugate horizontal saccades — both eyes move together ──
      const saccRate = 0.5 + rand(seed + 3) * 0.3;
      const saccCycle = Math.floor(t * saccRate);
      const saccPhase = (t * saccRate) % 1;
      let hSaccade = 0;
      if (saccPhase < 0.03) {
        const step = Math.sin(saccPhase * Math.PI / 0.03);
        const amp = 100 + rand(saccCycle * 13 + seed) * 100;
        const dir = rand(saccCycle * 37 + seed) > 0.5 ? 1 : -1;
        // Horizontal channels get full amplitude; vertical channels get volume-conducted leak
        const hAmp = isVertical ? amp * 0.12 : amp;
        // Both eyes move same direction — left and right see same-sign horizontal deflection
        hSaccade = dir * hAmp * step;
      }

      // ── Conjugate vertical saccades — both eyes, same polarity ──
      const vRate = 0.15 + rand(seed + 7) * 0.1;
      const vCycle = Math.floor(t * vRate);
      const vPhase = (t * vRate + 0.3) % 1;
      let vSaccade = 0;
      if (vPhase < 0.04) {
        const vStep = Math.sin(vPhase * Math.PI / 0.04);
        const vAmp = 120 + rand(vCycle * 17 + seed) * 130;
        // Vertical channels get full amplitude; horizontal channels get leak
        vSaccade = isVertical ? vAmp * vStep : vAmp * 0.18 * vStep;
      }

      // ── Slow rolling eye movements — conjugate, both eyes together ──
      const slowF = 0.3 + rand(seed + 11) * 0.2;
      const slow = 25 * Math.sin(2 * Math.PI * slowF * t + rand(seed * 17) * Math.PI * 2);

      // ── Desynchrony events — occasional non-conjugate movement ──
      // ~1 event every 8-15 seconds: one eye moves independently
      const desyncRate = 0.08 + rand(seed + 19) * 0.05;
      const desyncCycle = Math.floor(t * desyncRate);
      const desyncPhase = (t * desyncRate) % 1;
      let desync = 0;
      if (desyncPhase < 0.06) {
        const dStep = Math.sin(desyncPhase * Math.PI / 0.06);
        const dAmp = 60 + rand(desyncCycle * 23 + seed) * 80;
        // Only affects one eye per event — alternates which eye
        const affectsLeft = rand(desyncCycle * 41 + seed) > 0.5;
        if (affectsLeft === isLeft) {
          desync = dAmp * dStep * (isVertical ? 1 : 0.7);
        }
        // Other eye stays still — creates visible desynchrony
      }

      // ── Per-channel micro-variation (NOT independent signals, just noise) ──
      const drift = 8 * Math.sin(2 * Math.PI * 0.05 * t + (isLeft ? 0.3 : 0.9));
      const noise = (rand(i) - 0.5) * 8;
      // Small per-electrode uniqueness so LOC1≠LOC2 exactly, but highly correlated
      const electrodeOffset = isVertical ? 0 : 3 * Math.sin(2 * Math.PI * 0.15 * t + (isLeft ? 1.2 : 2.4));

      data[i] = blink + hSaccade + vSaccade + slow + desync + drift + noise + electrodeOffset;
    } else if (isEKG) {
      const beatPhase = (t * 72 / 60) % 1;
      const qrs = beatPhase < 0.02 ? -30 : beatPhase < 0.04 ? 120 : beatPhase < 0.06 ? -20 : 0;
      const pWave = beatPhase > 0.85 ? 8 * Math.sin((beatPhase - 0.85) * Math.PI / 0.15) : 0;
      const tWave = beatPhase > 0.12 && beatPhase < 0.35 ? 15 * Math.sin((beatPhase - 0.12) * Math.PI / 0.23) : 0;
      data[i] = qrs + pWave + tWave + (rand(i) - 0.5) * 5;
    } else if (isFrontal) {
      // Frontal: dominant beta 18-25Hz, minimal alpha, muscle noise
      const beta1 = 18 * Math.sin(2 * Math.PI * (20 + rand(4) * 5) * t + rand(channelIndex * 23) * Math.PI * 2);
      const beta2 = 10 * Math.sin(2 * Math.PI * (18 + rand(5) * 4) * t + rand(channelIndex * 31) * Math.PI * 2);
      const theta = 6 * Math.sin(2 * Math.PI * (5.5 + rand(2) * 2) * t + rand(channelIndex * 13) * Math.PI * 2);
      const alpha = 4 * Math.sin(2 * Math.PI * (9.5 + rand(3)) * t + rand(channelIndex * 19) * Math.PI * 2);
      const muscle = (rand(i * 3 + 1) - 0.5) * 10;
      const drift = 2 * Math.sin(2 * Math.PI * 0.08 * t + channelIndex);
      data[i] = beta1 + beta2 + theta + alpha + muscle + drift + (rand(i) - 0.5) * 5;
      // Occasional frontal spike
      if (rand(i * 7 + channelIndex) > 0.9985) {
        const spk = (rand(i) > 0.5 ? 1 : -1) * (70 + rand(i * 11) * 40);
        for (let j = 0; j < Math.min(15, samples - i); j++) data[i + j] += spk * Math.exp(-j / 3);
      }
    } else if (isTemporal) {
      // Temporal: slower beta 13-18Hz
      const beta = 14 * Math.sin(2 * Math.PI * (15 + rand(4) * 3) * t + rand(channelIndex * 23) * Math.PI * 2);
      const alpha = 8 * Math.sin(2 * Math.PI * (9 + rand(3) * 1.5) * t + rand(channelIndex * 19) * Math.PI * 2);
      const theta = 8 * Math.sin(2 * Math.PI * (5 + rand(2) * 2) * t + rand(channelIndex * 13) * Math.PI * 2);
      const delta = 6 * Math.sin(2 * Math.PI * (1.5 + rand(1)) * t + rand(channelIndex * 7) * Math.PI * 2);
      const drift = 2.5 * Math.sin(2 * Math.PI * 0.1 * t + channelIndex);
      data[i] = beta + alpha + theta + delta + drift + (rand(i) - 0.5) * 6;
    } else if (isParietal) {
      // Parietal: high-freq alpha 9-12Hz
      const alpha = 25 * Math.sin(2 * Math.PI * (10 + rand(3) * 2) * t + rand(channelIndex * 19) * Math.PI * 2);
      const beta = 8 * Math.sin(2 * Math.PI * (18 + rand(4) * 5) * t + rand(channelIndex * 23) * Math.PI * 2);
      const theta = 5 * Math.sin(2 * Math.PI * (5 + rand(2)) * t + rand(channelIndex * 13) * Math.PI * 2);
      const drift = 2 * Math.sin(2 * Math.PI * 0.09 * t + channelIndex);
      data[i] = alpha + beta + theta + drift + (rand(i) - 0.5) * 4;
    } else if (isOccipital) {
      // Occipital: fast alpha 8-11Hz + PDR at ~9.5Hz (eyes-closed implied by seed variation)
      const pdrFreq = 8.5 + (rand(seed + channelIndex) * 2.5); // 8.5-11Hz PDR
      const pdr = 35 * Math.sin(2 * Math.PI * pdrFreq * t + rand(channelIndex * 19) * Math.PI * 2);
      const alpha2 = 12 * Math.sin(2 * Math.PI * (9 + rand(3)) * t + rand(channelIndex * 7) * Math.PI * 2);
      const fastAlpha = 8 * Math.sin(2 * Math.PI * (11 + rand(4) * 2) * t + rand(channelIndex * 23) * Math.PI * 2);
      const delta = 4 * Math.sin(2 * Math.PI * (1.5 + rand(1)) * t + rand(channelIndex * 31) * Math.PI * 2);
      const drift = 1.5 * Math.sin(2 * Math.PI * 0.07 * t + channelIndex);
      data[i] = pdr + alpha2 + fastAlpha + delta + drift + (rand(i) - 0.5) * 4;
    } else {
      // Central / other: mixed alpha-beta
      const alpha = 15 * Math.sin(2 * Math.PI * (9.5 + rand(3) * 2) * t + rand(channelIndex * 19) * Math.PI * 2);
      const beta = 10 * Math.sin(2 * Math.PI * (18 + rand(4) * 6) * t + rand(channelIndex * 23) * Math.PI * 2);
      const theta = 6 * Math.sin(2 * Math.PI * (5 + rand(2) * 2) * t + rand(channelIndex * 13) * Math.PI * 2);
      const delta = 8 * Math.sin(2 * Math.PI * (1.5 + rand(1) * 2) * t + rand(channelIndex * 7) * Math.PI * 2);
      const drift = 3 * Math.sin(2 * Math.PI * 0.1 * t + channelIndex);
      data[i] = delta + theta + alpha + beta + drift + (rand(i) - 0.5) * 5;
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

    const b = 256;
    // Correct per-signal field offsets per EDF spec
    const offLabel   = b;
    const offTrans   = offLabel  + numSignals * 16;
    const offPhysDim = offTrans  + numSignals * 80;
    const offPhysMin = offPhysDim + numSignals * 8;
    const offPhysMax = offPhysMin + numSignals * 8;
    const offDigMin  = offPhysMax + numSignals * 8;
    const offDigMax  = offDigMin  + numSignals * 8;
    const offPrefilt = offDigMax  + numSignals * 8;
    const offNSamp   = offPrefilt + numSignals * 80;

    const sigs = [];
    for (let i = 0; i < numSignals; i++) {
      const label = readStr(offLabel + i * 16, 16);
      // Skip EDF Annotations signal
      const isAnnotation = label.toUpperCase().includes("ANNOTATION");
      sigs.push({
        label,
        isAnnotation,
        physMin: readFloat(offPhysMin + i * 8, 8),
        physMax: readFloat(offPhysMax + i * 8, 8),
        digMin:  readInt(offDigMin + i * 8, 8),
        digMax:  readInt(offDigMax + i * 8, 8),
        numSamples: readInt(offNSamp + i * 8, 8),
      });
    }

    sigs.forEach(s => {
      const dr = s.digMax - s.digMin;
      const pr = s.physMax - s.physMin;
      s.scale = dr !== 0 ? pr / dr : 1;
      s.offset = s.physMin - s.digMin * s.scale;
      s.sampleRate = recordDuration > 0 ? Math.round(s.numSamples / recordDuration) : 256;
    });

    // Total samples per record across all signals
    const samplesPerRecord = sigs.reduce((sum, s) => sum + s.numSamples, 0);

    // Only decode non-annotation signals
    const dataSigs = sigs.filter(s => !s.isAnnotation);
    const channelData = dataSigs.map(s => new Float32Array(s.numSamples * numRecords));
    const dv = new DataView(arrayBuffer);

    for (let rec = 0; rec < numRecords; rec++) {
      let rOff = headerBytes + rec * samplesPerRecord * 2;
      for (let si = 0; si < numSignals; si++) {
        const s = sigs[si];
        const ns = s.numSamples;
        if (s.isAnnotation) { rOff += ns * 2; continue; }
        const dataIdx = dataSigs.indexOf(s);
        const dest = rec * ns;
        for (let n = 0; n < ns; n++) {
          if (rOff + 1 < arrayBuffer.byteLength) {
            channelData[dataIdx][dest + n] = dv.getInt16(rOff, true) * s.scale + s.offset;
          }
          rOff += 2;
        }
      }
    }

    const sampleRate = dataSigs[0]?.sampleRate || 256;
    const totalDuration = numRecords * recordDuration;

    return {
      patientId, recordingId, startDate, startTime,
      numRecords, recordDuration, numSignals: dataSigs.length,
      totalDuration, sampleRate,
      signals: dataSigs.map(s => ({ label: s.label, numSamples: s.numSamples, sampleRate: s.sampleRate })),
      channelData,
      channelLabels: dataSigs.map(s => s.label),
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

// ── EDF Writer ──
function buildEDFFile({ channelLabels, channelData, sampleRate, recordDurationSec = 1, patientId = "", recordingId = "" }) {
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
  writeStr(192, 44, "");
  writeStr(236, 8, String(numRecords));
  writeStr(244, 8, String(recordDurationSec));
  writeStr(252, 4, String(ns));

  // Per-signal headers
  const b = 256;
  const physMins = [], physMaxs = [];
  for (let i = 0; i < ns; i++) {
    let min = Infinity, max = -Infinity;
    const d = channelData[i];
    for (let j = 0; j < d.length; j++) { if (d[j] < min) min = d[j]; if (d[j] > max) max = d[j]; }
    if (min === max) { min -= 1; max += 1; }
    physMins.push(min);
    physMaxs.push(max);
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
  Ohm: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M8 17v-2a4 4 0 1 1 8 0v2"/><line x1="6" y1="17" x2="10" y2="17"/><line x1="14" y1="17" x2="18" y2="17"/></svg>,
  Eye: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="22" y2="22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>,
  EyeDots: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><circle cx="9" cy="4" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="15" cy="4" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="9" cy="20" r="1.2" fill="#F59E0B" stroke="none"/><circle cx="15" cy="20" r="1.2" fill="#F59E0B" stroke="none"/></svg>,
  Radio: (s=16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>,
  MoreVert: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>,
  Folder: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  Edit: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Package: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m16.5 9.4-9-5.19"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>,
  BarChart: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  Ruler: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 2l20 20"/><path d="M5.5 5.5l3-3"/><path d="M9.5 9.5l3-3"/><path d="M13.5 13.5l3-3"/><path d="M17.5 17.5l3-3"/></svg>,
  GitCompare: (s=14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>,
};

// ── Seed data — single simulated test record ──

function generateSeedData() {
  const simRecord = {
    id: "TEST-SIM-1",
    subjectHash: hashSubjectId("SIM-001"),
    subjectId: "SIM-001",
    sport: "Simulation",
    position: "",
    studyType: "BL",
    date: "2026-03-01",
    filename: generateFilename("SIM-001", "BL", "2026-03-01"),
    channels: 21,
    duration: 5,
    sampleRate: 256,
    fileSize: 0.3,
    montage: "10-20",
    status: "pending",
    isTest: true,
    isSimulated: true,
    notes: "Simulated baseline — lobe-accurate synthetic signals",
    uploadedAt: "2026-03-01T09:00:00.000Z",
  };

  return [simRecord];
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
    if (cmd === "load_library_index") return localStorage.getItem("react_eeg_library") || "[]";
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
    try { localStorage.setItem("react_eeg_library", JSON.stringify(records)); } catch (e) { console.warn("Failed to save library:", e); }
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

// ── TypeBadge — study type label ──
function TypeBadge({ record }) {
  const st = STUDY_TYPES[record.studyType] || { label: "?", color: "#666" };
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5}}>
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
  isAddingAnnotation, isMeasuring, measurePoints, onMouseMove, onMouseLeave, onClick, onContextMenu, containerRef, canvasRef, children,
  isLiveSimulation, simClipRef }) {

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
      const ekgDampen = ch === "EKG" ? 3 : 1; // EKG needs lower default sensitivity
      const chScale = Math.max(1, (sensitivity - chSensOffset)) * 1.5 * ekgDampen;
      ctx.strokeStyle = "#151515"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(plotX, chHeight * (i + 1)); ctx.lineTo(W, chHeight * (i + 1)); ctx.stroke();
      ctx.fillStyle = ch === "EKG" ? "#EC4899" : (ch==="LOC1"||ch==="LOC2"||ch==="ROC1"||ch==="ROC2") ? "#F59E0B" : "#666";
      ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(ch, labelWidth - 8, yCenter);
      ctx.strokeStyle = ch === "EKG" ? "#FF3333" : (ch==="LOC1"||ch==="LOC2"||ch==="ROC1"||ch==="ROC2") ? "#F59E0B80" : "#1a8fff";
      ctx.lineWidth = ch === "EKG" ? 1.2 : 0.9;
      ctx.beginPath();
      const clipSamples = (isLiveSimulation && simClipRef?.current !== undefined)
        ? Math.min(data.length, Math.floor(simClipRef.current * samplesPerEpoch))
        : data.length;
      const step = Math.max(1, Math.floor(clipSamples / plotW / 2));
      for (let j = 0; j < clipSamples; j += step) {
        const x = plotX + (j / samplesPerEpoch) * plotW;
        const y = yCenter - (data[j] / chScale);
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // Sweep line for live simulation
    if (isLiveSimulation && simClipRef?.current !== undefined && simClipRef.current < 1.0) {
      const sweepX = plotX + simClipRef.current * plotW;
      ctx.strokeStyle = "#7ec8d940";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sweepX, 0);
      ctx.lineTo(sweepX, H);
      ctx.stroke();
    }

    // Time axis
    ctx.textAlign = "center"; ctx.fillStyle = "#444"; ctx.font = "10px 'IBM Plex Mono', monospace";
    for (let t = 0; t <= epochSec; t++) {
      const x = plotX + (t / epochSec) * plotW;
      const tv = epochStart + t;
      ctx.fillText(`${Math.floor(tv/60)}:${String(Math.floor(tv%60)).padStart(2,"0")}`, x, H - 2);
    }
    ctx.textAlign = "left";

    // Measurement crosshairs
    if (measurePoints && measurePoints.length > 0) {
      measurePoints.forEach((pt, idx) => {
        const x = plotX + ((pt.time - epochStart) / epochSec) * plotW;
        const chIdx = pt.channelIdx;
        const y = chIdx >= 0 && chIdx < chCount ? chHeight * chIdx + chHeight / 2 : pt.y;

        // Vertical line
        ctx.strokeStyle = idx === 0 ? "#FF6B6B" : "#6BFF6B";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.setLineDash([]);

        // Horizontal line through the point
        ctx.strokeStyle = idx === 0 ? "#FF6B6B40" : "#6BFF6B40";
        ctx.beginPath(); ctx.moveTo(plotX, pt.y); ctx.lineTo(plotX + plotW, pt.y); ctx.stroke();

        // Point marker
        ctx.fillStyle = idx === 0 ? "#FF6B6B" : "#6BFF6B";
        ctx.beginPath(); ctx.arc(x, pt.y, 4, 0, Math.PI * 2); ctx.fill();

        // Label
        ctx.fillStyle = idx === 0 ? "#FF6B6B" : "#6BFF6B";
        ctx.font = "bold 10px 'IBM Plex Mono', monospace";
        ctx.fillText(idx === 0 ? "A" : "B", x + 6, pt.y - 6);
        ctx.font = "9px 'IBM Plex Mono', monospace";
        ctx.fillText(pt.time.toFixed(3) + "s", x + 6, pt.y + 12);
      });

      // Draw connecting line and measurement between two points
      if (measurePoints.length === 2) {
        const p1 = measurePoints[0], p2 = measurePoints[1];
        const x1 = plotX + ((p1.time - epochStart) / epochSec) * plotW;
        const x2 = plotX + ((p2.time - epochStart) / epochSec) * plotW;

        // Connecting line
        ctx.strokeStyle = "#ffffff40";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(x1, p1.y); ctx.lineTo(x2, p2.y); ctx.stroke();
        ctx.setLineDash([]);

        // Measurement box
        const midX = (x1 + x2) / 2;
        const midY = Math.min(p1.y, p2.y) - 20;
        const timeDelta = Math.abs(p2.time - p1.time);
        const ampDelta = Math.abs(p2.amplitude - p1.amplitude);
        const freq = timeDelta > 0 ? (1 / timeDelta).toFixed(1) : "---";

        const label1 = `dt: ${(timeDelta * 1000).toFixed(1)} ms`;
        const label2 = `dA: ${ampDelta.toFixed(1)} uV`;
        const label3 = `f: ${freq} Hz`;

        ctx.fillStyle = "#000000CC";
        ctx.fillRect(midX - 55, midY - 28, 110, 42);
        ctx.strokeStyle = "#ffffff30";
        ctx.strokeRect(midX - 55, midY - 28, 110, 42);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px 'IBM Plex Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(label1, midX, midY - 14);
        ctx.fillStyle = "#7ec8d9";
        ctx.fillText(label2, midX, midY);
        ctx.fillStyle = "#F59E0B";
        ctx.font = "9px 'IBM Plex Mono', monospace";
        ctx.fillText(label3, midX, midY + 12);
        ctx.textAlign = "left";
      }
    }
  }, [waveformData, channels, epochSec, epochStart, epochEnd, sampleRate, sensitivity, channelSensitivity, annotations, annotationDraft, hoveredTime, selectedAnnotationType, canvasRef, containerRef, measurePoints, isMeasuring, isLiveSimulation, simClipRef]);

  useEffect(() => {
    drawEEG();
    const h = () => drawEEG();
    window.addEventListener("resize", h);
    let animFrame;
    if (isLiveSimulation) {
      const animLoop = () => { drawEEG(); animFrame = requestAnimationFrame(animLoop); };
      animFrame = requestAnimationFrame(animLoop);
    }
    return () => { window.removeEventListener("resize", h); if (animFrame) cancelAnimationFrame(animFrame); };
  }, [drawEEG]);

  return (
    <div ref={containerRef}
      style={{ flex: 1, position: "relative", cursor: isMeasuring ? "crosshair" : isAddingAnnotation ? "crosshair" : "default" }}
      onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} onClick={onClick} onContextMenu={onContextMenu}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {children}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CUSTOM ELECTRODE PICKER — modal for "Custom" EEG system
// ══════════════════════════════════════════════════════════════
const ELECTRODE_REGIONS = [
  { label: "Frontal", electrodes: ["Fp1","Fp2","F3","F4","F7","F8","Fz"] },
  { label: "Central", electrodes: ["C3","C4","Cz"] },
  { label: "Parietal", electrodes: ["P3","P4","Pz"] },
  { label: "Occipital", electrodes: ["O1","O2"] },
  { label: "Temporal", electrodes: ["T3","T4","T5","T6"] },
  { label: "Auricular", electrodes: ["A1","A2"] },
];
const EYE_LEAD_DEFS = [
  { ch: "LOC1", ref: "Fp1", label: "LOC1 (ref: Fp1)" },
  { ch: "ROC1", ref: "Fp2", label: "ROC1 (ref: Fp2)" },
  { ch: "LOC2", ref: "F7", label: "LOC2 (ref: F7)" },
  { ch: "ROC2", ref: "F8", label: "ROC2 (ref: F8)" },
];

function CustomElectrodePicker({ customElectrodes, setCustomElectrodes, onClose }) {
  const toggle = (el) => setCustomElectrodes(prev => {
    const next = new Set(prev);
    if (next.has(el)) next.delete(el); else next.add(el);
    return next;
  });
  const selectAll = () => setCustomElectrodes(new Set([...ELECTRODE_SETS["10-20"], "LOC1","LOC2","ROC1","ROC2"]));
  const clearAll = () => setCustomElectrodes(new Set());
  const eegCount = ELECTRODE_SETS["10-20"].filter(e => customElectrodes.has(e)).length;
  const eyeCount = EYE_LEAD_DEFS.filter(e => customElectrodes.has(e.ch)).length;

  const cbStyle = (checked) => ({
    display:"flex",alignItems:"center",gap:5,padding:"3px 8px",
    background:checked?"#1a2a30":"#111",border:`1px solid ${checked?"#4a9bab":"#222"}`,
    borderRadius:2,cursor:"pointer",fontSize:10,color:checked?"#7ec8d9":"#555",
    fontWeight:checked?700:400,fontFamily:"'IBM Plex Mono', monospace",transition:"all 0.15s",
    minWidth:52,justifyContent:"center",
  });
  const eyeStyle = (checked) => ({
    ...cbStyle(checked),
    color:checked?"#F59E0B":"#555",border:`1px solid ${checked?"#F59E0B40":"#222"}`,
    background:checked?"#1a1a10":"#111",minWidth:130,justifyContent:"flex-start",
  });

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:9999,
      display:"flex",alignItems:"center",justifyContent:"center"}}
      onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:"#0c0c0c",border:"1px solid #222",padding:"20px 24px",
        minWidth:420,maxWidth:520,borderRadius:2}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <span style={{fontSize:13,fontWeight:700,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>
            Custom Electrode Selection
          </span>
          <span style={{fontSize:10,color:"#555"}}>{eegCount} EEG + {eyeCount} Eye = {eegCount+eyeCount} leads</span>
        </div>

        {ELECTRODE_REGIONS.map(region => (
          <div key={region.label} style={{marginBottom:10}}>
            <div style={{fontSize:9,color:"#444",fontWeight:700,marginBottom:4,textTransform:"uppercase",letterSpacing:1}}>
              {region.label}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
              {region.electrodes.map(el => (
                <div key={el} onClick={()=>toggle(el)} style={cbStyle(customElectrodes.has(el))}>
                  <span style={{width:8,height:8,borderRadius:"50%",
                    background:customElectrodes.has(el)?"#7ec8d9":"#333",flexShrink:0}}/>
                  {el}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div style={{marginTop:12,marginBottom:10,borderTop:"1px solid #1a1a1a",paddingTop:12}}>
          <div style={{fontSize:9,color:"#F59E0B",fontWeight:700,marginBottom:4,textTransform:"uppercase",letterSpacing:1}}>
            Eye Leads
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
            {EYE_LEAD_DEFS.map(({ch, label}) => (
              <div key={ch} onClick={()=>toggle(ch)} style={eyeStyle(customElectrodes.has(ch))}>
                <span style={{width:8,height:8,borderRadius:"50%",
                  background:customElectrodes.has(ch)?"#F59E0B":"#333",flexShrink:0}}/>
                {label}
              </div>
            ))}
          </div>
          <div style={{fontSize:9,color:"#444",marginTop:6,fontStyle:"italic"}}>
            LOC1/LOC2 track vertical eye movement via Fp1/Fp2. ROC1/ROC2 track horizontal via F7/F8.
          </div>
        </div>

        <div style={{display:"flex",gap:8,marginTop:16,justifyContent:"space-between"}}>
          <div style={{display:"flex",gap:8}}>
            <button onClick={selectAll} style={{...controlBtn(),fontSize:10}}>Select All</button>
            <button onClick={clearAll} style={{...controlBtn(),fontSize:10}}>Clear</button>
          </div>
          <button onClick={onClose} style={{...controlBtn(),color:"#7ec8d9",border:"1px solid #4a9bab",fontSize:10,padding:"4px 16px"}}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EEG CONTROLS BAR — shared between REVIEW and ACQUIRE
// ══════════════════════════════════════════════════════════════
function EEGControls({ montage, setMontage, eegSystem, setEegSystem, recordingSystem, hpf, setHpf, lpf, setLpf, notch, setNotch,
  epochSec, setEpochSec, sensitivity, setSensitivity, rightContent, onOpenCustomPicker }) {
  return (
    <div style={{ display:"flex",alignItems:"flex-end",gap:16,padding:"8px 16px",
      borderBottom:"1px solid #1a1a1a",background:"#0c0c0c",flexWrap:"wrap",flexShrink:0 }}>
      {eegSystem !== undefined && setEegSystem && (
        <div><div style={microLabel}>EEG System</div>
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <select value={eegSystem} onChange={e=>setEegSystem(e.target.value)} style={{...selectStyle,width:eegSystem==="custom"?120:140}}>
            {Object.entries(EEG_SYSTEMS).map(([k,v])=>{
              const disabled = recordingSystem && !canViewInSystem(recordingSystem, k);
              return <option key={k} value={k} disabled={disabled}>{v.label}{disabled?" (insufficient data)":""}</option>;
            })}
          </select>
          {eegSystem === "custom" && onOpenCustomPicker && (
            <button onClick={onOpenCustomPicker} title="Configure custom leads"
              style={{padding:"3px 6px",background:"#111",border:"1px solid #4a9bab",borderRadius:2,
                color:"#7ec8d9",cursor:"pointer",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:3}}>
              {I.Edit(10)}
            </button>
          )}
          </div></div>
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

// Cross-correlation (Pearson coefficient) for eye movement synchronicity analysis
function computeCrossCorrelation(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const N = Math.min(a.length, b.length);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < N; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / N, meanB = sumB / N;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < N; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// Weighted Phase Lag Index (WPLI) — volume-conduction-resistant phase synchrony
// Vinck et al. 2011, NeuroImage. Uses only the imaginary part of cross-spectral
// density, which is zero for volume-conducted (zero-lag) signals.
// Returns value in [0, 1]: 1 = perfectly synchronous, 0 = no consistent phase relationship
function computeWPLI(a, b, sr, fLow = 1, fHigh = 15) {
  if (!a || !b || a.length < 16 || b.length < 16) return null;
  const N = Math.min(a.length, b.length);
  const freqRes = sr / N;
  const kLow = Math.max(1, Math.round(fLow / freqRes));
  const kHigh = Math.min(Math.floor(N / 2), Math.round(fHigh / freqRes));
  if (kHigh <= kLow) return null;

  // Hanning window
  const wA = new Float32Array(N), wB = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
    wA[n] = a[n] * w;
    wB[n] = b[n] * w;
  }

  // Compute CSD imaginary part for each frequency bin in the EOG range
  // CSD[k] = FFT_a[k] * conj(FFT_b[k]), we only need Im(CSD)
  let sumImCSD = 0, sumAbsImCSD = 0;
  for (let k = kLow; k <= kHigh; k++) {
    let reA = 0, imA = 0, reB = 0, imB = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      reA += wA[n] * cos; imA -= wA[n] * sin;
      reB += wB[n] * cos; imB -= wB[n] * sin;
    }
    // CSD = (reA + j*imA) * (reB - j*imB) = (reA*reB + imA*imB) + j*(imA*reB - reA*imB)
    const imCSD = imA * reB - reA * imB;
    sumImCSD += imCSD;
    sumAbsImCSD += Math.abs(imCSD);
  }

  return sumAbsImCSD > 0 ? Math.abs(sumImCSD) / sumAbsImCSD : 0;
}

// Z-score artifact detection — sliding RMS windows, flag |z| > threshold
// Returns { mask: boolean[], artifactPct: number } where mask[i]=true means artifact
function detectArtifacts(data, sr, windowMs = 250, zThreshold = 4.0) {
  if (!data || data.length < 4) return { mask: new Array(data?.length || 0).fill(false), artifactPct: 0 };
  const N = data.length;
  const winSamples = Math.max(4, Math.round((windowMs / 1000) * sr));
  const nWindows = Math.floor(N / winSamples);
  if (nWindows < 3) return { mask: new Array(N).fill(false), artifactPct: 0 };

  // Compute RMS per window
  const rmsVals = new Float32Array(nWindows);
  for (let w = 0; w < nWindows; w++) {
    let sum2 = 0;
    const start = w * winSamples;
    for (let j = 0; j < winSamples; j++) { const v = data[start + j]; sum2 += v * v; }
    rmsVals[w] = Math.sqrt(sum2 / winSamples);
  }

  // Z-score each window
  let mean = 0;
  for (let w = 0; w < nWindows; w++) mean += rmsVals[w];
  mean /= nWindows;
  let variance = 0;
  for (let w = 0; w < nWindows; w++) { const d = rmsVals[w] - mean; variance += d * d; }
  const std = Math.sqrt(variance / nWindows);

  const mask = new Array(N).fill(false);
  let artifactSamples = 0;
  if (std > 0) {
    for (let w = 0; w < nWindows; w++) {
      const z = Math.abs((rmsVals[w] - mean) / std);
      if (z > zThreshold) {
        const start = w * winSamples;
        for (let j = 0; j < winSamples && (start + j) < N; j++) {
          mask[start + j] = true;
          artifactSamples++;
        }
      }
    }
  }
  return { mask, artifactPct: (artifactSamples / N) * 100 };
}

// Spectral interpolation for line noise removal (60 Hz default)
// Replaces magnitude at lineFreq ± bandwidth with average of flanking bins, preserves phase
// Returns cleaned Float32Array — no spectral distortion unlike IIR notch
function removeLineNoiseSpectral(data, sr, lineFreq = 60, bandwidth = 2) {
  if (!data || data.length < 16 || sr < lineFreq * 2) return data;
  const N = data.length;
  const freqRes = sr / N;

  // Full DFT
  const reArr = new Float32Array(N), imArr = new Float32Array(N);
  for (let k = 0; k <= Math.floor(N / 2); k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += data[n] * Math.cos(angle);
      im -= data[n] * Math.sin(angle);
    }
    reArr[k] = re; imArr[k] = im;
    // Mirror for negative frequencies
    if (k > 0 && k < Math.floor(N / 2)) {
      reArr[N - k] = re; imArr[N - k] = -im;
    }
  }

  // Identify bins to interpolate: lineFreq ± bandwidth
  const kCenter = Math.round(lineFreq / freqRes);
  const kBand = Math.ceil(bandwidth / freqRes);
  const kLow = Math.max(1, kCenter - kBand);
  const kHigh = Math.min(Math.floor(N / 2) - 1, kCenter + kBand);

  // Flanking regions for magnitude interpolation
  const flankWidth = Math.max(2, kBand);
  const flankLow = Math.max(1, kLow - flankWidth);
  const flankHigh = Math.min(Math.floor(N / 2), kHigh + flankWidth);

  let flankMagSum = 0, flankCount = 0;
  for (let k = flankLow; k < kLow; k++) {
    flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    flankCount++;
  }
  for (let k = kHigh + 1; k <= flankHigh; k++) {
    flankMagSum += Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    flankCount++;
  }
  const avgFlankMag = flankCount > 0 ? flankMagSum / flankCount : 0;

  // Replace target bins: keep phase, set magnitude to flanking average
  for (let k = kLow; k <= kHigh; k++) {
    const mag = Math.sqrt(reArr[k] * reArr[k] + imArr[k] * imArr[k]);
    if (mag > 0) {
      const scale = avgFlankMag / mag;
      reArr[k] *= scale; imArr[k] *= scale;
      if (k > 0 && k < Math.floor(N / 2)) {
        reArr[N - k] = reArr[k]; imArr[N - k] = -imArr[k];
      }
    }
  }

  // Inverse DFT
  const cleaned = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const angle = (2 * Math.PI * k * n) / N;
      sum += reArr[k] * Math.cos(angle) + imArr[k] * Math.sin(angle);
    }
    cleaned[n] = sum / N;
  }
  return cleaned;
}

// IRASA — Irregular-Resampling Auto-Spectral Analysis (Wen & Liu, 2016)
// Separates aperiodic (1/f) component from oscillatory peaks by resampling at
// irrational ratios. Returns the aperiodic spectral slope (log-log fit, 1-40 Hz).
// Steeper slope (more negative) indicates more pathological slowing.
function computeAperiodicSlope(data, sr) {
  if (!data || data.length < 64) return null;
  const N = data.length;

  // Linear interpolation resampler
  const resample = (signal, ratio) => {
    const outLen = Math.floor(signal.length * ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i / ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, signal.length - 1);
      const frac = srcIdx - lo;
      out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
    }
    return out;
  };

  // Power spectrum via DFT (Hanning windowed)
  const powerSpectrum = (sig) => {
    const M = sig.length;
    const half = Math.floor(M / 2);
    const spec = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < M; n++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (M - 1)));
        const angle = (2 * Math.PI * k * n) / M;
        re += sig[n] * w * Math.cos(angle);
        im -= sig[n] * w * Math.sin(angle);
      }
      spec[k] = (re * re + im * im) / (M * M);
    }
    return spec;
  };

  const ratios = [1.1, 1.3, 1.5, 1.7, 1.9];
  // For each ratio, compute geometric mean of up/down resampled spectra
  // Use the minimum common frequency range (determined by downsampled version)
  const minLen = Math.floor(N / 1.9); // smallest downsampled length
  const minHalf = Math.floor(minLen / 2);
  if (minHalf < 4) return null;

  const aperiodicBins = new Float32Array(minHalf + 1).fill(1); // product for geometric mean
  let nRatios = 0;

  for (const h of ratios) {
    const up = resample(data, h);
    const down = resample(data, 1 / h);
    const specUp = powerSpectrum(up);
    const specDown = powerSpectrum(down);

    // Map both spectra to common frequency grid (original sr, minHalf bins)
    for (let k = 0; k <= minHalf; k++) {
      // Frequency this bin represents in original units
      const f = (k * sr) / N;
      // Corresponding bin in upsampled spectrum (sr stays same, length changes)
      const kUp = Math.min(Math.round((f * up.length) / sr), specUp.length - 1);
      const kDown = Math.min(Math.round((f * down.length) / sr), specDown.length - 1);
      const geoMean = Math.sqrt(Math.max(1e-30, specUp[kUp]) * Math.max(1e-30, specDown[kDown]));
      aperiodicBins[k] *= geoMean;
    }
    nRatios++;
  }

  // Take nth root for geometric mean across ratios
  for (let k = 0; k <= minHalf; k++) {
    aperiodicBins[k] = Math.pow(aperiodicBins[k], 1 / nRatios);
  }

  // Fit log-log line in 1-40 Hz range: log(P) = slope * log(f) + intercept
  const freqRes = sr / N;
  const kLow = Math.max(1, Math.round(1 / freqRes));
  const kHigh = Math.min(minHalf, Math.round(40 / freqRes));
  if (kHigh <= kLow + 2) return null;

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, nPts = 0;
  for (let k = kLow; k <= kHigh; k++) {
    const f = k * freqRes;
    if (f < 0.5 || aperiodicBins[k] <= 0) continue;
    const logF = Math.log10(f);
    const logP = Math.log10(aperiodicBins[k]);
    sumX += logF; sumY += logP; sumXX += logF * logF; sumXY += logF * logP;
    nPts++;
  }
  if (nPts < 3) return null;
  const slope = (nPts * sumXY - sumX * sumY) / (nPts * sumXX - sumX * sumX);
  return Math.round(slope * 100) / 100; // e.g. -1.73
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
  // Hanning-windowed DFT for band power — reduces spectral leakage vs raw rectangular window
  const computeBandPower = (data, sr) => {
    if (!data || data.length === 0) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const N = data.length;
    const freqRes = sr / N;

    // Apply Hanning window: w[n] = 0.5 * (1 - cos(2πn/(N-1)))
    const windowed = new Float32Array(N);
    let winEnergy = 0;
    for (let n = 0; n < N; n++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      windowed[n] = data[n] * w;
      winEnergy += w * w;
    }
    const winNorm = winEnergy / N; // window energy correction factor

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
          re += windowed[n] * Math.cos(angle);
          im -= windowed[n] * Math.sin(angle);
        }
        bandPow += (re * re + im * im) / (N * N * winNorm);
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

    // Artifact detection across all EEG channels — aggregate worst-case artifact %
    const AUX_EXCLUDE = new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]);
    let totalArtifactPct = 0, nArtChannels = 0;
    const channelArtifacts = {};

    const channelData = channels.map((ch, i) => {
      const raw = waveformData[i];
      if (!raw) return { channel: ch, bands: { delta:0, theta:0, alpha:0, beta:0, gamma:0, total:0 } };
      let sub = raw.slice(0, maxSamples);

      // Z-score artifact detection on EEG channels
      if (!AUX_EXCLUDE.has(ch)) {
        const { mask, artifactPct } = detectArtifacts(sub, sampleRate);
        channelArtifacts[ch] = artifactPct;
        totalArtifactPct += artifactPct;
        nArtChannels++;
        // Zero out artifact samples before spectral analysis
        if (artifactPct > 0) {
          sub = new Float32Array(sub);
          for (let j = 0; j < sub.length; j++) { if (mask[j]) sub[j] = 0; }
        }
      }

      // Spectral interpolation for 60 Hz line noise (cleaner than IIR notch)
      if (!AUX_EXCLUDE.has(ch) && sampleRate > 120) {
        sub = removeLineNoiseSpectral(sub, sampleRate, 60, 2);
      }

      const bands = computeBandPower(sub, sampleRate);
      return { channel: ch, bands };
    });

    const avgArtifactPct = nArtChannels > 0 ? totalArtifactPct / nArtChannels : 0;

    // Compute averages (exclude EKG and eye leads — not brain EEG)
    const avgBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
    const eegChannels = channelData.filter(c => !AUX_EXCLUDE.has(c.channel));
    eegChannels.forEach(c => {
      Object.keys(avgBands).forEach(b => { avgBands[b] += c.bands[b]; });
    });
    if (eegChannels.length > 0) {
      Object.keys(avgBands).forEach(b => { avgBands[b] /= eegChannels.length; });
    }

    // Alpha peak frequency — averaged across posterior channels with zero-padded 0.1 Hz resolution
    let peakAlphaFreq = 10;
    if (eegChannels.length > 0) {
      const posteriorNames = new Set(["P3","P4","Pz","O1","O2"]);
      const posteriorIdxs = channels.map((ch, i) => posteriorNames.has(ch.split("-")[0]) ? i : -1).filter(i => i >= 0);
      // Fall back to mid-channel if no posterior channels found
      const useIdxs = posteriorIdxs.length > 0 ? posteriorIdxs : [Math.floor(channels.length / 2)];
      // Average power spectrum across posterior channels for robust peak detection
      const Norig = Math.min(maxSamples, waveformData[0]?.length || 0);
      const Npad = Norig * 2; // zero-pad to 2x for finer freq resolution
      const freqRes = sampleRate / Npad;
      const kLow = Math.max(1, Math.round(7 / freqRes));
      const kHigh = Math.min(Math.floor(Npad / 2), Math.round(14 / freqRes));
      const avgSpectrum = new Float32Array(kHigh - kLow + 1);
      let nContrib = 0;
      for (const idx of useIdxs) {
        const raw = waveformData[idx]?.slice(0, Norig);
        if (!raw) continue;
        // Hanning window + zero-pad
        const padded = new Float32Array(Npad);
        for (let n = 0; n < Norig; n++) {
          padded[n] = raw[n] * 0.5 * (1 - Math.cos((2 * Math.PI * n) / (Norig - 1)));
        }
        for (let ki = 0; ki <= kHigh - kLow; ki++) {
          const k = kLow + ki;
          let re = 0, im = 0;
          for (let n = 0; n < Npad; n++) {
            const angle = (2 * Math.PI * k * n) / Npad;
            re += padded[n] * Math.cos(angle);
            im -= padded[n] * Math.sin(angle);
          }
          avgSpectrum[ki] += re * re + im * im;
        }
        nContrib++;
      }
      if (nContrib > 0) {
        let maxPow = 0;
        for (let ki = 0; ki < avgSpectrum.length; ki++) {
          const p = avgSpectrum[ki] / nContrib;
          if (p > maxPow) { maxPow = p; peakAlphaFreq = (kLow + ki) * freqRes; }
        }
        peakAlphaFreq = Math.round(peakAlphaFreq * 10) / 10; // round to 0.1 Hz
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
      if (AUX_EXCLUDE.has(c.channel)) return;
      const total = c.bands.total || 1;
      const deltaPct = (c.bands.delta / total) * 100;
      const thetaPct = (c.bands.theta / total) * 100;
      if (deltaPct > 60) flags.push({ channel: c.channel, type: "Elevated Delta", value: `${deltaPct.toFixed(0)}%`, severity: "high" });
      else if (deltaPct > 45) flags.push({ channel: c.channel, type: "Moderate Delta", value: `${deltaPct.toFixed(0)}%`, severity: "med" });
      if (thetaPct > 40) flags.push({ channel: c.channel, type: "Elevated Theta", value: `${thetaPct.toFixed(0)}%`, severity: "high" });
    });

    // Frontotemporal slowing composite — key concussion biomarker
    const ftChannels = channelData.filter(c => /^(Fp1|Fp2|F3|F4|F7|F8|T3|T4|Fz)/.test(c.channel.split("-")[0]));
    if (ftChannels.length > 0) {
      const ftSlowPower = ftChannels.reduce((s, c) => s + c.bands.delta + c.bands.theta, 0) / ftChannels.length;
      const ftTotalPower = ftChannels.reduce((s, c) => s + (c.bands.total || 1), 0) / ftChannels.length;
      const ftSlowPct = (ftSlowPower / ftTotalPower) * 100;
      if (ftSlowPct > 55) flags.push({ channel: "F/T", type: "Frontotemporal Slowing", value: `${ftSlowPct.toFixed(0)}% slow (δ+θ)`, severity: "high" });
      else if (ftSlowPct > 40) flags.push({ channel: "F/T", type: "Mild FT Slowing", value: `${ftSlowPct.toFixed(0)}% slow (δ+θ)`, severity: "med" });
    }

    // Eye Movement Synchronicity Analysis — dual method: WPLI (primary) + Pearson (secondary)
    const loc1Idx = channels.indexOf("LOC1");
    const roc1Idx = channels.indexOf("ROC1");
    const loc2Idx = channels.indexOf("LOC2");
    const roc2Idx = channels.indexOf("ROC2");

    let eyeSync = null;
    const hasVertical = loc1Idx >= 0 && roc1Idx >= 0;
    const hasHorizontal = loc2Idx >= 0 && roc2Idx >= 0;

    if (hasVertical || hasHorizontal) {
      const maxS = Math.min(512, waveformData[0]?.length || 0);
      const loc1Data = hasVertical ? waveformData[loc1Idx]?.slice(0, maxS) : null;
      const roc1Data = hasVertical ? waveformData[roc1Idx]?.slice(0, maxS) : null;
      const loc2Data = hasHorizontal ? waveformData[loc2Idx]?.slice(0, maxS) : null;
      const roc2Data = hasHorizontal ? waveformData[roc2Idx]?.slice(0, maxS) : null;

      // WPLI (Vinck 2011) — volume-conduction resistant, primary sync metric
      const wpliVert = hasVertical ? computeWPLI(loc1Data, roc1Data, sampleRate, 1, 15) : null;
      const wpliHoriz = hasHorizontal ? computeWPLI(loc2Data, roc2Data, sampleRate, 1, 15) : null;

      // Pearson correlation — secondary/legacy metric
      const vertCorr = hasVertical ? computeCrossCorrelation(loc1Data, roc1Data) : null;
      const horizCorr = hasHorizontal ? computeCrossCorrelation(loc2Data, roc2Data) : null;

      // Blink amplitude symmetry: compare RMS of vertical channels
      let blinkSymmetry = null;
      if (hasVertical && loc1Data && roc1Data) {
        let rmsL = 0, rmsR = 0;
        for (let i = 0; i < maxS; i++) { rmsL += loc1Data[i] * loc1Data[i]; rmsR += roc1Data[i] * roc1Data[i]; }
        rmsL = Math.sqrt(rmsL / maxS); rmsR = Math.sqrt(rmsR / maxS);
        const maxRms = Math.max(rmsL, rmsR, 1);
        blinkSymmetry = 1 - Math.abs(rmsL - rmsR) / maxRms;
      }

      // Combined synchronicity score — WPLI-weighted (favors volume-conduction-resistant measure)
      const scores = [];
      if (wpliVert !== null) scores.push(wpliVert);
      if (wpliHoriz !== null) scores.push(wpliHoriz);
      if (blinkSymmetry !== null) scores.push(blinkSymmetry);
      const syncScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : null;

      eyeSync = { wpliVert, wpliHoriz, vertCorr, horizCorr, blinkSymmetry, syncScore };
    }

    // IRASA aperiodic slope — computed on averaged EEG data for efficiency
    let aperiodicSlope = null;
    if (eegChannels.length > 0) {
      // Average a few representative channels for slope estimate
      const slopeChNames = new Set(["Fz","Cz","Pz","F3","F4","C3","C4"]);
      const slopeIdxs = channels.map((ch, i) => slopeChNames.has(ch.split("-")[0]) ? i : -1).filter(i => i >= 0);
      const useIdxs = slopeIdxs.length > 0 ? slopeIdxs : [Math.floor(channels.length / 2)];
      // Average signal across selected channels
      const avgSig = new Float32Array(maxSamples);
      let nSig = 0;
      for (const idx of useIdxs) {
        const raw = waveformData[idx]?.slice(0, maxSamples);
        if (!raw) continue;
        for (let j = 0; j < maxSamples; j++) avgSig[j] += raw[j];
        nSig++;
      }
      if (nSig > 0) {
        for (let j = 0; j < maxSamples; j++) avgSig[j] /= nSig;
        aperiodicSlope = computeAperiodicSlope(avgSig, sampleRate);
      }
    }

    // Artifact flags
    if (avgArtifactPct > 20) flags.push({ channel: "ALL", type: "High Artifact", value: `${avgArtifactPct.toFixed(0)}% contaminated`, severity: "high" });
    else if (avgArtifactPct > 10) flags.push({ channel: "ALL", type: "Moderate Artifact", value: `${avgArtifactPct.toFixed(0)}% contaminated`, severity: "med" });

    // Aperiodic slope flag
    if (aperiodicSlope !== null && aperiodicSlope < -2.5) flags.push({ channel: "ALL", type: "Steep 1/f Slope", value: `${aperiodicSlope} (pathological)`, severity: "high" });
    else if (aperiodicSlope !== null && aperiodicSlope < -2.2) flags.push({ channel: "ALL", type: "Mild 1/f Steepening", value: `${aperiodicSlope}`, severity: "med" });

    return { channelData, avgBands, peakAlphaFreq, asymmetryIndex, thetaBetaRatio, flags, eyeSync, avgArtifactPct, aperiodicSlope };
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
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr",gap:3,marginTop:8}}>
            {[
              {label:"α PEAK",value:`${analysis.peakAlphaFreq.toFixed(1)}`,unit:"Hz",color:analysis.peakAlphaFreq<8.5?"#F59E0B":"#10B981"},
              {label:"θ/β",value:analysis.thetaBetaRatio.toFixed(2),unit:"",color:analysis.thetaBetaRatio>3.5?"#f87171":analysis.thetaBetaRatio>2.5?"#F59E0B":"#10B981"},
              {label:"ASYM",value:`${analysis.asymmetryIndex>0?"+":""}${analysis.asymmetryIndex.toFixed(1)}`,unit:"%",color:Math.abs(analysis.asymmetryIndex)>15?"#F59E0B":"#7ec8d9"},
              {label:"1/f",value:analysis.aperiodicSlope!==null?analysis.aperiodicSlope.toFixed(1):"—",unit:"",color:analysis.aperiodicSlope!==null?(analysis.aperiodicSlope<-2.5?"#f87171":analysis.aperiodicSlope<-2.2?"#F59E0B":"#10B981"):"#555"},
              {label:"ART%",value:analysis.avgArtifactPct!==undefined?analysis.avgArtifactPct.toFixed(0):"0",unit:"%",color:analysis.avgArtifactPct>20?"#f87171":analysis.avgArtifactPct>10?"#F59E0B":"#10B981"},
              {label:"CH",value:channels.filter(c=>!new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]).has(c)).length,unit:"",color:"#888"},
            ].map((m,i)=>(
              <div key={i} style={{background:"#0a0a0a",border:"1px solid #1a1a1a",padding:"3px 4px",textAlign:"center"}}>
                <div style={{fontSize:6,color:"#555",letterSpacing:"0.06em"}}>{m.label}</div>
                <div style={{fontSize:11,fontWeight:700,color:m.color,fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}<span style={{fontSize:7,fontWeight:400}}>{m.unit}</span></div>
              </div>
            ))}
          </div>

          {/* Eye Movement Synchronicity */}
          {analysis.eyeSync && (() => {
            const s = analysis.eyeSync;
            const score = s.syncScore;
            const scoreColor = score >= 75 ? "#10B981" : score >= 50 ? "#F59E0B" : "#f87171";
            const statusLabel = score >= 75 ? "SYNC" : score >= 50 ? "MILD DESYNC" : "DESYNC";
            return (
              <div style={{marginTop:8,borderTop:"1px solid #1a1a1a",paddingTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <span style={{fontSize:8,color:"#F59E0B",fontWeight:700,letterSpacing:"0.06em"}}>EYE SYNCHRONICITY</span>
                  <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                    <span style={{fontSize:7,color:scoreColor,letterSpacing:"0.04em"}}>{statusLabel}</span>
                    <span style={{fontSize:14,fontWeight:700,color:scoreColor,fontFamily:"'IBM Plex Mono', monospace"}}>{score.toFixed(0)}%</span>
                  </div>
                </div>
                <div style={{height:3,background:"#111",borderRadius:2,marginBottom:6}}>
                  <div style={{height:"100%",background:scoreColor,width:`${Math.min(100, score)}%`,borderRadius:2,transition:"width 0.3s"}}/>
                </div>
                {/* WPLI — primary sync metric (volume-conduction resistant) */}
                {(s.wpliVert !== null || s.wpliHoriz !== null) && (
                  <div style={{display:"flex",gap:8,marginBottom:3}}>
                    {s.wpliVert !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 0"}}>
                        <span style={{fontSize:7,color:"#555"}}>WPLI Vert</span>
                        <span style={{fontSize:10,fontWeight:700,color:s.wpliVert>0.6?"#10B981":s.wpliVert>0.3?"#F59E0B":"#f87171",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.wpliVert.toFixed(3)}
                        </span>
                      </div>
                    )}
                    {s.wpliHoriz !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"2px 0"}}>
                        <span style={{fontSize:7,color:"#555"}}>WPLI Horiz</span>
                        <span style={{fontSize:10,fontWeight:700,color:s.wpliHoriz>0.6?"#10B981":s.wpliHoriz>0.3?"#F59E0B":"#f87171",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.wpliHoriz.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {/* Pearson — secondary metric */}
                {(s.vertCorr !== null || s.horizCorr !== null) && (
                  <div style={{display:"flex",gap:8,marginBottom:3}}>
                    {s.vertCorr !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                        <span style={{fontSize:7,color:"#444"}}>r Vert</span>
                        <span style={{fontSize:9,fontWeight:600,color:s.vertCorr>0.7?"#10B98180":s.vertCorr>0.4?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.vertCorr.toFixed(3)}
                        </span>
                      </div>
                    )}
                    {s.horizCorr !== null && (
                      <div style={{flex:1,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                        <span style={{fontSize:7,color:"#444"}}>r Horiz</span>
                        <span style={{fontSize:9,fontWeight:600,color:s.horizCorr>0.7?"#10B98180":s.horizCorr>0.4?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                          {s.horizCorr.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {s.blinkSymmetry !== null && (
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0"}}>
                    <span style={{fontSize:7,color:"#444"}}>Blink Sym</span>
                    <span style={{fontSize:9,fontWeight:600,color:s.blinkSymmetry>0.8?"#10B98180":s.blinkSymmetry>0.5?"#F59E0B80":"#f8717180",fontFamily:"'IBM Plex Mono', monospace"}}>
                      {(s.blinkSymmetry * 100).toFixed(1)}%
                    </span>
                  </div>
                )}
                <div style={{fontSize:7,color:"#333",marginTop:4,lineHeight:1.3}}>
                  WPLI: phase synchrony resistant to volume conduction. Pearson: amplitude correlation. Low values may indicate oculomotor desynchrony.
                </div>
              </div>
            );
          })()}
        </>)}

        {/* Per-Channel View — compact inline rows */}
        {activeView === "channels" && (
          <div>
            <div style={{fontSize:8,color:"#555",fontWeight:700,letterSpacing:"0.08em",marginBottom:4}}>BAND POWER BY CHANNEL</div>
            {analysis.channelData.filter(c => !new Set(["EKG","LOC1","LOC2","ROC1","ROC2"]).has(c.channel)).map(c => {
              const total = c.bands.total || 1;
              return (
                <div key={c.channel} style={{display:"flex",alignItems:"center",gap:4,marginBottom:1}}>
                  <div style={{fontSize:8,color:"#888",fontFamily:"'IBM Plex Mono', monospace",width:28,textAlign:"right",flexShrink:0}}>{c.channel}</div>
                  <div style={{display:"flex",height:5,background:"#0a0a0a",border:"1px solid #111",flex:1}}>
                    {Object.entries(bandColors).map(([band, color]) => (
                      <div key={band} title={`${band}: ${((c.bands[band]/total)*100).toFixed(1)}%`}
                        style={{height:"100%",background:color,width:`${(c.bands[band]/total)*100}%`}}/>
                    ))}
                  </div>
                </div>
              );
            })}
            <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap"}}>
              {Object.entries(bandColors).map(([band, color]) => (
                <div key={band} style={{display:"flex",alignItems:"center",gap:2,fontSize:7,color:"#555"}}>
                  <div style={{width:6,height:6,background:color}}/>{band}
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

            {/* Eye Movement Analysis */}
            {analysis.eyeSync && (() => {
              const es = analysis.eyeSync;
              const sc = es.syncScore;
              const sCol = sc >= 75 ? "#10B981" : sc >= 50 ? "#F59E0B" : "#f87171";
              const metrics = [];
              if (es.vertCorr !== null) metrics.push({
                label: "Vertical Correlation (LOC1↔ROC1)",
                value: `r = ${es.vertCorr.toFixed(4)}`,
                note: "Conjugate vertical gaze: expect r > 0.7 for normal bilateral tracking",
                color: es.vertCorr > 0.7 ? "#10B981" : es.vertCorr > 0.4 ? "#F59E0B" : "#f87171"
              });
              if (es.horizCorr !== null) metrics.push({
                label: "Horizontal Correlation (LOC2↔ROC2)",
                value: `r = ${es.horizCorr.toFixed(4)}`,
                note: "Conjugate horizontal gaze: expect r > 0.7 for normal bilateral tracking. Low correlation suggests desynchrony.",
                color: es.horizCorr > 0.7 ? "#10B981" : es.horizCorr > 0.4 ? "#F59E0B" : "#f87171"
              });
              if (es.blinkSymmetry !== null) metrics.push({
                label: "Blink Amplitude Symmetry",
                value: `${(es.blinkSymmetry * 100).toFixed(2)}%`,
                note: "RMS amplitude ratio of vertical channels: >80% indicates symmetric blink reflex",
                color: es.blinkSymmetry > 0.8 ? "#10B981" : es.blinkSymmetry > 0.5 ? "#F59E0B" : "#f87171"
              });
              metrics.push({
                label: "Combined Synchronicity Score",
                value: `${sc.toFixed(1)}%`,
                note: sc >= 75 ? "Normal bilateral eye movement coordination" : sc >= 50 ? "Mild oculomotor desynchrony — may warrant further evaluation" : "Significant desynchrony — consider oculomotor assessment",
                color: sCol
              });
              return (
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:10,color:"#F59E0B",marginBottom:6,fontWeight:700}}>Eye Movement Analysis</div>
                  {metrics.map((m, i) => (
                    <div key={i} style={{padding:"6px 0",borderBottom:"1px solid #111"}}>
                      <div style={{display:"flex",justifyContent:"space-between"}}>
                        <span style={{fontSize:10,color:"#888"}}>{m.label}</span>
                        <span style={{fontSize:11,fontWeight:700,color:m.color,fontFamily:"'IBM Plex Mono', monospace"}}>{m.value}</span>
                      </div>
                      <div style={{fontSize:8,color:"#444",marginTop:2}}>{m.note}</div>
                    </div>
                  ))}
                </div>
              );
            })()}

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
            eyeSync: analysis.eyeSync,
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
// COMPARE PANEL — cross-file frequency & eye sync comparison
// ══════════════════════════════════════════════════════════════

// Hanning-windowed FFT band power for a single segment — returns { delta, theta, alpha, beta, gamma, total, peakAlphaFreq }
function computeSegmentBands(seg, sr) {
  const N = seg.length;
  if (N < 16) return null;
  const freqRes = sr / N;
  const bandRanges = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
  const windowed = new Float32Array(N);
  let winE = 0;
  for (let n = 0; n < N; n++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
    windowed[n] = seg[n] * w;
    winE += w * w;
  }
  const winNorm = winE / N;

  // Compute full power spectrum for peak detection
  const maxK = Math.min(Math.floor(N / 2), Math.round(50 / freqRes));
  const spectrum = new Float32Array(maxK + 1);
  for (let k = 1; k <= maxK; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += windowed[n] * Math.cos(angle);
      im -= windowed[n] * Math.sin(angle);
    }
    spectrum[k] = (re * re + im * im) / (N * N * winNorm);
  }

  // Sum band powers from spectrum
  const powers = {};
  let total = 0;
  Object.entries(bandRanges).forEach(([band, [fLow, fHigh]]) => {
    let p = 0;
    const kL = Math.max(1, Math.round(fLow / freqRes));
    const kH = Math.min(maxK, Math.round(fHigh / freqRes));
    for (let k = kL; k <= kH; k++) p += spectrum[k];
    powers[band] = p;
    total += p;
  });
  powers.total = total;

  // Peak alpha frequency: highest-power bin in 7-13 Hz range
  const alphaLow = Math.max(1, Math.round(7 / freqRes));
  const alphaHigh = Math.min(maxK, Math.round(13 / freqRes));
  let peakK = alphaLow, peakP = 0;
  for (let k = alphaLow; k <= alphaHigh; k++) {
    if (spectrum[k] > peakP) { peakP = spectrum[k]; peakK = k; }
  }
  powers.peakAlphaFreq = peakK * freqRes;

  // Theta/beta ratio (frontal channels are handled by caller; here it's per-channel)
  const thetaPower = powers.theta || 0;
  const betaPower = powers.beta || 0.0001;
  powers.thetaBetaRatio = thetaPower / betaPower;

  return powers;
}

// Full-file analysis: multi-epoch averaged band power across all EEG channels
function analyzeFullFile(edfData) {
  if (!edfData?.channelData || !edfData.channelLabels) return null;
  const sr = edfData.sampleRate || 256;
  const normLabel = (l) => l.toUpperCase().replace(/^(EEG|ECG|EOG|EMG)\s+/, "").replace(/[\s\-.]/g, "");
  const AUX = new Set(["EKG","ECG","LOC1","LOC2","ROC1","ROC2","PG1","PG2","E1","E2","EOGL","EOGR"]);
  const eegIdxs = edfData.channelLabels.map((l, i) => AUX.has(normLabel(l)) ? -1 : i).filter(i => i >= 0);
  if (eegIdxs.length === 0) return null;

  // Analyze in 2-second non-overlapping epochs, average across all
  const epochSamples = sr * 2;
  const bandRanges = ["delta", "theta", "alpha", "beta", "gamma"];
  const avgBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, total: 0 };
  let peakAlphaSum = 0, tbrSum = 0, nSegments = 0;

  for (const idx of eegIdxs) {
    const raw = edfData.channelData[idx];
    if (!raw || raw.length < epochSamples) continue;
    const nEpochs = Math.min(30, Math.floor(raw.length / epochSamples)); // cap at 30 epochs for performance
    for (let e = 0; e < nEpochs; e++) {
      const seg = raw.slice(e * epochSamples, (e + 1) * epochSamples);
      const bp = computeSegmentBands(seg, sr);
      if (!bp) continue;
      bandRanges.forEach(b => avgBands[b] += bp[b]);
      avgBands.total += bp.total;
      peakAlphaSum += bp.peakAlphaFreq;
      tbrSum += bp.thetaBetaRatio;
      nSegments++;
    }
  }
  if (nSegments === 0) return null;
  bandRanges.forEach(b => avgBands[b] /= nSegments);
  avgBands.total /= nSegments;

  return {
    bands: avgBands,
    peakAlphaFreq: peakAlphaSum / nSegments,
    thetaBetaRatio: tbrSum / nSegments,
    nChannels: eegIdxs.length,
    nSegments,
  };
}

// Full-file eye synchronicity: multi-epoch WPLI + Pearson across vertical and horizontal pairs
function analyzeFullFileEyeSync(edfData) {
  if (!edfData?.channelData || !edfData.channelLabels) return null;
  const sr = edfData.sampleRate || 256;
  const normLabel = (l) => l.toUpperCase().replace(/^(EEG|ECG|EOG|EMG)\s+/, "").replace(/[\s\-.]/g, "");
  const labels = edfData.channelLabels.map(normLabel);

  // Find eye channels with alias support
  const ALIASES = { "PG1": "LOC1", "PG2": "ROC1", "E1": "LOC1", "E2": "ROC1", "EOGL": "LOC1", "EOGR": "ROC1" };
  const findCh = (target) => {
    let idx = labels.indexOf(target);
    if (idx >= 0) return idx;
    for (let i = 0; i < labels.length; i++) { if (ALIASES[labels[i]] === target) return i; }
    return -1;
  };

  const loc1 = findCh("LOC1"), loc2 = findCh("LOC2"), roc1 = findCh("ROC1"), roc2 = findCh("ROC2");
  // Need at least one vertical pair (LOC1+ROC1) for sync analysis
  if (loc1 < 0 || roc1 < 0) return null;

  const epochSamples = sr * 2;
  const totalSamples = edfData.channelData[loc1].length;
  const nEpochs = Math.min(30, Math.floor(totalSamples / epochSamples));
  if (nEpochs < 1) return null;

  // Bilateral metrics (L vs R eye — LOC1 vs ROC1, LOC2 vs ROC2)
  let wpliVertSum = 0, wpliVertN = 0;
  let wpliHorizSum = 0, wpliHorizN = 0;
  let corrVertSum = 0, corrVertN = 0;
  let corrHorizSum = 0, corrHorizN = 0;
  let blinkEvents = 0, blinkSymCount = 0;
  // Per-eye metrics (LOC1 vs LOC2 = left eye, ROC1 vs ROC2 = right eye)
  let wpliLeftSum = 0, wpliLeftN = 0;
  let wpliRightSum = 0, wpliRightN = 0;
  let corrLeftSum = 0, corrLeftN = 0;
  let corrRightSum = 0, corrRightN = 0;

  for (let e = 0; e < nEpochs; e++) {
    const s = e * epochSamples;
    const aV = edfData.channelData[loc1].slice(s, s + epochSamples);
    const bV = edfData.channelData[roc1].slice(s, s + epochSamples);

    // Bilateral vertical WPLI (LOC1 vs ROC1)
    const wV = computeWPLI(aV, bV, sr, 1, 15);
    if (wV !== null) { wpliVertSum += wV; wpliVertN++; }
    const cV = computeCrossCorrelation(aV, bV);
    if (cV !== null) { corrVertSum += Math.max(0, cV); corrVertN++; }

    // Bilateral horizontal WPLI (LOC2 vs ROC2)
    if (loc2 >= 0 && roc2 >= 0) {
      const aH = edfData.channelData[loc2].slice(s, s + epochSamples);
      const bH = edfData.channelData[roc2].slice(s, s + epochSamples);
      const wH = computeWPLI(aH, bH, sr, 1, 15);
      if (wH !== null) { wpliHorizSum += wH; wpliHorizN++; }
      const cH = computeCrossCorrelation(aH, bH);
      if (cH !== null) { corrHorizSum += Math.max(0, cH); corrHorizN++; }
    }

    // Per-eye: Left eye (LOC1 vs LOC2 — vertical vs horizontal of left eye)
    if (loc2 >= 0) {
      const lH = edfData.channelData[loc2].slice(s, s + epochSamples);
      const wL = computeWPLI(aV, lH, sr, 1, 15);
      if (wL !== null) { wpliLeftSum += wL; wpliLeftN++; }
      const cL = computeCrossCorrelation(aV, lH);
      if (cL !== null) { corrLeftSum += Math.max(0, cL); corrLeftN++; }
    }

    // Per-eye: Right eye (ROC1 vs ROC2 — vertical vs horizontal of right eye)
    if (roc2 >= 0) {
      const rH = edfData.channelData[roc2].slice(s, s + epochSamples);
      const wR = computeWPLI(bV, rH, sr, 1, 15);
      if (wR !== null) { wpliRightSum += wR; wpliRightN++; }
      const cR = computeCrossCorrelation(bV, rH);
      if (cR !== null) { corrRightSum += Math.max(0, cR); corrRightN++; }
    }

    // Blink symmetry: detect blinks as peaks > 80µV in LOC1, check if ROC1 also peaks
    const blinkThresh = 80;
    for (let i = 1; i < aV.length - 1; i++) {
      if (Math.abs(aV[i]) > blinkThresh && Math.abs(aV[i]) > Math.abs(aV[i - 1]) && Math.abs(aV[i]) > Math.abs(aV[i + 1])) {
        blinkEvents++;
        let found = false;
        for (let j = Math.max(0, i - 10); j <= Math.min(bV.length - 1, i + 10); j++) {
          if (Math.abs(bV[j]) > blinkThresh * 0.5) { found = true; break; }
        }
        if (found) blinkSymCount++;
      }
    }
  }

  const wpliVert = wpliVertN > 0 ? wpliVertSum / wpliVertN : null;
  const wpliHoriz = wpliHorizN > 0 ? wpliHorizSum / wpliHorizN : null;
  const corrVert = corrVertN > 0 ? corrVertSum / corrVertN : null;
  const corrHoriz = corrHorizN > 0 ? corrHorizSum / corrHorizN : null;
  const blinkSymmetry = blinkEvents > 0 ? blinkSymCount / blinkEvents : null;
  const wpliLeft = wpliLeftN > 0 ? wpliLeftSum / wpliLeftN : null;
  const wpliRight = wpliRightN > 0 ? wpliRightSum / wpliRightN : null;
  const corrLeft = corrLeftN > 0 ? corrLeftSum / corrLeftN : null;
  const corrRight = corrRightN > 0 ? corrRightSum / corrRightN : null;

  // Combined score — WPLI-weighted
  const scores = [];
  if (wpliVert !== null) scores.push(wpliVert);
  if (wpliHoriz !== null) scores.push(wpliHoriz);
  if (blinkSymmetry !== null) scores.push(blinkSymmetry);
  const syncScore = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : null;

  return { wpliVert, wpliHoriz, corrVert, corrHoriz, wpliLeft, wpliRight, corrLeft, corrRight, blinkSymmetry, syncScore, nEpochs };
}

function ComparePanel({ openTabs, records, edfFileStore, onSelectRecord, onClose, panelPos, setPanelPos }) {
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef(null);
  const [selA, setSelA] = useState(null); // filename override for File A
  const [selB, setSelB] = useState(null); // filename override for File B
  const [showPickerA, setShowPickerA] = useState(false);
  const [showPickerB, setShowPickerB] = useState(false);

  useEffect(() => {
    if (panelPos.x === null) setPanelPos({ x: Math.round(window.innerWidth / 2 - 220), y: 60 });
  }, []);
  const onMouseDown = (e) => {
    const r = panelRef.current?.getBoundingClientRect();
    if (!r) return;
    setDragOffset({ x: e.clientX - r.left, y: e.clientY - r.top });
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => setPanelPos({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging]);

  // Build list of same-subject files from all records
  const sameSubjectFiles = useMemo(() => {
    // Collect all subject keys from open tabs
    const tabSubjects = new Set();
    for (const tab of openTabs) {
      const rec = records.find(r => r.filename === tab.filename);
      if (rec) tabSubjects.add(extractSubjectId(rec.filename) || rec.subjectHash || extractPatientHash(rec.filename) || rec.filename);
    }
    // Return all records whose subject matches any open tab's subject
    return records.filter(r => {
      const key = extractSubjectId(r.filename) || r.subjectHash || extractPatientHash(r.filename) || r.filename;
      return tabSubjects.has(key);
    });
  }, [openTabs, records]);

  // Determine which two files to compare
  const comparison = useMemo(() => {
    if (openTabs.length < 2 && !selA && !selB) return { error: "Open 2+ files in Review to compare." };

    // If user selected specific files, use those
    let fileAname = selA, fileBname = selB;

    if (!fileAname || !fileBname) {
      // Auto-detect from open tabs: group by subject
      const bySubject = {};
      for (const tab of openTabs) {
        const rec = records.find(r => r.filename === tab.filename);
        if (!rec) continue;
        const key = extractSubjectId(rec.filename) || rec.subjectHash || extractPatientHash(rec.filename) || rec.filename;
        if (!bySubject[key]) bySubject[key] = [];
        bySubject[key].push(rec);
      }
      const pairs = Object.values(bySubject).filter(g => g.length >= 2);
      if (pairs.length === 0) {
        const ids = openTabs.map(t => extractSubjectId(t.filename) || extractPatientHash(t.filename) || "?");
        return { error: `Different patients open (${ids.join(", ")}). Open two files from the same patient to compare.` };
      }
      const pair = pairs[0].sort((a, b) => {
        if (a.studyType === "BL" && b.studyType !== "BL") return -1;
        if (b.studyType === "BL" && a.studyType !== "BL") return 1;
        return (a.date || "").localeCompare(b.date || "");
      });
      if (!fileAname) fileAname = pair[0].filename;
      if (!fileBname) fileBname = pair[1].filename;
    }

    // Validate same subject
    const recA = records.find(r => r.filename === fileAname);
    const recB = records.find(r => r.filename === fileBname);
    if (!recA || !recB) return { error: "Selected files not found in library." };

    const keyA = extractSubjectId(recA.filename) || recA.subjectHash || extractPatientHash(recA.filename);
    const keyB = extractSubjectId(recB.filename) || recB.subjectHash || extractPatientHash(recB.filename);
    if (keyA !== keyB) return { error: `Different patients: ${keyA} vs ${keyB}. Select two files from the same patient.` };

    const edfA = edfFileStore?.[fileAname];
    const edfB = edfFileStore?.[fileBname];

    const analysisA = edfA ? analyzeFullFile(edfA) : null;
    const analysisB = edfB ? analyzeFullFile(edfB) : null;
    const eyeA = edfA ? analyzeFullFileEyeSync(edfA) : null;
    const eyeB = edfB ? analyzeFullFileEyeSync(edfB) : null;

    if (!analysisA && !analysisB) return { error: "No EDF data available for comparison. Import real EDF files.", recA, recB };

    return { recA, recB, analysisA, analysisB, eyeA, eyeB };
  }, [openTabs, records, edfFileStore, selA, selB]);

  const bandColors = { delta: "#6366F1", theta: "#F59E0B", alpha: "#10B981", beta: "#3B82F6", gamma: "#EC4899" };
  const bandNames = ["delta", "theta", "alpha", "beta", "gamma"];
  const bandLabels = { delta: "Delta (0.5-4)", theta: "Theta (4-8)", alpha: "Alpha (8-13)", beta: "Beta (13-30)", gamma: "Gamma (30-50)" };

  // File picker dropdown
  const FilePicker = ({ current, onSelect, show, setShow, color }) => (
    <div style={{ position: "relative" }}>
      <div onClick={() => setShow(!show)} style={{
        fontSize: 9, color, fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3,
      }} title="Click to select file">{current || "Select file..."}</div>
      {show && (
        <div style={{ position: "absolute", left: 0, top: 16, width: 340, maxHeight: 200, overflow: "auto",
          background: "#111", border: "1px solid #2a2a2a", zIndex: 100 }}>
          <div style={{ padding: "4px 8px", borderBottom: "1px solid #1a1a1a", fontSize: 8, color: "#666", fontWeight: 700 }}>SELECT FILE</div>
          {sameSubjectFiles.map(r => (
            <button key={r.id} onClick={() => { onSelect(r.filename); setShow(false); }} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
              padding: "5px 8px", background: r.filename === current ? "#1a2a30" : "transparent",
              border: "none", cursor: "pointer", borderBottom: "1px solid #111", color: "#ccc",
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 9,
            }} onMouseEnter={e => e.currentTarget.style.background = "#1a1a1a"}
               onMouseLeave={e => e.currentTarget.style.background = r.filename === current ? "#1a2a30" : "transparent"}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.filename}</span>
              <span style={{ fontSize: 8, color: "#555", flexShrink: 0, marginLeft: 8 }}>{r.studyType} {r.date}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const recA = comparison.recA;
  const recB = comparison.recB;

  return (
    <div ref={panelRef} style={{
      position: "fixed", left: panelPos.x, top: panelPos.y, width: 440,
      background: "#0c0c0c", border: "1px solid #2a2a2a", borderRadius: 0,
      display: "flex", flexDirection: "column", zIndex: 85,
      cursor: dragging ? "grabbing" : "default", userSelect: dragging ? "none" : "auto",
      maxHeight: "80vh",
    }}>
      <div onMouseDown={onMouseDown} style={{ padding: "8px 12px", borderBottom: "1px solid #1a1a1a", cursor: "grab",
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#7ec8d9", letterSpacing: "0.1em" }}>CROSS-FILE COMPARISON</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", padding: 2 }}>{I.X()}</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "10px 12px" }}>
        {/* File selectors */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, background: "#0a1520", border: "1px solid #1a3040", padding: "4px 8px" }}>
            <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.06em" }}>{recA?.studyType === "BL" ? "BASELINE" : "FILE A (EARLIER)"}</div>
            <FilePicker current={selA || recA?.filename} onSelect={setSelA} show={showPickerA} setShow={setShowPickerA} color="#7ec8d9"/>
            {recA && <div style={{ fontSize: 8, color: "#444" }}>{recA.date}</div>}
          </div>
          <div style={{ flex: 1, background: "#150a20", border: "1px solid #302040", padding: "4px 8px" }}>
            <div style={{ fontSize: 7, color: "#555", letterSpacing: "0.06em" }}>{recB?.studyType === "FU" ? "FOLLOW-UP" : "FILE B (LATER)"}</div>
            <FilePicker current={selB || recB?.filename} onSelect={setSelB} show={showPickerB} setShow={setShowPickerB} color="#c084fc"/>
            {recB && <div style={{ fontSize: 8, color: "#444" }}>{recB.date}</div>}
          </div>
        </div>

        {comparison.error ? (
          <div style={{ fontSize: 11, color: "#666", textAlign: "center", padding: "20px 10px", lineHeight: 1.6 }}>
            {comparison.error}
          </div>
        ) : (
          <>
            {/* ── SPECTRAL SPEED ── */}
            {comparison.analysisA && comparison.analysisB && (() => {
              const a = comparison.analysisA, b = comparison.analysisB;
              const totA = a.bands.total || 1, totB = b.bands.total || 1;
              const mono = "'IBM Plex Mono', monospace";
              const mkRow = (label, vA, vB, unit, inverted) => {
                const d = vB - vA;
                const c = Math.abs(d) < (unit === "%" ? 2 : unit === "Hz" ? 0.3 : 0.15) ? "#555"
                  : inverted ? (d > 0 ? "#f87171" : "#4ade80") : (d > 0 ? "#4ade80" : "#f87171");
                return (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 1 }}>
                    <span style={{ fontSize: 8, color: "#666", width: 68, flexShrink: 0 }}>{label}</span>
                    <span style={{ fontSize: 9, color: "#7ec8d9", fontFamily: mono, width: 44, textAlign: "right" }}>{typeof vA === "number" ? (unit === "%" ? vA.toFixed(1) : vA.toFixed(2)) : vA}{unit === "Hz" ? "" : unit === "%" ? "%" : ""}</span>
                    <span style={{ fontSize: 7, color: "#333" }}>&rarr;</span>
                    <span style={{ fontSize: 9, color: "#c084fc", fontFamily: mono, width: 44 }}>{typeof vB === "number" ? (unit === "%" ? vB.toFixed(1) : vB.toFixed(2)) : vB}{unit === "Hz" ? "" : unit === "%" ? "%" : ""}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: c, fontFamily: mono, flex: 1, textAlign: "right" }}>
                      {d > 0 ? "+" : ""}{unit === "%" ? d.toFixed(1) + "%" : unit === "Hz" ? d.toFixed(1) + "Hz" : d.toFixed(2)}
                    </span>
                  </div>
                );
              };
              const slowA = (a.bands.delta + a.bands.theta), fastA = (a.bands.alpha + a.bands.beta) || 0.0001;
              const slowB = (b.bands.delta + b.bands.theta), fastB = (b.bands.alpha + b.bands.beta) || 0.0001;
              return (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 8, color: "#555", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>SPECTRAL POWER CHANGE</div>
                  {bandNames.map(band => mkRow(
                    band.charAt(0).toUpperCase() + band.slice(1),
                    (a.bands[band] / totA) * 100, (b.bands[band] / totB) * 100, "%",
                    band === "delta" || band === "theta"
                  ))}
                  <div style={{ borderTop: "1px solid #111", marginTop: 4, paddingTop: 4 }}>
                    {mkRow("Peak Alpha", a.peakAlphaFreq, b.peakAlphaFreq, "Hz", false)}
                    {mkRow("θ/β Ratio", a.thetaBetaRatio, b.thetaBetaRatio, "", true)}
                    {mkRow("Slow/Fast", slowA / fastA, slowB / fastB, "", true)}
                  </div>
                </div>
              );
            })()}

            {/* ── EYE SYNCHRONICITY ── */}
            {(comparison.eyeA || comparison.eyeB) && (
              <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 6, marginTop: 2 }}>
                <div style={{ fontSize: 8, color: "#F59E0B", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>EYE SYNCHRONICITY CHANGE</div>
                {comparison.eyeA && comparison.eyeB ? (() => {
                  const eA = comparison.eyeA, eB = comparison.eyeB;
                  const mono = "'IBM Plex Mono', monospace";
                  const eyeRow = (label, vA, vB, unit, labelColor) => {
                    if (vA === null || vB === null) return null;
                    const d = vB - vA;
                    const thresh = unit === "%" ? 3 : 0.03;
                    const c = Math.abs(d) < thresh ? "#555" : (d > 0 ? "#4ade80" : "#f87171");
                    return (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 1 }}>
                        <span style={{ fontSize: 8, color: labelColor || "#666", width: 68, flexShrink: 0 }}>{label}</span>
                        <span style={{ fontSize: 9, color: "#7ec8d9", fontFamily: mono, width: 44, textAlign: "right" }}>{unit === "%" ? vA.toFixed(0) + "%" : vA.toFixed(3)}</span>
                        <span style={{ fontSize: 7, color: "#333" }}>&rarr;</span>
                        <span style={{ fontSize: 9, color: "#c084fc", fontFamily: mono, width: 44 }}>{unit === "%" ? vB.toFixed(0) + "%" : vB.toFixed(3)}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: c, fontFamily: mono, flex: 1, textAlign: "right" }}>
                          {d > 0 ? "+" : ""}{unit === "%" ? d.toFixed(1) + "%" : d.toFixed(3)}
                        </span>
                      </div>
                    );
                  };
                  return (
                    <>
                      {/* Bilateral (L eye vs R eye) */}
                      <div style={{ fontSize: 7, color: "#444", marginBottom: 3 }}>Bilateral (L vs R eye)</div>
                      {eyeRow("Sync Score", eA.syncScore, eB.syncScore, "%", "#F59E0B")}
                      {eyeRow("WPLI Vert", eA.wpliVert, eB.wpliVert, "")}
                      {eyeRow("WPLI Horiz", eA.wpliHoriz, eB.wpliHoriz, "")}
                      {eyeRow("Blink Sym", eA.blinkSymmetry !== null ? eA.blinkSymmetry * 100 : null, eB.blinkSymmetry !== null ? eB.blinkSymmetry * 100 : null, "%")}

                      {/* Per-eye (L eye internal, R eye internal) */}
                      <div style={{ fontSize: 7, color: "#444", marginTop: 4, marginBottom: 3 }}>Per-eye (vertical vs horizontal within each eye)</div>
                      {eyeRow("L Eye WPLI", eA.wpliLeft, eB.wpliLeft, "", "#4fc3f7")}
                      {eyeRow("L Eye r", eA.corrLeft, eB.corrLeft, "")}
                      {eyeRow("R Eye WPLI", eA.wpliRight, eB.wpliRight, "", "#ce93d8")}
                      {eyeRow("R Eye r", eA.corrRight, eB.corrRight, "")}
                    </>
                  );
                })() : (
                  <div style={{ fontSize: 9, color: "#555" }}>Eye lead data (LOC/ROC) not available in both files.</div>
                )}
              </div>
            )}

            {/* Clinical note */}
            <div style={{ marginTop: 6, padding: "4px 8px", background: "#0a0a0a", border: "1px solid #1a1a1a" }}>
              <div style={{ fontSize: 7, color: "#444", lineHeight: 1.3 }}>
                Observational tool — not a diagnostic device. WPLI: Vinck et al. 2011.
              </div>
            </div>
          </>
        )}
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
function EpochNav({ currentEpoch, setCurrentEpoch, totalEpochs, epochStart, epochEnd, totalDuration, isPlaying, onPlayPause, leftContent, rightContent }) {
  return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:10,
      padding:"8px 16px",borderTop:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0 }}>
      {leftContent}
      {/* Play button — only shown when callback provided */}
      {onPlayPause && (
        <button onClick={onPlayPause} title="Play / Pause (Space)" style={{
          ...controlBtn(isPlaying),
          display:"flex",alignItems:"center",gap:4,minWidth:64,justifyContent:"center",
        }}>
          {isPlaying
            ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> PAUSE</>
            : <><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> PLAY</>
          }
        </button>
      )}
      <button onClick={()=>setCurrentEpoch(0)} style={controlBtn()}>|◀</button>
      <button onClick={()=>setCurrentEpoch(Math.max(0,currentEpoch-1))} style={controlBtn()}>{I.ChevLeft()}</button>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:11,color:"#888"}}>
          Epoch <span style={{color:"#7ec8d9",fontWeight:700}}>{currentEpoch+1}</span>
          <span style={{color:"#444"}}> / {totalEpochs}</span>
        </span>
        <span style={{color:"#333"}}>|</span>
        <span style={{fontSize:11,color:"#7ec8d9",fontWeight:600}}>
          {Math.floor(epochStart/60)}:{String(Math.floor(epochStart%60)).padStart(2,"0")}
        </span>
      </div>
      <input type="range" min={0} max={totalEpochs-1} value={currentEpoch}
        onChange={e=>setCurrentEpoch(parseInt(e.target.value))} style={{width:180,accentColor:"#7ec8d9"}}/>
      <span style={{fontSize:11,color:"#555"}}>
        {totalDuration != null ? `${Math.floor(totalDuration/60)}:${String(Math.floor(totalDuration%60)).padStart(2,"0")}` : ""}
      </span>
      <button onClick={()=>setCurrentEpoch(Math.min(totalEpochs-1,currentEpoch+1))} style={controlBtn()}>{I.ChevRight()}</button>
      <button onClick={()=>setCurrentEpoch(totalEpochs-1)} style={controlBtn()}>▶|</button>
      <span style={{color:"#333"}}>|</span>
      <span style={{fontSize:9,color:"#333"}}>Space play/pause &nbsp; ← → / hold &nbsp; Enter annotate &nbsp; +/- sens</span>
      {rightContent}
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
  "custom": { label: "Custom (Select Leads)", electrodes: 0 },
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
function useEEGState(totalDuration = 600, edfData = null, simSeedOverride = null) {
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
  const sampleRate = edfData?.sampleRate || 256;
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
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState([]);

  const [customElectrodes, setCustomElectrodes] = useState(
    () => new Set([...ELECTRODE_SETS["10-20"], "LOC1","LOC2","ROC1","ROC2"])
  );
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  const allChannels = useMemo(() => getMontageChannels(montage, eegSystem, eegSystem === "custom" ? customElectrodes : null),
    [montage, eegSystem, customElectrodes]);
  const AUX_CHANNELS = new Set(["LOC1","LOC2","ROC1","ROC2","EKG"]);
  const EYE_CHANNELS = new Set(["LOC1","LOC2","ROC1","ROC2"]);
  // EDF eye lead aliases: some systems use PG1/PG2 or E1/E2 for EOG channels
  const EYE_LEAD_ALIASES = { "PG1":"LOC1", "PG2":"ROC1", "E1":"LOC1", "E2":"ROC1", "EOGL":"LOC1", "EOGR":"ROC1" };
  const [visibilityState, setVisibilityState] = useState(0); // 0=default, 1=EEG shown (eyes hidden), 2=all shown

  // Normalize EDF label for matching (shared across hook)
  const normEdf = (l) => { const u = l.toUpperCase().trim(); if (/^(ECG|EKG)$/i.test(u)) return u.replace(/[\s\-\.]/g,""); return u.replace(/^(EEG|ECG|EOG|EMG)\s+/,"").replace(/[\s\-\.]/g,""); };
  const normCh  = (l) => l.toUpperCase().replace(/[\s\-\.]/g,"");

  // Compute which montage channels have real EDF coverage
  const channelsWithData = useMemo(() => {
    if (!edfData || !edfData.channelLabels) return new Set();
    const normed = edfData.channelLabels.map(normEdf);
    const covered = new Set();
    allChannels.forEach(ch => {
      const isEyeLead = ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2";
      const isEKG = ch === "EKG";
      if (isEKG) {
        if (normed.some(n => n === "ECG" || n === "EKG")) covered.add(ch);
        return;
      }
      if (isEyeLead) {
        if (normed.some(n => n === normCh(ch))) { covered.add(ch); return; }
        if (normed.some(n => EYE_LEAD_ALIASES[n] === ch)) covered.add(ch);
        return;
      }
      // Bipolar: need both electrodes
      if (ch.includes("-")) {
        const parts = ch.split("-");
        const ref = parts[parts.length - 1];
        if (ref === "Avg" || ref === "Cz") {
          if (normed.some(n => n === normCh(parts[0]))) covered.add(ch);
        } else if (parts.length === 2) {
          if (normed.some(n => n === normCh(parts[0])) && normed.some(n => n === normCh(parts[1]))) covered.add(ch);
          else if (normed.some(n => n === normCh(parts[0]))) covered.add(ch); // partial — show with ref subtracted
        }
      } else {
        if (normed.some(n => n === normCh(ch))) covered.add(ch);
      }
    });
    return covered;
  }, [edfData, allChannels]);

  // auxWithData: subset for PatternTable LIVE/SIM badges
  const auxWithData = useMemo(() => {
    const s = new Set();
    AUX_CHANNELS.forEach(ch => { if (channelsWithData.has(ch)) s.add(ch); });
    return s;
  }, [channelsWithData]);

  // Track user-explicit visibility overrides so auto-hide never fights the user
  const [userForcedVisible, setUserForcedVisible] = useState(new Set());
  const [userForcedHidden, setUserForcedHidden] = useState(new Set());

  // Whenever edfData or montage changes, auto-hide channels with no real data
  // (unless user has explicitly forced them visible)
  // For simulated records (simSeedOverride !== null), all channels have data — show all
  useEffect(() => {
    if (simSeedOverride !== null) {
      // Simulation: show all channels, set visibility to "all shown"
      setHiddenChannels(new Set());
      setVisibilityState(2);
      return;
    }
    // No EDF data at all — show all channels (flat lines) so user sees montage layout
    if (channelsWithData.size === 0) {
      setHiddenChannels(new Set());
      return;
    }
    // Real EDF data present — auto-hide channels not found in the EDF
    setHiddenChannels(() => {
      const next = new Set();
      allChannels.forEach(ch => {
        const hasData = channelsWithData.has(ch);
        if (userForcedHidden.has(ch)) { next.add(ch); return; }
        if (userForcedVisible.has(ch)) return; // user wants it — leave visible
        if (!hasData) next.add(ch);             // no data — hide by default
      });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsWithData, simSeedOverride]);

  const channels = allChannels.filter(ch => !hiddenChannels.has(ch));
  const totalEpochs = Math.ceil(totalDuration / epochSec);
  const epochStart = currentEpoch * epochSec;
  const epochEnd = Math.min(epochStart + epochSec, totalDuration);

  const toggleChannelVisibility = (ch) => {
    setHiddenChannels(prev => {
      const next = new Set(prev);
      const willShow = next.has(ch); // true = currently hidden, about to show
      if (willShow) next.delete(ch); else next.add(ch);
      // Track user explicit intent so auto-hide doesn't override their choice
      if (willShow) {
        setUserForcedVisible(p => { const np = new Set(p); np.add(ch); return np; });
        setUserForcedHidden(p => { const np = new Set(p); np.delete(ch); return np; });
      } else {
        setUserForcedHidden(p => { const np = new Set(p); np.add(ch); return np; });
        setUserForcedVisible(p => { const np = new Set(p); np.delete(ch); return np; });
      }
      return next;
    });
    setVisibilityState(0); // reset cycle when user manually toggles
  };

  const cycleVisibility = () => {
    // Clear user-forced overrides so auto-hide doesn't fight cycle
    setUserForcedVisible(new Set());
    setUserForcedHidden(new Set());
    if (visibilityState === 0) {
      // → State 1: Show all EEG, keep eyes + EKG hidden
      setHiddenChannels(() => {
        const next = new Set();
        allChannels.forEach(ch => { if (EYE_CHANNELS.has(ch) || ch === "EKG") next.add(ch); });
        return next;
      });
      setVisibilityState(1);
    } else if (visibilityState === 1) {
      // → State 2: Show eyes too (only EKG hidden)
      setHiddenChannels(() => {
        const next = new Set();
        allChannels.forEach(ch => { if (ch === "EKG") next.add(ch); });
        return next;
      });
      setVisibilityState(2);
    } else {
      // → State 0: Hide ALL
      setHiddenChannels(() => new Set(allChannels));
      setVisibilityState(0);
    }
  };

  // Batch-hide channels not available on hardware
  const setAvailableElectrodes = useCallback((electrodeSet) => {
    if (!electrodeSet) return;
    const hwSet = new Set([...electrodeSet].map(e => e.toUpperCase()));
    setHiddenChannels(() => {
      const next = new Set();
      allChannels.forEach(ch => {
        if (userForcedVisible.has(ch)) return;
        if (userForcedHidden.has(ch)) { next.add(ch); return; }
        const isAux = AUX_CHANNELS.has(ch);
        if (isAux) { next.add(ch); return; }
        if (ch.includes("-")) {
          const parts = ch.split("-");
          const hasFirst = hwSet.has(parts[0].toUpperCase());
          const ref = parts[parts.length - 1];
          const hasSecond = ref === "Avg" || ref === "Cz" || hwSet.has(ref.toUpperCase());
          if (!hasFirst || !hasSecond) next.add(ch);
        } else {
          if (!hwSet.has(ch.toUpperCase())) next.add(ch);
        }
      });
      return next;
    });
  }, [allChannels, userForcedVisible, userForcedHidden]);

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
        const isEyeLead = ch === "LOC1" || ch === "LOC2" || ch === "ROC1" || ch === "ROC2";
        const isEKG = ch === "EKG";
        const isSingleLabel = isEyeLead || isEKG || !ch.includes("-");

        if (isSingleLabel) {
          // EKG: match ECG label in EDF
          const searchLabel = isEKG ? "ECG" : ch;
          const edfIdx = edfData.channelLabels.findIndex(l => {
            const n = normEdf(l);
            if (n === normCh(searchLabel) || n === normCh(ch)) return true;
            if (isEKG && (n === "ECG" || n === "EKG")) return true;
            if (isEyeLead && EYE_LEAD_ALIASES[n] === ch) return true;
            return false;
          });
          if (edfIdx >= 0) {
            raw = getEDFEpochData(edfData, edfIdx, epochStart, epochSec, sampleRate);
            // ECG channels in many EDF files are stored in mV — convert to µV for display
            if (raw && isEKG) {
              let maxAbs = 0;
              for (let i = 0; i < raw.length; i++) { const a = Math.abs(raw[i]); if (a > maxAbs) maxAbs = a; }
              if (maxAbs > 0 && maxAbs < 10) { // values < 10 likely in mV, scale to µV
                const scaled = new Float32Array(raw.length);
                for (let i = 0; i < raw.length; i++) scaled[i] = raw[i] * 1000;
                raw = scaled;
              }
            }
          }
        } else {
          const parts = ch.split("-");
          const ref = parts[parts.length - 1];
          const isAvgRef = ref === "Avg";
          const isCzRef = ref === "Cz";

          const idx1 = edfData.channelLabels.findIndex(l => normEdf(l) === normCh(parts[0]));

          if (isAvgRef || isCzRef) {
            if (idx1 >= 0) raw = getEDFEpochData(edfData, idx1, epochStart, epochSec, sampleRate);
          } else if (parts.length === 2) {
            const idx2 = edfData.channelLabels.findIndex(l => normEdf(l) === normCh(parts[1]));
            if (idx1 >= 0 && idx2 >= 0) {
              const d1 = getEDFEpochData(edfData, idx1, epochStart, epochSec, sampleRate);
              const d2 = getEDFEpochData(edfData, idx2, epochStart, epochSec, sampleRate);
              if (d1 && d2) {
                raw = new Float32Array(d1.length);
                for (let i = 0; i < d1.length; i++) raw[i] = d1[i] - (i < d2.length ? d2[i] : 0);
              }
            } else if (idx1 >= 0) {
              raw = getEDFEpochData(edfData, idx1, epochStart, epochSec, sampleRate);
            }
          }
        }
      }

      // Fall back: real EDF loaded but channel not matched — flat line; sim mode → generate
      if (!raw) {
        if (edfData && edfData.channelData) {
          // Real EDF loaded but this channel not found — flat line (no simulated data)
          raw = new Float32Array(sampleRate * epochSec);
        } else if (simSeedOverride !== null) {
          raw = generateEEGSignal(fullIdx, sampleRate, epochSec, simSeedOverride + fullIdx * 137 + currentEpoch * 7919, ch);
        } else {
          raw = new Float32Array(sampleRate * epochSec);
        }
      }

      const chHpf = channelHpf[ch] !== undefined ? channelHpf[ch] : hpf;
      const chLpf = channelLpf[ch] !== undefined ? channelLpf[ch] : lpf;
      if (chHpf > 0) raw = applyHighPass(raw, chHpf, sampleRate);
      if (chLpf > 0) raw = applyLowPass(raw, chLpf, sampleRate);
      if (notch > 0) raw = applyNotch(raw, notch, sampleRate);
      return raw;
    });
  }, [montage, hpf, lpf, notch, epochSec, currentEpoch, sampleRate, channels, allChannels, hiddenChannels, channelHpf, channelLpf, edfData, epochStart, simSeedOverride]);

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
    // Measurement mode
    if (isMeasuring) {
      const time = getTimeFromX(e.clientX);
      if (time === null) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const chHeight = rect.height / channels.length;
      const chIdx = Math.floor(y / chHeight);
      const yCenter = chIdx >= 0 && chIdx < channels.length ? chHeight * chIdx + chHeight / 2 : y;

      // Get amplitude at this point
      let amplitude = 0;
      if (chIdx >= 0 && chIdx < channels.length && waveformData[chIdx]) {
        const sampleIdx = Math.floor((time - epochStart) / epochSec * waveformData[chIdx].length);
        if (sampleIdx >= 0 && sampleIdx < waveformData[chIdx].length) {
          amplitude = waveformData[chIdx][sampleIdx];
        }
      }

      const point = { time, y, channelIdx: chIdx, channel: chIdx >= 0 && chIdx < channels.length ? channels[chIdx] : "", amplitude };

      if (measurePoints.length < 2) {
        setMeasurePoints(prev => [...prev, point]);
      } else {
        // Reset and start new measurement
        setMeasurePoints([point]);
      }
      return;
    }

    // Annotation mode
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
      // Arrow keys handled by ReviewTab/AcquireTab to support hold-to-scroll; d/a as aliases here
      if (e.key === "d") setCurrentEpoch(p => Math.min(p+1, totalEpochs-1));
      if (e.key === "a") setCurrentEpoch(p => Math.max(p-1, 0));
      if (e.key === "=") setSensitivity(p => Math.max(p-1, 1));
      if (e.key === "-") setSensitivity(p => Math.min(p+1, 30));
      if (e.key === "Escape") { setIsAddingAnnotation(false); setAnnotationDraft(null); setIsMeasuring(false); setMeasurePoints([]); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [totalEpochs]);

  return {
    canvasRef, containerRef, montage, setMontage, eegSystem, setEegSystem,
    customElectrodes, setCustomElectrodes, showCustomPicker, setShowCustomPicker,
    hpf, setHpf, lpf, setLpf, notch, setNotch,
    epochSec, setEpochSec: (v) => { setEpochSec(v); setCurrentEpoch(0); },
    currentEpoch, setCurrentEpoch, sensitivity, setSensitivity, sampleRate,
    channels, allChannels, totalEpochs, epochStart, epochEnd, totalDuration, waveformData,
    annotations, setAnnotations, selectedAnnotationType, setSelectedAnnotationType,
    isAddingAnnotation, setIsAddingAnnotation, annotationDraft, setAnnotationDraft,
    showAnnotationPanel, setShowAnnotationPanel, hoveredTime, setHoveredTime,
    annotationText, setAnnotationText,
    hiddenChannels, toggleChannelVisibility, setAvailableElectrodes, visibilityState, cycleVisibility,
    channelSensitivity, adjustChannelSensitivity,
    channelHpf, setChannelHpf, channelLpf, setChannelLpf,
    auxWithData, AUX_CHANNELS, channelsWithData,
    contextMenu, setContextMenu, handleContextMenu,
    isMeasuring, setIsMeasuring, measurePoints, setMeasurePoints,
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
  const [showImport, setShowImport] = useState(false);
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
        <button onClick={()=>setShowImport(true)} style={{
          padding:"8px 16px",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,
          color:"#7ec8d9",cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:6
        }}>{I.Plus()} IMPORT</button>
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
              {[{key:null,label:"",w:"3%"},{key:"filename",label:"FILENAME",w:"24%"},{key:"studyType",label:"TYPE",w:"9%",sort:true},
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
              const dotColor = !edfFileStore?.[r.filename] && !r.isSimulated ? "#ef4444" : r.isTest ? "#3b82f6" : r.isAcquired ? "#22c55e" : "#eab308";
              const dotTitle = !edfFileStore?.[r.filename] && !r.isSimulated ? "No EDF data" : r.isTest ? "Test" : r.isAcquired ? "Recorded" : "Imported";
              return (
                <tr key={r.id} style={{borderBottom:"1px solid #111",cursor:"pointer",transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#111"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <td style={{padding:"10px 8px 10px 12px",textAlign:"center"}}>
                    <span title={dotTitle} style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:dotColor,flexShrink:0}}/>
                  </td>
                  <td style={{padding:"10px 12px",fontFamily:"'IBM Plex Mono', monospace",fontSize:12,color:"#bbb"}}>{r.filename}</td>
                  <td style={{padding:"10px 12px"}}><TypeBadge record={r}/></td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.date}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.channels}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.sampleRate}</td>
                  <td style={{padding:"10px 12px",color:"#888",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>{r.durationSec && r.durationSec < 60 ? `${r.durationSec}s` : `${r.duration}m`}</td>
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
              const dotColor = !edfFileStore?.[r.filename] && !r.isSimulated ? "#ef4444" : r.isTest ? "#3b82f6" : r.isAcquired ? "#22c55e" : "#eab308";
              const dotTitle = !edfFileStore?.[r.filename] && !r.isSimulated ? "No EDF data" : r.isTest ? "Test" : r.isAcquired ? "Recorded" : "Imported";
              return (
                <div key={r.id} style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:0,padding:16,cursor:"pointer",transition:"border-color 0.15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#333"} onMouseLeave={e=>e.currentTarget.style.borderColor="#1a1a1a"}
                  onClick={()=>onOpenReview(r)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span title={dotTitle} style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:dotColor,flexShrink:0}}/>
                      <TypeBadge record={r}/>
                    </div>
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

      {/* Import Modal */}
      {showImport && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowImport(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#111",border:"1px solid #2a2a2a",borderRadius:0,padding:28,width:480,maxHeight:"80vh",overflow:"auto"}}>
            <IngestForm onClose={()=>setShowImport(false)} onIngest={handleIngest} setEdfFileStore={setEdfFileStore}/>
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
          // Infer montage from channel count
          const detectedMontage = nSignals <= 21 ? "10-20" : nSignals <= 40 ? "hd-40" : "10-10";
          setForm(prev => ({...prev, montage: detectedMontage}));
          setFileInfo(prev => ({...prev, detectedMontage}));
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
        // Detect sample rate: read per-signal header
        // "nr of samples in each data record" starts at byte 256 + nSignals*216, 8 bytes per signal
        if (nSignals > 0 && nSignals < 200 && recordDuration > 0) {
          const srOffset = 256 + nSignals * 216;
          const srEnd = srOffset + 8;
          const hdrBytes = new Uint8Array(ev.target.result);
          if (hdrBytes.length >= srEnd) {
            const samplesPerRecord = parseInt(decoder.decode(hdrBytes.slice(srOffset, srEnd)).trim());
            if (samplesPerRecord > 0) {
              const detectedSr = Math.round(samplesPerRecord / recordDuration);
              setForm(prev => ({...prev, sampleRate: detectedSr}));
              setFileInfo(prev => ({...prev, detectedSampleRate: detectedSr}));
            }
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
    // Read enough header bytes for per-signal fields (up to ~60 signals)
    reader.readAsArrayBuffer(file.slice(0, 16384));
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
          // Persist raw EDF to IndexedDB so it survives page reloads
          saveEdfToDB(deIdFilename, ev.target.result);
          // Back-update record with real sampleRate from EDF
          const realSr = parsed.sampleRate || 256;
          if (realSr !== form.sampleRate) {
            // record already emitted; caller will need to handle via setRecords if desired
            // We correct the stored record by patching via a secondary update
          }
        }
      };
      reader.readAsArrayBuffer(selectedFile);
    }

    onIngest(record);
    onClose();
  };

  return (<>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
      <h3 style={{margin:0,color:"#e0e0e0",fontSize:16,fontWeight:700}}>Import New Record</h3>
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
      <span style={{color:"#555",fontSize:10,display:"block",marginBottom:2}}>GENERATED FILENAME</span>{generateFilename(form.subjectId,form.studyType,form.date)}
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
      <div><label style={formLabel}>Internal Subject ID</label><SubjectIdInput value={form.subjectId} onChange={v=>setForm({...form,subjectId:v})}/></div>
      <div><label style={formLabel}>Study Type</label><select style={inputStyle} value={form.studyType} onChange={e=>setForm({...form,studyType:e.target.value})}>{Object.entries(STUDY_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
      <div><label style={formLabel}>Recording Date</label><input style={inputStyle} type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></div>
      <div style={{gridColumn:"1/-1"}}><label style={formLabel}>Notes</label><input style={inputStyle} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Optional notes"/></div>
    </div>

    {/* Read-only file metadata — shown after EDF file selection */}
    {selectedFile && fileInfo && (
      <div style={{background:"#0a0a0a",border:"1px solid #1a3040",borderRadius:0,padding:"12px 16px",marginBottom:16}}>
        <div style={{fontSize:10,color:"#555",fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",marginBottom:8}}>FILE METADATA</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 24px",fontFamily:"'IBM Plex Mono', monospace",fontSize:12}}>
          <div><span style={{color:"#666"}}>Montage: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedMontage || form.montage}</span></div>
          <div><span style={{color:"#666"}}>Channels: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedChannels || form.channels}</span></div>
          <div><span style={{color:"#666"}}>Sample Rate: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedSampleRate || form.sampleRate} Hz</span></div>
          <div><span style={{color:"#666"}}>Duration: </span><span style={{color:"#7ec8d9"}}>{fileInfo.detectedDuration || form.duration} min</span></div>
          <div><span style={{color:"#666"}}>File Size: </span><span style={{color:"#7ec8d9"}}>{fileInfo.size} MB</span></div>
          <div><span style={{color:"#666"}}>Format: </span><span style={{color:"#7ec8d9"}}>{fileInfo.isEdf ? "EDF/EDF+" : "Unknown"}</span></div>
          {fileInfo.startDate && <div><span style={{color:"#666"}}>Start Date: </span><span style={{color:"#7ec8d9"}}>{fileInfo.startDate}</span></div>}
        </div>
      </div>
    )}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      <button onClick={onClose} style={{padding:"8px 16px",background:"transparent",border:"1px solid #333",borderRadius:0,color:"#888",cursor:"pointer",fontSize:13}}>Cancel</button>
      <button onClick={handleSubmit} disabled={!form.subjectId} style={{padding:"8px 20px",background:form.subjectId?"#1a4a54":"#1a1a1a",border:"1px solid "+(form.subjectId?"#4a9bab":"#333"),borderRadius:0,color:form.subjectId?"#7ec8d9":"#555",cursor:form.subjectId?"pointer":"default",fontSize:13,fontWeight:600}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}>{I.Upload()} Import Record</span>
      </button>
    </div>
  </>);
}

// ══════════════════════════════════════════════════════════════
// TAB: REVIEW
// ══════════════════════════════════════════════════════════════
function ReviewTab({ record, updateRecordStatus, records, onSelectRecord, annotationsMap, setAnnotationsMap, edfFileStore, openTabs, setOpenTabs, activeTabIdx, setActiveTabIdx, tabEpochCache }) {
  const filename = record?.filename || "";
  const edfData = edfFileStore?.[filename] || null;
  const totalDur = edfData ? edfData.totalDuration : 600;
  const recordSeed = useMemo(() => {
    const fn = record?.filename || "";
    let h = 0;
    for (let i = 0; i < fn.length; i++) h = ((h << 5) - h + fn.charCodeAt(i)) | 0;
    return Math.abs(h);
  }, [record?.filename]);
  // Only use simulated signals for the explicit simulation record — never for real EDF records
  const isSimRecord = record?.isSimulated === true;
  const eeg = useEEGState(totalDur, edfData, isSimRecord ? recordSeed : null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisPanelPos, setAnalysisPanelPos] = useState({ x: null, y: null });
  const [showCompare, setShowCompare] = useState(false);
  const [comparePanelPos, setComparePanelPos] = useState({ x: null, y: null });
  const [isPlaying, setIsPlaying] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  const playIntervalRef = useRef(null);
  // Stable refs so interval callbacks never capture stale values
  const totalEpochsRef = useRef(eeg.totalEpochs);
  const epochSecRef = useRef(eeg.epochSec);
  const setCurrentEpochRef = useRef(eeg.setCurrentEpoch);
  useEffect(() => { totalEpochsRef.current = eeg.totalEpochs; }, [eeg.totalEpochs]);
  useEffect(() => { epochSecRef.current = eeg.epochSec; }, [eeg.epochSec]);
  useEffect(() => { setCurrentEpochRef.current = eeg.setCurrentEpoch; }, [eeg.setCurrentEpoch]);
  // Reset or restore epoch when file changes
  useEffect(() => {
    const cached = tabEpochCache.current[record?.filename];
    eeg.setCurrentEpoch(cached !== undefined ? cached : 0);
  }, [record?.filename]);

  // Save epoch when switching away from a file
  const prevFilenameRef = useRef(null);
  useEffect(() => {
    if (!record) return;
    if (prevFilenameRef.current && prevFilenameRef.current !== record.filename) {
      tabEpochCache.current[prevFilenameRef.current] = eeg.currentEpoch;
    }
    prevFilenameRef.current = record.filename;
  }, [record?.filename]);

  const switchToTab = (idx) => {
    if (idx === activeTabIdx) return;
    const leavingTab = openTabs[activeTabIdx];
    if (leavingTab) tabEpochCache.current[leavingTab.filename] = eeg.currentEpoch;
    setActiveTabIdx(idx);
    const targetTab = openTabs[idx];
    if (targetTab) onSelectRecord(targetTab);
  };

  const closeTab = (idx, e) => {
    e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) return prev;
      delete tabEpochCache.current[prev[idx].filename];
      if (idx === activeTabIdx) {
        const newIdx = Math.min(idx, next.length - 1);
        setActiveTabIdx(newIdx);
        onSelectRecord(next[newIdx]);
      } else if (idx < activeTabIdx) {
        setActiveTabIdx(activeTabIdx - 1);
      }
      return next;
    });
  };

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

  // Play / pause auto-advance — uses refs to avoid stale closures
  useEffect(() => {
    clearInterval(playIntervalRef.current);
    if (isPlaying) {
      playIntervalRef.current = setInterval(() => {
        setCurrentEpochRef.current(p => {
          if (p >= totalEpochsRef.current - 1) { setIsPlaying(false); return p; }
          return p + 1;
        });
      }, epochSecRef.current * 1000);
    }
    return () => clearInterval(playIntervalRef.current);
  }, [isPlaying]);

  // Keyboard: Spacebar=play/pause, Arrow=epoch, Enter=annotation — all via stable refs
  const annotationDraftRef = useRef(null);
  const epochStartRef = useRef(eeg.epochStart);
  const epochSecKbRef = useRef(eeg.epochSec);
  const setIsAddingAnnotationRef = useRef(eeg.setIsAddingAnnotation);
  const setAnnotationDraftRef = useRef(eeg.setAnnotationDraft);
  useEffect(() => { annotationDraftRef.current = eeg.annotationDraft; }, [eeg.annotationDraft]);
  useEffect(() => { epochStartRef.current = eeg.epochStart; }, [eeg.epochStart]);
  useEffect(() => { epochSecKbRef.current = eeg.epochSec; }, [eeg.epochSec]);
  useEffect(() => { setIsAddingAnnotationRef.current = eeg.setIsAddingAnnotation; });
  useEffect(() => { setAnnotationDraftRef.current = eeg.setAnnotationDraft; });

  useEffect(() => {
    let arrowInterval = null;
    const onKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        setIsPlaying(p => !p);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!annotationDraftRef.current) {
          const t = epochStartRef.current + epochSecKbRef.current / 2;
          setIsPlaying(false);
          setIsAddingAnnotationRef.current(true);
          setAnnotationDraftRef.current({ time: Math.round(t * 100) / 100, duration: 0.2, x: 200, y: 100 });
          setShowAnnotations(true);
        }
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIsPlaying(false);
        setCurrentEpochRef.current(p => Math.min(p + 1, totalEpochsRef.current - 1));
        if (!arrowInterval) {
          arrowInterval = setInterval(() => {
            setCurrentEpochRef.current(p => Math.min(p + 1, totalEpochsRef.current - 1));
          }, 180);
        }
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIsPlaying(false);
        setCurrentEpochRef.current(p => Math.max(p - 1, 0));
        if (!arrowInterval) {
          arrowInterval = setInterval(() => {
            setCurrentEpochRef.current(p => Math.max(p - 1, 0));
          }, 180);
        }
      }
    };
    const onKeyUp = (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        clearInterval(arrowInterval); arrowInterval = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      clearInterval(arrowInterval);
    };
  }, []); // stable — all values via refs

  // Auto-verify pending records when opened for review
  useEffect(() => {
    if (record && record.status === "pending") {
      updateRecordStatus(record.id, "verified");
    }
  }, [record?.id]);

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* Multi-file tabs — always visible */}
      {openTabs.length >= 1 && (
        <div style={{display:"flex",alignItems:"center",gap:0,padding:"0 16px",borderBottom:"1px solid #1a1a1a",background:"#080808",overflow:"hidden",flexShrink:0}}>
          {openTabs.map((tab, idx) => {
            const isActive = idx === activeTabIdx;
            const tabName = tab.filename || "Unknown";
            const display = tabName.length > 30 ? tabName.slice(0, 27) + "..." : tabName;
            const patHash = extractPatientHash(tabName);
            const subId = extractSubjectId(tabName);
            // Deterministic color from patient hash so same patient = same color badge
            const hashColor = patHash ? `hsl(${(parseInt(patHash, 16) % 360)}, 60%, 55%)` : null;
            return (
              <div key={tab.filename || idx} onClick={()=>switchToTab(idx)}
                onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background="#111"}}
                onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background="transparent"}}
                style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",cursor:"pointer",
                  background:isActive?"#1a2a30":"transparent",borderBottom:isActive?"2px solid #7ec8d9":"2px solid transparent",
                  borderRight:"1px solid #1a1a1a",transition:"background 0.1s",maxWidth:260,minWidth:0}}>
                <span style={{width:6,height:6,borderRadius:"50%",flexShrink:0,
                  background:!edfFileStore?.[tab.filename]&&!tab.isSimulated?"#ef4444":tab.isTest?"#3b82f6":tab.isAcquired?"#22c55e":"#eab308"}}/>
                {subId && <span style={{fontSize:8,fontWeight:700,color:hashColor||"#888",fontFamily:"'IBM Plex Mono', monospace",
                  background:`${hashColor||"#888"}15`,padding:"1px 4px",borderRadius:2,flexShrink:0,letterSpacing:"0.05em"}}
                  title={`Patient: ${subId} (${patHash||"?"})`}>{subId}</span>}
                <span style={{fontSize:10,color:isActive?"#7ec8d9":"#666",fontWeight:isActive?700:400,
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={tabName}>{display}</span>
                {openTabs.length > 1 && (
                  <span onClick={e=>closeTab(idx,e)}
                    onMouseEnter={e=>e.currentTarget.style.color="#EF4444"}
                    onMouseLeave={e=>e.currentTarget.style.color="#444"}
                    style={{fontSize:12,color:"#444",cursor:"pointer",display:"flex",alignItems:"center",padding:"0 2px",lineHeight:1}}
                    title="Close tab">&times;</span>
                )}
              </div>
            );
          })}
          <span style={{fontSize:9,color:"#333",padding:"0 8px",flexShrink:0}}>{openTabs.length}/5</span>
        </div>
      )}

      {!toolbarCollapsed ? (<>
      {/* File info bar */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 16px",borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",fontSize:10,color:"#555"}}>
        {/* File type dot */}
        {record && <span title={!edfData&&!record.isSimulated?"No EDF data":record.isTest?"Test":record.isAcquired?"Recorded":"Imported"}
          style={{display:"inline-block",width:9,height:9,borderRadius:"50%",flexShrink:0,
            background:!edfData&&!record.isSimulated?"#ef4444":record.isTest?"#3b82f6":record.isAcquired?"#22c55e":"#eab308"}}/>}
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
                <span style={{display:"flex",alignItems:"center",gap:6}}>
                  <span title={!edfFileStore?.[r.filename]&&!r.isSimulated?"No EDF data":r.isTest?"Test":r.isAcquired?"Recorded":"Imported"} style={{display:"inline-block",width:7,height:7,borderRadius:"50%",flexShrink:0,
                    background:!edfFileStore?.[r.filename]&&!r.isSimulated?"#ef4444":r.isTest?"#3b82f6":r.isAcquired?"#22c55e":"#eab308"}}/>
                  <span style={{color:"#7ec8d9"}}>{r.filename}</span>
                </span>
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
          onOpenCustomPicker={()=>eeg.setShowCustomPicker(true)}
          hpf={eeg.hpf} setHpf={eeg.setHpf}
          lpf={eeg.lpf} setLpf={eeg.setLpf} notch={eeg.notch} setNotch={eeg.setNotch}
          epochSec={eeg.epochSec} setEpochSec={eeg.setEpochSec} sensitivity={eeg.sensitivity} setSensitivity={eeg.setSensitivity}
          rightContent={<>
            <button onClick={(e)=>{e.stopPropagation();eeg.cycleVisibility();}} style={{...controlBtn(),
              color:eeg.visibilityState===2?"#666":"#F59E0B",border:`1px solid ${eeg.visibilityState===2?"#22222280":"#F59E0B40"}`}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>
                {eeg.visibilityState===0 && <>{I.Eye(12)} Show All ({eeg.hiddenChannels.size})</>}
                {eeg.visibilityState===1 && <>{I.EyeDots(12)} Show Eyes</>}
                {eeg.visibilityState===2 && <>{I.EyeOff(12)} Hide</>}
              </span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowAnalysis(prev => !prev);}} style={controlBtn(showAnalysis)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.BarChart()} qEEG</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowCompare(prev => !prev);}} style={controlBtn(showCompare)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.GitCompare()} Compare</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();if(eeg.isMeasuring){eeg.setIsMeasuring(false);eeg.setMeasurePoints([]);}else{eeg.setIsMeasuring(true);eeg.setMeasurePoints([]);eeg.setIsAddingAnnotation(false);}}} style={controlBtn(eeg.isMeasuring)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Ruler()} Measure{eeg.measurePoints.length>0?` (${eeg.measurePoints.length}/2)`:""}</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
            </button>
          </>}/>
        <div onClick={()=>setToolbarCollapsed(true)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#111"}
          style={{height:14,background:"#111",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9650;</span>
        </div>
      </>) : (
        <div onClick={()=>setToolbarCollapsed(false)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#151515"}
          style={{height:20,background:"#151515",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9660;</span>
        </div>
      )}
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        <WaveformCanvas channels={eeg.channels} waveformData={eeg.waveformData} epochSec={eeg.epochSec}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} sampleRate={eeg.sampleRate}
          sensitivity={eeg.sensitivity} channelSensitivity={eeg.channelSensitivity}
          annotations={annotations} annotationDraft={eeg.annotationDraft}
          selectedAnnotationType={eeg.selectedAnnotationType} hoveredTime={eeg.hoveredTime}
          isAddingAnnotation={eeg.isAddingAnnotation} isMeasuring={eeg.isMeasuring} measurePoints={eeg.measurePoints}
          onMouseMove={eeg.handleCanvasMouseMove}
          onMouseLeave={()=>eeg.setHoveredTime(null)} onClick={eeg.handleCanvasClick}
          onContextMenu={eeg.handleContextMenu}
          containerRef={eeg.containerRef} canvasRef={eeg.canvasRef}>
          <AnnotationPopup draft={eeg.annotationDraft} annotationType={eeg.selectedAnnotationType}
            text={eeg.annotationText} setText={eeg.setAnnotationText} onConfirm={eeg.confirmAnnotation}
            onCancel={()=>{eeg.setAnnotationDraft(null);eeg.setIsAddingAnnotation(false);}} containerRef={eeg.containerRef}/>
        </WaveformCanvas>
      </div>
      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}
        totalDuration={eeg.totalDuration}
        isPlaying={isPlaying} onPlayPause={()=>setIsPlaying(p=>!p)}/>

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

      {/* Floating cross-file comparison panel */}
      {showCompare && (
        <ComparePanel openTabs={openTabs} records={records} edfFileStore={edfFileStore}
          onClose={()=>setShowCompare(false)}
          panelPos={comparePanelPos} setPanelPos={setComparePanelPos}/>
      )}

      {eeg.showCustomPicker && (
        <CustomElectrodePicker customElectrodes={eeg.customElectrodes}
          setCustomElectrodes={eeg.setCustomElectrodes}
          onClose={()=>eeg.setShowCustomPicker(false)}/>
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
          auxWithData={eeg.auxWithData} AUX_CHANNELS={eeg.AUX_CHANNELS}
          onClose={()=>setShowPatternTable(false)}/>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DEVICE REGISTRY — All supported hardware & protocols
// ══════════════════════════════════════════════════════════════
const DEVICE_PROTOCOLS = {
  brainflow: { label: "OpenBCI", color: "#3B82F6", desc: "Direct board API" },
  simulated: { label: "Simulated", color: "#F59E0B", desc: "Test signals" },
};

const DEVICE_CATALOG = [
  // OpenBCI hardware (BrainFlow)
  { id: "openbci-cyton-8", name: "OpenBCI Cyton", protocol: "brainflow", channels: 8, maxSr: 250, resolution: "24-bit", wireless: false, boardId: 0, port: "COM3" },
  { id: "openbci-cyton-16", name: "OpenBCI Cyton + Daisy", protocol: "brainflow", channels: 16, maxSr: 125, resolution: "24-bit", wireless: false, boardId: 2, port: "COM3" },
  // Simulator
  { id: "sim-19ch", name: "Simulator (10-20)", protocol: "simulated", channels: 19, maxSr: 256, resolution: "N/A", wireless: false },
];

// ── Connection states ──
const CONN = { disconnected: 0, connecting: 1, connected: 2, impedance: 3, ready: 4, error: -1 };
const CONN_LABELS = {
  [CONN.disconnected]: { text: "Not Connected", color: "#555" },
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
    name, value: Math.round((0.5 + Math.random() * 4.0) * 10) / 10,
    status: "good",
  }));
}
function generateNoConnectionImpedances(channelCount) {
  const electrodes = ["Fp1","Fp2","F3","F4","C3","C4","P3","P4","O1","O2","F7","F8","T3","T4","T5","T6","Fz","Cz","Pz","A1","A2"];
  return electrodes.slice(0, channelCount).map(name => ({ name, value: null, status: "poor" }));
}

// ══════════════════════════════════════════════════════════════
// DEVICE SELECTOR PANEL
// ══════════════════════════════════════════════════════════════
function DeviceSelector({ selectedDevice, setSelectedDevice, connectionState, onConnect, onDisconnect, deviceConfig, setDeviceConfig }) {
  const isConnected = connectionState >= CONN.connected;
  const connInfo = CONN_LABELS[connectionState] || CONN_LABELS[CONN.disconnected];

  return (
    <div style={{borderBottom:"1px solid #1a1a1a",background:"#0a0a0a",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 16px"}}>
        {/* Connection status indicator */}
        <div style={{display:"flex",alignItems:"center",gap:6,minWidth:140}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:connInfo.color,
            animation: connectionState===CONN.connecting ? "pulse 1.5s ease infinite" : "none"}}/>
          <span style={{fontSize:11,fontWeight:700,color:connInfo.color,letterSpacing:"0.05em"}}>{connInfo.text}</span>
        </div>

        {/* Device dropdown — flat select */}
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
            {DEVICE_CATALOG.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.channels}ch, {d.maxSr}Hz)
              </option>
            ))}
          </select>
        </div>

        {/* Port config for brainflow devices */}
        {selectedDevice && selectedDevice.protocol === "brainflow" && !selectedDevice.wireless && (
          <div><div style={microLabel}>Port</div>
            <input value={deviceConfig.port} onChange={e=>setDeviceConfig({...deviceConfig,port:e.target.value})}
              placeholder="COM3" style={{...selectStyle,width:80,padding:"5px 8px"}}/></div>
        )}

        {/* Action buttons */}
        <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
          {!isConnected ? (
            <button onClick={onConnect} disabled={!selectedDevice||connectionState===CONN.connecting} style={{
              padding:"6px 14px",background:selectedDevice?"#0a2a0a":"#1a1a1a",
              border:`1px solid ${selectedDevice?"#4a9bab40":"#333"}`,borderRadius:0,
              color:selectedDevice?"#7ec8d9":"#555",cursor:selectedDevice?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Zap()} CONNECT</button>
          ) : (
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

  const sportsExamples = [
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
  ];
  const topExamples = [
    { prefix: "OT", desc: "Other" },
    { prefix: "ST", desc: "Standard" },
    { prefix: "RS", desc: "Research" },
  ];
  const [sportsOpen, setSportsOpen] = useState(false);

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
          <div style={{padding:"8px 12px",borderBottom:"1px solid #1a1a1a",maxHeight:220,overflow:"auto"}}>
            <div style={{fontSize:9,fontWeight:700,color:"#555",letterSpacing:"0.08em",marginBottom:6}}>SUBJECT CODES — click to apply</div>

            {/* Top-level: OT, ST, RS */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3,marginBottom:6}}>
              {topExamples.map(ex => (
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

            {/* Sports subfolder */}
            <button onClick={()=>setSportsOpen(p=>!p)} style={{
              width:"100%",display:"flex",alignItems:"center",gap:6,padding:"5px 8px",
              background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:0,cursor:"pointer",marginBottom:sportsOpen?4:0,
              color:"#888",fontSize:10,fontWeight:700,letterSpacing:"0.06em",
            }}>
              <span style={{fontSize:9,color:"#444"}}>{sportsOpen?"▼":"▶"}</span>
              {I.Folder()} SPORTS
            </button>
            {sportsOpen && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3,paddingLeft:8}}>
                {sportsExamples.map(ex => (
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
            )}
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
  globalHpf, globalLpf, onClose, auxWithData, AUX_CHANNELS }) {

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

  const renderAuxChannels = () => {
          const auxChs = allChannels.filter(ch => AUX_CHANNELS.has(ch));
          if (auxChs.length === 0) return null;
          return (
            <div>
              <div style={{padding:"6px 20px",background:"#0d0d0d",borderBottom:"1px solid #111",
                fontSize:9,color:"#666",fontWeight:700,letterSpacing:"0.1em",
                display:"flex",alignItems:"center",gap:8}}>
                AUX CHANNELS (EYE / EKG)
                <span style={{fontSize:8,color:"#444",fontWeight:400}}>— activate to display when no hardware input is present</span>
              </div>
              {auxChs.map(ch => {
                const isHidden = hiddenChannels.has(ch);
                const hasRealData = auxWithData.has(ch);
                const isEKG = ch === "EKG";
                const isEye = !isEKG;
                const sens = channelSensitivity[ch] || 0;
                const chHpfVal = channelHpf[ch];
                const chLpfVal = channelLpf[ch];
                return (
                  <div key={ch} style={{
                    display:"flex",alignItems:"center",padding:"4px 20px",borderBottom:"1px solid #0d0d0d",
                    background:isHidden?"#0a0a0a":"transparent",opacity:isHidden?0.5:1,transition:"all 0.15s",
                  }}>
                    <div style={{width:30,textAlign:"center"}}>
                      <button onClick={()=>toggleChannelVisibility(ch)} style={{
                        width:16,height:16,borderRadius:0,
                        background:isHidden?"#1a1a1a":"#1a4a54",
                        border:`1px solid ${isHidden?"#333":"#4a9bab50"}`,cursor:"pointer",
                        display:"flex",alignItems:"center",justifyContent:"center",
                        color:isHidden?"#555":"#7ec8d9",fontSize:9,
                      }}>{isHidden?" ":"✓"}</button>
                    </div>
                    <span style={{width:34,textAlign:"center",fontSize:9,color:"#444",fontFamily:"'IBM Plex Mono', monospace"}}>{allChannels.indexOf(ch)+1}</span>
                    <span style={{flex:1,fontSize:11,fontWeight:600,fontFamily:"'IBM Plex Mono', monospace",
                      color:isHidden?"#444":isEKG?"#EC4899":"#F59E0B"}}>{ch}</span>
                    {/* Data source badge */}
                    <span style={{
                      fontSize:8,padding:"1px 5px",marginRight:8,fontWeight:700,
                      border:`1px solid ${hasRealData?"#10B98140":"#33333380"}`,
                      color:hasRealData?"#10B981":"#555",background:hasRealData?"#10B98110":"transparent",
                      letterSpacing:"0.06em",
                    }}>{hasRealData ? "LIVE" : "SIM"}</span>
                    <div style={{width:56,display:"flex",justifyContent:"center"}}>
                      <select value={chHpfVal !== undefined ? chHpfVal : ""} onChange={e=>{
                        const v = e.target.value;
                        if (v===""){const next={...channelHpf};delete next[ch];setChannelHpf(next);}
                        else setChannelHpf({...channelHpf,[ch]:parseFloat(v)});
                      }} style={{...tinySelect,color:chHpfVal!==undefined?"#7ec8d9":"#555"}}>
                        <option value="">—</option>
                        {hpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                      </select>
                    </div>
                    <div style={{width:56,display:"flex",justifyContent:"center"}}>
                      <select value={chLpfVal !== undefined ? chLpfVal : ""} onChange={e=>{
                        const v = e.target.value;
                        if (v===""){const next={...channelLpf};delete next[ch];setChannelLpf(next);}
                        else setChannelLpf({...channelLpf,[ch]:parseFloat(v)});
                      }} style={{...tinySelect,color:chLpfVal!==undefined?"#7ec8d9":"#555"}}>
                        <option value="">—</option>
                        {lpfOptions.map(v=><option key={v} value={v}>{v===0?"Off":`${v}`}</option>)}
                      </select>
                    </div>
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
                      <div style={{width:20,height:3,background:isEKG?"#EC4899":"#F59E0B",opacity:isHidden?0.15:0.6}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          );
  };
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

          {/* AUX CHANNELS section — Eye Leads + EKG */}
          {renderAuxChannels()}
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
                color:e.value===null?"#f87171":e.status==="good"?"#7ec8d9":e.status==="fair"?"#facc15":"#f87171"
              }}>{e.value===null?"-":`${e.value}kΩ`}</span>
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
function AcquireTab({ annotationsMap, setAnnotationsMap, setRecords, edfFileStore, setEdfFileStore, openReview }) {
  // State declared before useEEGState so they can be passed as args
  const [selectedDevice, setSelectedDevice] = useState(DEVICE_CATALOG.find(d => d.id === "openbci-cyton-16") || null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [subjectId, setSubjectId] = useState("");
  const [studyType, setStudyType] = useState("BL");
  const [showPatternTable, setShowPatternTable] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [annotationPanelPos, setAnnotationPanelPos] = useState({ x: null, y: null });
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [showPostRecordPrompt, setShowPostRecordPrompt] = useState(false);
  const [lastRecordedFile, setLastRecordedFile] = useState(null);
  const timerRef = useRef(null);

  // ── Sim epoch engine ──
  const SIM_EPOCH_SEC = 10;
  const SIM_MAX_SEC   = 60;
  const simTickRef    = useRef(null);
  const simElapsedRef = useRef(0);
  const [simEpochSeed, setSimEpochSeed] = useState(() => Math.floor(Math.random() * 100000));
  const simClipRef = useRef(1.0);
  const simAnimFrameRef = useRef(null);
  const simEpochStartRef = useRef(null);
  const simCurrentEpochRef = useRef(0);
  const seedHistoryRef = useRef([]);

  const isSim = selectedDevice?.protocol === "simulated";
  const simSeed = isSim ? (isRecording ? simEpochSeed : 42) : null;
  const eeg = useEEGState(600, null, simSeed);

  // Auto-hide channels that don't match the hardware's available electrodes
  useEffect(() => {
    if (!selectedDevice) return;
    if (isSim) {
      // Simulator has all electrodes for the current EEG system
      eeg.setAvailableElectrodes(new Set(ELECTRODE_SETS[eeg.eegSystem] || ELECTRODE_SETS["10-20"]));
      return;
    }
    const hw = OPENBCI_CHANNEL_MAP[selectedDevice.id];
    if (hw) eeg.setAvailableElectrodes(new Set(hw));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, isSim, eeg.montage, eeg.eegSystem]);

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
  const [connectionState, setConnectionState] = useState(CONN.disconnected);
  const [deviceConfig, setDeviceConfig] = useState({ sampleRate: 125, channels: 16, port: "COM3" });
  const [impedances, setImpedances] = useState(null);
  const [showImpedance, setShowImpedance] = useState(false);

  // Connection flow
  const handleConnect = useCallback(() => {
    if (!selectedDevice) return;
    if (selectedDevice.protocol === "simulated") {
      setConnectionState(CONN.connecting);
      setTimeout(() => { setConnectionState(CONN.connected); setTimeout(() => setConnectionState(CONN.ready), 500); }, 800);
      return;
    }
    // BrainFlow hardware — no real integration yet, show error
    setConnectionState(CONN.connecting);
    setTimeout(() => {
      setConnectionState(CONN.error);
    }, 2000);
  }, [selectedDevice]);

  const handleDisconnect = () => {
    setConnectionState(CONN.disconnected);
    setImpedances(null);
    setShowImpedance(false);
    if (isRecording) { setIsRecording(false); setIsPaused(false); }
  };

  const handleAcceptImpedance = () => {
    setShowImpedance(false);
    setConnectionState(CONN.ready);
  };

  // Stable ref for eeg methods so sim tick can call them without stale closures
  const eegRef = useRef(eeg);
  eegRef.current = eeg;

  // Sim tick function — called from setInterval, uses only refs to avoid stale closures
  const simTick = useCallback(() => {
    const now = performance.now();
    if (!simEpochStartRef.current) simEpochStartRef.current = now;
    const epochMs = now - simEpochStartRef.current;
    const fraction = Math.min(epochMs / (SIM_EPOCH_SEC * 1000), 1.0);
    simClipRef.current = fraction;

    const curEpoch = simCurrentEpochRef.current;
    const totalSec = Math.floor(curEpoch * SIM_EPOCH_SEC + fraction * SIM_EPOCH_SEC);
    if (totalSec !== simElapsedRef.current) {
      simElapsedRef.current = totalSec;
      setElapsedSec(totalSec);
    }

    if (fraction >= 1.0) {
      simEpochStartRef.current = now;
      simClipRef.current = 0;
      const nextEpoch = curEpoch + 1;
      const newSeed = Math.floor(Math.random() * 100000);
      seedHistoryRef.current.push(newSeed);
      if (nextEpoch * SIM_EPOCH_SEC >= SIM_MAX_SEC) {
        simElapsedRef.current = 0;
        simCurrentEpochRef.current = 0;
        setElapsedSec(0);
        eegRef.current.setCurrentEpoch(0);
        setSimEpochSeed(newSeed);
      } else {
        simCurrentEpochRef.current = nextEpoch;
        eegRef.current.setCurrentEpoch(nextEpoch);
        setSimEpochSeed(newSeed);
      }
    }
  }, []);

  // Recording engine — real devices tick elapsed; simulated devices use interval for smooth clip updates
  useEffect(() => {
    const isSim = selectedDevice?.protocol === "simulated";
    if (isRecording && !isPaused) {
      if (isSim) {
        // Resume from existing clip fraction (handles pause/resume)
        const existingFraction = simClipRef.current;
        simEpochStartRef.current = performance.now() - existingFraction * SIM_EPOCH_SEC * 1000;
        simTickRef.current = setInterval(simTick, 16);
        return () => clearInterval(simTickRef.current);
      } else {
        timerRef.current = setInterval(() => {
          setElapsedSec(p => { const next = p+1; eegRef.current.setCurrentEpoch(Math.floor(next/eegRef.current.epochSec)); return next; });
        }, 1000);
        return () => clearInterval(timerRef.current);
      }
    } else {
      clearInterval(timerRef.current);
      clearInterval(simTickRef.current);
    }
  }, [isRecording, isPaused, selectedDevice, simTick]);

  const startRecording = () => {
    if (!subjectId || connectionState < CONN.ready) return;
    simElapsedRef.current = 0;
    simClipRef.current = 0;
    simEpochStartRef.current = null;
    simCurrentEpochRef.current = 0;
    const firstSeed = Math.floor(Math.random() * 100000);
    seedHistoryRef.current = [firstSeed];
    setSimEpochSeed(firstSeed);
    setIsRecording(true); setIsPaused(false); setElapsedSec(0); eeg.setCurrentEpoch(0);
  };
  const stopRecording = () => {
    setIsRecording(false); setIsPaused(false);
    simClipRef.current = 1.0;
    cancelAnimationFrame(simAnimFrameRef.current);
    if (!subjectId || elapsedSec < 1) return;

    const today = new Date().toISOString().split("T")[0];
    const acqFile = generateFilename(subjectId, studyType, today);
    const sr = deviceConfig.sampleRate || 256;
    const actualDurationSec = elapsedSec;
    const totalSamples = sr * actualDurationSec;

    // Generate EDF from seed history — individual electrode signals
    const electrodes = ELECTRODE_SETS[eeg.eegSystem] || ELECTRODE_SETS["10-20"];
    const channelData = electrodes.map((elec, elecIdx) => {
      const fullData = new Float32Array(totalSamples);
      let offset = 0;
      seedHistoryRef.current.forEach((seed) => {
        const epochSamples = Math.min(SIM_EPOCH_SEC * sr, totalSamples - offset);
        if (epochSamples <= 0) return;
        const signal = generateEEGSignal(elecIdx, sr, SIM_EPOCH_SEC, seed + elecIdx * 137, elec);
        fullData.set(signal.subarray(0, epochSamples), offset);
        offset += epochSamples;
      });
      return fullData;
    });

    // Build EDF binary and parse it back
    const edfBuffer = buildEDFFile({
      channelLabels: electrodes,
      channelData,
      sampleRate: sr,
      recordDurationSec: 1,
      patientId: hashSubjectId(subjectId),
      recordingId: `REACT-${studyType}`,
    });
    const parsed = parseEDFFile(edfBuffer);

    // Store in edfFileStore for review and persist to IndexedDB
    if (setEdfFileStore && !parsed.error) {
      setEdfFileStore(prev => ({ ...prev, [acqFile]: parsed }));
      saveEdfToDB(acqFile, edfBuffer);
    }

    const chCount = electrodes.length;
    const durationMin = Math.round(actualDurationSec / 60 * 10) / 10;
    const newRecord = {
      id: `ACQ-${Date.now()}`,
      subjectHash: hashSubjectId(subjectId),
      subjectId,
      sport: "",
      position: "",
      studyType,
      date: today,
      filename: acqFile,
      channels: chCount,
      duration: durationMin,
      durationSec: actualDurationSec,
      sampleRate: sr,
      fileSize: Math.round(edfBuffer.byteLength / 1024 / 1024 * 10) / 10,
      montage: eeg.eegSystem,
      status: "pending",
      isTest: false,
      isAcquired: true,
      notes: `Recorded via ${selectedDevice?.name || "simulated device"}`,
      uploadedAt: new Date().toISOString(),
      sourceFile: null,
      hasEdfData: true,
    };
    if (setRecords) setRecords(prev => [newRecord, ...prev]);

    // Trigger post-recording prompt (Patch D)
    setLastRecordedFile({ record: newRecord, filename: acqFile });
    setShowPostRecordPrompt(true);
  };
  const togglePause = () => {
    const next = !isPaused;
    setIsPaused(next);
    if (next) setShowAnnotations(true);  // auto-open annotation panel on pause
  };

  const elapsed = `${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,"0")}`;
  const hash = subjectId ? hashSubjectId(subjectId) : "----";
  const canRecord = connectionState >= CONN.ready && subjectId;

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden",position:"relative"}}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {!toolbarCollapsed ? (<>
      {/* Device Selector */}
      <DeviceSelector selectedDevice={selectedDevice} setSelectedDevice={setSelectedDevice}
        connectionState={connectionState} onConnect={handleConnect} onDisconnect={handleDisconnect}
        deviceConfig={deviceConfig} setDeviceConfig={setDeviceConfig}/>

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
        </>) : (<>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:isPaused?"#F59E0B":"#EF4444",
              animation:isPaused?"none":"pulse 1.5s ease infinite"}}/>
            <span style={{fontSize:12,fontWeight:800,color:isPaused?"#F59E0B":"#EF4444",letterSpacing:"0.1em"}}>
              {isPaused?"PAUSED":"RECORDING"}</span>
          </div>
          <div style={{fontFamily:"'IBM Plex Mono', monospace",fontSize:18,fontWeight:800,color:"#e0e0e0",minWidth:60}}>{elapsed}</div>
          {isSim && (
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",
              background:"#0a0a0a",border:"1px solid #1a1a1a"}}>
              <span style={{fontSize:9,color:"#555",letterSpacing:"0.08em"}}>SIM WIPE IN</span>
              <span style={{fontSize:13,fontWeight:700,fontFamily:"'IBM Plex Mono', monospace",
                color: (SIM_MAX_SEC - elapsedSec) <= 10 ? "#EF4444" : "#F59E0B"}}>
                {SIM_MAX_SEC - elapsedSec}s
              </span>
            </div>
          )}
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#7ec8d9",fontFamily:"'IBM Plex Mono', monospace"}}>{hash}</span>
          <span style={{fontSize:10,color:"#555"}}>|</span>
          <span style={{fontSize:11,color:"#888"}}>{STUDY_TYPES[studyType]?.label}</span>
          {selectedDevice && (<>
            <span style={{fontSize:10,color:"#555"}}>|</span>
            <span style={{fontSize:10,color:DEVICE_PROTOCOLS[selectedDevice.protocol].color}}>{selectedDevice.name}</span>
          </>)}
        </>)}
      </div>
        <EEGControls montage={eeg.montage} setMontage={eeg.setMontage}
          eegSystem={eeg.eegSystem} setEegSystem={eeg.setEegSystem}
          onOpenCustomPicker={()=>eeg.setShowCustomPicker(true)}
          hpf={eeg.hpf} setHpf={eeg.setHpf}
          lpf={eeg.lpf} setLpf={eeg.setLpf} notch={eeg.notch} setNotch={eeg.setNotch}
          epochSec={eeg.epochSec} setEpochSec={eeg.setEpochSec} sensitivity={eeg.sensitivity} setSensitivity={eeg.setSensitivity}
          rightContent={<>
            <button onClick={(e)=>{e.stopPropagation();eeg.cycleVisibility();}} style={{...controlBtn(),
              color:eeg.visibilityState===2?"#666":"#F59E0B",border:`1px solid ${eeg.visibilityState===2?"#22222280":"#F59E0B40"}`}}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>
                {eeg.visibilityState===0 && <>{I.Eye(12)} Show All ({eeg.hiddenChannels.size})</>}
                {eeg.visibilityState===1 && <>{I.EyeDots(12)} Show Eyes</>}
                {eeg.visibilityState===2 && <>{I.EyeOff(12)} Hide</>}
              </span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowPatternTable(true);}} style={controlBtn(showPatternTable)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.List()} Pattern Table</span>
            </button>
            <button onClick={(e)=>{e.stopPropagation();setShowAnnotations(prev => !prev);}} style={controlBtn(showAnnotations)}>
              <span style={{display:"flex",alignItems:"center",gap:4}}>{I.Bookmark()} Annotations ({annotations.length})</span>
            </button>
          </>}/>
        <div onClick={()=>setToolbarCollapsed(true)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#111"}
          style={{height:14,background:"#111",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9650;</span>
        </div>
      </>) : (
        <div onClick={()=>setToolbarCollapsed(false)}
          onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
          onMouseLeave={e=>e.currentTarget.style.background="#151515"}
          style={{height:20,background:"#151515",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <span style={{fontSize:8,color:"#555",lineHeight:1}}>&#9660;</span>
        </div>
      )}

      <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
        <WaveformCanvas channels={eeg.channels} waveformData={eeg.waveformData} epochSec={eeg.epochSec}
          epochStart={eeg.epochStart} epochEnd={eeg.epochEnd} sampleRate={eeg.sampleRate}
          sensitivity={eeg.sensitivity} channelSensitivity={eeg.channelSensitivity}
          annotations={annotations} annotationDraft={eeg.annotationDraft}
          selectedAnnotationType={eeg.selectedAnnotationType} hoveredTime={eeg.hoveredTime}
          isAddingAnnotation={eeg.isAddingAnnotation} isMeasuring={eeg.isMeasuring} measurePoints={eeg.measurePoints}
          onMouseMove={eeg.handleCanvasMouseMove}
          onMouseLeave={()=>eeg.setHoveredTime(null)} onClick={eeg.handleCanvasClick}
          onContextMenu={eeg.handleContextMenu}
          containerRef={eeg.containerRef} canvasRef={eeg.canvasRef}
          isLiveSimulation={isSim && isRecording && !isPaused} simClipRef={simClipRef}>
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
              {connectionState === CONN.connecting && (
                <>
                  <div style={{width:48,height:48,borderRadius:0,background:"#111",border:"1px solid #F59E0B30",
                    display:"flex",alignItems:"center",justifyContent:"center",color:"#F59E0B",
                    animation:"pulse 1.5s ease infinite"}}>{I.Radio(20)}</div>
                  <div style={{color:"#F59E0B",fontSize:14,fontWeight:600}}>Connecting to device...</div>
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
                  <div style={{color:"#EF4444",fontSize:14,fontWeight:600}}>No Device Detected</div>
                  <div style={{color:"#666",fontSize:11}}>Check device power, USB connection, and port settings</div>
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
                {subjectId ? "Click REC in the bottom bar to begin acquisition" : "Enter a Subject ID to begin"}
              </div>
            </div>
          )}
        </WaveformCanvas>
      </div>

      <EpochNav currentEpoch={eeg.currentEpoch} setCurrentEpoch={eeg.setCurrentEpoch}
        totalEpochs={eeg.totalEpochs} epochStart={eeg.epochStart} epochEnd={eeg.epochEnd}
        totalDuration={eeg.totalDuration}
        isPlaying={isRecording && !isPaused} onPlayPause={isRecording ? togglePause : undefined}
        leftContent={connectionState >= CONN.ready && !isRecording ? (
          <button onClick={()=>{setShowImpedance(true);setImpedances(isSim ? generateImpedances(selectedDevice?.channels||19) : generateNoConnectionImpedances(selectedDevice?.channels||19));}} style={{
            padding:"4px 10px",background:"#111",border:"1px solid #8B5CF640",borderRadius:0,
            color:"#8B5CF6",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{I.Ohm(14)} Z</button>
        ) : null}
        rightContent={!isRecording ? (
          connectionState >= CONN.ready ? (
            <button onClick={startRecording} disabled={!canRecord} style={{
              padding:"4px 14px",background:canRecord?"#7f1d1d":"#1a1a1a",border:`1px solid ${canRecord?"#EF444450":"#333"}`,
              borderRadius:0,color:canRecord?"#EF4444":"#555",cursor:canRecord?"pointer":"default",
              fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
            }}>{I.Record()} REC</button>
          ) : null
        ) : (
          <button onClick={stopRecording} style={{
            padding:"4px 10px",background:"#111",border:"1px solid #EF444440",borderRadius:0,
            color:"#EF4444",cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4
          }}>{I.Square()} STOP</button>
        )}/>

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
          auxWithData={eeg.auxWithData} AUX_CHANNELS={eeg.AUX_CHANNELS}
          onClose={()=>setShowPatternTable(false)}/>
      )}

      {eeg.showCustomPicker && (
        <CustomElectrodePicker customElectrodes={eeg.customElectrodes}
          setCustomElectrodes={eeg.setCustomElectrodes}
          onClose={()=>eeg.setShowCustomPicker(false)}/>
      )}

      {/* Post-recording prompt */}
      {showPostRecordPrompt && lastRecordedFile && (
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200}}>
          <div style={{background:"#111",border:"1px solid #2a2a2a",padding:"32px 40px",maxWidth:420,textAlign:"center"}}>
            <div style={{color:"#7ec8d9",fontSize:14,fontWeight:700,marginBottom:8}}>Recording Saved</div>
            <div style={{color:"#888",fontSize:12,fontFamily:"'IBM Plex Mono', monospace",marginBottom:6}}>{lastRecordedFile.filename}</div>
            <div style={{color:"#555",fontSize:11,marginBottom:24}}>
              {lastRecordedFile.record.durationSec}s recorded | {lastRecordedFile.record.channels} channels | {lastRecordedFile.record.sampleRate}Hz
            </div>
            <div style={{color:"#ccc",fontSize:13,marginBottom:24}}>Do you wish to load current recording to Review?</div>
            <div style={{display:"flex",gap:12,justifyContent:"center"}}>
              <button onClick={()=>setShowPostRecordPrompt(false)} style={{
                padding:"8px 20px",background:"transparent",border:"1px solid #333",borderRadius:0,
                color:"#888",cursor:"pointer",fontSize:12
              }}>No</button>
              <button onClick={()=>{setShowPostRecordPrompt(false);if(openReview&&lastRecordedFile.record)openReview(lastRecordedFile.record);}} style={{
                padding:"8px 20px",background:"#1a4a54",border:"1px solid #4a9bab50",borderRadius:0,
                color:"#7ec8d9",cursor:"pointer",fontSize:12,fontWeight:700
              }}>Yes, Open in Review</button>
            </div>
          </div>
        </div>
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

  // Multi-tab state (lifted from ReviewTab so it persists across tab switches)
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const tabEpochCache = useRef({});

  // ── Initialize on first launch ──
  useEffect(() => {
    (async () => {
      try {
        const dir = await tauriBridge.invoke("initialize_app");
        setDataDir(dir || "");
      } catch (e) { console.log("Init:", e); }

      // Load saved library or fall back to seed data
      let seedRecords;
      try {
        const json = await tauriBridge.invoke("load_library_index");
        const saved = JSON.parse(json || "[]");
        seedRecords = saved.length > 0 ? saved : generateSeedData();
      } catch (e) {
        seedRecords = generateSeedData();
      }
      setRecords(seedRecords);
      setInitialized(true);

      // Load persisted EDF files from IndexedDB (imported files survive reloads)
      loadAllEdfsFromDB().then(stored => {
        if (Object.keys(stored).length > 0) {
          setEdfFileStore(prev => ({ ...prev, ...stored }));
        }
      });
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
    // Add to multi-tab list (max 5)
    setOpenTabs(prev => {
      const existingIdx = prev.findIndex(t => t.filename === record.filename);
      if (existingIdx >= 0) {
        setActiveTabIdx(existingIdx);
        return prev;
      }
      let next = [...prev, record];
      if (next.length > 5) next = next.slice(next.length - 5);
      setActiveTabIdx(next.length - 1);
      return next;
    });
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
          display:"flex",alignItems:"center",gap:12,
        }}>REACT EEG, LLC &mdash; 2026 <span style={{color:"#4a9bab80",fontFamily:"'IBM Plex Mono', monospace",fontSize:10,fontWeight:600,letterSpacing:"0.1em"}}>v11.0</span></div>
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
              <div style={{fontSize:18,fontWeight:700,letterSpacing:"0.04em",color:"#e0e0e0",fontFamily:"'Rajdhani', sans-serif",display:"flex",alignItems:"baseline",gap:8}}>
                REACT <span style={{color:"#7ec8d9"}}>EEG</span>
                <span style={{fontSize:9,fontWeight:600,color:"#4a9bab80",letterSpacing:"0.08em",fontFamily:"'IBM Plex Mono', monospace"}}>v11.0</span>
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
        {activeTab === "review" && <ReviewTab record={reviewRecord || records[0] || null} updateRecordStatus={updateRecordStatus} records={records} onSelectRecord={openReview} annotationsMap={annotationsMap} setAnnotationsMap={setAnnotationsMap} edfFileStore={edfFileStore} openTabs={openTabs} setOpenTabs={setOpenTabs} activeTabIdx={activeTabIdx} setActiveTabIdx={setActiveTabIdx} tabEpochCache={tabEpochCache}/>}
        {activeTab === "acquire" && <AcquireTab annotationsMap={annotationsMap} setAnnotationsMap={setAnnotationsMap} setRecords={setRecords} edfFileStore={edfFileStore} setEdfFileStore={setEdfFileStore} openReview={openReview}/>}
      </div>
    </div>
  );
}
