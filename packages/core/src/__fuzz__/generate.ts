/**
 * Case generators for the query fuzzer.
 *
 * Each generator returns a type-valid params object (built through the branded
 * constructors) together with `intendedValid`: whether every *identifier* and
 * *date* in the case is well-formed. Filter values, entity refs, and org-node
 * values may be hostile even in an `intendedValid` case — they are bound as SQL
 * parameters, so a well-built query should still execute and return rows with
 * the expected columns. `intendedValid` therefore predicts "should execute
 * cleanly", which drives both the productivity sanity-check and the injection
 * oracle in the harness.
 */
import {
  asDateString,
  asDimensionId,
  asEntityRef,
  asHourString,
  asTagValue,
} from '../types/branded.js';
import type { DimensionId, TagValue } from '../types/branded.js';
import type {
  CostQueryParams,
  DailyCostsParams,
  DateRange,
  EntityDetailParams,
  FilterMap,
  Granularity,
} from '../types/query.js';

import {
  FILTER_VALUES,
  HOSTILE_DATES,
  HOSTILE_DIMENSION_IDS,
  HOSTILE_HOURS,
} from './corpus.js';
import { VALID_DIMENSION_IDS } from './fixture-config.js';
import { chance, intBetween, pick, sample, type Rng } from './prng.js';

export type FuzzCase =
  | { readonly kind: 'cost'; readonly intendedValid: boolean; readonly params: CostQueryParams }
  | { readonly kind: 'daily'; readonly intendedValid: boolean; readonly params: DailyCostsParams }
  | { readonly kind: 'entity'; readonly intendedValid: boolean; readonly params: EntityDetailParams };

/** Whole-day dates that exist in the fixture window (well-formed, in range). */
const VALID_DATES: readonly string[] = [
  '2026-01-01', '2026-01-15', '2026-01-31',
  '2026-02-01', '2026-02-14', '2026-02-28',
];

/** Valid + hostile dates, precomputed once (the hostile path samples from it). */
const ALL_DATES: readonly string[] = [...VALID_DATES, ...HOSTILE_DATES];

interface GenDim {
  readonly id: DimensionId;
  readonly valid: boolean;
}

function genDimensionId(rng: Rng): GenDim {
  if (chance(rng, 0.7)) {
    return { id: pick(rng, VALID_DIMENSION_IDS), valid: true };
  }
  return { id: asDimensionId(pick(rng, HOSTILE_DIMENSION_IDS)), valid: false };
}

interface GenRange {
  readonly range: DateRange;
  readonly valid: boolean;
  readonly forcesHourly: boolean;
}

function genDateRange(rng: Rng): GenRange {
  // ~20% of ranges add a sub-day hour window, which forces hourly granularity.
  if (chance(rng, 0.2)) {
    const startHourStr = pick(rng, HOSTILE_HOURS);
    const endHourStr = pick(rng, HOSTILE_HOURS);
    const hoursValid = isValidHour(startHourStr) && isValidHour(endHourStr);
    const range: DateRange = {
      start: asDateString('2026-02-01'),
      end: asDateString('2026-02-28'),
      startHour: asHourString(startHourStr),
      endHour: asHourString(endHourStr),
    };
    return { range, valid: hoursValid, forcesHourly: true };
  }

  const useValid = chance(rng, 0.7);
  if (useValid) {
    // Order the two valid endpoints so the range spans real on-disk months and
    // reliably executes — reversed/empty ranges are covered by the hostile path.
    const p = pick(rng, VALID_DATES);
    const q = pick(rng, VALID_DATES);
    const [a, b] = p <= q ? [p, q] : [q, p];
    const range: DateRange = { start: asDateString(a), end: asDateString(b) };
    return { range, valid: true, forcesHourly: false };
  }
  const startStr = pick(rng, ALL_DATES);
  const endStr = pick(rng, ALL_DATES);
  const range: DateRange = { start: asDateString(startStr), end: asDateString(endStr) };
  return { range, valid: isValidDate(startStr) && isValidDate(endStr), forcesHourly: false };
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HOUR_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):00:00$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Format AND calendar valid — rejects impossible days (Feb 30, Apr 31) so an
 *  intendedValid case isn't mislabelled when DuckDB would reject the date. */
function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}
function isValidHour(value: string): boolean { return HOUR_RE.test(value); }

interface GenFilters {
  readonly filters: FilterMap;
  readonly valid: boolean;
}

function genFilters(rng: Rng): GenFilters {
  const count = intBetween(rng, 0, 3);
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  let valid = true;
  for (let i = 0; i < count; i++) {
    const dim = genDimensionId(rng);
    if (!dim.valid) valid = false;
    // Occasionally a huge value list to stress parameter count / SQL length.
    const valueCount = chance(rng, 0.05) ? intBetween(rng, 200, 800) : intBetween(rng, 1, 4);
    const values = sample(rng, FILTER_VALUES, valueCount).map(asTagValue);
    filters[dim.id] = values;
  }
  return { filters, valid };
}

function genGranularity(rng: Rng, forcesHourly: boolean): Granularity | undefined {
  if (forcesHourly) return 'hourly';
  const roll = rng();
  if (roll < 0.4) return 'daily';
  if (roll < 0.8) return 'hourly';
  return undefined;
}

function genOrgNodeValues(rng: Rng): readonly string[] | undefined {
  if (!chance(rng, 0.2)) return undefined;
  return sample(rng, FILTER_VALUES, intBetween(rng, 1, 5));
}

function genCost(rng: Rng): FuzzCase {
  const gb = genDimensionId(rng);
  const dr = genDateRange(rng);
  const fl = genFilters(rng);
  const params: CostQueryParams = {
    groupBy: gb.id,
    dateRange: dr.range,
    filters: fl.filters,
    granularity: genGranularity(rng, dr.forcesHourly),
    orgNodeValues: genOrgNodeValues(rng),
    origin: 'fuzz:cost',
  };
  return { kind: 'cost', intendedValid: gb.valid && dr.valid && fl.valid, params };
}

function genDaily(rng: Rng): FuzzCase {
  const gb = genDimensionId(rng);
  const dr = genDateRange(rng);
  const fl = genFilters(rng);
  const params: DailyCostsParams = {
    groupBy: gb.id,
    dateRange: dr.range,
    filters: fl.filters,
    granularity: genGranularity(rng, dr.forcesHourly),
    origin: 'fuzz:daily',
  };
  return { kind: 'daily', intendedValid: gb.valid && dr.valid && fl.valid, params };
}

function genEntity(rng: Rng): FuzzCase {
  const dim = genDimensionId(rng);
  const dr = genDateRange(rng);
  const fl = genFilters(rng);
  const params: EntityDetailParams = {
    entity: asEntityRef(pick(rng, FILTER_VALUES)),
    dimension: dim.id,
    dateRange: dr.range,
    filters: fl.filters,
    granularity: genGranularity(rng, dr.forcesHourly),
    origin: 'fuzz:entity',
  };
  return { kind: 'entity', intendedValid: dim.valid && dr.valid && fl.valid, params };
}

/** Generate one random case (cost / daily / entity-detail). */
export function generateCase(rng: Rng): FuzzCase {
  const roll = rng();
  if (roll < 0.5) return genCost(rng);
  if (roll < 0.8) return genDaily(rng);
  return genEntity(rng);
}
