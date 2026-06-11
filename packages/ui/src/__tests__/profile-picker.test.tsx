import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProfilePicker, filterProfiles } from '../components/profile-picker.js';

const SSO_PROFILES = [
  'Accounts-Domain-Production-ReadOnly',
  'Accounts-Domain-Sandbox-ReadOnly',
  'AI-Taskforce-Production-ReadOnly',
  'SRE-Default-Production-ReadOnly',
  'sre-emea-admin',
  'default',
];

describe('filterProfiles', () => {
  it('matches case-insensitively anywhere in the name', () => {
    expect(filterProfiles(SSO_PROFILES, 'SRE')).toEqual(['SRE-Default-Production-ReadOnly', 'sre-emea-admin']);
    expect(filterProfiles(SSO_PROFILES, 'sandbox')).toEqual(['Accounts-Domain-Sandbox-ReadOnly']);
  });

  it('requires every whitespace-separated token to match', () => {
    expect(filterProfiles(SSO_PROFILES, 'prod accounts')).toEqual(['Accounts-Domain-Production-ReadOnly']);
    expect(filterProfiles(SSO_PROFILES, 'sre prod')).toEqual(['SRE-Default-Production-ReadOnly']);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(filterProfiles(SSO_PROFILES, '')).toEqual(SSO_PROFILES);
    expect(filterProfiles(SSO_PROFILES, '   ')).toEqual(SSO_PROFILES);
  });

  it('returns nothing when no profile matches', () => {
    expect(filterProfiles(SSO_PROFILES, 'gcp')).toEqual([]);
  });
});

describe('ProfilePicker', () => {
  it('narrows the list as the user types', async () => {
    const user = userEvent.setup();
    render(<ProfilePicker profiles={SSO_PROFILES} selected="" onSelect={() => undefined} />);

    expect(screen.getAllByRole('option')).toHaveLength(SSO_PROFILES.length);
    await user.type(screen.getByPlaceholderText('Type to filter profiles…'), 'SRE');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('sre-emea-admin')).toBeDefined();
  });

  it('selects a clicked profile and selects the first match on Enter', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ProfilePicker profiles={SSO_PROFILES} selected="" onSelect={onSelect} />);

    await user.click(screen.getByText('default'));
    expect(onSelect).toHaveBeenCalledWith('default');

    await user.type(screen.getByPlaceholderText('Type to filter profiles…'), 'sandbox{Enter}');
    expect(onSelect).toHaveBeenCalledWith('Accounts-Domain-Sandbox-ReadOnly');
  });

  it('shows a no-match message and badges the current profile', async () => {
    const user = userEvent.setup();
    render(<ProfilePicker profiles={SSO_PROFILES} selected="default" currentProfile="default" onSelect={() => undefined} />);

    expect(screen.getByText('Current')).toBeDefined();
    await user.type(screen.getByPlaceholderText('Type to filter profiles…'), 'gcp');
    expect(screen.getByText(/No profiles match/)).toBeDefined();
  });
});
