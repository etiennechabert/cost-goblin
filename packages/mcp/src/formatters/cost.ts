export function formatDollars(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return 'N/A';
  const sign = pct > 0 ? '+' : '';
  if (Math.abs(pct) >= 100) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatDelta(amount: number): string {
  const sign = amount > 0 ? '+' : '';
  return `${sign}${formatDollars(amount)}`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function truncateRows<T>(
  rows: readonly T[],
  limit: number,
  costFn: (row: T) => number,
): { visible: readonly T[]; hiddenCount: number; hiddenCost: number } {
  if (rows.length <= limit) {
    return { visible: rows, hiddenCount: 0, hiddenCost: 0 };
  }
  const visible = rows.slice(0, limit);
  const hidden = rows.slice(limit);
  const hiddenCost = hidden.reduce((sum, r) => sum + costFn(r), 0);
  return { visible, hiddenCount: hidden.length, hiddenCost };
}

export function truncateFooter(hiddenCount: number, hiddenCost: number): string {
  if (hiddenCount === 0) return '';
  return `\n*...and ${String(hiddenCount)} more totaling ${formatDollars(hiddenCost)}*`;
}
