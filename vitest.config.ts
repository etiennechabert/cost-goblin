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
          // Must exceed setup.ts's asyncUtilTimeout (5s). Left at vitest's
          // default the two are equal, so a stuck waitFor is killed by the
          // test timeout at the same moment it would have reported its
          // assertion diff, and CI shows only an opaque "Test timed out in
          // 5000ms" instead of what was being waited on. The headroom also
          // covers multi-step RTL tests (several sequential waits, 250ms
          // debounces) on loaded runners — though a test that has already
          // spent most of its budget on earlier waits can still be killed
          // before its final wait reports, so this narrows the opaque-failure
          // window rather than closing it.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
