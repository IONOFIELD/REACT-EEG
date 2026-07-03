import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build modes:
//   `npm run build`         → standard chunked build for GitHub Pages (base /REACT-EEG/)
//   `npm run build:single`  → one self-contained dist-single/index.html for sharing
//   `npm run build:tauri`   → chunked build with a relative base for the Tauri desktop shell
//                             (assets load from tauri://localhost/, so base must be './')
// NOTE: the Pages base path must match the GitHub repo name (project site serves at
// https://<user>.github.io/<repo>/). Repo: IONOFIELD/REACT-EEG.
export default defineConfig(({ mode }) => {
  const isSingle = mode === 'singlefile'
  const isTauri = mode === 'tauri'
  return {
    plugins: [
      react(),
      ...(isSingle ? [viteSingleFile()] : []),
    ],
    base: (isSingle || isTauri) ? './' : '/REACT-EEG/',
    // Tauri drives a fixed dev-server port + shows Rust build output, so don't clear it.
    clearScreen: !isTauri,
    server: isTauri ? { port: 5173, strictPort: true } : undefined,
    build: isSingle
      ? {
          outDir: 'dist-single',
          assetsInlineLimit: 100000000,
          cssCodeSplit: false,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : isTauri
        ? { outDir: 'dist-tauri', emptyOutDir: true }
        : undefined,
  }
})
