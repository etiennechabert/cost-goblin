/** Detection runs against a 30-day baseline at 2σ — pulling these into one
 *  module keeps the dashboard, the modal's daily-trend query, and the off-toggle
 *  default in agreement, since the modal must mirror what generated the alert. */
export const ANOMALY_LOOKBACK_DAYS = 30;
export const ANOMALY_STDDEV_THRESHOLD = 2;
