import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { closeApp, launchApp } from './helpers.js';

// Locks the main-window confinement (main/window-guards.ts +
// main/window-security.ts, #598): the window may only show the app's own
// renderer document, permissions are deny-by-default, and the preload bridge
// is never handed to another document.
//
// Every "stays put" test asserts the URL AND the bridge after a fixed wait: a
// navigation the guard failed to stop would land on the target (or on
// chrome-error:// for the unresolvable .invalid hosts), so the URL check
// cannot false-pass. The 2s wait is the window a navigation has to commit.
// No coverage is collected here (see ci.yml's expected-shard comment).

let app: ElectronApplication;
let page: Page;

const NAV_SETTLE_MS = 2_000;

async function expectStillOnRenderer(): Promise<void> {
  expect(page.url()).toMatch(/\/index\.html(?:[?#].*)?$/);
  expect(page.url().startsWith('file://')).toBe(true);
  const bridgeType = await page.evaluate(() => typeof Reflect.get(globalThis, 'costgoblin'));
  expect(bridgeType).toBe('object');
}

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await expect(page).toHaveTitle('CostGoblin');
});

test.afterAll(async () => {
  await closeApp(app);
});

test('location.href to a remote page is blocked', async () => {
  await page.evaluate(() => { globalThis.location.href = 'https://nav-guard.invalid/'; });
  await page.waitForTimeout(NAV_SETTLE_MS);
  await expectStillOnRenderer();
});

test('a meta refresh to a remote page is blocked', async () => {
  await page.evaluate(() => {
    const meta = document.createElement('meta');
    meta.httpEquiv = 'refresh';
    meta.content = '0;url=https://nav-guard.invalid/';
    document.head.appendChild(meta);
  });
  await page.waitForTimeout(NAV_SETTLE_MS);
  await expectStillOnRenderer();
});

test('navigating to another local file is blocked', async () => {
  await page.evaluate(() => { globalThis.location.href = 'file:///tmp/evil.html'; });
  await page.waitForTimeout(NAV_SETTLE_MS);
  await expectStillOnRenderer();
});

test('location.reload() of the app itself still works and keeps the bridge', async () => {
  // Reload is the app's own self-navigation (config import, App.tsx). Fired
  // from a timer so the evaluate returns before the context is torn down.
  const loaded = page.waitForEvent('load');
  await page.evaluate(() => { setTimeout(() => { globalThis.location.reload(); }, 0); });
  await loaded;
  await expect(page).toHaveTitle('CostGoblin');
  await expectStillOnRenderer();
});

test('permissions are deny-by-default except clipboard write', async () => {
  const states = await page.evaluate(async () => {
    async function query(name: string): Promise<string> {
      // PermissionName in lib.dom lacks 'clipboard-write'; build the
      // descriptor at runtime rather than asserting its type.
      const descriptor: PermissionDescriptor = Object.assign(Object.create(null), { name });
      const status = await navigator.permissions.query(descriptor);
      return status.state;
    }
    return {
      geolocation: await query('geolocation'),
      clipboardWrite: await query('clipboard-write'),
    };
  });
  expect(states.geolocation).toBe('denied');
  // Checked via permissions.query rather than a real writeText: the hidden
  // e2e window never has focus, which writeText requires.
  expect(states.clipboardWrite).toBe('granted');
});

test('an <a download> blob export is a download, not a navigation', async () => {
  await app.evaluate(({ session }) => {
    Reflect.deleteProperty(globalThis, '__navGuardDownload');
    session.defaultSession.once('will-download', (event, item) => {
      Reflect.set(globalThis, '__navGuardDownload', item.getFilename());
      event.preventDefault();
    });
  });
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 't.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  await expect.poll(
    () => app.evaluate(() => {
      const name: unknown = Reflect.get(globalThis, '__navGuardDownload');
      return typeof name === 'string' ? name : null;
    }),
    { timeout: 5_000 },
  ).toBe('t.csv');
  await expectStillOnRenderer();
});

// Last on purpose: it moves the shared window off the app. loadURL is a
// main-process load, which the navigation guards deliberately do not police,
// so this reaches a foreign document and proves the second layer on its own —
// the preload re-runs there and must expose no bridge, and the document gets
// no permissions either.
test('a foreign document gets no preload bridge and no permissions', async () => {
  // A main-process load issued while the renderer still has IPC invokes in
  // flight (the startup queries) can stall indefinitely in the hidden e2e
  // window — the same happens on main without these guards. Wait for the app
  // to go idle so the test also holds when run on its own (-g).
  await expect.poll(() => page.evaluate(() => {
    const debug: unknown = Reflect.get(globalThis, 'costgoblinDebug');
    const count: unknown = typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'getInFlightCount') : undefined;
    return typeof count === 'function' ? Number(Reflect.apply(count, debug, [])) : -1;
  }), { timeout: 15_000 }).toBe(0);
  await app.evaluate(async ({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (win === undefined) throw new Error('no window');
    await win.loadURL('data:text/html,<title>foreign</title>');
  });
  await expect(page).toHaveTitle('foreign');
  const exposed = await page.evaluate(async () => {
    const descriptor: PermissionDescriptor = Object.assign(Object.create(null), { name: 'clipboard-write' });
    return {
      bridges: ['costgoblin', 'costgoblinBaselines', 'costgoblinUpdate', 'costgoblinRollup', 'costgoblinDebug']
        .filter((key) => Reflect.get(globalThis, key) !== undefined),
      clipboardWrite: (await navigator.permissions.query(descriptor)).state,
    };
  });
  expect(exposed.bridges).toEqual([]);
  expect(exposed.clipboardWrite).toBe('denied');
});
