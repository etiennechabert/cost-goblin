import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    environmentMatchGlobs: [
      ['packages/ui/src/**/*.test.tsx', 'jsdom'],
    ],
  },
});
