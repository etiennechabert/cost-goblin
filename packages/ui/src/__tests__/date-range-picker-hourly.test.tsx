import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAG_DAYS, asBucketPath, asDateString, asHourString } from '@costgoblin/core/browser';
import type { CostGoblinConfig } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DateRangePicker, getDefaultDateRange, lastNDaysRange } from '../components/date-range-picker.js';
import type { DateRange, Granularity } from '../components/date-range-picker.js';

/** A mock whose provider has the hourly tier, which lights up the toggle. */
class HourlyApi extends MockCostApi {
  override async getConfig(): Promise<CostGoblinConfig> {
    const base = await super.getConfig();
    return {
      ...base,
      providers: base.providers.map(p => p.type === 'aws'
        ? { ...p, sync: { ...p.sync, hourly: { bucket: asBucketPath('acme-cur/hourly'), retentionDays: 30 } } }
        : p),
    };
  }
}

type OnChange = (range: DateRange, granularity: Granularity, lastNDays?: number) => void;

function renderPicker(props: {
  value?: DateRange;
  granularity?: Granularity;
  hourly?: boolean;
  compareEnabled?: boolean;
  onCompareChange?: (enabled: boolean) => void;
} = {}) {
  const onChange = vi.fn<OnChange>();
  const api = props.hourly === false ? new MockCostApi() : new HourlyApi();
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DateRangePicker
        value={props.value ?? getDefaultDateRange()}
        granularity={props.granularity ?? 'daily'}
        onChange={onChange}
        {...(props.compareEnabled === undefined ? {} : { compareEnabled: props.compareEnabled })}
        onCompareChange={props.onCompareChange}
      />
    </CostApiProvider>,
  );
  return { onChange, user };
}

const HOUR_RANGE: DateRange = {
  start: asDateString('2026-04-30'),
  end: asDateString('2026-04-30'),
  startHour: asHourString('2026-04-30 14:00:00'),
  endHour: asHourString('2026-04-30 18:00:00'),
};

/** A whole past month, so every day of the calendar it opens on is pickable
 *  whatever today's date is. */
const MARCH_2024: DateRange = { start: asDateString('2024-03-01'), end: asDateString('2024-03-31') };

async function hourlyEnabled(): Promise<HTMLElement> {
  const hourly = screen.getByRole('button', { name: 'Hourly' });
  await waitFor(() => { expect(hourly).toHaveProperty('disabled', false); });
  return hourly;
}

afterEach(cleanup);

describe('DateRangePicker — hour bounds', () => {
  it('labels a drag-zoomed hour range by its hours', () => {
    renderPicker({ value: HOUR_RANGE, granularity: 'hourly' });
    expect(screen.getByText('Apr 30 14:00 → Apr 30 18:00')).toBeDefined();
  });

  it('adds "vs prev" while comparing, to hour ranges and presets alike', () => {
    renderPicker({ value: HOUR_RANGE, granularity: 'hourly', compareEnabled: true });
    expect(screen.getByText('Apr 30 14:00 → Apr 30 18:00 vs prev')).toBeDefined();
    cleanup();
    renderPicker({ compareEnabled: true, hourly: false });
    expect(screen.getByText('Last 30 days vs prev')).toBeDefined();
    cleanup();
    renderPicker({ value: { start: asDateString('2026-01-03'), end: asDateString('2026-01-20') }, compareEnabled: true, hourly: false });
    expect(screen.getByText('2026-01-03 → 2026-01-20 vs prev')).toBeDefined();
  });

  it('shows an hour bound that is no real time as it was given', () => {
    renderPicker({ value: { ...HOUR_RANGE, startHour: asHourString('2026-99-99 99:99:99') }, granularity: 'hourly' });
    expect(screen.getByText('2026-99-99 99:99:99 → Apr 30 18:00')).toBeDefined();
  });

  it('marks no preset active while hour bounds are set', async () => {
    const { user } = renderPicker({ value: { ...getDefaultDateRange(), startHour: asHourString('2026-04-30 14:00:00'), endHour: asHourString('2026-04-30 18:00:00') } });
    await user.click(screen.getByRole('button', { name: /14:00/ }));
    const thirty = screen.getByRole('button', { name: 'Last 30 days' });
    expect(thirty.className).not.toContain('border-accent');
  });
});

describe('DateRangePicker — with the hourly tier configured', () => {
  it('enables the Hourly toggle and switches granularity, keeping a day range that fits the retention', async () => {
    const value = lastNDaysRange(14, DEFAULT_LAG_DAYS);
    const { onChange, user } = renderPicker({ value });
    const hourly = await hourlyEnabled();
    expect(hourly.getAttribute('title')).toBeNull();

    // Daily is already active: pressing it again does nothing.
    await user.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(hourly);
    expect(onChange).toHaveBeenLastCalledWith(value, 'hourly');
  });

  it('falls back to the last 7 days when the day range outlasts the hourly retention', async () => {
    const { onChange, user } = renderPicker({ value: lastNDaysRange(90, DEFAULT_LAG_DAYS) });
    await user.click(await hourlyEnabled());
    expect(onChange).toHaveBeenLastCalledWith(lastNDaysRange(7, DEFAULT_LAG_DAYS), 'hourly');
  });

  it('drops the hour bounds when switching back to Daily', async () => {
    const { onChange, user } = renderPicker({ value: HOUR_RANGE, granularity: 'hourly' });
    await hourlyEnabled();
    await user.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onChange).toHaveBeenLastCalledWith({ start: '2026-04-30', end: '2026-04-30' }, 'daily');
  });

  it('opens "Last 7 days" at hourly granularity and says so', async () => {
    const { onChange, user } = renderPicker();
    await hourlyEnabled();
    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    const seven = screen.getByRole('button', { name: /Last 7 days/ });
    expect(within(seven).getByText('hourly')).toBeDefined();
    await user.click(seven);
    const last = onChange.mock.calls.at(-1);
    expect(last?.[1]).toBe('hourly');
    expect(last?.[2]).toBe(7);
  });

  it('switches a short custom range to hourly on its own', async () => {
    const { onChange, user } = renderPicker({ value: MARCH_2024 });
    await hourlyEnabled();
    await user.click(screen.getByRole('button', { name: '2024-03-01 → 2024-03-31' }));
    await user.click(screen.getByText('Custom range…'));
    const days = within(screen.getByRole('grid')).getAllByRole('button').filter(b => !b.hasAttribute('disabled'));
    const [first, second] = days;
    if (first === undefined || second === undefined) throw new Error('calendar shows fewer than two days');
    await user.click(first);
    await user.click(second);
    const last = onChange.mock.calls.at(-1);
    expect(last?.[1]).toBe('hourly');
    expect(last?.[0].startHour).toBeUndefined();
  });

  it('keeps a long custom range daily', async () => {
    const { onChange, user } = renderPicker({ value: MARCH_2024 });
    await hourlyEnabled();
    await user.click(screen.getByRole('button', { name: '2024-03-01 → 2024-03-31' }));
    await user.click(screen.getByText('Custom range…'));
    const days = within(screen.getByRole('grid')).getAllByRole('button').filter(b => !b.hasAttribute('disabled'));
    const first = days[0];
    const tenth = days[9];
    if (first === undefined || tenth === undefined) throw new Error('calendar shows fewer than ten days');
    await user.click(first);
    await user.click(tenth);
    expect(onChange.mock.calls.at(-1)?.[1]).toBe('daily');
  });
});

describe('DateRangePicker — dismissing', () => {
  it('drops a half-picked custom range when closed with Escape', async () => {
    const { onChange, user } = renderPicker({ value: MARCH_2024, hourly: false });
    const trigger = screen.getByRole('button', { name: '2024-03-01 → 2024-03-31' });
    await user.click(trigger);
    await user.click(screen.getByText('Custom range…'));
    const day = within(screen.getByRole('grid')).getAllByRole('button').find(b => !b.hasAttribute('disabled'));
    if (day === undefined) throw new Error('no pickable day');
    // One end only: nothing is committed yet.
    await user.click(day);
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByText('Custom range…')).toBeNull(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain('2024-03-01 → 2024-03-31');
  });
});

describe('DateRangePicker — compare to previous period', () => {
  it('reports the compare checkbox, and leaves it out without a handler', async () => {
    const onCompareChange = vi.fn<(enabled: boolean) => void>();
    const { user } = renderPicker({ compareEnabled: false, onCompareChange, hourly: false });
    await user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    const compare = screen.getByRole('checkbox', { name: 'Compare to previous period' });
    expect(compare).toHaveProperty('checked', false);
    await user.click(compare);
    expect(onCompareChange).toHaveBeenLastCalledWith(true);
    cleanup();

    const second = renderPicker({ hourly: false });
    await second.user.click(screen.getByRole('button', { name: /Last 30 days/ }));
    expect(screen.queryByRole('checkbox', { name: 'Compare to previous period' })).toBeNull();
  });

  it('shows the box ticked while comparing, and reports unticking it', async () => {
    const onCompareChange = vi.fn<(enabled: boolean) => void>();
    const { user } = renderPicker({ compareEnabled: true, onCompareChange, hourly: false });
    await user.click(screen.getByRole('button', { name: /vs prev/ }));
    const compare = screen.getByRole('checkbox', { name: 'Compare to previous period' });
    expect(compare).toHaveProperty('checked', true);
    await user.click(compare);
    expect(onCompareChange).toHaveBeenLastCalledWith(false);
  });
});
