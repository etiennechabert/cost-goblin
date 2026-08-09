/**
 * COSTGOBLIN_NOW support: e2e runs and the screenshot script pin the renderer
 * clock so relative date presets ("Last 30 days") resolve inside the fixture
 * data window (Jan–Feb 2026) regardless of the real date. The env var is
 * parsed in the preload (the sandboxed renderer cannot read process.env) and
 * applied here, imported first in main.tsx so it runs before any app module
 * reads the clock. Real launches never set the variable, making this a no-op.
 */
const fakeNowMs = window.costgoblinDebug.fakeNowMs();

if (fakeNowMs !== null) {
  const nowMs = fakeNowMs;
  // Typed view of Reflect.construct: its lib declaration returns `any`, which
  // must not propagate (no-unsafe-return).
  const construct: (target: DateConstructor, args: unknown[], newTarget: new (...args: never[]) => unknown) => Date =
    Reflect.construct;
  // Consumers reach "now" two ways: Date.now() and a zero-argument new Date().
  // Patch the former on the real constructor and wrap the latter with a Proxy;
  // explicit timestamps (new Date(iso), Date.parse) pass through untouched.
  Date.now = (): number => nowMs;
  globalThis.Date = new Proxy(Date, {
    construct(target: DateConstructor, argArray: unknown[], newTarget: new (...args: never[]) => unknown): object {
      return construct(target, argArray.length === 0 ? [nowMs] : argArray, newTarget);
    },
    // Date() without `new` returns the current date as a string.
    apply(target: DateConstructor): string {
      return construct(target, [nowMs], target).toString();
    },
  });
}

export {};
