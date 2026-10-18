import { defineConfig } from 'vitest/config';

// Mirrors the root vitest.config.ts's `node` and `desktop-renderer` projects
// for this package, so `npm run check` here runs the renderer's .test.tsx
// files too — in jsdom, with the same setup files as a root run. The handler
// suites copy the synthetic Parquet tree, so the root's fixture generator runs
// here too (it returns at once when the tree is already there).
export default defineConfig({
  test: {
    globalSetup: ['../core/src/__fixtures__/setup.ts'],
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
