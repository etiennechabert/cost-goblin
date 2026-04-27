import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['packages/core/src/__fixtures__/setup.ts'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{core,desktop}/src/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/__tests__/setup.ts'],
          passWithNoTests: true,
        },
      },
    ],
  },
});
