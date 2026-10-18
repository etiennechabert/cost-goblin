import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { Dimension, WidgetSpec } from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';
import { WidgetInspector } from '../components/widget-inspector.js';

const DIMENSIONS: readonly Dimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account' },
  { name: asDimensionId('service'), label: 'Service', field: 'service' },
];

function renderInspector(widget: WidgetSpec, dimensions: readonly Dimension[] = DIMENSIONS) {
  const changes: WidgetSpec[] = [];
  render(
    <WidgetInspector
      widget={widget}
      dimensions={dimensions}
      onChange={(next) => { changes.push(next); }}
      onDelete={() => undefined}
    />,
  );
  return changes;
}

function select(label: string): HTMLSelectElement {
  const el = screen.getByLabelText(label);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`${label} is not a select`);
  return el;
}

describe('WidgetInspector summary metric', () => {
  it('shows the metric, defaulting to Total, and no group-by while it is unused', () => {
    renderInspector({ id: 's', type: 'summary', size: 'small' });

    expect(select('Metric').value).toBe('total');
    expect(screen.queryByLabelText('Group by')).toBeNull();
  });

  it('sets the picked metric', () => {
    const changes = renderInspector({ id: 's', type: 'summary', size: 'small', metric: 'total' });

    fireEvent.change(select('Metric'), { target: { value: 'entityCount' } });

    expect(changes).toEqual([{ id: 's', type: 'summary', size: 'small', metric: 'entityCount' }]);
  });

  it('offers a group-by for top entity and entity count, defaulting to service', () => {
    const changes = renderInspector({ id: 's', type: 'summary', size: 'small', metric: 'topEntity' });

    expect(select('Group by').value).toBe('service');
    fireEvent.change(select('Group by'), { target: { value: 'account' } });

    expect(changes).toEqual([{ id: 's', type: 'summary', size: 'small', metric: 'topEntity', groupBy: 'account' }]);
  });

  it('shows the group-by it reads even when that dimension is not listed', () => {
    const changes = renderInspector({ id: 's', type: 'summary', size: 'small', metric: 'entityCount' }, DIMENSIONS.slice(0, 1));

    const groupBy = select('Group by');
    expect(groupBy.value).toBe('service');
    fireEvent.change(groupBy, { target: { value: 'account' } });

    expect(changes).toEqual([{ id: 's', type: 'summary', size: 'small', metric: 'entityCount', groupBy: 'account' }]);
  });

  it('drops the group-by when switching to a metric that ignores it', () => {
    const changes = renderInspector({
      id: 's', type: 'summary', size: 'small', title: 'Top', metric: 'topEntity', groupBy: asDimensionId('account'),
    });

    fireEvent.change(select('Metric'), { target: { value: 'delta' } });

    expect(changes).toEqual([{ id: 's', type: 'summary', size: 'small', title: 'Top', metric: 'delta' }]);
  });

  it('keeps metric and group-by when the title is cleared', () => {
    const changes = renderInspector({
      id: 's', type: 'summary', size: 'small', title: 'Accounts', metric: 'entityCount', groupBy: asDimensionId('account'),
    });

    fireEvent.change(screen.getByPlaceholderText('Auto'), { target: { value: '' } });

    expect(changes).toEqual([{ id: 's', type: 'summary', size: 'small', metric: 'entityCount', groupBy: 'account' }]);
  });

  it("carries a summary's group-by into a chart it is switched to", () => {
    const changes = renderInspector({
      id: 's', type: 'summary', size: 'small', metric: 'topEntity', groupBy: asDimensionId('account'),
    });

    fireEvent.change(screen.getByDisplayValue('Summary'), { target: { value: 'pie' } });

    expect(changes).toEqual([{ id: 's', type: 'pie', size: 'small', groupBy: 'account' }]);
  });
});
