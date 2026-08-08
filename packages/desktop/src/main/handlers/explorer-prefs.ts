import { readFile } from 'node:fs/promises';
import {
  DEFAULT_EXPLORER_HIDDEN_COLUMNS,
  asDateString,
  isStringRecord,
  migrateLegacyDimensionId,
  parseJsonObject,
} from '@costgoblin/core';
import type { ExplorerPreferences } from '@costgoblin/core';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateRange(value: unknown): value is { start: string; end: string } {
  if (!isStringRecord(value)) return false;
  return typeof value['start'] === 'string' && typeof value['end'] === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v): v is string => typeof v === 'string');
}

function firstRunPreferences(): ExplorerPreferences {
  return { hiddenColumns: [...DEFAULT_EXPLORER_HIDDEN_COLUMNS], columnOrder: [] };
}

/** Load the persisted Explorer preferences from `filePath`.
 *
 *  First-run contract: when the file is missing or unreadable — or its
 *  `hiddenColumns` field is malformed — the default hidden set applies, so a
 *  fresh profile opens the Explorer with the curated column subset rather
 *  than all ~16 columns. A persisted `hiddenColumns: []` is different: that's
 *  the user's explicit "Show all" and is returned as-is.
 *
 *  `loadLiveIds` supplies the current dimension ids for the CUR-era id
 *  migration (#515); it is only invoked once the file has been read. */
export async function readExplorerPreferences(
  filePath: string,
  loadLiveIds: () => Promise<ReadonlySet<string> | undefined>,
): Promise<ExplorerPreferences> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    // file doesn't exist yet — first-run defaults
    return firstRunPreferences();
  }
  const obj = parseJsonObject(raw);
  const rawHidden = obj?.['hiddenColumns'];
  const rawOrder = obj?.['columnOrder'];
  const rawDateRange = obj?.['lastUsedDateRange'];
  const rawGranularity = obj?.['lastUsedGranularity'];

  // Persisted prefs may carry CUR-era column ids (#515) — rename them so
  // saved layouts survive the FOCUS migration. Live dimension ids are
  // exempt (a current tag key like `user:team` derives a `tag_user_*` id).
  const liveIds = await loadLiveIds();
  const hiddenColumns = isStringArray(rawHidden)
    ? rawHidden.map(id => migrateLegacyDimensionId(id, liveIds))
    : [...DEFAULT_EXPLORER_HIDDEN_COLUMNS];
  const columnOrder = isStringArray(rawOrder)
    ? rawOrder.map(id => migrateLegacyDimensionId(id, liveIds))
    : [];

  const validDateRange =
    isDateRange(rawDateRange) && ISO_DATE_RE.test(rawDateRange.start) && ISO_DATE_RE.test(rawDateRange.end)
      ? { start: asDateString(rawDateRange.start), end: asDateString(rawDateRange.end) }
      : null;

  // Validate lastUsedGranularity: must be 'daily' or 'hourly'
  const validGranularity =
    rawGranularity === 'daily' || rawGranularity === 'hourly' ? rawGranularity : null;

  const rawCompare = obj?.['compareEnabled'];
  const compareEnabled = rawCompare === true ? true : undefined;

  return {
    hiddenColumns,
    columnOrder,
    ...(validDateRange !== null && { lastUsedDateRange: validDateRange }),
    ...(validGranularity !== null && { lastUsedGranularity: validGranularity }),
    ...(compareEnabled !== undefined && { compareEnabled }),
  };
}
