// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Jayson Leach
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import ReactEEGApp from './App.jsx'
import UiLab from './ui-lab/UiLab.jsx'

// Opt-in prototype. The clinical app mounts only when this is false, so the
// lab never shares its tree and never runs library init.
function uiLabRequested() {
  if (typeof window === 'undefined') return false
  const q = new URLSearchParams(window.location.search)
  return window.location.hash === '#ui-lab' || q.get('ui-lab') === '1'
}

function Root() {
  const [lab, setLab] = useState(uiLabRequested)
  useEffect(() => {
    const sync = () => setLab(uiLabRequested())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  return lab ? <UiLab /> : <ReactEEGApp />
}

// Tauri v2 compatibility shim. The desktop bridge (src/App.jsx `tauriBridge`) calls the
// v1-style `window.__TAURI__.invoke(...)`, but Tauri v2 exposes it at
// `window.__TAURI__.core.invoke`. With `withGlobalTauri: true` set in tauri.conf.json, we
// alias it so every existing bridge call works unchanged. No-op in the browser.
if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke && !window.__TAURI__.invoke) {
  window.__TAURI__.invoke = (...args) => window.__TAURI__.core.invoke(...args)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
