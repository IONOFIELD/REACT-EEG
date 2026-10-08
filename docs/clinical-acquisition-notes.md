# Clinical acquisition notes: filter phase and EDF time axes

Author: Jayson Leach, REEGT — practicing clinical EEG technologist
Context: lessons from building REACT EEG (live acquisition + review)

> This is the canonical copy. It is also offered upstream to the
> [neoxai](https://github.com/neowalter/neoxai) methods collection in
> [neowalter/neoxai#18](https://github.com/neowalter/neoxai/pull/18).

## 1. Causal vs zero-phase filtering: why live and reviewed traces differ

- Live acquisition can only filter causally (forward IIR). Zero-phase
  (filtfilt) needs future samples.
- Causal Butterworth adds frequency-dependent group delay: sharp transients
  (spikes, sharp waves) shift slightly and ring *after* the event.
- Zero-phase filtering preserves timing but rings symmetrically, so
  pre-ringing can appear *before* a spike, which can shift apparent onset
  timing.
- filtfilt squares the magnitude response: a "1 Hz LFF" is -6 dB at 1 Hz,
  not -3 dB. If the UI labels filters the way a clinical system does,
  compensate the design cutoff or document the mismatch.
- Streaming/worker implementations must carry filter state (zi) across
  chunks; otherwise each block boundary injects a small transient that
  looks like periodic artifact.
- MNE's default is zero-phase FIR; phase="minimum" gives a causal
  alternative. Know which one produced the trace you're reading.
- Rule: filtering is display-only. Store raw samples in the file.

## 2. EDF time axes: board timestamps vs sample count

- EDF has no per-sample timestamps: a header start time, fixed samples per
  data record, fixed record duration. The time axis is always rebuilt from
  sample count.
- Sample count x 1/fs, paced by the ADC crystal, is usually a better
  intra-record clock than host read timestamps, which carry SPI and
  scheduler jitter.
- The real failure mode is dropped samples (missed DRDY, socket
  backpressure). A count-based axis silently compresses the gap.
- Recommended: carry a sample/packet counter through the bridge, detect
  gaps on the receiving side, and write them as EDF+D (discontinuous,
  per-record onset) or at minimum an annotation. Use host wall-clock only
  to anchor start time and check drift.

## References

- Widmann A, Schröger E, Maess B. Digital filter design for
  electrophysiological data – a practical approach. *J Neurosci Methods*.
  2015;250:34–46. doi:[10.1016/j.jneumeth.2014.08.002](https://doi.org/10.1016/j.jneumeth.2014.08.002)
- Kemp B, Olivan J. European data format 'plus' (EDF+), an EDF alike
  standard format for the exchange of physiological data. *Clin
  Neurophysiol*. 2003;114(9):1755–1761.
  doi:[10.1016/S1388-2457(03)00123-8](https://doi.org/10.1016/S1388-2457(03)00123-8)
- MNE-Python: Background information on filtering.
  [mne.tools/stable/auto_tutorials/preprocessing/25_background_filtering.html](https://mne.tools/stable/auto_tutorials/preprocessing/25_background_filtering.html)
