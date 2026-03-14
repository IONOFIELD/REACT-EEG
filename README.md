# REACT EEG

Rapid Electroencephalographic Audit of Cortical Trends

De-identified EEG file management, waveform review, and live acquisition platform.

REACT EEG, LLC - 2026

---

## Overview

REACT EEG is a biometric data acquisition and storage platform built as a web application with React. It runs in any modern browser and auto-deploys to GitHub Pages. Three core modules:

| Tab | Purpose |
|-----|---------|
| LIBRARY | File repository - ingest, search, filter, manage, export de-identified EDF recordings |
| REVIEW | Waveform viewer - EEG playback with montage switching, digital filters, annotations, pattern table |
| ACQUIRE | Live recording - real-time acquisition with device selection, impedance checking, pattern table |

## De-Identification Naming Convention

All files use a PHI-free naming scheme:

```
REACT-[StudyType]-[SubjectHash]-[YYYYMMDD]-[Seq].edf
```

Example: `REACT-BL-A7F3-20260309-001.edf`

- StudyType: `BL` (Baseline), `PI` (Post-Injury), `PS` (Post-Season), `FU` (Follow-Up), `RT` (Routine), `LT` (Long-Term), `NCV`, `TCD`, `AUTO` (Autonomic)
- SubjectHash: 4-character hex derived from salted hash of internal subject ID
- Seq: Sequential recording number per subject/day

Subject IDs follow a guided format like FB-001, SC-042, or OT-003. The app includes a dropdown legend with 13 sport codes plus Other / General for non-sport patients.

## Features

### Library
- Stats dashboard showing total records, verified count, unique subjects, storage
- Table and grid views with sort/filter by study type, status, and free-text search
- Ingest modal with guided Subject ID input and live de-identified filename preview
- Inline status controls per record - Pending, Verified, Flagged
- Three-dot edit menu per record with Open in Review, Open File Location, Delete with confirmation
- Export modal to select a subject by hash and bundle all their EDF and annotation files
- 5 test records on first launch marked with green dot indicator

### EEG Systems
- 10-20 Standard with 21 electrodes
- HD-40 High Density with 40 electrodes
- 10-10 Extended with 75+ electrodes
- System compatibility enforcement - a 10-20 recording cannot be viewed in HD-40 or 10-10 montages due to insufficient data
- Higher-density recordings can always be viewed in lower-density systems

### Montages (per EEG system)
- Bipolar Longitudinal (Double Banana)
- Bipolar Transverse
- Referential (Cz Reference)
- Average Reference
- Each montage has system-specific channel derivations
- Trace count changes when switching between 10-20, HD-40, and 10-10

### Filters (Real DSP)
- LFF (High-Pass): Off, 0.1, 0.3, 0.5, 1, 1.6, 5, 10 Hz
- HFF (Low-Pass): 15, 30, 35, 40, 50, 70, 100 Hz, Off
- Notch: Off, 50 Hz, 60 Hz
- All filters use Butterworth approximation algorithms
- Per-channel filter overrides via Pattern Table

### Pattern Table (Review + Acquire)
- Nihon Kohden-style trace configuration panel
- Channels grouped by region - Left/Right Parasagittal, Left/Right Temporal, Midline, Other
- Per-channel toggle visibility, individual sensitivity, per-channel LFF override, per-channel HFF override
- Color indicator per trace
- Show All and Reset Filters bulk actions
- Footer with visible/total/hidden counts and custom filter count

### Right-Click Channel Menu
- Right-click any channel on the waveform canvas
- Show or Hide channel
- Per-channel sensitivity adjustment
- Works in both Review and Acquire

### Annotation System
- 9 annotation types - Spike, Sharp Wave, Seizure, Artifact, Arousal, Sleep Spindle, K-Complex, Eye Movement, Note
- Click-to-place on waveform with popup at click position
- Free-text notes per annotation
- Jump-to-annotation from sidebar
- Export annotations as JSON sidecar file, EDF is never modified

### Waveform Controls
- Epoch duration: 5, 10, 15, 20, 30 seconds per page (default 10s)
- Global sensitivity (gain scaling)
- Keyboard navigation: left/right arrow for epoch paging, +/- for sensitivity, Esc to cancel
- Epoch scrubber slider

### Device Management (Acquire Tab)
- Input Source dropdown grouped by protocol
- BrainFlow: OpenBCI Cyton 8/16ch, Ganglion, g.tec Unicorn, ANT Neuro eego, Neurosity Crown, Muse 2, BrainBit, Enophone
- LSL: Generic auto-discover, Natus Xltek, Nihon Kohden, BioSemi ActiveTwo via LSL bridge
- File Import: EDF/EDF+ and BDF/BDF+
- Simulated: 19ch and 32ch test signal generators
- Connection flow: Select, Configure, Connect, Impedance check, Ready, Record
- Impedance check with per-electrode color coding
- FDA-cleared device indicator when clinical hardware is connected

### Record Status Workflow
- Pending is the default for all new recordings
- Verified is auto-set when a pending record is opened in Review, can also be set manually
- Flagged is manually set for recordings needing attention
- Status editable from both Library and Review tabs

### Review Tab File Picker
- Click the filename at the top of the Review tab
- Dropdown lists all records in the library
- Switch files without returning to Library

## Signal Generation

Waveforms are currently algorithmically generated with realistic characteristics:
- Delta (0.5-4 Hz), Theta (4-8 Hz), Alpha (8-13 Hz), Beta (13-30 Hz) bands
- Stronger alpha power in occipital channels
- More muscle artifact in frontal channels
- Synthetic QRS complex on EKG channel
- Occasional spike-like transients
- All filters are real DSP applied to the signal data

## Tech Stack

- React 18 with functional components, hooks, and Canvas API
- Vite for build tooling
- IBM Plex Mono typography
- Canvas API for waveform rendering with real-time DSP
- GitHub Actions for auto-deploy to GitHub Pages

## File Structure

```
react-eeg/
├── .github/workflows/deploy.yml
├── src/
│   ├── App.jsx
│   └── main.jsx
├── index.html
├── package.json
├── vite.config.js
├── .gitignore
└── README.md
```

## Getting Started

### Run Locally

```bash
git clone https://github.com/YOUR_USERNAME/react-eeg.git
cd react-eeg
npm install
npm run dev
```

Open http://localhost:5173/react-eeg/ in your browser.

### Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to Settings then Pages then Source and select GitHub Actions
3. Auto-deploys on every push to main

Your app will be live at https://YOUR_USERNAME.github.io/react-eeg/

If your repo name is different from react-eeg, update the base value in vite.config.js to match your repo name.

## Roadmap

- EDF file parser integration for real waveform data from .edf files
- BrainFlow hardware integration for real-time acquisition
- Encrypted subject identity lookup database
- ZIP export bundling actual EDF and annotation files
- Desktop application packaging via Tauri
- User authentication and role-based access
- EDF+ export from acquisition recordings
- Waveform comparison view for baseline vs post-injury overlay
- Batch operations for multi-file status update and bulk export
- 10-20 head map visualization with electrode positions
- Spectral analysis with FFT power spectrum per channel

## License

Proprietary - REACT EEG, LLC

---

Built for biometric data acquisition and storage. Not a diagnostic tool.
