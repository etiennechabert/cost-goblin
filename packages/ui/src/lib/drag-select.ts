import type { Granularity } from '../components/date-range-picker.js';
import { daysBetween } from './dates.js';

const HOURLY_THRESHOLD_DAYS = 7;

export function pixelToIndex(x: number, containerWidth: number, bucketCount: number): number {
  if (bucketCount <= 0 || containerWidth <= 0) return 0;
  const slot = containerWidth / bucketCount;
  const idx = Math.floor(x / slot);
  if (idx < 0) return 0;
  if (idx >= bucketCount) return bucketCount - 1;
  return idx;
}

export function bucketKeyToDate(key: string): string {
  return key.length >= 10 ? key.slice(0, 10) : key;
}

export function shouldAutoSwitchToHourly(
  startDate: string,
  endDate: string,
  currentGranularity: Granularity,
): boolean {
  if (currentGranularity !== 'daily') return false;
  return daysBetween(startDate, endDate) <= HOURLY_THRESHOLD_DAYS;
}
