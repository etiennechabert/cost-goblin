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

function validateWidget(raw: unknown, ctx: string): WidgetSpec {
  assertObject(raw, ctx);
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

  const id = raw['id'];
  const type = raw['type'];
  const size = raw['size'];
  const title = raw['title'] !== undefined ? (assertString(raw['title'], `${ctx}.title`), raw['title']) : undefined;
  const filters = validateFilters(raw['filters'], `${ctx}.filters`);

  const base = {
    id,
    size,
    ...(title !== undefined ? { title } : {}),
    ...(filters !== undefined ? { filters } : {}),
  };

  switch (type) {
    case 'summary': {
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
      return { type, ...base, ...(metric !== undefined ? { metric } : {}) };
    }
    case 'pie': {
      assertString(raw['groupBy'], `${ctx}.groupBy`);
      return { type, ...base, groupBy: asDimensionId(raw['groupBy']) };
    }
    case 'stackedBar':
    case 'bubble':
    case 'treemap': {
      assertString(raw['groupBy'], `${ctx}.groupBy`);
      const drillTo = type === 'treemap' && raw['drillTo'] !== undefined
        ? (assertString(raw['drillTo'], `${ctx}.drillTo`), asDimensionId(raw['drillTo']))
        : undefined;
      const groupBy = asDimensionId(raw['groupBy']);
      if (type === 'treemap') {
        return { type, ...base, groupBy, ...(drillTo !== undefined ? { drillTo } : {}) };
      }
      return { type, ...base, groupBy };
    }
    case 'line':
    case 'topNBar':
    case 'heatmap': {
      assertString(raw['groupBy'], `${ctx}.groupBy`);
      let topN: number | undefined;
      if (raw['topN'] !== undefined) {
        assertNumber(raw['topN'], `${ctx}.topN`);
        topN = raw['topN'];
      }
      return {
        type,
        ...base,
        groupBy: asDimensionId(raw['groupBy']),
        ...(topN !== undefined ? { topN } : {}),
      };
    }
    case 'table': {
      let hiddenColumns: string[] | undefined;
      if (raw['hiddenColumns'] !== undefined) {
        assertArray(raw['hiddenColumns'], `${ctx}.hiddenColumns`);
        hiddenColumns = raw['hiddenColumns'].map((c, i) => {
          assertString(c, `${ctx}.hiddenColumns[${String(i)}]`);
          return c;
        });
      }
      let columnOrder: string[] | undefined;
      if (raw['columnOrder'] !== undefined) {
        assertArray(raw['columnOrder'], `${ctx}.columnOrder`);
        columnOrder = raw['columnOrder'].map((c, i) => {
          assertString(c, `${ctx}.columnOrder[${String(i)}]`);
          return c;
        });
      }
      return {
        type,
        ...base,
        ...(hiddenColumns !== undefined ? { hiddenColumns } : {}),
        ...(columnOrder !== undefined ? { columnOrder } : {}),
      };
    }
  }
}

function validateView(raw: unknown, ctx: string): ViewSpec {
  assertObject(raw, ctx);
  assertString(raw['id'], `${ctx}.id`);
  assertString(raw['name'], `${ctx}.name`);
  assertArray(raw['rows'], `${ctx}.rows`);

  const icon = raw['icon'] !== undefined
    ? (assertString(raw['icon'], `${ctx}.icon`), raw['icon'])
    : undefined;
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
    ...(icon !== undefined ? { icon } : {}),
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
