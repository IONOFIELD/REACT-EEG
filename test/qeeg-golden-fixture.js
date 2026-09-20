// Deterministic inputs for the qEEG golden test (no RNG → reproducible byte-for-byte).
// Shared by the fixture generator and the test so both feed IDENTICAL data to the kernels.

// A full 20-electrode + eye-lead epoch: exercises artifact detection, 60 Hz spectral line-noise
// removal, band power, WPLI eye-sync and IRASA slope. 160 Hz, 512 samples (sr>120 so line-noise runs).
export function buildQeegInput() {
  const N = 512, sr = 160;
  const channels = ["Fp1","Fp2","F7","F3","Fz","F4","F8","T3","C3","Cz","C4","T4","T5","P3","Pz","P4","T6","O1","O2","EKG","LOC1","ROC1","LOC2","ROC2"];
  const waveformData = channels.map((ch, c) => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      a[i] = 20 * Math.sin(2 * Math.PI * (8 + (c % 5)) * i / sr)   // alpha-ish, channel-varying
           + 5 * Math.sin(2 * Math.PI * 60 * i / sr)               // mains line noise
           + 10 * Math.sin(2 * Math.PI * 2 * i / sr)               // slow drift
           + ((i * 7 + c * 13) % 17 - 8);                          // deterministic jitter
    }
    return a;
  });
  return { waveformData, channels, sr };
}

// A single 60 Hz-contaminated signal for the focused removeLineNoiseSpectral golden.
export function buildLineNoiseSignal() {
  const N = 512, sr = 256;
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    a[i] = 30 * Math.sin(2 * Math.PI * 10 * i / sr)
         + 12 * Math.sin(2 * Math.PI * 60 * i / sr)
         + ((i * 11) % 13 - 6);
  }
  return { data: a, sr };
}
