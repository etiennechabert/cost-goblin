import { defineConfig } from 'vitest/config';

// Mirrors the root vitest.config.ts's `node` and `desktop-renderer` projects
// for this package, so `npm run check` here runs the renderer's .test.tsx
// files too — in jsdom, with the same setup files as a root run.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'desktop-renderer',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['../ui/src/__tests__/setup.ts', 'src/__tests__/renderer-setup.ts'],
          passWithNoTests: true,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
