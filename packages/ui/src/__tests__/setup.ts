import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

globalThis.ResizeObserver = class ResizeObserver {
  observe() { /* noop */ }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
};

Element.prototype.scrollIntoView = () => { /* noop */ };

afterEach(() => {
  cleanup();
});
