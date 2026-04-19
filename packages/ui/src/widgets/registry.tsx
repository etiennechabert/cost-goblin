import type { WidgetType } from '@costgoblin/core/browser';
import type { WidgetComponent } from './widget.js';
import { SummaryWidget } from './summary-widget.js';
import { PieWidget } from './pie-widget.js';
import { StackedBarWidget } from './stacked-bar-widget.js';
import { TopNBarWidget } from './top-n-bar-widget.js';
import { LineWidget } from './line-widget.js';
import { TreemapWidget } from './treemap-widget.js';
import { HeatmapWidget } from './heatmap-widget.js';
import { BubbleWidget } from './bubble-widget.js';
import { TableWidget } from './table-widget.js';

export const WIDGET_REGISTRY: Readonly<Record<WidgetType, WidgetComponent>> = {
  summary: SummaryWidget,
  pie: PieWidget,
  stackedBar: StackedBarWidget,
  topNBar: TopNBarWidget,
  line: LineWidget,
  treemap: TreemapWidget,
  heatmap: HeatmapWidget,
  bubble: BubbleWidget,
  table: TableWidget,
};

export interface WidgetCatalogEntry {
  readonly type: WidgetType;
  readonly label: string;
  readonly description: string;
  /** Widgets that have a `groupBy` field — used by the editor to know whether
   *  to show a dimension picker for this type. */
  readonly needsGroupBy: boolean;
}

export const WIDGET_CATALOG: readonly WidgetCatalogEntry[] = [
  { type: 'summary',    label: 'Summary',          description: 'Total cost vs previous period.', needsGroupBy: false },
  { type: 'pie',        label: 'Pie',              description: 'Donut breakdown by dimension.', needsGroupBy: true },
  { type: 'stackedBar', label: 'Stacked bar',      description: 'Daily / weekly cost over time, stacked.', needsGroupBy: true },
  { type: 'line',       label: 'Line',             description: 'Multi-series cost trend.', needsGroupBy: true },
  { type: 'topNBar',    label: 'Top-N bar',        description: 'Ranked horizontal bars.', needsGroupBy: true },
  { type: 'treemap',    label: 'Treemap',          description: 'Hierarchical cells sized by cost.', needsGroupBy: true },
  { type: 'heatmap',    label: 'Heatmap',          description: 'Dimension × date density.', needsGroupBy: true },
  { type: 'bubble',     label: 'Bubble (trends)',  description: 'Period-over-period scatter.', needsGroupBy: true },
  { type: 'table',      label: 'Table',            description: 'Top rows with service breakdown.', needsGroupBy: true },
];
