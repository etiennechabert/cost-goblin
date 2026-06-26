import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SettingsShell } from '../components/settings-shell.js';
import { SETTINGS_TABS, isSettingsTabId } from '../settings/registry.js';

afterEach(cleanup);

describe('SettingsShell', () => {
  it('renders every registered tab in the rail', () => {
    render(
      <SettingsShell tabs={SETTINGS_TABS} activeTab="general" onTabChange={vi.fn()}>
        <div>panel</div>
      </SettingsShell>,
    );
    for (const tab of SETTINGS_TABS) {
      expect(screen.getByRole('button', { name: tab.label })).toBeDefined();
    }
  });

  it('marks the active tab with aria-current', () => {
    render(
      <SettingsShell tabs={SETTINGS_TABS} activeTab="cost-scope" onTabChange={vi.fn()}>
        <div>panel</div>
      </SettingsShell>,
    );
    const active = screen.getByRole('button', { name: 'Cost Scope' });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('button', { name: 'General' });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('calls onTabChange with the tab id when a tab is clicked', async () => {
    const onTabChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsShell tabs={SETTINGS_TABS} activeTab="general" onTabChange={onTabChange}>
        <div>panel</div>
      </SettingsShell>,
    );
    await user.click(screen.getByRole('button', { name: 'Dimensions' }));
    expect(onTabChange).toHaveBeenCalledWith('dimensions');
  });

  it('renders the active tab content', () => {
    render(
      <SettingsShell tabs={SETTINGS_TABS} activeTab="general" onTabChange={vi.fn()}>
        <div>my-panel-content</div>
      </SettingsShell>,
    );
    expect(screen.getByText('my-panel-content')).toBeDefined();
  });
});

describe('isSettingsTabId', () => {
  it('accepts known tab ids and rejects others', () => {
    expect(isSettingsTabId('general')).toBe(true);
    expect(isSettingsTabId('data-sync')).toBe(true);
    expect(isSettingsTabId('not-a-tab')).toBe(false);
    expect(isSettingsTabId('')).toBe(false);
  });
});
