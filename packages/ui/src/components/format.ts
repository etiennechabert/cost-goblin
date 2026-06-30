export function formatDollars(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `$${(amount / 1_000).toFixed(1)}k`;
  }
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Currency with an explicit leading sign, e.g. "+$1.2k". */
export function signedDollars(amount: number): string {
  return `${amount >= 0 ? '+' : ''}${formatDollars(amount)}`;
}

/** Truncate with a trailing ellipsis when longer than `max`. */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  let digits = unit === 0 || value >= 100 ? 0 : 1;
  // Rounding can push e.g. 1023.7 MB to "1024 MB"; roll over to the next unit.
  if (Number(value.toFixed(digits)) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
    digits = value >= 100 ? 0 : 1;
  }
  const label = units[unit] ?? 'B';
  return `${value.toFixed(digits)} ${label}`;
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** Compact "time since" label for last-sync timestamps: relative for recent
 *  syncs ("just now", "5m ago", "3h ago", "2d ago"), absolute date beyond a
 *  week. Accepts an ISO 8601 string or a Date (Electron IPC preserves Dates). */
export function formatRelativeTime(value: string | Date, now: number = Date.now()): string {
  const then = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = now - then;
  if (diffMs < 45_000) return 'just now';
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.round(diffMs / 3_600_000);
  if (hr < 24) return `${String(hr)}h ago`;
  const day = Math.round(diffMs / 86_400_000);
  if (day < 7) return `${String(day)}d ago`;
  return (value instanceof Date ? value : new Date(value)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return date;
  }
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
