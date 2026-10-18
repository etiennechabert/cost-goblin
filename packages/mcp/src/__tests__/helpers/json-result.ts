// Narrowing for a tool's `format: 'json'` response (formatAsJson's shape), so
// tests can assert on titles, meta values and rows without type assertions.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export interface JsonTable {
  readonly title: unknown;
  readonly footer: unknown;
  readonly columnKeys: readonly string[];
  readonly columnHeaders: readonly unknown[];
  /** Each row as `{ columnKey: cell }`. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface JsonResult {
  readonly title: unknown;
  readonly meta: ReadonlyMap<string, unknown>;
  readonly notes: readonly unknown[];
  readonly tables: readonly JsonTable[];
  readonly coverage: Readonly<Record<string, unknown>> | undefined;
}

export function parseJsonResult(text: string): JsonResult {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`not a JSON object: ${text}`);
  const meta = new Map<string, unknown>();
  for (const m of asList(parsed['meta'])) {
    if (isRecord(m) && typeof m['label'] === 'string') meta.set(m['label'], m['value']);
  }
  const tables = asList(parsed['tables']).map((t): JsonTable => {
    if (!isRecord(t)) throw new Error('table is not an object');
    const columns = asList(t['columns']).filter(isRecord);
    const columnKeys = columns.map(c => (typeof c['key'] === 'string' ? c['key'] : ''));
    const rows = asList(t['rows']).map((r) => {
      const cells = asList(r);
      const row: Record<string, unknown> = {};
      columnKeys.forEach((k, i) => { row[k] = cells[i]; });
      return row;
    });
    return { title: t['title'], footer: t['footer'], columnKeys, columnHeaders: columns.map(c => c['header']), rows };
  });
  const coverage = parsed['coverage'];
  return {
    title: parsed['title'],
    meta,
    notes: asList(parsed['notes']),
    tables,
    coverage: isRecord(coverage) ? coverage : undefined,
  };
}

/** The first text content of a tool result. */
export function resultText(result: { readonly content: readonly [{ readonly type: 'text'; readonly text: string }] }): string {
  return result.content[0].text;
}
