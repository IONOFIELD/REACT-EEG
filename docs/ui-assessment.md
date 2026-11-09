# Dot-matrix trends: what to keep

A formative look at the caffeine-tracker visual language on real EEG, not a restyle of REACT EEG. The clinical app is unchanged. The prototype is a separate screen.

Open it from a dev build at `#ui-lab` (or `?ui-lab=1`) on the same origin, for example `http://127.0.0.1:5173/REACT-EEG/#ui-lab`. Leaving the screen does not write the library, annotations, or any EDF. Nothing in the lab is a clinical display.

The recording is PhysioNet EEGMMIDB, already in `public/seed-edfs/`. Eyes closed (S001 R02, 64 ch, 160 Hz, occipital O1/Oz/O2) and the fist task (S010 R03, C3/Cz/C4, with the file's own T0/T1/T2 marks). Band power and RMS use `computeBands` and `acPower` from the app, so the numbers are the review maths, not a sketch. Windows are 2 s, hopped 0.5 s. The ridge is linearly interpolated between those windows.

## Recommendation

Use the discipline. Do not use the drawing as a page of EEG.

**Adopt, on trends only, and only beside the raw page**

- One dark neutral surface, one accent, no shadow and no glass. The current review chrome already wants this more than it wants another cyan.
- Tabular figures on every time and every value that changes.
- A time cursor that tracks the pointer 1:1, coalesced to the frame, never eased.
- The number in a tooltip or a readout. The drawing is the shape.
- Canvas (one buffer, one blit). Not a DOM node per sample.
- File events locked. User marks separate, with undo.

**Adapt**

- The dot field, as an optional trend (band power, RMS, later a suppression or aEEG-style summary), time-locked to the raw EEG. Label the window and the hop on the chart. Say that the ridge is interpolated.
- Blue for selection only, and a second cue that is not hue: the lab uses a filled disc for a user mark and a ring for a file event. Keep that.
- Dragging a mark, if marks become draggable at all, with the 3 px click-versus-drag split, undo, and a real audit line. Not as the way a seizure onset gets its time.

**Avoid**

- Dot-matrix raw traces, at any channel count. The page has to stay a line at a stated µV/mm and mm/s.
- Click-empty to create a clinical mark, and click-again to delete one.
- A dark-only theme as the only theme in a reading room.
- Red, yellow, or cyan for selection. Those are alarm colors (see below). The app already spends cyan on "active", "verified", and "connected". Do not add the new blue to that pile.
- Reading relative band power off the dots as if it were µV, µV², or a diagnostic index.

This was one engineer and two files. It is not a summative IEC 62366-1 evaluation and it does not clear a residual-risk file.

## Where the language actually helps

Eyes closed, the alpha share is obvious. The white field is total power (delta through gamma). The blue field is alpha, and it sits inside the white because it is a real subset of that total. Selecting beta, or clearing the selection, changes the blue and does not change the recording. That is the one caffeine idea that transfers cleanly: a selected part drawn in the accent, on top of the whole, with the same fade.

The cursor is the other one. Dragging it does not lag, rubber-band, or animate toward the pointer. Hover is a dashed stem, a dot on the ridge, and a fixed-width time plus the interpolated value. Play moves the same cursor in real time and does not rebuild the dot buffer. For a trend next to a page of EEG, that is the right feel. A technologist already expects the cursor to be where the mouse is.

RMS of the same channels is the second chart, because these EDFs do not contain impedance. Inventing impedances would have made the prototype prettier and the assessment worthless. The 50 µV line is a scale mark. It is not a limit and it is not an alarm. File marks are rings and cannot be moved or deleted. A filled dot is a note this session added. That split is the useful part, more than the dots.

The paint is cheap enough that the interaction can stay on `requestAnimationFrame`. Numbers are below.

## Where it hurts

The drawing is not EEG. Polarity, a spike against the background, a field across the montage, left over right, a calibration pulse: none of that survives a filled dot ridge. A 2 s window hopped at 0.5 s will not show a spike, a sharp, or an onset. The dots then interpolate those windows, so the ridge is smoother than the measurement. Smooth is the look the reference is selling. On a trend of alpha it is fine. On anything a reader might mistake for the page, smooth is how a short event disappears.

The unit on the band chart is relative power from `computeBands` (sum of bin powers). It is not µV². The tooltip prints that number. Someone who reads the height of the dots and skips the tooltip has no unit at all. The scale tick (a round number near half the max) is the only magnitude cue in the picture, and the line itself is #404040 on #111111, about 1.8:1. In the screenshot it is easy to miss the line and only see the label.

Two charts on one page use the same gesture for different jobs. On band power, a click moves the cursor. On signal quality, a click in empty space adds a note, a click selects, and a click on the selected note deletes it. That is the reference's interaction, and it is the wrong default for a medical record. The 3 px threshold keeps a real drag from also deleting, which is necessary and not sufficient. A slip that does not travel 3 px deletes. Undo is in memory for this session only. The six-line log on the page is not stored, not tied to the annotator hash the app already writes, and not an audit trail.

The eyes-closed file has one real EDF+ event, T0, covering the whole record. It becomes a ring on the origin. It is locked, so it cannot be dragged onto a different second. It is still a poor handle: easy to hit, and if selection painted its full duration the blue would cover the entire chart. The fist file is the better test. T0/T1/T2 are real, short (~4.1 s), and numerous. Thirty rings along one minute is busy. Selection has to carry a text label or the rings are anonymous.

A blue column on the RMS chart is "the samples inside this mark," not "the mark created this RMS." The picture does not say that by itself. The caption does. Captions are not a control against a glance.

## Precision, zoom, DPI

On a chart about 900 px wide, the dot pitch is 4 CSS pixels, so a 61 s file has on the order of 220 columns. One column is about a quarter of a second. The underlying series moves every 0.5 s. The source samples are 6.25 ms apart. Three different clocks, and the drawing is the coarsest one that still looks continuous.

The tooltip does not snap to a column. It interpolates the series at the pointer's time, and the time is formatted `mm:ss.ss` so the width does not change as the digits change. That is the value of record. The dot is the shape. If those two ever disagree, the tooltip wins and the dot is wrong. Today they can disagree by a fraction of a window, because the ridge is interpolated and the column is quantized.

There is no time zoom in the lab, on purpose. A 10 s window on the same width would make each column about 40 ms, still not a sample, and it would still be a 2 s analysis window drawn as a smooth ridge. Zooming the browser re-rasterizes through a `ResizeObserver` at the current device pixel ratio, so the dots stay in CSS pixels rather than stretching a bitmap. At DPR 2 the same chart paints in about 4.4 ms instead of 2.1 ms (median, this machine, the function the canvas uses). The cost did not quadruple, because the per-dot stamp dominates the fill. It does go up. A finer pitch, to look more like the reference's 1–1.5 px discs, is a square-law on the number of discs. That is the aliasing trade: coarser dots are cheaper and lie more about time; finer dots tell a bit more of the truth and start to compete with the frame.

DPR and OS zoom are not a calibrated millimetre. ACNS timebase and sensitivity are physical (mm/s, µV/mm). A dot grid in CSS pixels cannot be that, and should not be labelled as if it were.

## Color, reading rooms, color vision

Measured contrast of the lab palette on #111111:

| Pair | Ratio | Role |
| --- | --- | --- |
| #FFFFFF on #111111 | 18.9:1 | Primary text, user-mark fill |
| #A3A3A3 on #111111 | 7.5:1 | Secondary text, axis |
| #888888 on #111111 | 5.3:1 | Notes, inactive bands |
| #3B82F6 on #111111 | 5.1:1 | Selection |
| #FFFFFF on #3B82F6 | 3.7:1 | White text on a blue chip, if anyone puts text there |
| #404040 on #111111 | 1.8:1 | Guide lines, peak stem |
| #262626 on #111111 | 1.3:1 | The idle dots |

Body text and the blue accent clear WCAG AA on this background. The guide line does not clear the 3:1 non-text contrast for a meaningful graphic. The idle dots are not meant to; they are texture. A meaningful line cannot be texture. If a 50 µV tick matters, it needs a stronger line or it needs to live in the label only. The label already passes.

Blue against white is also a luminance difference (blue is about a quarter of white). A deuteranopic reader still gets "bright ridge" versus "darker ridge," and the selected mark is a larger disc, not only a recolor. Do not drop the shape cue. Do not encode good/fair/poor as green/amber/red inside this picture; the lab does not. The existing impedance chips do, and that is a separate question: those already have a text value next to the color, which is what should remain.

A dark-only screen in a bright EEG reading room is a use condition, not a preference. Specular glare on a glossy panel, and a technologist who has just looked at a paper-white report, will lose #888888 and the guide line first. The lab does not offer a light theme. Adopting the palette means proving it under the room light the service actually uses, or shipping a second theme. Shipping only the dark one because the reference is dark is not a reason.

IEC 60601-1-8 is the alarm-signals collateral. High priority is red. Medium is yellow. The 2006 edition used cyan for low priority; later editions pull low priority to yellow so cyan is not an alarm color either. Selection must not use those. Blue is not one of them, which is why it is a reasonable selection accent, on the condition that this product never also uses it for an alarm, a "needs attention" state, or a connection state. Information signals and alarm signals have to be distinguishable before anyone animates anything. The lab has no alarm and should not grow one.

## Use errors worth writing down

Framed the way 62366-1 asks: hazard-related use scenarios for a formative review. Not a user test. Not a residual-risk number.

1. **Trend read as the page.** A power bump or a clean alpha ridge is called a seizure, or a low ridge is called suppression, and the raw EEG is not on screen. This is the known qEEG failure mode. The lab makes it easy, because the lab is only the trend. Mitigation that would actually work: the trend is a strip on the review page, same time base as the traces, and choosing a moment opens that second of EEG. A banner that says "not a clinical display" is a reminder to us, not a control for a reader in a hurry.

2. **Onset time taken from the dots.** Someone calls the left edge of a blue column the onset. The column is a 2 s window, then interpolated, then quantized to a quarter-second. Mitigation: onset is marked on the trace. The trend does not accept an onset.

3. **Click adds, click deletes.** A scrub, a channel click, or a slipped drag of less than 3 px creates or destroys a mark. Mitigation in the lab: locked file events, a 3 px threshold, session undo, Delete as an explicit key. Mitigation still required before this is real: an explicit add tool (not empty-space click), confirm or a trash that can be undone after the session, and the annotator-hash audit the sidecar already has. Click-to-delete of a selected clinical mark should not ship.

4. **Drag moves physiology.** The cursor and the notes move. The recording does not. A reader can still feel that the hill moved because the blue moved. Mitigation: the white field is immutable for the life of the file. Say so. Do not let a drag edit the series.

5. **Blue means too many things.** In this lab it means the selected band, the selected mark, and the cursor. Three selection meanings, one color. Tolerable while a caption names them. Not tolerable if blue later also means alarm, live, or good contact.

6. **The scale line is an alarm.** A 50 µV line, or a 5 kΩ line on a future impedance chart, gets treated as a limit that was crossed. Mitigation: the word "scale" in the caption, no color change when the ridge crosses it, no sound. An impedance limit, if the product has one, is a separate, standard-colored alarm with a numeric value, not a restyle of this guide.

7. **Glare and a single theme.** Secondary text at 5:1 on a black panel fails in practice before it fails the ratio. Mitigation: a light theme tested in the room, or a proven matte display and a measured illuminance. Not done here.

8. **Locked is not the same as correct.** A file event can still be the wrong clinical label (EEGMMIDB T1 is "left fist" in this dataset's task, and the prototype says so). Locking stops a destructive edit. It does not stop a wrong reading. The label has to stay visible on selection, which it does.

## Performance

Measured in the lab's own **Measure frame time** button, in Chrome on this cloud VM, device pixel ratio about 1, on the fist-task file (64 channels, 160 Hz). Medians. This is not a clinic PC. Re-run the button on the hardware the service will ship. The ratios are the result.

| Work | Median | p95 |
| --- | --- | --- |
| Trend dot field, including the blit (24 paints) | 3.1 ms | 6.5 ms |
| `computeBands`, one 2 s window at 160 Hz | 0.2 ms (1 ch), 1.3 ms (21 ch), 2.7 ms (64 ch) | — |
| Raw-trace dot fill, 2 s, 1100×640 | 4.8 ms for 21 ch | 5.4 ms |
| Same fill, 64 channels | 3.5 ms | 3.7 ms |
| Same window drawn as polylines | 0.2 ms (21 ch), 0.5 ms (64 ch) | — |

A separate timing of the pixel loop alone (no blit), on the eyes-closed trend at a simulated DPR of 2, was 4.4 ms median (p95 5.9, first cold frame 14.7). Building that 61 s trend once, 119 windows of three occipital channels averaged together, was 19 ms.

A 60 Hz frame is 16.7 ms. The trend fits, with margin for a tooltip and a cursor. Recomputing one window across a 10-20 montage is about a millisecond here, and across all 64 channels about 3 ms, so a few updates a second during live review is comfortable. Doing it every display frame would be wasteful. The physiology inside a 2 s window does not move at 60 Hz.

The raw dot fill also fit in a frame. That is not an argument for using it. It was about 24× the polyline at 21 channels (4.8 ms against 0.2 ms) and about 7× at 64. The 64-channel fill was faster than the 21-channel fill, because each lane was shorter and less of the screen was painted. Cost follows filled pixels, not the channel count on the invoice. A tall clinical lane paints more dots. DPR 2 and a finer pitch eat the margin, and the frame still has filters, the real polylines, hit testing, and the rest of the UI.

Live streaming does not change the conclusion. The chart should consume a derived series (one number per hop), not the sample stream. The sample stream stays on the trace canvas the review page already has, which scrolls by blitting cached tiles. Putting the dot renderer on that path would throw away the tile cache for a less readable line.

## ACNS display, in one paragraph

Routine review is a montage, left over right, at a stated sensitivity and timebase, with filters the reader can see and change. The conventional starting point is on the order of 7 µV/mm and 30 mm/s, high-pass near 1 Hz and low-pass near 70 Hz, and enough channels to hold a full 10-20 page. Digital review exists to reformat that page, not to replace it with a summary. Quantitative trends in continuous EEG are an adjunct: same clock as the raw EEG, and the raw EEG has to be openable at the moment the trend made someone look. The dot field can be that kind of adjunct. It cannot be the page. It has no millimetre, no polarity, and no per-channel line. Annotation terms the app already uses (the ACNS/ILAE set) stay on the trace, where duration and channel mean something. A trend mark that cannot be seen on the trace is not an annotation.

## What I would ship, and what I would not

Ship the tokens as a future option for chrome: #111 background, white primary, #A3A3A3 secondary, one blue for the selected control, tabular numbers, no shadow. Prove a light counterpart before it is the only theme. Do not start by repainting review.

Ship the cursor behavior (1:1, frame-coalesced, numeric tooltip) on the existing scrub bar and on any future trend strip. That part is a straight improvement and does not change the record.

Ship a band-power or RMS strip only with the raw page under it, the window and hop printed, the unit printed, and the series immutable. Blue is the selected band or the selected mark, and nothing else.

Do not ship click-to-add or click-to-delete. If user marks are edited from a trend, add is a tool, delete is explicit, undo survives the session, and the existing annotation sidecar keeps the audit.

Do not ship dots as traces. The polyline is the clinical object. The measurement above is why it can stay that way without a performance excuse to change it.
