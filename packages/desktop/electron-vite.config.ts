import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@costgoblin/core'] })],
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
    plugins: [externalizeDepsPlugin()],
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
