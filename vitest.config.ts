import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['packages/core/src/__fixtures__/setup.ts'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{core,desktop,mcp}/src/**/*.test.ts', 'workers/signup/src/**/*.test.ts'],
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
      {
        // The desktop renderer (packages/desktop/src/renderer) is React; the
        // node project above globs only `*.test.ts` and has no DOM. Renderer
        // components render @costgoblin/ui ones, so they share the ui setup
        // (RTL cleanup and the jsdom gaps those components need:
        // ResizeObserver, matchMedia, ...) and the ui project's timeout, for
        // the same reasons. renderer-setup.ts then installs typed fakes of the
        // preload's window bridges, which some renderer modules read once, at
        // import time (debug-panel.tsx, App.tsx).
        test: {
          name: 'desktop-renderer',
          include: ['packages/desktop/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/__tests__/setup.ts', 'packages/desktop/src/__tests__/renderer-setup.ts'],
          passWithNoTests: true,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
