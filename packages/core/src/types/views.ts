import type { DimensionId, TagValue } from './branded.js';

export type WidgetId = string;
export type ViewId = string;

export type WidgetSize = 'small' | 'medium' | 'large' | 'full';

/** Extra filter overlay applied on top of the view's global FilterBar. The
 *  widget's own filters compose via object spread; widget filters win on key
 *  conflict so the global bar stays the user's primary control. */
export type WidgetFilterOverlay = Readonly<Partial<Record<DimensionId, TagValue>>>;

export type SummaryMetric = 'total' | 'delta' | 'topEntity' | 'entityCount';

export type TableColumn =
  | 'entity'
  | 'cost'
  | 'percentage'
  | 'topService'
  | 'previousCost'
  | 'delta'
  | 'percentChange';

interface WidgetBase {
  readonly id: WidgetId;
  readonly title?: string | undefined;
  readonly size: WidgetSize;
  readonly filters?: WidgetFilterOverlay | undefined;
}

export type WidgetSpec =
  | (WidgetBase & {
      readonly type: 'summary';
      readonly metric?: SummaryMetric | undefined;
    })
  | (WidgetBase & {
      readonly type: 'pie';
      readonly groupBy: DimensionId;
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
    })
  | (WidgetBase & {
      readonly type: 'table';
      readonly groupBy: DimensionId;
      readonly columns?: readonly TableColumn[] | undefined;
      readonly topN?: number | undefined;
    });

export type WidgetType = WidgetSpec['type'];

export interface ViewRow {
  readonly widgets: readonly WidgetSpec[];
}

export interface ViewSpec {
  readonly id: ViewId;
  readonly name: string;
  readonly icon?: string | undefined;
  /** Built-in seed view. The user can duplicate/clone but not delete. */
  readonly builtIn?: boolean | undefined;
  readonly rows: readonly ViewRow[];
}

export interface ViewsConfig {
  readonly views: readonly ViewSpec[];
}
