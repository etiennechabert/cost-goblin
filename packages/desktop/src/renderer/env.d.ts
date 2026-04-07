import type { CostApi } from '@costgoblin/core/browser';

declare global {
  interface Window {
    costgoblin: CostApi;
  }
}
