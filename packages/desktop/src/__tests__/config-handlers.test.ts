import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asDimensionId } from '@costgoblin/core';
import { registerConfigHandlers } from '../main/handlers/config.js';
import {
  FIXTURE_AWS_PROVIDER,
  FIXTURE_GCP_PROVIDER,
  at,
  createHarness,
  list,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The config IPC channels: the renderer's enabled-dimension list, the org
 *  tree, the surgical AWS-profile swap, and provider removal (config entry
 *  plus its on-disk data). */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function configApp(config: FixtureConfigSet = 'single', data: 'synthetic' | 'none' = 'none'): Promise<Harness> {
  const h = await createHarness({ config, data });
  registerConfigHandlers(h.app);
  harnesses.push(h);
  return h;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const DIMENSIONS = [
  'builtIn:',
  '  - name: account',
  '    label: Account',
  '    field: account_id',
  '    displayField: account_name',
  '    defaultFilterValues:',
  "      - '111111111111'",
  '  - name: service',
  '    label: Service',
  '    field: service',
  '  - name: operation',
  '    label: Operation',
  '    field: operation',
  '    enabled: false',
  'tags:',
  '  - tagName: team',
  '    label: Team',
  '    concept: owner',
  '    normalize: lowercase-kebab',
  "    separator: '/'",
  '    aliases:',
  '      core: [core-team]',
  '    defaultFilterValues: [core]',
  '  - label: OU Path',
  '    accountTagFallback: __ouPath__',
  '    pathSegment:',
  '      separator: /',
  '      index: 1',
  '  - tagName: legacy',
  '    label: Legacy',
  '    enabled: false',
  '',
].join('\n');

describe('config:get, config:dimensions, config:org-tree', () => {
  it('serves the loaded config and the org tree', async () => {
    const h = await configApp();
    expect(await h.ipc.invoke('config:get')).toBe(await h.app.getConfig());
    const tree = await h.ipc.invoke('config:org-tree');
    expect(tree).toEqual([...(await h.app.getOrgTreeConfig()).tree]);
    expect(list(tree).length).toBeGreaterThan(0);
  });

  it('lists only enabled dimensions, carrying just the fields each one sets', async () => {
    const h = await configApp();
    await writeFile(h.ws.dimensionsPath, DIMENSIONS);
    const dims = list(await h.ipc.invoke('config:dimensions'));
    const byLabel = new Map(dims.map(d => [String(at(d, 'label')), d]));
    expect(byLabel.has('Operation')).toBe(false);
    expect(byLabel.has('Legacy')).toBe(false);
    expect(byLabel.get('Account')).toEqual({
      name: 'account', label: 'Account', field: 'account_id', displayField: 'account_name', defaultFilterValues: ['111111111111'],
    });
    expect(byLabel.get('Service')).toEqual({ name: 'service', label: 'Service', field: 'service' });
    expect(byLabel.get('Team')).toEqual({
      tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab', separator: '/',
      aliases: { core: ['core-team'] }, defaultFilterValues: ['core'],
    });
    // An account-only dimension has no tag name: the key is omitted.
    expect(byLabel.get('OU Path')).toEqual({ label: 'OU Path', accountTagFallback: '__ouPath__', pathSegment: { separator: '/', index: 1 } });
  });

  it('drops empty default-filter lists and empty tag names', async () => {
    const h = await configApp();
    h.app.state.dimensions = {
      builtIn: [{ name: asDimensionId('region'), label: 'Region', field: 'region', defaultFilterValues: [] }],
      tags: [{ tagName: '', label: 'Unit', accountTagFallback: 'unit', defaultFilterValues: [] }],
    };
    expect(await h.ipc.invoke('config:dimensions')).toEqual([
      { name: 'region', label: 'Region', field: 'region' },
      { label: 'Unit', accountTagFallback: 'unit' },
    ]);
  });
});

describe('config:update-aws-profile', () => {
  it('swaps the first provider\'s profile by default, dropping a legacy credentials block', async () => {
    const h = await configApp();
    const original = await readFile(h.ws.configPath, 'utf-8');
    await writeFile(h.ws.configPath, original.replace('    credentialsProfile: test-profile\n', '    credentialsProfile: test-profile\n    credentials:\n      profile: stale\n'));
    await h.app.getConfig();
    await h.ipc.invoke('config:update-aws-profile', 'elevated');
    const written: unknown = parse(await readFile(h.ws.configPath, 'utf-8'));
    expect(at(written, 'providers', 0, 'credentialsProfile')).toBe('elevated');
    expect(at(written, 'providers', 0, 'credentials')).toBeUndefined();
    expect(at(written, 'providers', 0, 'sync', 'daily', 'bucket')).toBe('s3://test-cur-bucket/daily/');
    expect(h.app.state.config).toBeNull();
  });

  it('targets a named provider, and refuses an unknown or GCP one', async () => {
    const h = await configApp('multi');
    await h.ipc.invoke('config:update-aws-profile', 'other', FIXTURE_AWS_PROVIDER);
    expect(at(parse(await readFile(h.ws.configPath, 'utf-8')), 'providers', 0, 'credentialsProfile')).toBe('other');
    await expect(h.ipc.invoke('config:update-aws-profile', 'x', 'ghost')).rejects.toThrow('Unknown provider "ghost"');
    await expect(h.ipc.invoke('config:update-aws-profile', 'x', FIXTURE_GCP_PROVIDER)).rejects.toThrow('is a GCP provider');
  });

  it('refuses a config file that is not a YAML object', async () => {
    const h = await configApp();
    await writeFile(h.ws.configPath, '- not\n- an object\n');
    await expect(h.ipc.invoke('config:update-aws-profile', 'x')).rejects.toThrow('Config file is not a YAML object');
    await expect(h.ipc.invoke('config:remove-provider', FIXTURE_AWS_PROVIDER)).rejects.toThrow('Config file is not a YAML object');
  });
});

describe('config:remove-provider', () => {
  it('removes the entry and deletes that provider\'s data, then resets every cache', async () => {
    const h = await configApp('multi', 'synthetic');
    await h.app.getConfig();
    await h.ipc.invoke('config:remove-provider', FIXTURE_GCP_PROVIDER);
    expect(await exists(join(h.ws.dataDir, FIXTURE_GCP_PROVIDER))).toBe(false);
    expect(await exists(join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw'))).toBe(true);
    expect(list(at(parse(await readFile(h.ws.configPath, 'utf-8')), 'providers')).map(p => at(p, 'name'))).toEqual([FIXTURE_AWS_PROVIDER]);
    expect(h.db.cancelPendingQueries).toHaveBeenCalled();
    expect((await h.app.getConfig()).providers.map(p => String(p.name))).toEqual([FIXTURE_AWS_PROVIDER]);
  });

  it('refuses the last provider, an unknown one, and a name that is not a safe path segment', async () => {
    const h = await configApp('single', 'synthetic');
    await expect(h.ipc.invoke('config:remove-provider', FIXTURE_AWS_PROVIDER)).rejects.toThrow('Cannot remove the last provider');
    await expect(h.ipc.invoke('config:remove-provider', 'ghost')).rejects.toThrow('Unknown provider "ghost"');
    expect(await exists(join(h.ws.dataDir, FIXTURE_AWS_PROVIDER, 'raw'))).toBe(true);

    const unsafe = await configApp('none');
    await writeFile(unsafe.ws.configPath, 'providers:\n  - name: ../escape\n  - name: other\n');
    // Refused by the path-segment check itself, not by some earlier failure.
    await expect(unsafe.ipc.invoke('config:remove-provider', '../escape')).rejects.toThrow('Provider names must start with a letter or number');
    expect(await readFile(unsafe.ws.configPath, 'utf-8')).toContain('../escape');
  });
});
