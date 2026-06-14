import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const monorepoRoot = resolve(root, '..', '..');

// Standalone Vite app that renders the EXISTING desktop renderer verbatim.
// The only swap vs. Electron is the IPC seam: `src/bridge.ts` installs
// `window.costgoblin` (and friends) backed by Tauri `invoke` instead of
// Electron's contextBridge. Public assets (goblin/splash images) are served
// from the desktop renderer's public dir so the UI loads identically.
export default defineConfig({
  root,
  plugins: [react()],
  publicDir: resolve(root, '..', 'desktop', 'src', 'renderer', 'public'),
  clearScreen: false,
  server: {
    port: 5599,
    strictPort: true,
    fs: {
      // Allow importing sibling workspace package sources (ui, desktop, core).
      allow: [monorepoRoot],
    },
  },
});
