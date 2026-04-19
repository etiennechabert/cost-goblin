import { CustomView } from './custom-view.js';
import { OVERVIEW_SEED_VIEW } from './seed-views.js';

export function CostOverview() {
  return (
    <CustomView
      spec={OVERVIEW_SEED_VIEW}
      headerSubtitle="Cloud spending visibility"
    />
  );
}
