// ══════════════════════════════════════════════════════════════
// DSP Web Worker — runs the heavy Review-panel math OFF the main thread
// ══════════════════════════════════════════════════════════════
// The topographic map, qEEG panel and spectrogram used to compute their DFT/STFT synchronously in
// a useMemo, which blocked the main thread and made waveform review stutter while a panel was open.
// This worker runs the SAME dsp.js kernels (so the output is identical) on a background thread.
//
// Protocol:  postMessage({ id, job, args })  →  postMessage({ id, ok, result | error })
//   job "bands": args { channels: Float32Array[], sr }              → BandPowers[] (one per channel)
//   job "stft":  args { windows: Float32Array[], crops:{lead,len}[], sampleRate, hpf, lpf, notch }
//                       → { powerMatrix, nFrames, nFreqs, ... }  (region STFT, filtered + cropped)
//   job "qeeg":  args { waveformData: number[][], channels: string[], sampleRate }
//                       → full qEEG analysis object (band power, ratios, flags, eye-sync, slope)
import { computeBands, computeSTFT, applyHighPass, applyLowPass, applyNotch } from "./dsp.js";
import { computeQeegAnalysis } from "./qeeg.js";

// Filter + crop one raw window exactly as the SpectrogramPanel did inline (kept identical so the
// spectrogram matches what Review is filtering).
function filterCrop(win, crop, sampleRate, hpf, lpf, notch) {
  let ext = win;
  if (hpf > 0) ext = applyHighPass(ext, hpf, sampleRate);
  if (lpf > 0) ext = applyLowPass(ext, lpf, sampleRate);
  if (notch > 0) ext = applyNotch(ext, notch, sampleRate);
  const lead = crop ? crop.lead : 0, len = crop ? crop.len : ext.length;
  return (lead > 0 || len < ext.length) ? ext.slice(lead, lead + len) : ext;
}

self.onmessage = (e) => {
  const { id, job, args } = e.data || {};
  try {
    let result = null;
    if (job === "bands") {
      result = args.channels.map((ch) => computeBands(ch, args.sr));
    } else if (job === "stft") {
      const { windows, crops, sampleRate, hpf, lpf, notch } = args;
      const sigs = windows.map((w, i) => filterCrop(w, crops && crops[i], sampleRate, hpf, lpf, notch));
      result = computeSTFT(sigs, sampleRate);
    } else if (job === "qeeg") {
      result = computeQeegAnalysis(args.waveformData, args.channels, args.sampleRate);
    } else {
      throw new Error("unknown DSP job: " + job);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
