import { readFile, writeFile } from 'node:fs/promises';
import {
  DEFAULT_EXPLORER_HIDDEN_COLUMNS,
  asDateString,
  asHourString,
  isDateString,
  isHourString,
  isStringRecord,
  migrateLegacyDimensionId,
  parseJsonObject,
} from '@costgoblin/core';
import type { ExplorerPreferences, ExplorerPreferencesUpdate } from '@costgoblin/core';

function isDateRange(
  value: unknown,
): value is { start: string; end: string; startHour?: string; endHour?: string } {
  if (!isStringRecord(value)) return false;
  if (typeof value['start'] !== 'string' || typeof value['end'] !== 'string') return false;
  if (value['startHour'] !== undefined && typeof value['startHour'] !== 'string') return false;
  if (value['endHour'] !== undefined && typeof value['endHour'] !== 'string') return false;
  return true;
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
  // Only pay for the dimensions load when there is actually an id to migrate
  // (the "Show all" / empty / corrupt cases have nothing to rename).
  const needsMigration =
    (isStringArray(rawHidden) && rawHidden.length > 0) ||
    (isStringArray(rawOrder) && rawOrder.length > 0);
  const liveIds = needsMigration ? await loadLiveIds() : undefined;
  const hiddenColumns = isStringArray(rawHidden)
    ? rawHidden.map(id => migrateLegacyDimensionId(id, liveIds))
    : [...DEFAULT_EXPLORER_HIDDEN_COLUMNS];
  const columnOrder = isStringArray(rawOrder)
    ? rawOrder.map(id => migrateLegacyDimensionId(id, liveIds))
    : [];

  const validDateRange =
    isDateRange(rawDateRange) && isDateString(rawDateRange.start) && isDateString(rawDateRange.end)
      ? {
          start: asDateString(rawDateRange.start),
          end: asDateString(rawDateRange.end),
          // Preserve a persisted hourly sub-window, but only atomically —
          // both bounds must be well-formed HourStrings, else fall back to
          // the whole-day range (the view writes the pair together).
          ...(rawDateRange.startHour !== undefined &&
            rawDateRange.endHour !== undefined &&
            isHourString(rawDateRange.startHour) &&
            isHourString(rawDateRange.endHour) && {
              startHour: asHourString(rawDateRange.startHour),
              endHour: asHourString(rawDateRange.endHour),
            }),
        }
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

/** Persist an Explorer preferences update by MERGING it onto whatever is
 *  already on disk, then writing the result back.
 *
 *  The Explorer, EntityDetail, and CustomView views share this one file.
 *  Only the Explorer manages column visibility; the other two persist just a
 *  date range / granularity and omit `hiddenColumns` / `columnOrder`. Merging
 *  (rather than overwriting) means those views can't clobber the user's
 *  curated column set — the classic failure being a date-range save writing
 *  `hiddenColumns: []`, which `readExplorerPreferences` reads back as the
 *  explicit "Show all" and reveals every column.
 *
 *  The merge is over the raw persisted JSON: CUR-era column ids are migrated
 *  on READ (`readExplorerPreferences`), so carrying the raw on-disk values
 *  forward untouched here is safe — and it also preserves any field this
 *  build doesn't know about. */
export async function writeExplorerPreferences(
  filePath: string,
  update: ExplorerPreferencesUpdate,
): Promise<void> {
  let existing: Readonly<Record<string, unknown>> = {};
  try {
    const parsed = parseJsonObject(await readFile(filePath, 'utf-8'));
    if (parsed !== null) existing = parsed;
  } catch {
    // No file yet (or unreadable) — nothing to preserve; write the update as-is.
  }
  const merged = { ...existing, ...update };
  await writeFile(filePath, JSON.stringify(merged, null, 2));
}
