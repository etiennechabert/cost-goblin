import type { DimensionId } from './branded.js';

export type WidgetSize = 'small' | 'medium' | 'large' | 'full';

export type SummaryMetric = 'total' | 'delta' | 'topEntity' | 'entityCount';

interface WidgetBase {
  readonly id: string;
  readonly title?: string | undefined;
  readonly size: WidgetSize;
}

export type WidgetSpec =
  | (WidgetBase & {
      readonly type: 'summary';
      readonly metric?: SummaryMetric | undefined;
    })
  | (WidgetBase & {
      readonly type: 'pie';
      readonly groupBy: DimensionId;
      readonly showLegend?: boolean | undefined;
    })
  | (WidgetBase & {
      readonly type: 'stackedBar';
      readonly groupBy: DimensionId;
    })
  | (WidgetBase & {
      readonly type: 'line';
      readonly groupBy: DimensionId;
      readonly topN?: number | undefined;
    })
  | (WidgetBase & {
      readonly type: 'topNBar';
      readonly groupBy: DimensionId;
      readonly topN?: number | undefined;
    })
  | (WidgetBase & {
      readonly type: 'treemap';
      readonly groupBy: DimensionId;
      readonly drillTo?: DimensionId | undefined;
    })
  | (WidgetBase & {
      readonly type: 'heatmap';
      readonly groupBy: DimensionId;
      readonly topN?: number | undefined;
    })
  | (WidgetBase & {
      readonly type: 'bubble';
      readonly groupBy: DimensionId;
      /** `'linear'` selects `scaleLinear`. A number is the symlog
       *  "linearization constant" — defaults to 10 when unset. */
      readonly logScale?: number | 'linear' | undefined;
      /** Minimum absolute $ delta for a group to appear. Defaults to 0. */
      readonly deltaThreshold?: number | undefined;
      /** Minimum absolute % change for a group to appear. Defaults to 0. */
      readonly percentThreshold?: number | undefined;
    })
  | (WidgetBase & {
      readonly type: 'table';
      readonly enabledColumns?: readonly string[] | undefined;
    });

export type WidgetType = WidgetSpec['type'];

export interface ViewRow {
  readonly widgets: readonly WidgetSpec[];
}

export interface ViewSpec {
  readonly id: string;
  readonly name: string;
  readonly icon?: string | undefined;
  /** Built-in seed view. The user can duplicate/clone but not delete. */
  readonly builtIn?: boolean | undefined;
  readonly rows: readonly ViewRow[];
}

export interface ViewsConfig {
  readonly views: readonly ViewSpec[];
}
