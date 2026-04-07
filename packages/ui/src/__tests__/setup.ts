import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

global.ResizeObserver = class ResizeObserver {
  observe() { /* noop */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
};

afterEach(() => {
  cleanup();
});
