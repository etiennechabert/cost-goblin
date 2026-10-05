/** Parsing for the Explorer's IPC payloads. Kept in its own module (no
 *  electron import) so it is unit-testable without the main process.
 *
 *  The renderer is not trusted: each handler parses its `unknown` payload here
 *  and uses only the returned object, so a malformed payload is refused with a
 *  TypeError at the boundary instead of failing deep in SQL building (#479). */

import {
  COST_METRICS,
  asDateString,
  asHourString,
  isDateString,
  isHourString,
  isStringArray,
  isStringRecord,
} from '@costgoblin/core';
import type {
  AggregatedTableParams,
  CostMetric,
  DateRange,
  ExplorerBaseParams,
  ExplorerFilterMap,
  ExplorerFilterValuesParams,
  ExplorerOverviewParams,
  ExplorerRowsParams,
  ExplorerSort,
  Granularity,
} from '@costgoblin/core';

type Payload = Readonly<Record<string, unknown>>;

function parsePayload(value: unknown, channel: string): Payload {
  if (!isStringRecord(value)) throw new TypeError(`${channel} expects an object payload`);
  return value;
}

function parseFilters(value: unknown, channel: string): ExplorerFilterMap {
  if (!isStringRecord(value)) throw new TypeError(`${channel}: filters must be an object of string arrays`);
  const filters: Record<string, readonly string[]> = {};
  for (const [dimId, values] of Object.entries(value)) {
    if (!isStringArray(values)) throw new TypeError(`${channel}: filters.${dimId} must be an array of strings`);
    filters[dimId] = values;
  }
  return filters;
}

/** A structurally bad range is refused. Malformed date strings are dropped
 *  instead, so the handler falls back to its default window, as it always
 *  did; hour bounds are kept only when both are well-formed. */
function parseDateRange(value: unknown, channel: string): DateRange | undefined {
  if (value === undefined) return undefined;
  if (!isStringRecord(value)) throw new TypeError(`${channel}: dateRange must be an object`);
  const { start, end, startHour, endHour } = value;
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new TypeError(`${channel}: dateRange.start and dateRange.end must be strings`);
  }
  if ((startHour !== undefined && typeof startHour !== 'string') || (endHour !== undefined && typeof endHour !== 'string')) {
    throw new TypeError(`${channel}: dateRange.startHour and dateRange.endHour must be strings`);
  }
  if (!isDateString(start) || !isDateString(end)) return undefined;
  const range = { start: asDateString(start), end: asDateString(end) };
  if (typeof startHour === 'string' && typeof endHour === 'string' && isHourString(startHour) && isHourString(endHour)) {
    return { ...range, startHour: asHourString(startHour), endHour: asHourString(endHour) };
  }
  return range;
}

function parseGranularity(value: unknown, channel: string): Granularity | undefined {
  if (value === undefined || value === 'daily' || value === 'hourly') return value;
  throw new TypeError(`${channel}: granularity must be 'daily' or 'hourly'`);
}

function parseCostMetric(value: unknown, channel: string): CostMetric | undefined {
  if (value === undefined) return undefined;
  const metric = COST_METRICS.find(m => m === value);
  if (metric === undefined) throw new TypeError(`${channel}: costMetric must be one of ${COST_METRICS.join(', ')}`);
  return metric;
}

function parseOptionalBoolean(value: unknown, field: string, channel: string): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  throw new TypeError(`${channel}: ${field} must be a boolean`);
}

function parseOptionalString(value: unknown, field: string, channel: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new TypeError(`${channel}: ${field} must be a string`);
}

/** Any number: the handlers clamp the range (a non-finite limit falls back to
 *  their default), so only the type is checked here. */
function parseRowLimit(value: unknown, channel: string): number {
  if (typeof value !== 'number') throw new TypeError(`${channel}: rowLimit must be a number`);
  return value;
}

function parseSort(value: unknown, channel: string): ExplorerSort | undefined {
  if (value === undefined) return undefined;
  if (!isStringRecord(value)) throw new TypeError(`${channel}: sort must be an object`);
  const { column, direction } = value;
  if (typeof column !== 'string') throw new TypeError(`${channel}: sort.column must be a string`);
  if (direction !== 'asc' && direction !== 'desc') throw new TypeError(`${channel}: sort.direction must be 'asc' or 'desc'`);
  return { column, direction };
}

function parseRowFilters(value: unknown, channel: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isStringRecord(value)) throw new TypeError(`${channel}: rowFilters must be an object of strings`);
  const rowFilters: Record<string, string> = {};
  for (const [col, val] of Object.entries(value)) {
    if (typeof val !== 'string') throw new TypeError(`${channel}: rowFilters.${col} must be a string`);
    rowFilters[col] = val;
  }
  return rowFilters;
}

function parseBase(payload: Payload, channel: string): ExplorerBaseParams {
  const dateRange = parseDateRange(payload['dateRange'], channel);
  const granularity = parseGranularity(payload['granularity'], channel);
  const applyCostScope = parseOptionalBoolean(payload['applyCostScope'], 'applyCostScope', channel);
  const costMetric = parseCostMetric(payload['costMetric'], channel);
  const origin = parseOptionalString(payload['origin'], 'origin', channel);
  return {
    filters: parseFilters(payload['filters'], channel),
    ...(dateRange === undefined ? {} : { dateRange }),
    ...(granularity === undefined ? {} : { granularity }),
    ...(applyCostScope === undefined ? {} : { applyCostScope }),
    ...(costMetric === undefined ? {} : { costMetric }),
    ...(origin === undefined ? {} : { origin }),
  };
}

export function parseExplorerOverviewParams(payload: unknown): ExplorerOverviewParams {
  const channel = 'explorer:query-overview';
  return parseBase(parsePayload(payload, channel), channel);
}

export function parseExplorerRowsParams(payload: unknown): ExplorerRowsParams {
  const channel = 'explorer:query-rows';
  const raw = parsePayload(payload, channel);
  const sort = parseSort(raw['sort'], channel);
  return {
    ...parseBase(raw, channel),
    ...(sort === undefined ? {} : { sort }),
    rowLimit: parseRowLimit(raw['rowLimit'], channel),
  };
}

export function parseAggregatedTableParams(payload: unknown): AggregatedTableParams {
  const channel = 'explorer:query-aggregated-table';
  const raw = parsePayload(payload, channel);
  const groupByColumns = raw['groupByColumns'];
  if (!isStringArray(groupByColumns)) throw new TypeError(`${channel}: groupByColumns must be an array of strings`);
  const sort = parseSort(raw['sort'], channel);
  const rowFilters = parseRowFilters(raw['rowFilters'], channel);
  return {
    ...parseBase(raw, channel),
    groupByColumns,
    ...(sort === undefined ? {} : { sort }),
    rowLimit: parseRowLimit(raw['rowLimit'], channel),
    ...(rowFilters === undefined ? {} : { rowFilters }),
  };
}

export function parseExplorerFilterValuesParams(payload: unknown): ExplorerFilterValuesParams {
  const channel = 'explorer:filter-values';
  const raw = parsePayload(payload, channel);
  const dimensionId = raw['dimensionId'];
  if (typeof dimensionId !== 'string') throw new TypeError(`${channel}: dimensionId must be a string`);
  return { ...parseBase(raw, channel), dimensionId };
}
