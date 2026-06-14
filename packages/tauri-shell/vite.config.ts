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
  // Strip Vite's `crossorigin` from the bundled tags — under Tauri's custom
  // asset protocol a CORS-mode fetch can be blocked. (Build-only; dev unaffected.)
  plugins: [
    react(),
    {
      name: 'tauri-strip-crossorigin',
      transformIndexHtml(html: string): string {
        return html.replace(/\s+crossorigin/g, '');
      },
    },
  ],
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
