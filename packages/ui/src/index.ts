export type {
  CostApi,
  Dimension,
} from './api/CostApi.js';

export { cn } from './lib/utils.js';

export { useCostApi, CostApiProvider } from './hooks/use-cost-api.js';
export { useQuery } from './hooks/use-query.js';
export { UnsavedChangesProvider, useUnsavedChanges, useConfirmLeave } from './hooks/use-unsaved-changes.js';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './components/ui/card.js';
export { Button, buttonVariants } from './components/ui/button.js';
export type { ButtonProps } from './components/ui/button.js';

export { ErrorBoundary } from './components/error-boundary.js';
export { BubbleChart } from './components/bubble-chart.js';
export { CostTable } from './components/cost-table.js';
export { EntityPopup } from './components/entity-popup.js';
export { ConfirmModal } from './components/confirm-modal.js';
export { CsvExport } from './components/csv-export.js';
export { SyncStatusIndicator } from './components/sync-status.js';
export { SyncActivityIndicator } from './components/sync-activity-indicator.js';
export { formatDollars, formatPercent, formatDate } from './components/format.js';
export { FilterBar } from './components/filter-bar.js';
export { DateRangePicker, getDefaultDateRange } from './components/date-range-picker.js';
export { EnvironmentBar } from './components/environment-bar.js';
export { SummaryCard } from './components/summary-card.js';
export { DimensionSelector } from './components/dimension-selector.js';
export { PieChart } from './components/pie-chart.js';
export { StackedBarChart } from './components/stacked-bar-chart.js';
export { TopNBarChart } from './components/top-n-bar-chart.js';
export { LineChart } from './components/line-chart.js';
export { TreemapChart } from './components/treemap-chart.js';
export { HeatmapChart } from './components/heatmap-chart.js';
export { FilterActiveBanner } from './components/filter-active-banner.js';
export { CoinRainLoader } from './components/coin-rain-loader.js';
export { useCostFocus, useCostFocusDispatch, useCostFocusReducer, CostFocusProvider, CostFocusDispatchProvider } from './hooks/use-cost-focus.js';

export { WIDGET_REGISTRY, WIDGET_CATALOG } from './widgets/registry.js';
export type { WidgetCatalogEntry } from './widgets/registry.js';
export { widgetFlexBasis } from './widgets/widget.js';
export type { WidgetCommonProps, WidgetComponent } from './widgets/widget.js';

export { CustomView } from './views/custom-view.js';
export { OVERVIEW_SEED_VIEW } from './views/seed-views.js';
export { ViewsEditor } from './views/views-editor.js';
export { CostOverview } from './views/cost-overview.js';
export { CostTrends } from './views/cost-trends.js';
export { MissingTags } from './views/missing-tags.js';
export { Savings } from './views/savings.js';
export { EntityDetail } from './views/entity-detail.js';
export { DataManagement } from './views/data-management.js';
export { DimensionsView } from './views/dimensions.js';
export { CostScopeView } from './views/cost-scope.js';
export { ExplorerView } from './views/explorer.js';
export { SetupWizard } from './views/setup-wizard.js';

export { getDimensionId, isTagDimension, isEnvironmentDimension, isOwnerDimension, isProductDimension } from './lib/dimensions.js';

export { PALETTE_STANDARD, PALETTE_COLORBLIND, getActivePalette } from './lib/palette.js';

export { MockCostApi } from './__fixtures__/mock-api.js';
