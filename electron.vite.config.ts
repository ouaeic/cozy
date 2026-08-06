import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const r = (...p: string[]) => resolve(__dirname, ...p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: r('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: r('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: r('src/renderer'),
    resolve: {
      alias: { '@': r('src/renderer') },
    },
    // Preact's automatic JSX runtime — no React, no preset plugin needed.
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    define: {
      // `COZY_SIGNAL=wss://…/ws npm run dist` bakes your own server in, so
      // nobody who installs the build has to configure anything.
      'import.meta.env.VITE_COZY_SIGNAL': JSON.stringify(process.env.COZY_SIGNAL ?? ''),
    },
    build: {
      rollupOptions: {
        input: {
          // The Stage window. It owns every MediaStream and all app state.
          index: r('src/renderer/index.html'),
          // The floating Faces window. An empty shell — the Stage renders into
          // its document directly (same renderer process, see src/main/windows.ts).
          faces: r('src/renderer/faces.html'),
          // The control bar: a second always-on-top panel, so the controls are
          // reachable from whatever app you're actually looking at.
          bar: r('src/renderer/bar.html'),
        },
      },
    },
  },
})
