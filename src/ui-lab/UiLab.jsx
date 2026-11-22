// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// Isolated prototype. Open with the hash #ui-lab. It does not mount the
// clinical app, and it does not read or write the library, annotations, or EDFs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEDFWindow } from "../edf.js";
import { computeBands } from "../dsp.js";
import { readEdfAnnotations, eventsFromAnnotations } from "./annotations.js";
import {
  DATASETS, pickChannels, buildTrend, electrodeName, scaleTick,
  formatPower, formatUv, sampleAt,
} from "./series.js";
import { formatClock } from "./pointer.js";
import { paintRawDotLanes, bench, summarize, DOT_PITCH, DOT_RADIUS } from "./dotMatrix.js";
import DotMatrixChart from "./DotMatrixChart.jsx";
import "./ui-lab.css";

let noteSeq = 1;

export default function UiLab() {
  const [datasetId, setDatasetId] = useState(DATASETS[0].id);
  const [study, setStudy] = useState(null);
  const [error, setError] = useState("");
  const [band, setBand] = useState(DATASETS[0].band);
  const [cursor, setCursor] = useState(12);
  const [marks, setMarks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [past, setPast] = useState([]);
  const [log, setLog] = useState([]);
  const [benchText, setBenchText] = useState("");
  const [playing, setPlaying] = useState(false);
  const paintSamples = useRef([]);
  const [paintReadout, setPaintReadout] = useState("");
  const edfRef = useRef(null);

  const spec = DATASETS.find((d) => d.id === datasetId) || DATASETS[0];

  useEffect(() => {
    document.body.classList.add("ui-lab-root");
    const prev = document.title;
    document.title = "REACT EEG — UI lab";
    return () => {
      document.body.classList.remove("ui-lab-root");
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStudy(null);
    setError("");
    setBenchText("");
    (async () => {
      try {
        const base = import.meta.env.BASE_URL || "/";
        const url = `${base}seed-edfs/${spec.file}`.replace(/\/+/g, "/").replace(":/", "://");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not load ${spec.file} (${res.status})`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const edf = parseEDFWindow(buf);
        if (!edf || edf.error) throw new Error(edf?.error || "EDF parse failed");
        const idxs = pickChannels(edf.channelLabels, spec.channels);
        const trend = buildTrend(edf, idxs, { windowSec: 2, hopSec: 0.5 });
        const fileEvents = eventsFromAnnotations(readEdfAnnotations(buf));
        edfRef.current = { edf, idxs, trend };
        const names = idxs.map((i) => electrodeName(edf.channelLabels[i]));
        const seeded = fileEvents.length >= 3 ? fileEvents : [
          ...fileEvents,
          { id: "seed-note", t: 20, dur: 2, label: "Note", locked: false, source: "user" },
        ];
        if (cancelled) return;
        setStudy({ ...trend, names, file: spec.file, task: spec.task, source: spec.source });
        setBand(spec.band);
        setMarks(seeded);
        setSelectedId(seeded.find((m) => !m.locked)?.id || seeded[0]?.id || null);
        setCursor(Math.min(12, trend.duration / 2));
        setPlaying(false);
        setPast([]);
        setLog(seeded.some((m) => m.source === "user")
          ? ["Sample note at 00:20.00 — not in the file. File events, if any, are locked."]
          : ["Task marks are the file's EDF+ annotations. They are locked."]);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec]);

  const pushLog = (line) => setLog((prev) => [line, ...prev].slice(0, 6));

  const commitMarks = useCallback((next, line) => {
    setPast((p) => [...p, marks].slice(-40));
    setMarks(next);
    if (line) pushLog(line);
  }, [marks]);

  const onAdd = (t) => {
    const id = `note-${noteSeq++}`;
    const mark = { id, t, dur: 1.5, label: "Note", locked: false, source: "user" };
    commitMarks([...marks, mark], `${formatClock(t)}  added Note`);
    setSelectedId(id);
  };

  const onSelect = (id) => {
    setSelectedId(id);
    const m = marks.find((x) => x.id === id);
    if (m) pushLog(`${formatClock(m.t)}  selected ${m.label}${m.locked ? " (file)" : ""}`);
  };

  const onRemove = (id) => {
    const m = marks.find((x) => x.id === id);
    if (!m || m.locked) return;
    commitMarks(marks.filter((x) => x.id !== id), `${formatClock(m.t)}  removed ${m.label}`);
    setSelectedId(null);
  };

  const marksRef = useRef(marks);
  marksRef.current = marks;
  const dragSnap = useRef(null);
  const lastMove = useRef(null);

  const onMove = (id, t) => {
    const current = marksRef.current;
    const m = current.find((x) => x.id === id);
    if (!m || m.locked || !study) return;
    if (dragSnap.current !== id) {
      dragSnap.current = id;
      const snapshot = current;
      setPast((p) => [...p, snapshot].slice(-40));
    }
    const clamped = Math.max(0, Math.min(study.duration, t));
    lastMove.current = { id, t: clamped, label: m.label };
    setMarks((prev) => prev.map((x) => x.id === id ? { ...x, t: clamped } : x));
  };

  const onMoveEnd = () => {
    dragSnap.current = null;
    const moved = lastMove.current;
    if (moved) pushLog(`${formatClock(moved.t)}  moved ${moved.label}`);
  };

  const pastRef = useRef(past);
  pastRef.current = past;
  const undo = () => {
    const p = pastRef.current;
    if (!p.length) return;
    setMarks(p[p.length - 1]);
    setPast(p.slice(0, -1));
    setSelectedId(null);
    pushLog("Undid the last change to your marks");
  };

  const keyRef = useRef({});
  keyRef.current = { undo, onRemove, commitMarks, marks, selectedId, study, cursor };
  useEffect(() => {
    const onKey = (e) => {
      const k = keyRef.current;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        k.undo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && k.selectedId) {
        const m = k.marks.find((x) => x.id === k.selectedId);
        if (m && !m.locked) {
          e.preventDefault();
          k.onRemove(k.selectedId);
        }
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && k.study) {
        const step = e.key === "ArrowLeft" ? -k.study.hopSec : k.study.hopSec;
        const m = k.marks.find((x) => x.id === k.selectedId);
        if (m && !m.locked) {
          e.preventDefault();
          const t = Math.max(0, Math.min(k.study.duration, m.t + step));
          k.commitMarks(k.marks.map((x) => x.id === m.id ? { ...x, t } : x), `${formatClock(t)}  nudged ${m.label}`);
        } else if (k.cursor != null) {
          e.preventDefault();
          setCursor(Math.max(0, Math.min(k.study.duration, k.cursor + step)));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const contribution = useMemo(() => {
    if (!study || !band) return null;
    return study.bands[band];
  }, [study, band]);

  const selected = marks.find((m) => m.id === selectedId) || null;
  const qualityContribution = useMemo(() => {
    if (!study || !selected) return null;
    const end = selected.t + Math.max(selected.dur, study.hopSec);
    return study.rms.map((v, i) => {
      const t = study.times[i];
      return t >= selected.t && t <= end ? v : 0;
    });
  }, [study, selected]);

  const powerGuide = study ? scaleTick(Math.max(...study.total, 1)) : 0;
  const uvGuide = 50;

  const onPaint = (ms) => {
    const s = paintSamples.current;
    s.push(ms);
    if (s.length > 120) s.shift();
    if (s.length === 1 || s.length % 12 === 0) {
      const sum = summarize(s);
      setPaintReadout(`Field paint ${sum.p50.toFixed(2)} ms median, ${sum.p95.toFixed(2)} ms p95 (last ${sum.n})`);
    }
  };

  const runBench = () => {
    const held = edfRef.current;
    if (!held) return;
    const { edf, idxs, trend } = held;
    const lines = [];

    const dsp = (count) => {
      const win = Math.round(2 * trend.sr);
      const start = Math.min(edf.channelData[0].length - win, Math.round(10 * trend.sr));
      const samples = [];
      for (let n = 0; n < 8; n++) {
        const tA = performance.now();
        for (let c = 0; c < count; c++) {
          const src = edf.channelData[c];
          computeBands(src.subarray(start, start + win), trend.sr);
        }
        samples.push(performance.now() - tA);
      }
      const s = summarize(samples);
      return s;
    };
    const nCh = edf.channelLabels.length;
    const one = dsp(1);
    const montage = dsp(Math.min(21, nCh));
    const all = dsp(nCh);
    lines.push(`Band power, 2 s window, ${trend.sr} Hz: 1 ch ${one.p50.toFixed(2)} ms, ${Math.min(21, nCh)} ch ${montage.p50.toFixed(2)} ms, ${nCh} ch ${all.p50.toFixed(2)} ms (median of 8).`);

    const view = Math.round(2 * trend.sr);
    const take = (n) => edf.channelData.slice(0, n).map((ch) => ch.subarray(0, view));
    const raw = (n, w, h) => {
      const channels = take(n);
      const buf = new Uint8ClampedArray(w * h * 4);
      return bench(12, () => paintRawDotLanes(buf, w, h, {
        channels, pitch: DOT_PITCH, radius: DOT_RADIUS,
      }));
    };
    const d21 = raw(Math.min(21, nCh), 1100, 640);
    const d64 = raw(nCh, 1100, 640);
    lines.push(`Raw-trace dot fill, 2 s at ${trend.sr} Hz, 1100×640: ${Math.min(21, nCh)} ch ${d21.p50.toFixed(1)} ms median (p95 ${d21.p95.toFixed(1)}), ${nCh} ch ${d64.p50.toFixed(1)} ms median (p95 ${d64.p95.toFixed(1)}).`);

    const poly = (n) => {
      const channels = take(n);
      const canvas = document.createElement("canvas");
      canvas.width = 1100;
      canvas.height = 640;
      const ctx = canvas.getContext("2d");
      return bench(12, () => {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, 1100, 640);
        const lane = 640 / n;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#ffffff";
        for (let c = 0; c < n; c++) {
          const src = channels[c];
          let peak = 1e-6;
          for (let i = 0; i < src.length; i += 4) if (Math.abs(src[i]) > peak) peak = Math.abs(src[i]);
          const mid = lane * (c + 0.5);
          const amp = (lane * 0.42) / peak;
          ctx.beginPath();
          const step = Math.max(1, Math.floor(src.length / 1100));
          for (let i = 0, x = 0; i < src.length; i += step, x++) {
            const y = mid - src[i] * amp;
            if (x === 0) ctx.moveTo(0, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      });
    };
    const p21 = poly(Math.min(21, nCh));
    const pAll = poly(nCh);
    lines.push(`Same window as polylines: ${Math.min(21, nCh)} ch ${p21.p50.toFixed(2)} ms median, ${nCh} ch ${pAll.p50.toFixed(2)} ms median.`);
    lines.push(`Channels used for the trends: ${idxs.map((i) => electrodeName(edf.channelLabels[i])).join(" ")}. Source file has ${nCh} channels.`);
    setBenchText(lines.join("\n"));
  };

  const leave = () => {
    if (window.location.hash) window.location.hash = "";
    else window.location.search = "";
  };

  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useEffect(() => {
    if (!playing || !study) return;
    let raf = 0;
    let last = performance.now();
    const dur = study.duration;
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let n = cursorRef.current + dt;
      if (n >= dur) {
        cursorRef.current = dur;
        setCursor(dur);
        setPlaying(false);
        return;
      }
      cursorRef.current = n;
      setCursor(n);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, study]);

  const atCursor = study ? sampleAt(study.times, study.total, cursor) : 0;
  const atBand = study && contribution ? sampleAt(study.times, contribution, cursor) : 0;

  return (
    <div className="ui-lab">
      <div className="lab-wrap">
        <div className="lab-top">
          <div>
            <div className="kicker">UI lab</div>
            <div className="lab-sub">
              Dot-matrix trends on a real seed recording. Hover scrubs. Drag is 1:1 with the pointer.
              This screen is not review, not acquisition, and not a clinical display.
            </div>
          </div>
          <button className="back" onClick={leave}>Back to REACT EEG</button>
        </div>
        <div className="warn">Prototype only · nothing here is written to the library</div>

        <div className="sets">
          {DATASETS.map((d) => (
            <button key={d.id} className={datasetId === d.id ? "set on" : "set"} onClick={() => setDatasetId(d.id)}>
              <div className="set-name">{d.task}</div>
              <div className="set-meta">{d.file}</div>
            </button>
          ))}
        </div>

        {!study && !error && <div className="status">Reading {spec.file}…</div>}
        {error && <div className="status">{error}</div>}

        {study && (
          <>
            <DotMatrixChart
              title="Band power"
              subtitle={`${study.source} · ${study.names.join(" ")} · ${study.nCh} ch · ${study.sr} Hz · ${study.windowSec.toFixed(0)} s window, ${study.hopSec.toFixed(1)} s hop · relative power, not µV²`}
              times={study.times}
              values={study.total}
              contribution={contribution}
              duration={study.duration}
              formatValue={formatPower}
              unit="rel"
              guides={[{ y: powerGuide, label: formatPower(powerGuide) }]}
              cursor={cursor}
              onCursor={setCursor}
              height={300}
              onPaint={onPaint}
              peakCaption={band ? `${band} peak` : "Total peak"}
            />
            <div className="row-actions">
              <button className="text-btn" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
              <span className="note" style={{ marginTop: 0 }}>Moves the cursor in real time. The dot field stays put; only the guide is redrawn.</span>
            </div>
            <div className="bands">
              {["delta", "theta", "alpha", "beta", "gamma"].map((b) => (
                <button key={b} className={band === b ? "band on" : "band"} onClick={() => setBand((cur) => cur === b ? null : b)}>
                  {b}
                </button>
              ))}
            </div>
            <p className="note">
              White is total band power (delta through gamma) of {study.names.join(", ")}.{" "}
              {band
                ? <>Blue is the {band} band, a real subset of that total. Selecting it does not change the recording.{" "}</>
                : <>No band is selected, so nothing is drawn in blue.{" "}</>
              }
              The cursor sits at {formatClock(cursor)} · {formatPower(atCursor)} rel
              {band ? ` · ${band} ${formatPower(atBand)}` : ""}.
              Drag the cursor, or click the plot. The ridge is linearly interpolated between windows, so it is smoother than the measurement. The tooltip is the number; the dots are only the shape.
            </p>

            <DotMatrixChart
              title="Signal quality"
              subtitle={`RMS of the same channels, µV · file marks are rings and cannot be moved or deleted · a filled dot is your note`}
              times={study.times}
              values={study.rms}
              contribution={qualityContribution}
              duration={study.duration}
              formatValue={formatUv}
              unit="µV"
              guides={[{ y: uvGuide, label: `${uvGuide} µV` }]}
              markers={marks}
              selectedId={selectedId}
              onSelect={onSelect}
              onRemove={onRemove}
              onAdd={onAdd}
              onMove={onMove}
              onMoveEnd={onMoveEnd}
              emptyAdds
              height={260}
              onPaint={onPaint}
              peakCaption="RMS peak"
            />
            <p className="note">
              Click empty space to add a note. Click a note to select it (blue). Click the selected note to remove it.
              Drag a note and it follows the pointer with no easing. File events stay put.
              The 50 µV line is a scale mark, not a limit and not an alarm.
              Undo puts a removed note back. Delete and the arrow keys do the same as the pointer.
            </p>
            <div className="row-actions">
              <button className="text-btn" disabled={!past.length} onClick={undo}>Undo</button>
              <span className="note" style={{ marginTop: 0 }}>{past.length ? `${past.length} change${past.length === 1 ? "" : "s"} to undo` : "Nothing to undo"}</span>
            </div>
            <div className="log">
              {log.map((line, i) => <div key={i}>{line}</div>)}
            </div>

            <div className="bench">
              <button className="text-btn" onClick={runBench}>Measure frame time</button>
              {paintReadout && <div style={{ marginTop: 8 }}>{paintReadout}</div>}
              {benchText && benchText.split("\n").map((line, i) => <div key={i}>{line}</div>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
