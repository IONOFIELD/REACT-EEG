import React from 'react'
import ReactDOM from 'react-dom/client'
import ReactEEGApp from './App.jsx'

// Tauri v2 compatibility shim. The desktop bridge (src/App.jsx `tauriBridge`) calls the
// v1-style `window.__TAURI__.invoke(...)`, but Tauri v2 exposes it at
// `window.__TAURI__.core.invoke`. With `withGlobalTauri: true` set in tauri.conf.json, we
// alias it so every existing bridge call works unchanged. No-op in the browser.
if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke && !window.__TAURI__.invoke) {
  window.__TAURI__.invoke = (...args) => window.__TAURI__.core.invoke(...args)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ReactEEGApp />
  </React.StrictMode>,
)
