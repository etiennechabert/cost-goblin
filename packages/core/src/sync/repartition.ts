import type { DuckDBInstance } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RepartitionResult {
  readonly dates: readonly string[];
  readonly rowCount: number;
}

export async function repartitionMonthlyToDaily(
  db: DuckDBInstance,
  stagingFile: string,
  dailyDir: string,
  usageDateColumn: string = 'usage_date',
): Promise<RepartitionResult> {
  const conn = await db.connect();

  const dateResult = await conn.run(
    `SELECT DISTINCT ${usageDateColumn}::DATE::VARCHAR AS d FROM read_parquet('${stagingFile}') ORDER BY d`,
  );

  const dates: string[] = [];
  let chunk = await dateResult.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const val = chunk.getColumnVector(0).getItem(r);
      if (typeof val === 'string') {
        dates.push(val);
      }
    }
    chunk = await dateResult.fetchChunk();
  }

  let totalRows = 0;
  for (const date of dates) {
    const dateDir = join(dailyDir, `usage_date=${date}`);
    await mkdir(dateDir, { recursive: true });
    const outPath = join(dateDir, 'data.parquet');

    const countResult = await conn.run(
      `COPY (SELECT * FROM read_parquet('${stagingFile}') WHERE ${usageDateColumn}::DATE = '${date}') TO '${outPath}' (FORMAT PARQUET)`,
    );
    const countChunk = await countResult.fetchChunk();
    if (countChunk !== null && countChunk.rowCount > 0) {
      const count = countChunk.getColumnVector(0).getItem(0);
      totalRows += typeof count === 'number' ? count : 0;
    }
  }

  return { dates, rowCount: totalRows };
}
