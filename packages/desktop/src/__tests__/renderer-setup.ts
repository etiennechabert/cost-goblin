import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { installRendererBridges, resetRendererBridges } from './helpers/renderer-bridges.js';

// Setup for the desktop-renderer vitest project, run after the ui project's
// setup.ts (which supplies RTL cleanup and the jsdom gaps).
//
// Renderer modules reach the main process only through the preload's window
// bridges, and some read a bridge once, at import time — debug-panel.tsx keeps
// `globalThis.costgoblinDebug`, App.tsx evaluates `isDev()`. So the fakes are
// installed here, before any test file imports a renderer module, and are
// reset in place after each test instead of being replaced.
installRendererBridges();

afterEach(() => {
  // Unmount before resetting: after-hooks run in reverse registration order,
  // so the ui setup's own cleanup comes later — too late for a still-mounted
  // poller that would otherwise read a half-reset bridge.
  cleanup();
  // Neither fake timers, stubbed globals nor spies on the shared bridges may
  // outlive the test that installed them.
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetRendererBridges();
});
