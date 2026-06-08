import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Two build modes:
//   `npm run build`           → standard chunked build for GitHub Pages (base /REACT-EEG/)
//   `npm run build:single`    → one self-contained dist-single/index.html for sharing
// NOTE: the Pages base path must match the GitHub repo name (project site serves at
// https://<user>.github.io/<repo>/). Repo: IONOFIELD/REACT-EEG.
export default defineConfig(({ mode }) => {
  const isSingle = mode === 'singlefile'
  return {
    plugins: [
      react(),
      ...(isSingle ? [viteSingleFile()] : []),
    ],
    base: isSingle ? './' : '/REACT-EEG/',
    build: isSingle
      ? {
          outDir: 'dist-single',
          assetsInlineLimit: 100000000,
          cssCodeSplit: false,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : undefined,
  }
})
