/**
 * Builds the spike's local data dir (`.fixtures/`) from the committed synthetic
 * fixtures, shifting every timestamp forward so the newest row lands on
 * ~today. The renderer's default window is "last 30 days from now"; the
 * committed fixtures are dated Jan–Feb 2026, so without this shift the landing
 * dashboard would be empty. The real fixtures are never modified.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(pkgRoot, '..', 'core', 'src', '__fixtures__', 'synthetic', 'aws', 'raw');
const outRoot = join(pkgRoot, '.fixtures', 'aws', 'raw');

function globFor(tier: string): string {
  return join(srcDir, `${tier}-*`, '*.parquet').replaceAll('\\', '/');
}

async function main(): Promise<void> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  const dailyGlob = globFor('daily');
  const maxRows = await (
    await conn.run(`SELECT max(line_item_usage_start_date)::DATE::VARCHAR AS d FROM read_parquet('${dailyGlob}')`)
  ).getRowObjects();
  const maxDate = String(maxRows[0]?.['d'] ?? '');
  if (maxDate === '') throw new Error(`No daily fixture data found at ${dailyGlob}`);

  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const maxUTC = Date.parse(`${maxDate}T00:00:00Z`);
  const offset = Math.round((todayUTC - maxUTC) / 86_400_000);

  await rm(join(pkgRoot, '.fixtures'), { recursive: true, force: true });

  for (const tier of ['daily', 'hourly']) {
    const glob = globFor(tier).replaceAll("'", "''");
    const shift = `(line_item_usage_start_date + ${offset} * INTERVAL '1' DAY)`;
    await conn.run(`CREATE OR REPLACE TABLE shifted AS SELECT * REPLACE (${shift} AS line_item_usage_start_date) FROM read_parquet('${glob}')`);
    const monthRows = await (
      await conn.run(`SELECT DISTINCT strftime(line_item_usage_start_date, '%Y-%m') AS m FROM shifted ORDER BY m`)
    ).getRowObjects();
    for (const r of monthRows) {
      const month = String(r['m']);
      const dir = join(outRoot, `${tier}-${month}`);
      await mkdir(dir, { recursive: true });
      const out = join(dir, 'data.parquet').replaceAll("'", "''");
      await conn.run(
        `COPY (SELECT * FROM shifted WHERE strftime(line_item_usage_start_date, '%Y-%m') = '${month}') TO '${out}' (FORMAT PARQUET)`,
      );
    }
    process.stdout.write(`  ${tier}: ${monthRows.length} month(s) shifted by ${offset}d (newest ~${maxDate}+${offset}d)\n`);
  }
  process.stdout.write(`Prepared spike fixtures at ${join(pkgRoot, '.fixtures')}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`prepare-fixtures failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
