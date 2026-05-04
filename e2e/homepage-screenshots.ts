/**
 * Takes screenshots for the homepage (docs/screenshots/).
 * Run: npm run build --workspace=packages/desktop && npx tsx e2e/homepage-screenshots.ts
 */
import { _electron } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { setup } from '../packages/core/src/__fixtures__/setup.js';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop');
const OUTPUT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUTPUT_DIR, { recursive: true });

const FIXTURE_DATA_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'synthetic');
const FIXTURE_CONFIG_DIR = join(ROOT, 'packages', 'core', 'src', '__fixtures__', 'config');

// Fake "today" to March 2 2026 so presets align with fixture data (Jan-Feb 2026)
const FAKE_NOW = new Date('2026-03-02T12:00:00Z').getTime();

async function main() {
  console.log('Generating fixture data...');
  await setup();

  const app = await _electron.launch({
    args: [join(DESKTOP_DIR, 'out', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      COSTGOBLIN_E2E: '1',
      COSTGOBLIN_DATA_DIR: FIXTURE_DATA_DIR,
      COSTGOBLIN_CONFIG_DIR: FIXTURE_CONFIG_DIR,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByText('CostGoblin', { exact: true }).waitFor({ timeout: 10_000 });

  // Override Date.now so date presets resolve within fixture data range
  await page.evaluate(`
    (function() {
      var fakeNow = ${String(FAKE_NOW)};
      var OrigDate = Date;
      function FakeDate() {
        if (arguments.length === 0) return new OrigDate(fakeNow);
        return new (Function.prototype.bind.apply(OrigDate, [null].concat(Array.prototype.slice.call(arguments))))();
      }
      FakeDate.prototype = OrigDate.prototype;
      FakeDate.now = function() { return fakeNow; };
      FakeDate.parse = function(s) { return OrigDate.parse(s); };
      FakeDate.UTC = function() { return OrigDate.UTC.apply(null, arguments); };
      Date = FakeDate;
    })();
  `);

  async function settle() {
    try {
      const loading = page.getByText('Loading', { exact: false }).first();
      await loading.waitFor({ state: 'hidden', timeout: 5000 });
    } catch { /* may never appear */ }
    await page.waitForTimeout(500);
  }

  async function selectPreset(label: string) {
    const trigger = page.locator('button:has(svg.lucide-calendar)');
    await trigger.click();
    await page.getByText(label, { exact: true }).click();
    await settle();
  }

  // --- Tags (Missing) ---
  await page.getByRole('button', { name: /Tags/ }).first().click();
  await page.getByText('without the selected allocation tag', { exact: false }).waitFor({ timeout: 5000 });
  await settle();
  await selectPreset('Last month');
  await page.screenshot({ path: join(OUTPUT_DIR, 'tags-missing.png') });
  console.log('✓ tags-missing.png');

  // --- Trends ---
  await page.getByRole('button', { name: /Trends/ }).first().click();
  await page.getByText('Period-over-period comparison', { exact: false }).waitFor({ timeout: 5000 });
  await settle();
  await selectPreset('Last month');
  // Switch to AWS Service dimension for more data points
  await page.getByRole('button', { name: 'AWS Service' }).click();
  await settle();
  // Lower thresholds to show more data
  const minDollar = page.locator('input[type="number"]').first();
  await minDollar.fill('1');
  await settle();
  const minPct = page.locator('input[type="number"]').nth(1);
  await minPct.fill('0');
  await settle();
  await page.screenshot({ path: join(OUTPUT_DIR, 'trends.png') });
  console.log('✓ trends.png');

  // --- Cost Optimization (Findings) ---
  await page.getByRole('button', { name: /Findings/ }).first().click();
  await page.getByText('cost optimization recommendations', { exact: false }).waitFor({ timeout: 5000 });
  await settle();
  await page.screenshot({ path: join(OUTPUT_DIR, 'cost-optimization.png') });
  console.log('✓ cost-optimization.png');

  await app.close();
  console.log('\nDone — screenshots saved to docs/screenshots/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
