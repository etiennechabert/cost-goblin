import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';

// The production renderer loads over file:// (win.loadFile), where Playwright
// never surfaces response headers — the previous header-string capture hung
// forever and the suite could not pass. The CSP is therefore verified by its
// enforced EFFECTS: securitypolicyviolation events only fire when a policy
// actually blocks something, so none of these tests can false-pass if the
// onHeadersReceived injection (main.ts) silently stops applying to file://.

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
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      violations.push(e.violatedDirective);
    });
    const marker = document.createElement('script');
    marker.textContent = 'document.title = "CSP-BYPASSED";';
    document.head.appendChild(marker);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { title: document.title, violations };
  });
  expect(result.title).not.toBe('CSP-BYPASSED');
  expect(result.violations.some((v) => v.startsWith('script-src'))).toBe(true);
});

test('remote script elements are blocked by script-src', async () => {
  const violations = await page.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
    const s = document.createElement('script');
    s.src = 'https://example.com/evil.js';
    document.head.appendChild(s);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return seen;
  });
  expect(violations.some((v) => v.startsWith('script-src'))).toBe(true);
});

test('remote network access is blocked by connect-src', async () => {
  // Asserted via the violation event, not the fetch outcome: a fetch to a
  // remote host can fail for network reasons even without a CSP, but a
  // connect-src violation event only exists when the policy blocked it.
  const violations = await page.evaluate(async () => {
    const seen: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(e.violatedDirective);
    });
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
    } catch {
      // expected under CSP — the rejection itself is not the assertion
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return seen;
  });
  expect(violations).toContain('connect-src');
});
