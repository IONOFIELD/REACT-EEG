// ══════════════════════════════════════════════════════════════
// Client for the DSP web worker (src/dsp-worker.js)
// ══════════════════════════════════════════════════════════════
// One shared worker for the whole app. runDsp() returns a Promise per job, matched back by id.
// If Workers are unavailable (unit tests, SSR) or the worker fails to construct, it transparently
// falls back to running the SAME kernels synchronously on the main thread — identical output.
import { useState, useEffect, useRef } from "react";
import { computeBands, computeSTFT, applyHighPass, applyLowPass, applyNotch } from "./dsp.js";
import { computeQeegAnalysis } from "./qeeg.js";

let _worker = null;        // null = not tried yet; false = unavailable → use sync; Worker = ready
let _nextId = 1;
const _pending = new Map();

function getWorker() {
  if (_worker !== null) return _worker;
  if (typeof Worker === "undefined") { _worker = false; return false; }
  try {
    const w = new Worker(new URL("./dsp-worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const p = _pending.get(id); if (!p) return;
      _pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    w.onerror = () => {
      // Stop trusting the worker — runDsp falls back to sync from here on. Crucially, SETTLE everything
      // already in flight: useDspJob runs one job at a time, so a promise that never settles would wedge
      // that hook forever (pending:true, no further dispatch) and leak its _pending entry.
      _worker = false;
      const stranded = [..._pending.values()];
      _pending.clear();
      stranded.forEach((p) => p.reject(new Error("DSP worker failed; falling back to synchronous DSP")));
    };
    _worker = w;
  } catch { _worker = false; }
  return _worker;
}

// Synchronous fallback — kept byte-identical to the worker's handlers.
function runSync(job, args) {
  if (job === "bands") return args.channels.map((ch) => computeBands(ch, args.sr));
  if (job === "stft") {
    const { windows, crops, sampleRate, hpf, lpf, notch } = args;
    const sigs = windows.map((w, i) => {
      let ext = w;
      if (hpf > 0) ext = applyHighPass(ext, hpf, sampleRate);
      if (lpf > 0) ext = applyLowPass(ext, lpf, sampleRate);
      if (notch > 0) ext = applyNotch(ext, notch, sampleRate);
      const c = crops && crops[i], lead = c ? c.lead : 0, len = c ? c.len : ext.length;
      return (lead > 0 || len < ext.length) ? ext.slice(lead, lead + len) : ext;
    });
    return computeSTFT(sigs, sampleRate);
  }
  if (job === "qeeg") return computeQeegAnalysis(args.waveformData, args.channels, args.sampleRate);
  throw new Error("unknown DSP job: " + job);
}

// Run a DSP job off the main thread (or synchronously if no worker). Args are structured-cloned to
// the worker (never transferred), so the caller's arrays are never neutered.
export function runDsp(job, args) {
  const w = getWorker();
  if (!w) { try { return Promise.resolve(runSync(job, args)); } catch (e) { return Promise.reject(e); } }
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    try { w.postMessage({ id, job, args }); }
    catch { _pending.delete(id); try { resolve(runSync(job, args)); } catch (e) { reject(e); } }
  });
}

// React hook: (re)run `job` whenever `deps` change; returns { result, pending }.
//
// Real-time scheduling: at most ONE worker job runs per hook at a time, and while it runs the newest
// args are remembered and dispatched the instant it finishes (single-in-flight, trailing-latest). So
// when a panel tracks the LIVE review position (no useDeferredValue), fast scrubbing can't flood the
// worker queue with stale jobs that would make the display lag further behind — the worker always
// computes the most RECENT epoch and skips the intermediate ones, so the panel updates as fast as the
// worker can go. The previous result stays on screen while the next computes, so it never flashes
// empty. `buildArgs()` returns the job args, or null to skip and clear the result.
export function useDspJob(job, buildArgs, deps) {
  const [state, setState] = useState({ result: null, pending: false });
  const reqRef = useRef(0);            // monotonic id — only the newest job's result is shown
  const inFlightRef = useRef(false);   // is a worker job currently running for this hook?
  const latestRef = useRef(undefined); // newest args awaiting a free slot (undefined = nothing queued)
  const jobRef = useRef(job); jobRef.current = job;

  // Run the newest queued args; when it settles, immediately run whatever is newest THEN (or go idle).
  const pumpRef = useRef(null);
  pumpRef.current = () => {
    const args = latestRef.current;
    if (args === undefined) { inFlightRef.current = false; return; }
    latestRef.current = undefined;
    inFlightRef.current = true;
    const myReq = ++reqRef.current;
    setState((s) => ({ result: s.result, pending: true }));
    runDsp(jobRef.current, args)
      .then((result) => { if (myReq === reqRef.current) setState({ result, pending: false }); })
      .catch(() => { if (myReq === reqRef.current) setState((s) => ({ result: s.result, pending: false })); })
      .finally(() => { pumpRef.current(); }); // trailing: pick up the latest args that arrived meanwhile
  };

  useEffect(() => {
    const args = buildArgs();
    if (!args) {                         // clear: invalidate any in-flight result and show nothing
      reqRef.current++;
      latestRef.current = undefined;
      setState({ result: null, pending: false });
      return;
    }
    latestRef.current = args;            // record the newest desired input
    if (!inFlightRef.current) pumpRef.current(); // idle -> start now; busy -> picked up on finish
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
