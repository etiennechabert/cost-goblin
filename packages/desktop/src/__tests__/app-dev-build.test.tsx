import { render, screen } from '@testing-library/react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ViewsConfig } from '@costgoblin/core/browser';
import { MockCostApi } from '@costgoblin/ui';
import { App } from '../renderer/App.js';
import { fakeDebug } from './helpers/renderer-bridges.js';

// App.tsx reads `isDev()` and whether the perf bridge exists once, at import —
// so this file puts the renderer in a dev build with COSTGOBLIN_PERF_MODE=1
// before App.js is loaded (vi.hoisted runs ahead of the imports above). The
// setup file resets the fake's `dev` flag after each test, which App's
// import-time read is past caring about.
await vi.hoisted(async () => {
  const bridges = await import('./helpers/renderer-bridges.js');
  bridges.fakeDebug.dev = true;
  globalThis.costgoblinPerf = {
    getIpcTimings: () => [],
    clearIpcTimings: () => undefined,
    startCpuProfile: () => Promise.resolve(undefined),
    stopCpuProfile: () => Promise.resolve({ path: '' }),
  };
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'costgoblinPerf');
  Reflect.deleteProperty(globalThis, '__PERF_REACT__');
});

const VIEWS: ViewsConfig = { views: [{ id: 'overview', name: 'Cost Overview', builtIn: true, rows: [] }] };

class AppApi extends MockCostApi {
  override getViewsConfig(): Promise<ViewsConfig> { return Promise.resolve(VIEWS); }
}

async function bootApp(): Promise<void> {
  globalThis.costgoblin = new AppApi();
  render(<App />);
  await screen.findByRole('heading', { name: 'Cost Overview' });
}

describe('App in a dev build', () => {
  it.each([
    { memoryMB: 1536, shown: '1.50 GB' },
    { memoryMB: 512, shown: '512 MB' },
  ])('shows the renderer memory use ($shown)', async ({ memoryMB, shown }) => {
    fakeDebug.memoryMB = memoryMB;
    await bootApp();
    expect(await screen.findByText(shown)).toBeDefined();
  });

  it('shows no memory figure until one has been read', async () => {
    fakeDebug.memoryMB = 0;
    await bootApp();
    expect(screen.queryByText(/^\d+(\.\d+)? (MB|GB)$/)).toBeNull();
  });

  it('records React render timings for the perf harness', async () => {
    await bootApp();
    const timings = globalThis.__PERF_REACT__ ?? [];
    expect(timings.some(t => t.id === 'custom:overview' && t.phase === 'mount')).toBe(true);
  });
});
