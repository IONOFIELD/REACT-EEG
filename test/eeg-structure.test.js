// EEG structure detection. The label lists below are copied verbatim from the EDF headers of REAL
// public recordings (read 2026-10-08; header bytes only, no signal data):
//   Helsinki neonatal  zenodo 2547147  eeg57.edf
//   CHB-MIT            physionet chbmit  chb01/chb01_01.edf
//   Sleep-EDF          physionet sleep-edfx  sleep-cassette/SC4001E0-PSG.edf
//   EEGMMIDB           physionet eegmmidb  S001/S001R01.edf
import { describe, it, expect } from "vitest";
import {
  splitEdfLabel, electrodeMatchKey, isReferenceToken, classifyStructure, recommendMontage,
  describeStructure, MONTAGE, CLASSIC_BANANA_ELECTRODES,
} from "../src/eeg-structure.js";

const HELSINKI = ["EEG Fp1-Ref", "EEG Fp2-Ref", "EEG F3-Ref", "EEG F4-Ref", "EEG F7-Ref", "EEG F8-Ref", "EEG Fz-Ref", "EEG C3-Ref", "EEG C4-Ref", "EEG Cz-Ref", "EEG T3-Ref", "EEG T5-Ref", "EEG T4-Ref", "EEG T6-Ref", "EEG P3-Ref", "EEG P4-Ref", "EEG Pz-Ref", "EEG O1-Ref", "EEG O2-Ref", "ECG EKG", "Resp Effort"];
const CHBMIT = ["FP1-F7", "F7-T7", "T7-P7", "P7-O1", "FP1-F3", "F3-C3", "C3-P3", "P3-O1", "FP2-F4", "F4-C4", "C4-P4", "P4-O2", "FP2-F8", "F8-T8", "T8-P8", "P8-O2", "FZ-CZ", "CZ-PZ", "P7-T7", "T7-FT9", "FT9-FT10", "FT10-T8", "T8-P8"];
const SLEEPEDF = ["EEG Fpz-Cz", "EEG Pz-Oz", "EOG horizontal", "Resp oro-nasal", "EMG submental", "Temp rectal", "Event marker"];
const EEGMMIDB = ["Fc5.", "Fc3.", "Fc1.", "Fcz.", "Fc2.", "Fc4.", "Fc6.", "C5..", "C3..", "C1..", "Cz..", "C2..", "C4..", "C6..", "Cp5.", "Cp3.", "Cp1.", "Cpz.", "Cp2.", "Cp4.", "Cp6.", "Fp1.", "Fpz.", "Fp2.", "Af7.", "Af3.", "Afz.", "Af4.", "Af8.", "F7..", "F5..", "F3..", "F1..", "Fz..", "F2..", "F4..", "F6..", "F8..", "Ft7.", "Ft8.", "T7..", "T8..", "T9..", "T10.", "Tp7.", "Tp8.", "P7..", "P5..", "P3..", "P1..", "Pz..", "P2..", "P4..", "P6..", "P8..", "Po7.", "Po3.", "Poz.", "Po4.", "Po8.", "O1..", "Oz..", "O2..", "Iz..", "EDF Annotations"];

// Stand-in for App.jsx's canonicalElectrode on a bare token: the 10-10 names (legacy T3–T6 too),
// matched case-insensitively. The real table is larger; these cover every electrode above.
const NAMES = ["Fp1", "Fpz", "Fp2", "AF7", "AF3", "AFz", "AF4", "AF8", "F7", "F5", "F3", "F1", "Fz", "F2", "F4", "F6", "F8",
  "FT9", "FT7", "FC5", "FC3", "FC1", "FCz", "FC2", "FC4", "FC6", "FT8", "FT10", "T9", "T7", "C5", "C3", "C1", "Cz", "C2", "C4", "C6", "T8", "T10",
  "TP7", "CP5", "CP3", "CP1", "CPz", "CP2", "CP4", "CP6", "TP8", "P7", "P5", "P3", "P1", "Pz", "P2", "P4", "P6", "P8",
  "PO7", "PO3", "POz", "PO4", "PO8", "O1", "Oz", "O2", "Iz", "T3", "T4", "T5", "T6"];
const BY_UPPER = new Map(NAMES.map((n) => [n.toUpperCase(), n]));
const canon = (t) => BY_UPPER.get(String(t || "").trim().toUpperCase()) || null;

describe("splitEdfLabel / electrodeMatchKey", () => {
  it("separates the electrode from its reference or derivation partner", () => {
    expect(splitEdfLabel("EEG Fp1-Ref")).toEqual({ base: "Fp1", ref: "Ref" });
    expect(splitEdfLabel("Fc3.")).toEqual({ base: "Fc3", ref: null });
    expect(splitEdfLabel("C5..")).toEqual({ base: "C5", ref: null });
    expect(splitEdfLabel("FP1-F7")).toEqual({ base: "FP1", ref: "F7" });
    expect(splitEdfLabel("EEG Fpz-Cz")).toEqual({ base: "Fpz", ref: "Cz" });
  });
  it("gives referential labels the montage code's electrode key, derivations none", () => {
    expect(electrodeMatchKey("EEG Fp1-Ref")).toBe("FP1");
    expect(electrodeMatchKey("EEG T3-Ref")).toBe("T3");
    expect(electrodeMatchKey("EEG FP1-LE")).toBe("FP1");
    expect(electrodeMatchKey("Fp1-A1")).toBe("FP1");
    expect(electrodeMatchKey("Cz..")).toBe("CZ");
    expect(electrodeMatchKey("FP1-F7")).toBeNull();
    expect(electrodeMatchKey("EEG Fpz-Cz")).toBeNull();
    expect(electrodeMatchKey("")).toBeNull();
  });
  it("recognises reference suffixes but not scalp electrodes", () => {
    for (const t of ["Ref", "REF", "LE", "A1", "A2", "M1", "avg", "CAR"]) expect(isReferenceToken(t)).toBe(true);
    for (const t of ["F7", "Cz", "T3", "horizontal", ""]) expect(isReferenceToken(t)).toBe(false);
  });
});

describe("classifyStructure + recommendMontage on real recordings", () => {
  it("Helsinki neonatal: referential 10-20 (all 19 classic electrodes) → classic double banana", () => {
    const s = classifyStructure(HELSINKI, canon);
    expect(s).toMatchObject({ kind: "referential", system: "10-20", referentialCount: 19, derivedCount: 0, bananaCoverage: 19 });
    expect(s.electrodes).toHaveLength(19);
    expect(recommendMontage(s)).toBe(MONTAGE.CLASSIC);
    expect(describeStructure(s)).toBe("Referential 10-20 · 19 electrodes");
  });

  it("CHB-MIT: pre-montaged bipolar derivations → As Recorded", () => {
    const s = classifyStructure(CHBMIT, canon);
    expect(s.kind).toBe("derived");
    expect(s.referentialCount).toBe(0);
    expect(s.derivedCount).toBe(23);
    expect(recommendMontage(s)).toBe(MONTAGE.AS_RECORDED);
    expect(describeStructure(s)).toMatch(/^Pre-montaged derivations/);
  });

  it("Sleep-EDF: Fpz-Cz / Pz-Oz derivations (Cz is not treated as a reference) → As Recorded", () => {
    const s = classifyStructure(SLEEPEDF, canon);
    expect(s).toMatchObject({ kind: "derived", derivedCount: 2, referentialCount: 0 });
    expect(s.electrodes.sort()).toEqual(["Cz", "Fpz", "Oz", "Pz"]);
    expect(recommendMontage(s)).toBe(MONTAGE.AS_RECORDED);
  });

  it("EEGMMIDB: 64-electrode referential (dotted labels) → adaptive banana, as before", () => {
    const s = classifyStructure(EEGMMIDB, canon);
    expect(s).toMatchObject({ kind: "referential", system: "10-10", referentialCount: 64 });
    expect(recommendMontage(s)).toBe(MONTAGE.ADAPTIVE);
  });
});

describe("edge cases", () => {
  it("a referential 10-20 file named with modern T7/P7 misses the classic chain → adaptive banana", () => {
    const modern = ["Fp1", "Fp2", "F3", "F4", "F7", "F8", "Fz", "C3", "C4", "Cz", "T7", "P7", "T8", "P8", "P3", "P4", "Pz", "O1", "O2"];
    const s = classifyStructure(modern, canon);
    expect(s.system).toBe("10-20");
    expect(s.bananaCoverage).toBe(15);
    expect(recommendMontage(s)).toBe(MONTAGE.ADAPTIVE);
  });
  it("a sparse referential file → adaptive banana", () => {
    expect(recommendMontage(classifyStructure(["EEG C3-Ref", "EEG C4-Ref", "EEG O1-Ref", "EEG O2-Ref"], canon))).toBe(MONTAGE.ADAPTIVE);
  });
  it("no scalp electrodes → unknown → As Recorded", () => {
    const s = classifyStructure(["ECG EKG", "Resp Effort", "EDF Annotations"], canon);
    expect(s).toMatchObject({ kind: "unknown", system: null, electrodes: [] });
    expect(recommendMontage(s)).toBe(MONTAGE.AS_RECORDED);
    expect(describeStructure(s)).toMatch(/No standard scalp electrodes/);
  });
  it("tolerates junk input", () => {
    expect(classifyStructure(null, canon).kind).toBe("unknown");
    expect(recommendMontage(null)).toBe(MONTAGE.AS_RECORDED);
    expect(CLASSIC_BANANA_ELECTRODES).toHaveLength(19);
  });
});
