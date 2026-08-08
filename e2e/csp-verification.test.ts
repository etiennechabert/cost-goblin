import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';

// The production renderer loads over file:// (win.loadFile), where Playwright
// never surfaces response headers — the previous header-string capture hung
// forever and the suite could not pass. The CSP is therefore verified by its
// enforced EFFECTS: securitypolicyviolation events only fire when a policy
// actually blocks something, so none of these tests can false-pass if the
// onHeadersReceived injection (main.ts) silently stops applying to file://.
//
// Each capture filters on the specific blockedURI it provoked (never a bare
// first-event grab): the page is shared across tests, so a late-dispatched
// violation from an earlier test must not satisfy a later one. The 2s ceiling
// is a timeout, not a sleep — a real violation resolves in milliseconds.
//
// Known limit vs the old header assertion: additive widening of directives we
// don't provoke here (object-src, frame-src, worker-src) is not detectable
// without header access. The four tests below cover the surfaces user input
// can reach: inline scripts, remote scripts, remote fetch, remote img/style.

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('inline script injection is blocked by script-src', async () => {
  // launchApp sets NODE_ENV=production, whose policy has no 'unsafe-inline'
  // for scripts — the load-bearing difference from the dev policy.
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.blockedURI === 'inline' && e.violatedDirective.startsWith('script-src')) {
          resolve(e.violatedDirective);
        }
      });
    });
    const marker = document.createElement('script');
    marker.textContent = 'document.title = "CSP-BYPASSED";';
    document.head.appendChild(marker);
    const directive = await Promise.race([
      violation,
      new Promise<string>((resolve) => setTimeout(() => { resolve('TIMED-OUT'); }, 2000)),
    ]);
    return { title: document.title, directive };
  });
  expect(result.title).not.toBe('CSP-BYPASSED');
  expect(result.directive).toMatch(/^script-src/);
});

test('remote script elements are blocked by script-src', async () => {
  const directive = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.blockedURI.includes('evil.js')) resolve(e.violatedDirective);
      });
    });
    const s = document.createElement('script');
    s.src = 'https://example.com/evil.js';
    document.head.appendChild(s);
    return Promise.race([
      violation,
      new Promise<string>((resolve) => setTimeout(() => { resolve('TIMED-OUT'); }, 2000)),
    ]);
  });
  expect(directive).toMatch(/^script-src/);
});

test('remote network access is blocked by connect-src', async () => {
  // Asserted via the violation event, not the fetch outcome: a fetch to a
  // remote host can fail for network reasons even without a CSP, but a
  // connect-src violation event only exists when the policy blocked it.
  const directive = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.violatedDirective === 'connect-src') resolve(e.violatedDirective);
      });
    });
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
    } catch {
      // expected under CSP — the rejection itself is not the assertion
    }
    return Promise.race([
      violation,
      new Promise<string>((resolve) => setTimeout(() => { resolve('TIMED-OUT'); }, 2000)),
    ]);
  });
  expect(directive).toBe('connect-src');
});

test('remote images and stylesheets are blocked by img-src and style-src', async () => {
  // Guards the rest of the policy the first three tests don't touch: img-src
  // must stay 'self' data: blob: (no remote hosts) and style-src 'self'
  // 'unsafe-inline' (no remote stylesheets).
  const directives = await page.evaluate(async () => {
    const seen: string[] = [];
    const both = new Promise<string[]>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => {
        if (!e.blockedURI.includes('example.com')) return;
        seen.push(e.violatedDirective);
        if (
          seen.some((d) => d.startsWith('img-src')) &&
          seen.some((d) => d.startsWith('style-src'))
        ) {
          resolve(seen);
        }
      });
    });
    const img = document.createElement('img');
    img.src = 'https://example.com/pixel.png';
    document.body.appendChild(img);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.com/evil.css';
    document.head.appendChild(link);
    return Promise.race([
      both,
      new Promise<string[]>((resolve) => setTimeout(() => { resolve(seen); }, 2000)),
    ]);
  });
  expect(directives.some((d) => d.startsWith('img-src'))).toBe(true);
  expect(directives.some((d) => d.startsWith('style-src'))).toBe(true);
});
