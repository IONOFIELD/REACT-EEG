// ══════════════════════════════════════════════════════════════
// qEEG analysis pipeline — pure, worker-safe (no React / no DOM)
// ══════════════════════════════════════════════════════════════
// Everything QuantAnalysisPanel needs to turn one epoch of waveform data into band power,
// ratios, flags, eye-sync (WPLI) and aperiodic-slope metrics. Moved verbatim out of App.jsx
// so the SAME code can run on the DSP web worker (dsp-worker.js, off the main thread) and, as
// a fallback, synchronously — the output is identical either way. computeWPLI /
// computeCrossCorrelation are re-imported by App.jsx for the EOG-metrics panel.
import { dftTwiddles, interpolateArtifacts } from "./dsp.js";

// Cross-correlation (Pearson coefficient) for eye movement synchronicity analysis
export function computeCrossCorrelation(a, b) {
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
export function computeWPLI(a, b, sr, fLow = 1, fHigh = 15) {
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


function computeBandPower(data, sr) {
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
    const { cos, sin } = dftTwiddles(N); // precomputed twiddles — identical math, no per-sample trig

    const bandRanges = { delta: [0.5, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 50] };
    const powers = {};
    let total = 0;

    Object.entries(bandRanges).forEach(([band, [fLow, fHigh]]) => {
      let bandPow = 0;
      const kLow = Math.max(1, Math.round(fLow / freqRes));
      const kHigh = Math.min(Math.floor(N / 2), Math.round(fHigh / freqRes));
      for (let k = kLow; k <= kHigh; k++) {
        let re = 0, im = 0;
        const base = k * N;
        for (let n = 0; n < N; n++) {
          re += windowed[n] * cos[base + n];
          im -= windowed[n] * sin[base + n];
        }
        bandPow += (re * re + im * im) / (N * N * winNorm);
      }
      powers[band] = bandPow;
      total += bandPow;
    });
    powers.total = total;
    return powers;
}

export function computeQeegAnalysis(waveformData, channels, sampleRate) {
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
        // Replace artifact samples with boundary-respecting interpolation before spectral analysis.
        // (Zeroing them — the previous behavior — injected broadband energy into the band-power
        // estimate of the very signal being measured. See interpolateArtifacts + dsp.golden tests.)
        if (artifactPct > 0) sub = interpolateArtifacts(sub, mask);
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

    // Alpha-Delta Ratio (alpha ÷ delta, mean band power) — descriptive state/slowing index.
    const alphaDeltaRatio = avgBands.delta > 0 ? avgBands.alpha / avgBands.delta : 0;

    return { channelData, avgBands, peakAlphaFreq, asymmetryIndex, thetaBetaRatio, alphaDeltaRatio, flags, eyeSync, avgArtifactPct, aperiodicSlope };
}
