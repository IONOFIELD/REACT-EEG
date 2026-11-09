// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
// One dot-matrix chart. The field is redrawn when the series or the selection
// changes. Hover and drag update on requestAnimationFrame from the latest
// pointer position — coalesced, not eased and not debounced.

import { useEffect, useRef, useState } from "react";
import { paintDotField, DOT_PITCH, DOT_RADIUS } from "./dotMatrix.js";
import {
  valueFromClientX, hitMarker, pointerAction, formatClock, DRAG_THRESHOLD_PX,
} from "./pointer.js";
import { sampleAt, argMax } from "./series.js";

const GUIDE = "#404040";
const DIM = "#8a8a8a";
const AXIS = "#a3a3a3";

export default function DotMatrixChart({
  title,
  subtitle,
  times,
  values,
  contribution = null,
  duration,
  formatValue,
  unit,
  guides = [],
  markers = [],
  selectedId = null,
  onSelect,
  onRemove,
  onAdd,
  onMove,
  onMoveEnd,
  cursor = null,
  onCursor,
  emptyAdds = false,
  height = 280,
  onPaint,
  peakCaption = "Peak",
}) {
  const wrapRef = useRef(null);
  const fieldRef = useRef(null);
  const overRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [scrub, setScrub] = useState(null);
  const scrubRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const pendingRef = useRef(null);
  const layoutRef = useRef(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t0 = 0;
  const t1 = duration > 0 ? duration : (times[times.length - 1] || 1);
  const pad = { l: 28, r: 84, t: 52, b: 64 };
  const plot = {
    left: pad.l,
    top: pad.t,
    w: Math.max(10, width - pad.l - pad.r),
    h: Math.max(10, height - pad.t - pad.b),
  };
  const handleY = plot.top + plot.h + 24;

  let yMax = 1e-6;
  for (let i = 0; i < values.length; i++) if (values[i] > yMax) yMax = values[i];
  if (contribution) for (let i = 0; i < contribution.length; i++) if (contribution[i] > yMax) yMax = contribution[i];
  for (const g of guides) if (g.y > yMax) yMax = g.y;
  yMax *= 1.08;

  const xOf = (t) => plot.left + ((t - t0) / (t1 - t0)) * plot.w;
  const yOf = (v) => plot.top + plot.h - (v / yMax) * plot.h;

  layoutRef.current = { plot, handleY, t0, t1, xOf, yOf, yMax };

  useEffect(() => {
    const canvas = fieldRef.current;
    if (!canvas || !values.length) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(bw, bh);
    const tStart = performance.now();
    paintDotField(img.data, bw, bh, {
      plot: { x: plot.left * dpr, y: plot.top * dpr, w: plot.w * dpr, h: plot.h * dpr },
      yMax,
      pitch: DOT_PITCH * dpr,
      radius: DOT_RADIUS * dpr,
      sample: (u) => sampleAt(times, values, t0 + u * (t1 - t0)),
      contrib: contribution ? (u) => sampleAt(times, contribution, t0 + u * (t1 - t0)) : null,
    });
    ctx.putImageData(img, 0, 0);
    onPaint?.(performance.now() - tStart);
    // onPaint is a measurement callback. It is not a reason to repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, times, values, contribution, yMax, t0, t1]);

  useEffect(() => {
    const canvas = overRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textBaseline = "middle";

    // Scale guides. Dotted, labelled, not a threshold.
    ctx.save();
    ctx.setLineDash([1, 3]);
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    ctx.fillStyle = DIM;
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "left";
    for (const g of guides) {
      const y = Math.round(yOf(g.y)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.left + plot.w, y);
      ctx.stroke();
      ctx.fillText(g.label, plot.left + plot.w + 8, y);
    }
    ctx.restore();

    // Peak of the series the eye is meant to read (the blue one, if any).
    const peakSeries = contribution || values;
    const pi = argMax(peakSeries);
    if (peakSeries.length && times.length) {
      const px = xOf(times[pi]);
      const py = yOf(peakSeries[pi]);
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, plot.top);
      ctx.lineTo(Math.round(px) + 0.5, plot.top + plot.h);
      ctx.stroke();
      const labelX = px > plot.left + plot.w - 130 ? px - 8 : px + 8;
      ctx.textAlign = px > plot.left + plot.w - 130 ? "right" : "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = DIM;
      ctx.font = "700 11px Inter, sans-serif";
      ctx.fillText(peakCaption.toUpperCase(), labelX, 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 13px Inter, sans-serif";
      ctx.fillText(formatValue(peakSeries[pi]), labelX, 16);
      ctx.fillStyle = DIM;
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(formatClock(times[pi]), labelX, 32);
    }

    // Persistent cursor (band chart) — a thin guide, separate from the hover dash.
    if (cursor != null && onCursor) {
      const cx = xOf(cursor);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, plot.top);
      ctx.lineTo(Math.round(cx) + 0.5, handleY);
      ctx.stroke();
      drawHandle(ctx, cx, handleY, true, false);
    }

    // Event marks. Locked file events are rings; user marks are discs.
    const selected = markers.find((m) => m.id === selectedId) || null;
    for (const m of markers) {
      const mx = xOf(m.t);
      const on = m.id === selectedId;
      if (on && m.dur > 0) {
        ctx.strokeStyle = "rgba(59,130,246,0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(xOf(m.t + m.dur)) + 0.5, plot.top);
        ctx.lineTo(Math.round(xOf(m.t + m.dur)) + 0.5, plot.top + plot.h);
        ctx.stroke();
      }
      if (on) {
        ctx.strokeStyle = "rgba(59,130,246,0.55)";
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(mx) + 0.5, plot.top);
        ctx.lineTo(Math.round(mx) + 0.5, handleY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawHandle(ctx, mx, handleY, on, m.locked);
    }
    if (selected) {
      const mx = xOf(selected.t);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 12px Inter, sans-serif";
      const nearLeft = mx < plot.left + 36;
      const nearRight = mx > plot.left + plot.w - 36;
      ctx.textAlign = nearLeft ? "left" : nearRight ? "right" : "center";
      ctx.fillText(formatClock(selected.t), mx, handleY + 10);
    }

    // Hover: dashed stem + a dot locked to the curve.
    const hv = scrub;
    if (hv) {
      ctx.save();
      ctx.setLineDash([1, 3]);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hv.x) + 0.5, plot.top);
      ctx.lineTo(Math.round(hv.x) + 0.5, handleY);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(hv.x, hv.y, 3.25, 0, Math.PI * 2);
      ctx.fillStyle = hv.blue ? "#3B82F6" : "#ffffff";
      ctx.fill();
    }

    // Time axis.
    ctx.fillStyle = AXIS;
    ctx.font = "11px Inter, sans-serif";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const t = t0 + ((t1 - t0) * i) / 4;
      const x = xOf(t);
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.fillText(formatClock(t).slice(0, 5), x, plot.top + plot.h + 6);
    }
    // `scrub` is included so the dashed stem repaints on hover. The field
    // effect above does not: hovering must not rebuild the dot buffer.
  }, [width, height, times, values, contribution, yMax, t0, t1, guides, markers, selectedId, cursor, scrub, onCursor, peakCaption, formatValue]);

  function flushPointer() {
    rafRef.current = 0;
    const ev = pendingRef.current;
    if (!ev) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const t = valueFromClientX(ev.clientX, rect.left + layout.plot.left, layout.plot.w, layout.t0, layout.t1);
    const drag = dragRef.current;

    if (drag && drag.kind === "move") {
      if (Math.abs(ev.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
      if (drag.moved) onMove?.(drag.id, t);
      return;
    }
    if (drag && drag.kind === "cursor") {
      if (Math.abs(ev.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
      onCursor?.(t);
      return;
    }

    const v = sampleAt(times, values, t);
    const c = contribution ? sampleAt(times, contribution, t) : 0;
    const next = {
      x: layout.xOf(t),
      y: layout.yOf(v),
      time: formatClock(t),
      value: `${formatValue(v)} ${unit}`,
      extra: contribution ? formatValue(c) : null,
      blue: c > 0,
      inside: y >= layout.plot.top - 8 && y <= layout.handleY + 22 && x >= layout.plot.left && x <= layout.plot.left + layout.plot.w,
    };
    if (!next.inside) {
      if (scrubRef.current) {
        scrubRef.current = null;
        setScrub(null);
      }
      return;
    }
    scrubRef.current = next;
    setScrub(next);
  }

  function schedule(ev) {
    pendingRef.current = { clientX: ev.clientX, clientY: ev.clientY };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(flushPointer);
  }

  function markerPoints(layout) {
    return markers.map((m) => ({ marker: m, x: layout.xOf(m.t), y: layout.handleY }));
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const hit = hitMarker(markerPoints(layout), x, y, 14);
    wrapRef.current.setPointerCapture(ev.pointerId);
    if (hit && !hit.locked && onMove) {
      dragRef.current = { kind: "move", id: hit.id, startX: ev.clientX, moved: false, marker: hit };
    } else if (!hit && onCursor && y >= layout.plot.top && y <= layout.handleY + 16) {
      const t = valueFromClientX(ev.clientX, rect.left + layout.plot.left, layout.plot.w, layout.t0, layout.t1);
      dragRef.current = { kind: "cursor", startX: ev.clientX, moved: false };
      onCursor(t);
    } else {
      dragRef.current = { kind: "click", startX: ev.clientX, moved: false, marker: hit };
    }
  }

  function onPointerMove(ev) {
    const drag = dragRef.current;
    if (drag && Math.abs(ev.clientX - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true;
    schedule(ev);
  }

  function onPointerUp(ev) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (wrapRef.current.hasPointerCapture?.(ev.pointerId)) {
      wrapRef.current.releasePointerCapture(ev.pointerId);
    }
    if (!drag) return;
    const layout = layoutRef.current;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const hit = hitMarker(markerPoints(layout), x, y, 14) || (drag.moved ? drag.marker : null);
    const inLane = y >= layout.plot.top && y <= layout.handleY + 20
      && x >= layout.plot.left - 4 && x <= layout.plot.left + layout.plot.w + 4;
    if (drag.kind === "cursor") return;
    if (drag.kind === "move" && drag.moved) {
      onMoveEnd?.(drag.id);
      return;
    }
    const action = pointerAction({
      marker: hit,
      selectedId,
      moved: drag.moved,
      inLane: emptyAdds && inLane,
    });
    if (action.type === "select") onSelect?.(action.id);
    else if (action.type === "remove") onRemove?.(action.id);
    else if (action.type === "add") {
      const t = valueFromClientX(ev.clientX, rect.left + layout.plot.left, layout.plot.w, layout.t0, layout.t1);
      onAdd?.(t);
    }
  }

  function onPointerLeave() {
    if (dragRef.current) return;
    scrubRef.current = null;
    setScrub(null);
  }

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const tipLeft = scrub ? Math.min(width - 88, Math.max(8, scrub.x - 36)) : 0;
  const tipTop = scrub ? Math.max(0, scrub.y - 46) : 0;

  return (
    <figure className="chart">
      <header className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          <div className="chart-sub">{subtitle}</div>
        </div>
      </header>
      <div
        ref={wrapRef}
        className="chart-stage"
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <canvas ref={fieldRef} className="chart-field" />
        <canvas ref={overRef} className="chart-over" />
        {scrub && (
          <div className="scrub-tip" style={{ left: tipLeft, top: tipTop }}>
            <div className="scrub-time">{scrub.time}</div>
            <div className="scrub-val">{scrub.value}</div>
            {scrub.extra != null && <div className="scrub-extra">Band {scrub.extra}</div>}
          </div>
        )}
      </div>
    </figure>
  );
}

function drawHandle(ctx, x, y, selected, locked) {
  ctx.beginPath();
  ctx.arc(x, y, selected ? 5 : 4, 0, Math.PI * 2);
  if (locked && !selected) {
    ctx.strokeStyle = "#a3a3a3";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  } else if (locked && selected) {
    ctx.fillStyle = "#3B82F6";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = "#111111";
    ctx.fill();
  } else {
    ctx.fillStyle = selected ? "#3B82F6" : "#ffffff";
    ctx.fill();
  }
}
