import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createGcsStorage, logger } from '@costgoblin/core';
import type { BackfillRequest } from '@costgoblin/core';
import { confirmAndFileBackfillCase, type ConfirmFiling } from '../main/aws-support.js';
import { runGcloudCapture, type GcloudCaptureResult } from '../main/gcloud-capture.js';
import { POST_SETUP_FLAG, registerSetupHandlers } from '../main/handlers/setup.js';
import { dialog, resetElectronFakes, shell } from './helpers/electron-fake.js';
import {
  at,
  awsProviderYaml,
  configYaml,
  createHarness,
  gcpProviderYaml,
  list,
  str,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The setup wizard's main-process half: first-run status, the CloudFormation
 *  template and the backfill support case, the GCP project/bucket browse and
 *  download check, and writing / scaffolding the config files. The gcloud CLI,
 *  the Storage SDK and the AWS Support call are faked at their module edges. */

interface FakeListing {
  readonly prefixes?: readonly string[];
  readonly nextPageToken?: string;
}

const gcs = vi.hoisted(() => {
  const state: {
    listings: FakeListing[];
    periodFiles: readonly string[] | Error;
    getFilesCalls: { bucket: string; options: Readonly<Record<string, unknown>> }[];
  } = { listings: [], periodFiles: [], getFilesCalls: [] };
  return state;
});

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('../main/gcloud-capture.js', () => ({ runGcloudCapture: vi.fn() }));
vi.mock('../main/aws-support.js', () => ({ confirmAndFileBackfillCase: vi.fn() }));
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  // A Storage stand-in serving the scripted listings: delimiter calls page
  // through `gcs.listings`, the period probe returns `gcs.periodFiles`.
  const storage = {
    bucket: (bucketName: string) => ({
      getFiles: (options: Readonly<Record<string, unknown>>): Promise<unknown[]> => {
        gcs.getFilesCalls.push({ bucket: bucketName, options });
        if (options['delimiter'] === '/') {
          const page = gcs.listings.shift() ?? {};
          const nextQuery = page.nextPageToken === undefined ? null : { pageToken: page.nextPageToken };
          return Promise.resolve([[], nextQuery, { prefixes: page.prefixes ?? [] }]);
        }
        if (gcs.periodFiles instanceof Error) return Promise.reject(gcs.periodFiles);
        return Promise.resolve([gcs.periodFiles.map(name => ({ name }))]);
      },
    }),
  };
  return { ...actual, createGcsStorage: vi.fn(() => Promise.resolve(storage)) };
});

const READER = 'reader@billing-project.iam.gserviceaccount.com';
const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
  vi.mocked(runGcloudCapture).mockReset();
  vi.mocked(confirmAndFileBackfillCase).mockReset();
  vi.mocked(createGcsStorage).mockClear();
  gcs.listings = [];
  gcs.periodFiles = [];
  gcs.getFilesCalls = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function setupApp(config: FixtureConfigSet = 'none'): Promise<Harness> {
  const h = await createHarness({ config });
  registerSetupHandlers(h.app);
  harnesses.push(h);
  return h;
}

function exited(code: number, stdout: string, stderr = ''): GcloudCaptureResult {
  return { kind: 'exited', code, stdout, stderr };
}

describe('setup:status', () => {
  it('reports whether a config exists, and consumes the post-setup flag once', async () => {
    const fresh = await setupApp();
    process.argv.push(POST_SETUP_FLAG);
    try {
      expect(await fresh.ipc.invoke('setup:status')).toEqual({ configured: false, postSetup: true });
      expect(await fresh.ipc.invoke('setup:status')).toEqual({ configured: false, postSetup: false });
    } finally {
      process.argv.splice(process.argv.indexOf(POST_SETUP_FLAG), 1);
    }
    const configured = await setupApp('single');
    expect(await configured.ipc.invoke('setup:status')).toEqual({ configured: true, postSetup: false });
  });
});

describe('setup:save-exports-template', () => {
  it('refuses settings it cannot vouch for', async () => {
    const h = await setupApp();
    expect(await h.ipc.invoke('setup:save-exports-template', { bucketName: 'Not A Bucket' })).toEqual({ status: 'error', message: 'Invalid template settings.' });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('saves the rendered template where the user chose', async () => {
    const h = await setupApp();
    const target = join(h.ws.root, 'exports.yaml');
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    expect(await h.ipc.invoke('setup:save-exports-template', { bucketName: 'my-billing-exports', hourly: true })).toEqual({ status: 'saved', path: target });
    const template = await readFile(target, 'utf-8');
    expect(template).toContain('my-billing-exports');
    expect(template).toContain('AWSTemplateFormatVersion');
  });

  it('reports a cancelled save and a failed write', async () => {
    const h = await setupApp();
    expect(await h.ipc.invoke('setup:save-exports-template', {})).toEqual({ status: 'canceled' });
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' });
    expect(await h.ipc.invoke('setup:save-exports-template', {})).toEqual({ status: 'canceled' });
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(h.ws.root, 'missing-dir', 'exports.yaml') });
    const failed = await h.ipc.invoke('setup:save-exports-template', {});
    expect(at(failed, 'status')).toBe('error');
    expect(str(at(failed, 'message'))).toContain('ENOENT');
  });
});

describe('setup:file-backfill-case', () => {
  it('refuses a malformed request', async () => {
    const h = await setupApp();
    expect(await h.ipc.invoke('setup:file-backfill-case', { profile: 'p', tiers: ['weekly'] })).toEqual({ status: 'error', message: 'Invalid backfill request.' });
    expect(confirmAndFileBackfillCase).not.toHaveBeenCalled();
  });

  it('files only after the user confirms the exact case text in a native dialog', async () => {
    const h = await setupApp();
    vi.mocked(confirmAndFileBackfillCase).mockImplementation(async (request: BackfillRequest, confirm: ConfirmFiling) =>
      (await confirm({ profile: request.profile, caseText: 'Please backfill the FOCUS export.' }))
        ? { status: 'filed', caseId: 'case-123' }
        : { status: 'canceled' });

    dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(await h.ipc.invoke('setup:file-backfill-case', { profile: 'billing admin', tiers: ['daily', 'hourly'] })).toEqual({ status: 'filed', caseId: 'case-123' });
    const prompt = dialog.showMessageBox.mock.calls[0]?.[0];
    expect(prompt?.buttons).toEqual(['File the case', 'Cancel']);
    expect(prompt?.detail).toContain('"billing admin" profile');
    expect(prompt?.detail).toContain('Please backfill the FOCUS export.');

    dialog.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    expect(await h.ipc.invoke('setup:file-backfill-case', { profile: 'p', tiers: ['daily'] })).toEqual({ status: 'canceled' });
  });
});

describe('setup:list-gcp-projects', () => {
  it('lists projects through gcloud, logging a failed run', async () => {
    const h = await setupApp();
    const info = vi.spyOn(logger, 'info');
    vi.mocked(runGcloudCapture).mockResolvedValueOnce(exited(0, JSON.stringify([{ projectId: 'billing-1', name: 'Billing' }])));
    expect(at(await h.ipc.invoke('setup:list-gcp-projects'), 'projects', 0, 'projectId')).toBe('billing-1');
    expect(vi.mocked(runGcloudCapture).mock.calls[0]?.[0]).toEqual(['projects', 'list', '--format=json']);

    vi.mocked(runGcloudCapture).mockResolvedValueOnce(exited(1, '', 'ERROR: You do not currently have an active account selected.'));
    expect(await h.ipc.invoke('setup:list-gcp-projects')).toEqual({ projects: [], error: 'ERROR: You do not currently have an active account selected.' });
    expect(info).toHaveBeenCalledWith('setup:list-gcp-projects failed', expect.anything());

    info.mockClear();
    vi.mocked(runGcloudCapture).mockResolvedValueOnce({ kind: 'missing' });
    expect(await h.ipc.invoke('setup:list-gcp-projects')).toEqual({ projects: [], error: 'GCLOUD_CLI_NOT_FOUND' });
    expect(info).not.toHaveBeenCalledWith('setup:list-gcp-projects failed', expect.anything());
  });
});

describe('setup:browse-gcs', () => {
  it('lists child folders of a normalized prefix, walking every page', async () => {
    const h = await setupApp();
    gcs.listings = [
      { prefixes: ['focus/daily/', 'focus/hourly/'], nextPageToken: 'page-2' },
      { prefixes: ['focus/daily/', 'focus/notes/'] },
    ];
    const result = await h.ipc.invoke('setup:browse-gcs', { projectId: 'billing-1', bucket: 'export-bucket', prefix: 'focus', impersonateServiceAccount: READER });
    expect(result).toEqual({ prefixes: ['daily', 'hourly', 'notes'], folder: { kind: 'tier-parent', tiers: ['daily', 'hourly'] }, hasParquet: false, truncated: false });
    expect(createGcsStorage).toHaveBeenCalledWith({ projectId: 'billing-1', impersonateServiceAccount: READER });
    expect(gcs.getFilesCalls.map(c => [c.options['prefix'], c.options['pageToken']])).toEqual([['focus/', undefined], ['focus/', 'page-2']]);
  });

  it('probes the newest period of an export folder for Parquet shards', async () => {
    const h = await setupApp();
    const exportFolder = { prefixes: ['focus/daily/billing_period=2026-01/', 'focus/daily/billing_period=2026-02/'] };
    gcs.listings = [exportFolder];
    gcs.periodFiles = ['focus/daily/billing_period=2026-02/_SUCCESS', 'focus/daily/billing_period=2026-02/shard-0.parquet'];
    const found = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'export-bucket', prefix: 'focus/daily/' });
    expect(found).toMatchObject({ folder: { kind: 'export', periods: ['2026-01', '2026-02'] }, hasParquet: true });
    expect(gcs.getFilesCalls.at(-1)?.options['prefix']).toBe('focus/daily/billing_period=2026-02/');

    gcs.listings = [exportFolder];
    gcs.periodFiles = ['focus/daily/billing_period=2026-02/.tmp'];
    expect(at(await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'export-bucket', prefix: 'focus/daily/' }), 'hasParquet')).toBe(false);

    // A probe that fails degrades the shard check, never the listing.
    gcs.listings = [exportFolder];
    gcs.periodFiles = new Error('403 storage.objects.list denied on the period prefix');
    const degraded = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'export-bucket', prefix: 'focus/daily/' });
    expect(degraded).toMatchObject({ prefixes: ['billing_period=2026-01', 'billing_period=2026-02'], hasParquet: false });
  });

  it('browses the bucket root as the ADC login when no reader is named', async () => {
    const h = await setupApp();
    gcs.listings = [{ prefixes: ['focus/'] }];
    const result = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'export-bucket', prefix: '' });
    expect(result).toEqual({ prefixes: ['focus'], folder: { kind: 'unknown' }, hasParquet: false, truncated: false });
    expect(createGcsStorage).toHaveBeenCalledWith({ projectId: 'p', impersonateServiceAccount: undefined });
  });

  it('reports an invalid reader, an invalid bucket name and a failed listing inline', async () => {
    const h = await setupApp();
    const badReader = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'b', prefix: '', impersonateServiceAccount: 'me@gmail.com' });
    expect(at(badReader, 'folder')).toEqual({ kind: 'unknown' });
    expect(str(at(badReader, 'error'))).toContain('"me@gmail.com" is not');
    expect(createGcsStorage).not.toHaveBeenCalled();

    const badBucket = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'Bad/Bucket', prefix: '' });
    expect(str(at(badBucket, 'error')).length).toBeGreaterThan(0);
    expect(createGcsStorage).not.toHaveBeenCalled();

    vi.mocked(createGcsStorage).mockRejectedValueOnce(new Error('unable to impersonate: PERMISSION_DENIED'));
    const denied = await h.ipc.invoke('setup:browse-gcs', { projectId: 'p', bucket: 'export-bucket', prefix: '', impersonateServiceAccount: READER });
    expect(str(at(denied, 'error'))).toContain(`CostGoblin could not read as ${READER}`);
  });
});

describe('setup:verify-gcs-download', () => {
  it('checks the download as the named key-file provider\'s key', async () => {
    const h = await setupApp();
    await writeFile(h.ws.configPath, configYaml(
      gcpProviderYaml('gcp-key', 'gs://export-bucket/focus/daily/', ['    keyFile: /keys/reader.json']),
      awsProviderYaml('aws-main'),
    ));
    vi.mocked(runGcloudCapture).mockResolvedValue(exited(0, 'gs://export-bucket/focus/daily/billing_period=2026-02/\n'));
    const ok = await h.ipc.invoke('setup:verify-gcs-download', { bucketPath: 'gs://export-bucket/focus/daily/', keyFileProvider: 'gcp-key' });
    expect(at(ok, 'ok')).toBe(true);
    expect(vi.mocked(runGcloudCapture).mock.calls[0]?.[2]).toEqual({ CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/keys/reader.json' });

    // An AWS (or unknown) provider has no key to apply.
    await h.ipc.invoke('setup:verify-gcs-download', { bucketPath: 'gs://export-bucket/focus/daily/', keyFileProvider: 'aws-main' });
    await h.ipc.invoke('setup:verify-gcs-download', { bucketPath: 'gs://export-bucket/focus/daily/', keyFileProvider: 'ghost' });
    expect(vi.mocked(runGcloudCapture).mock.calls.slice(1).map(c => c[2])).toEqual([{}, {}]);
  });

  it('applies no key when the config cannot be loaded', async () => {
    const h = await setupApp();
    vi.mocked(runGcloudCapture).mockResolvedValue(exited(0, ''));
    await h.ipc.invoke('setup:verify-gcs-download', { bucketPath: 'gs://export-bucket/focus/daily/', keyFileProvider: 'gcp-key' });
    expect(vi.mocked(runGcloudCapture).mock.calls[0]?.[2]).toEqual({});
  });
});

describe('setup:write-config', () => {
  const awsWizard = {
    providerName: 'team-aws',
    profile: 'billing-sso',
    dailyBucket: 's3://billing-exports/focus/daily/',
  };

  it('writes the provider and the default dimensions on a first run, tags with or without a concept', async () => {
    const h = await setupApp();
    await h.ipc.invoke('setup:write-config', {
      ...awsWizard,
      tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }, { tagName: 'cost-center', label: 'Cost Center' }],
    });
    const config: unknown = parse(await readFile(h.ws.configPath, 'utf-8'));
    expect(at(config, 'providers', 0)).toMatchObject({ name: 'team-aws', type: 'aws', credentialsProfile: 'billing-sso' });
    const dims: unknown = parse(await readFile(h.ws.dimensionsPath, 'utf-8'));
    expect(list(at(dims, 'builtIn')).map(d => at(d, 'name'))).toEqual(['account', 'region', 'service', 'service_category', 'charge_category', 'sku_meter', 'operation']);
    expect(at(dims, 'tags')).toEqual([{ tagName: 'team', label: 'Team', concept: 'owner' }, { tagName: 'cost-center', label: 'Cost Center' }]);
    expect((await h.app.getConfig()).providers[0]?.name).toBe('team-aws');
  });

  it('leaves curated dimensions alone on a re-run that skipped the tag step, and keeps other providers', async () => {
    const h = await setupApp('single');
    const dimensionsBefore = await readFile(h.ws.dimensionsPath, 'utf-8');
    await h.ipc.invoke('setup:write-config', awsWizard);
    expect(await readFile(h.ws.dimensionsPath, 'utf-8')).toBe(dimensionsBefore);
    const config: unknown = parse(await readFile(h.ws.configPath, 'utf-8'));
    expect(list(at(config, 'providers')).map(p => at(p, 'name'))).toEqual(['aws-main', 'team-aws']);
  });

  it('omits the dimensions a GCP export lacks, and stores the reader the wizard browsed as', async () => {
    const h = await setupApp();
    await h.ipc.invoke('setup:write-config', {
      providerName: 'team-gcp', type: 'gcp', profile: '', dailyBucket: 'gs://export-bucket/focus/daily/',
      impersonateServiceAccount: READER, tags: [],
    });
    const dims: unknown = parse(await readFile(h.ws.dimensionsPath, 'utf-8'));
    const names = list(at(dims, 'builtIn')).map(d => at(d, 'name'));
    expect(names).not.toContain('service_category');
    expect(names).toContain('service');
    expect(await readFile(h.ws.configPath, 'utf-8')).toContain(READER);
  });

  it('starts over from an existing file that is not a YAML object, and refuses an invalid reader or name', async () => {
    const h = await setupApp();
    await writeFile(h.ws.configPath, '- just\n- a list\n');
    await h.ipc.invoke('setup:write-config', awsWizard);
    expect(list(at(parse(await readFile(h.ws.configPath, 'utf-8')), 'providers'))).toHaveLength(1);

    await expect(h.ipc.invoke('setup:write-config', { ...awsWizard, type: 'gcp', impersonateServiceAccount: 'nobody' })).rejects.toThrow('"nobody" is not');
    await expect(h.ipc.invoke('setup:write-config', { ...awsWizard, providerName: '../escape' })).rejects.toThrow('Provider names must start with a letter or number');
  });
});

describe('setup:scaffold-config', () => {
  it('writes the template for the chosen provider type without overwriting existing files, then opens the folder', async () => {
    const gcp = await setupApp();
    await gcp.ipc.invoke('setup:scaffold-config', 'gcp');
    expect(await readFile(gcp.ws.configPath, 'utf-8')).toContain('gs://');
    expect(shell.openPath).toHaveBeenCalledWith(gcp.ws.configDir);

    const aws = await setupApp();
    await aws.ipc.invoke('setup:scaffold-config', 42);
    expect(await readFile(aws.ws.configPath, 'utf-8')).toContain('s3://');

    const existing = await setupApp('single');
    const before = await readFile(existing.ws.configPath, 'utf-8');
    const dimsBefore = await readFile(existing.ws.dimensionsPath, 'utf-8');
    await existing.ipc.invoke('setup:scaffold-config', 'aws');
    expect(await readFile(existing.ws.configPath, 'utf-8')).toBe(before);
    expect(await readFile(existing.ws.dimensionsPath, 'utf-8')).toBe(dimsBefore);
  });
});
