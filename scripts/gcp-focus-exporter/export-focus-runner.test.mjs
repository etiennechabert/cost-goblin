import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createExporter, parseTiers } from './export-focus.mjs';

/** The runner paths `export-focus.test.mjs` leaves alone: the SDK clients the
 *  job builds for itself when none are injected, the shapes a TIMESTAMP can
 *  come back in, a run with nothing to do, and the entry point Cloud Run
 *  executes. Neither Google SDK is installed at the repo root (the image's own
 *  `npm install` provides them), so both are replaced here — no test can reach
 *  a real project. */

const sdk = vi.hoisted(() => ({
  /** Answers by the first marker the SQL contains; records every request. */
  responses: [],
  requests: [],
  bigQueryConstructed: 0,
  storageConstructed: 0,
  bucketsTouched: [],
  failWith: undefined,
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    constructor() {
      sdk.bigQueryConstructed++;
    }

    async query(request) {
      sdk.requests.push(request);
      if (sdk.failWith !== undefined) throw sdk.failWith;
      for (const [marker, rows] of sdk.responses) {
        if (request.query.includes(marker)) return [rows];
      }
      throw new Error(`no scripted response for: ${request.query}`);
    }
  },
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    constructor() {
      sdk.storageConstructed++;
    }

    bucket(name) {
      sdk.bucketsTouched.push(name);
      return { deleteFiles: async () => undefined };
    }
  },
}));

const CONFIG = {
  focusTable: 'proj.ds.tbl',
  stateTable: 'proj.state.export_state',
  bucketName: 'b',
  prefix: 'focus',
  tiers: ['daily'],
  location: 'EU',
  dryRun: false,
};

/** Responses for a run whose source has nothing the state has not seen. */
const CAUGHT_UP = [
  ['CREATE TABLE IF NOT EXISTS', []],
  ['ALTER TABLE', []],
  ['FROM `proj.ds.tbl`', [
    { period_label: '2026-03', period_start: '2026-03-01', watermark: { value: '2026-03-15T00:00:00Z' } },
  ]],
  ['FROM `proj.state.export_state`', [
    { period_start: '2026-03-01', tier: 'daily', watermark: { value: '2026-03-15T00:00:00.000000Z' } },
  ]],
];

/** A `bigquery.query()` stand-in for an injected client. */
function fakeBigQuery(responses) {
  const calls = [];
  return {
    calls,
    query: async (request) => {
      calls.push(request);
      for (const [marker, rows] of responses) {
        if (request.query.includes(marker)) return [rows];
      }
      throw new Error(`no scripted response for: ${request.query}`);
    },
  };
}

/** Silence and capture the job's structured stdout log lines. */
function captureLogs() {
  const logs = [];
  vi.spyOn(console, 'log').mockImplementation((line) => { logs.push(JSON.parse(line)); });
  return logs;
}

beforeEach(() => {
  sdk.responses = [];
  sdk.requests = [];
  sdk.bigQueryConstructed = 0;
  sdk.storageConstructed = 0;
  sdk.bucketsTouched = [];
  sdk.failWith = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('parseTiers', () => {
  it('falls back to daily when TIERS holds only separators', () => {
    expect(parseTiers(',')).toEqual(['daily']);
    expect(parseTiers(' , ,')).toEqual(['daily']);
  });
});

describe('pendingExports — the TIMESTAMP shapes BigQuery can return', () => {
  it('skips a period with no export time yet, and accepts plain-string watermarks on both sides', async () => {
    const bigquery = fakeBigQuery([
      ['FROM `proj.ds.tbl`', [
        // A period whose rows carry no x_ExportTime has nothing to compare.
        { period_label: '2026-01', period_start: '2026-01-01', watermark: null },
        { period_label: '2026-02', period_start: '2026-02-01', watermark: '2026-02-10T08:00:00.5Z' },
        { period_label: '2026-03', period_start: '2026-03-01', watermark: '2026-03-02T00:00:00Z' },
        { period_label: '2026-04', period_start: '2026-04-01', watermark: '2026-04-02T00:00:00Z' },
      ]],
      ['FROM `proj.state.export_state`', [
        { period_start: '2026-02-01', tier: 'daily', watermark: '2026-02-10T08:00:00.4Z' },
        // Published as fresh as the source: nothing to do for March.
        { period_start: '2026-03-01', tier: 'daily', watermark: '2026-03-02T00:00:00.000Z' },
        // A state row without a watermark counts as never published.
        { period_start: '2026-04-01', tier: 'daily', watermark: null },
      ]],
    ]);
    const { pendingExports } = createExporter(CONFIG, { bigquery });

    expect(await pendingExports()).toEqual([
      { tier: 'daily', periodLabel: '2026-02', periodStart: '2026-02-01', watermark: '2026-02-10T08:00:00.500000Z' },
      { tier: 'daily', periodLabel: '2026-04', periodStart: '2026-04-01', watermark: '2026-04-02T00:00:00.000000Z' },
    ]);
  });

  it.each([
    ['a bare number', 1773532800000, 'Unrecognized TIMESTAMP shape from BigQuery: 1773532800000'],
    ['an object with no value', { seconds: 1773532800 }, 'Unrecognized TIMESTAMP shape from BigQuery: {"seconds":1773532800}'],
    ['a wrapper whose value is not text', { value: 1773532800 }, 'Unrecognized TIMESTAMP shape from BigQuery: {"value":1773532800}'],
  ])('refuses %s rather than comparing it as a string', async (_label, watermark, message) => {
    const bigquery = fakeBigQuery([
      ['FROM `proj.ds.tbl`', [{ period_label: '2026-03', period_start: '2026-03-01', watermark }]],
      ['FROM `proj.state.export_state`', []],
    ]);
    const { pendingExports } = createExporter(CONFIG, { bigquery });

    await expect(pendingExports()).rejects.toThrow(message);
  });
});

describe('run', () => {
  it('returns 0 and touches neither the schema nor the bucket when nothing changed', async () => {
    const logs = captureLogs();
    const bigquery = fakeBigQuery(CAUGHT_UP);
    const storage = { bucket: vi.fn() };

    await expect(createExporter(CONFIG, { bigquery, storage }).run()).resolves.toBe(0);

    expect(logs.map(l => l.message)).toEqual(['starting', 'nothing changed since the last run']);
    expect(bigquery.calls.some(c => c.query.includes('INFORMATION_SCHEMA'))).toBe(false);
    expect(bigquery.calls.some(c => c.query.includes('EXPORT DATA'))).toBe(false);
    expect(storage.bucket).not.toHaveBeenCalled();
  });

  it('builds each SDK client once, on first use, when none is injected', async () => {
    captureLogs();
    sdk.responses = CAUGHT_UP;

    await expect(createExporter(CONFIG).run()).resolves.toBe(0);

    expect(sdk.bigQueryConstructed).toBe(1);
    expect(sdk.storageConstructed).toBe(1);
    // The four statements of a caught-up run, all in the dataset's location.
    expect(sdk.requests).toHaveLength(4);
    expect(sdk.requests.every(r => r.location === 'EU')).toBe(true);
    expect(sdk.bucketsTouched).toEqual([]);
  });
});

describe('the Cloud Run entry point', () => {
  const scriptPath = fileURLToPath(new URL('./export-focus.mjs', import.meta.url));
  let argv1;

  beforeEach(() => {
    argv1 = process.argv[1];
    process.argv[1] = scriptPath;
    vi.resetModules();
  });

  afterEach(() => {
    process.argv[1] = argv1;
  });

  /** Evaluate the module as `node export-focus.mjs` would, and report what
   *  the job wrote to stderr and the exit code it asked for. */
  async function runAsMain() {
    captureLogs();
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation((line) => { errors.push(JSON.parse(line)); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    await import('./export-focus.mjs');
    return { errors, exitCodes: exit.mock.calls.map(([code]) => code) };
  }

  function stubValidEnv() {
    vi.stubEnv('FOCUS_TABLE', 'proj.ds.tbl');
    vi.stubEnv('STATE_TABLE', 'proj.state.export_state');
    vi.stubEnv('BUCKET', 'billing-export');
    vi.stubEnv('PREFIX', 'focus');
    vi.stubEnv('TIERS', 'daily');
    vi.stubEnv('BQ_LOCATION', 'EU');
    vi.stubEnv('DRY_RUN', '0');
  }

  it('runs the export from the environment and exits normally', async () => {
    stubValidEnv();
    sdk.responses = CAUGHT_UP;

    const { errors, exitCodes } = await runAsMain();

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(sdk.requests).toHaveLength(4);
  });

  it('logs a configuration error as structured JSON and exits non-zero, so Cloud Run marks the run failed', async () => {
    stubValidEnv();
    vi.stubEnv('FOCUS_TABLE', undefined);

    const { errors, exitCodes } = await runAsMain();

    expect(exitCodes).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ severity: 'ERROR', message: 'Missing required environment variable FOCUS_TABLE' });
    expect(errors[0].stack).toMatch(/^Error: Missing required environment variable FOCUS_TABLE/);
    // Failed at configuration: no client was built, no query was sent.
    expect(sdk.bigQueryConstructed).toBe(0);
  });

  it('reports a failure that is not an Error by its text, with no stack', async () => {
    stubValidEnv();
    sdk.failWith = 'quota exceeded for project proj';

    const { errors, exitCodes } = await runAsMain();

    expect(exitCodes).toEqual([1]);
    expect(errors).toEqual([{ severity: 'ERROR', message: 'quota exceeded for project proj' }]);
  });
});
