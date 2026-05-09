import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils.js';
import type { AnomalySeverity } from '@costgoblin/core';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      severity: {
        high: 'border-transparent bg-negative text-white',
        medium: 'border-transparent bg-orange-500 text-white',
        low: 'border-transparent bg-yellow-500 text-white',
      },
    },
    defaultVariants: {
      severity: 'low',
    },
  },
);

export interface AnomalyBadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * Anomaly severity level
   */
  severity: AnomalySeverity;
  /**
   * Optional count to display in the badge
   */
  count?: number | undefined;
}

/**
 * Badge component for displaying anomaly alerts with severity levels.
 * Used to highlight entities with detected cost anomalies in the UI.
 */
export const AnomalyBadge = React.forwardRef<HTMLDivElement, AnomalyBadgeProps>(
  ({ className, severity, count, children, ...props }, ref) => {
    const displayContent = children ?? (count !== undefined ? `${count}` : '!');

    return (
      <div
        ref={ref}
        className={cn(badgeVariants({ severity }), className)}
        role="status"
        aria-label={`${severity} severity anomaly${count !== undefined ? `: ${count} detected` : ''}`}
        {...props}
      >
        {displayContent}
      </div>
    );
  },
);

AnomalyBadge.displayName = 'AnomalyBadge';

export { badgeVariants };
