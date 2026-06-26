export function formatDollars(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `$${(amount / 1_000).toFixed(1)}k`;
  }
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
