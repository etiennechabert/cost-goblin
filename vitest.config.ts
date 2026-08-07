import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['packages/core/src/__fixtures__/setup.ts'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{core,desktop,mcp}/src/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        // The GCP exporter is plain ESM that ships in a container rather than
        // in a package, so it sits outside the TypeScript projects above — but
        // it generates SQL, and generated SQL is exactly what needs covering.
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.mjs'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.ts', 'packages/ui/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/__tests__/setup.ts'],
          passWithNoTests: true,
        },
      },
    ],
  },
});
