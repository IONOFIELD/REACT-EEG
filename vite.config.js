import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Two build modes:
//   `npm run build`           → standard chunked build for GitHub Pages (base /react-build-v11/)
//   `npm run build:single`    → one self-contained dist-single/index.html for sharing
export default defineConfig(({ mode }) => {
  const isSingle = mode === 'singlefile'
  return {
    plugins: [
      react(),
      ...(isSingle ? [viteSingleFile()] : []),
    ],
    base: isSingle ? './' : '/react-build-v11/',
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
