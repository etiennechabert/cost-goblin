import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    globalSetup: ['packages/core/src/__fixtures__/setup.ts'],
    environmentMatchGlobs: [
      ['packages/ui/src/**/*.test.tsx', 'jsdom'],
    ],
    setupFiles: ['packages/ui/src/__tests__/setup.ts'],
  },
});
