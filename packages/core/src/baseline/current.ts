import type { BaselineCurrent, BaselineDailyPoint } from '../types/baseline.js';
import { asDollars } from '../types/branded.js';
import { mean } from './stats.js';

/** Average daily cost over the most recent `windowDays` of the series. Returns
 *  null for an empty series. The series is sorted by date so callers need not
 *  pre-sort. */
export function computeCurrent(series: readonly BaselineDailyPoint[], windowDays: number): BaselineCurrent | null {
  if (series.length === 0) return null;
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const window = sorted.slice(Math.max(0, sorted.length - Math.max(1, windowDays)));
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    avgDaily: asDollars(mean(window.map((p) => p.cost))),
    windowStart: first.date,
    windowEnd: last.date,
    days: window.length,
  };
}
