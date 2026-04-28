import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      commonjsOptions: {
        ignoreDynamicRequires: true,
      },
      lib: {
        entry: 'src/main/main.ts',
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: 'src/preload/preload.ts',
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    publicDir: 'src/renderer/public',
    plugins: [react()],
    build: {
      outDir: '../../out/renderer',
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
  },
});
