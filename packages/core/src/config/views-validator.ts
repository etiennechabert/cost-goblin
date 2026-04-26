import { asDimensionId, asTagValue } from '../types/branded.js';
import type { DimensionId, TagValue } from '../types/branded.js';
import type {
  SummaryMetric,
  ViewSpec,
  ViewsConfig,
  WidgetFilterOverlay,
  WidgetSize,
  WidgetSpec,
  WidgetType,
} from '../types/views.js';
import {
  ConfigValidationError,
  assertArray,
  assertNumber,
  assertObject,
  assertString,
} from './validator.js';

const WIDGET_TYPES: readonly WidgetType[] = [
  'summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table',
];

const WIDGET_SIZES: readonly WidgetSize[] = ['small', 'medium', 'large', 'full'];

const SUMMARY_METRICS: readonly SummaryMetric[] = ['total', 'delta', 'topEntity', 'entityCount'];

function isWidgetType(s: string): s is WidgetType {
  return (WIDGET_TYPES as readonly string[]).includes(s);
}

function isWidgetSize(s: string): s is WidgetSize {
  return (WIDGET_SIZES as readonly string[]).includes(s);
}

function isSummaryMetric(s: string): s is SummaryMetric {
  return (SUMMARY_METRICS as readonly string[]).includes(s);
}

function validateFilters(raw: unknown, ctx: string): WidgetFilterOverlay | undefined {
  if (raw === undefined) return undefined;
  assertObject(raw, ctx);
  const out: Partial<Record<DimensionId, TagValue>> = {};
  for (const [k, v] of Object.entries(raw)) {
    assertString(v, `${ctx}.${k}`);
    out[asDimensionId(k)] = asTagValue(v);
  }
  return out;
}

interface WidgetBase {
  readonly id: string;
  readonly size: WidgetSize;
  readonly title?: string;
  readonly filters?: WidgetFilterOverlay;
}

function parseWidgetBase(raw: Record<string, unknown>, ctx: string): WidgetBase {
  assertString(raw['id'], `${ctx}.id`);
  assertString(raw['type'], `${ctx}.type`);
  if (!isWidgetType(raw['type'])) {
    throw new ConfigValidationError(
      `${ctx}.type must be one of: ${WIDGET_TYPES.join(', ')} (got ${raw['type']})`,
    );
  }
  assertString(raw['size'], `${ctx}.size`);
  if (!isWidgetSize(raw['size'])) {
    throw new ConfigValidationError(
      `${ctx}.size must be one of: ${WIDGET_SIZES.join(', ')} (got ${raw['size']})`,
    );
  }
  const title = raw['title'] === undefined ? undefined : (assertString(raw['title'], `${ctx}.title`), raw['title']);
  const filters = validateFilters(raw['filters'], `${ctx}.filters`);
  return {
    id: raw['id'],
    size: raw['size'],
    ...(title === undefined ? {} : { title }),
    ...(filters === undefined ? {} : { filters }),
  };
}

function validateSummaryWidget(raw: Record<string, unknown>, ctx: string, base: WidgetBase): WidgetSpec {
  let metric: SummaryMetric | undefined;
  if (raw['metric'] !== undefined) {
    assertString(raw['metric'], `${ctx}.metric`);
    if (!isSummaryMetric(raw['metric'])) {
      throw new ConfigValidationError(
        `${ctx}.metric must be one of: ${SUMMARY_METRICS.join(', ')}`,
      );
    }
    metric = raw['metric'];
  }
  return { type: 'summary', ...base, ...(metric === undefined ? {} : { metric }) };
}

function validateGroupByWidget(raw: Record<string, unknown>, ctx: string, base: WidgetBase, type: 'pie' | 'stackedBar' | 'bubble' | 'treemap'): WidgetSpec {
  assertString(raw['groupBy'], `${ctx}.groupBy`);
  const groupBy = asDimensionId(raw['groupBy']);
  if (type === 'treemap') {
    const drillTo = raw['drillTo'] !== undefined
      ? (assertString(raw['drillTo'], `${ctx}.drillTo`), asDimensionId(raw['drillTo']))
      : undefined;
    return { type, ...base, groupBy, ...(drillTo === undefined ? {} : { drillTo }) };
  }
  if (type === 'pie') return { type, ...base, groupBy };
  return { type, ...base, groupBy };
}

function validateTopNWidget(raw: Record<string, unknown>, ctx: string, base: WidgetBase, type: 'line' | 'topNBar' | 'heatmap'): WidgetSpec {
  assertString(raw['groupBy'], `${ctx}.groupBy`);
  let topN: number | undefined;
  if (raw['topN'] !== undefined) {
    assertNumber(raw['topN'], `${ctx}.topN`);
    topN = raw['topN'];
  }
  return { type, ...base, groupBy: asDimensionId(raw['groupBy']), ...(topN === undefined ? {} : { topN }) };
}

function validateTableWidget(raw: Record<string, unknown>, ctx: string, base: WidgetBase): WidgetSpec {
  let enabledColumns: string[] | undefined;
  if (raw['enabledColumns'] !== undefined) {
    assertArray(raw['enabledColumns'], `${ctx}.enabledColumns`);
    enabledColumns = raw['enabledColumns'].map((c, i) => {
      assertString(c, `${ctx}.enabledColumns[${String(i)}]`);
      return c;
    });
  }
  return { type: 'table', ...base, ...(enabledColumns === undefined ? {} : { enabledColumns }) };
}

function validateWidget(raw: unknown, ctx: string): WidgetSpec {
  assertObject(raw, ctx);
  const base = parseWidgetBase(raw, ctx);
  assertString(raw['type'], `${ctx}.type`);
  const type = raw['type'] as WidgetType;

  switch (type) {
    case 'summary':
      return validateSummaryWidget(raw, ctx, base);
    case 'pie':
    case 'stackedBar':
    case 'bubble':
    case 'treemap':
      return validateGroupByWidget(raw, ctx, base, type);
    case 'line':
    case 'topNBar':
    case 'heatmap':
      return validateTopNWidget(raw, ctx, base, type);
    case 'table':
      return validateTableWidget(raw, ctx, base);
  }
}

function validateView(raw: unknown, ctx: string): ViewSpec {
  assertObject(raw, ctx);
  assertString(raw['id'], `${ctx}.id`);
  assertString(raw['name'], `${ctx}.name`);
  assertArray(raw['rows'], `${ctx}.rows`);

  const icon = raw['icon'] === undefined
    ? undefined
    : (assertString(raw['icon'], `${ctx}.icon`), raw['icon']);
  const builtIn = raw['builtIn'] === true || undefined;

  const rows = raw['rows'].map((rowRaw, i) => {
    assertObject(rowRaw, `${ctx}.rows[${String(i)}]`);
    assertArray(rowRaw['widgets'], `${ctx}.rows[${String(i)}].widgets`);
    const widgets = rowRaw['widgets'].map((w, j) =>
      validateWidget(w, `${ctx}.rows[${String(i)}].widgets[${String(j)}]`),
    );
    return { widgets };
  });

  const seenIds = new Set<string>();
  for (const row of rows) {
    for (const w of row.widgets) {
      if (seenIds.has(w.id)) {
        throw new ConfigValidationError(`${ctx}: duplicate widget id "${w.id}"`);
      }
      seenIds.add(w.id);
    }
  }

  return {
    id: raw['id'],
    name: raw['name'],
    ...(icon === undefined ? {} : { icon }),
    ...(builtIn === true ? { builtIn } : {}),
    rows,
  };
}

export function validateViews(raw: unknown): ViewsConfig {
  assertObject(raw, 'views config');
  assertArray(raw['views'], 'views');
  const views = raw['views'].map((v, i) => validateView(v, `views[${String(i)}]`));
  const seenViewIds = new Set<string>();
  for (const v of views) {
    if (seenViewIds.has(v.id)) {
      throw new ConfigValidationError(`duplicate view id "${v.id}"`);
    }
    seenViewIds.add(v.id);
  }
  return { views };
}
