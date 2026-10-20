import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** deploy.sh's settings block, run against stub `gcloud` and `bq` that only
 *  record their arguments: no test can reach a real project. The settings are
 *  edited into a copy of the script, as a user edits them in Cloud Shell. */

const SCRIPT = fileURLToPath(new URL('./deploy.sh', import.meta.url));

let tmp;
let calls;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'deploy-sh-'));
  calls = join(tmp, 'calls.log');
  const stubs = join(tmp, 'stubs');
  mkdirSync(stubs);
  writeFileSync(join(stubs, 'gcloud'), `#!/bin/sh\necho "gcloud $*" >> "${calls}"\n`);
  // The dataset grant parses `bq show`'s JSON, so `show` answers an empty ACL.
  writeFileSync(join(stubs, 'bq'), `#!/bin/sh\necho "bq $*" >> "${calls}"\n[ "$1" = show ] && echo '{"access": []}'\nexit 0\n`);
  chmodSync(join(stubs, 'gcloud'), 0o755);
  chmodSync(join(stubs, 'bq'), 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Runs a copy of deploy.sh with `settings` written over its own lines. */
function deploy(settings, env = {}) {
  let script = readFileSync(SCRIPT, 'utf8');
  for (const [name, value] of Object.entries(settings)) {
    const line = new RegExp(`^${name}=.*$`, 'm');
    expect(script, `deploy.sh has a ${name}= setting`).toMatch(line);
    script = script.replace(line, `${name}=${value}`);
  }
  const copy = join(tmp, 'deploy.sh');
  writeFileSync(copy, script);
  const result = spawnSync('bash', [copy], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(tmp, 'stubs')}:${process.env.PATH}`,
      // Belt and braces: a gcloud that escaped the stubs would find no login.
      CLOUDSDK_CONFIG: join(tmp, 'gcloud-config'),
      ...env,
    },
  });
  return { status: result.status, stderr: result.stderr, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

const FILLED = {
  PROJECT_ID: 'billing-proj',
  DATASET: 'gcp_billing_immutable_ABC_us',
  TABLE: 'gcp_billing_export_focus_ABC',
  BUCKET: 'acme-billing',
  LOCATION: 'US',
  REGION: 'us-east1',
};

describe('deploy.sh settings', () => {
  it('refuses to run, before any gcloud or bq call, while settings hold their example values', () => {
    const run = deploy({});
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('PROJECT_ID DATASET TABLE BUCKET');
    expect(run.calls).toBe('');
  });

  it('names only the settings still left to set', () => {
    const run = deploy({ PROJECT_ID: FILLED.PROJECT_ID, BUCKET: FILLED.BUCKET });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('set DATASET TABLE at the top');
    expect(run.calls).toBe('');
  });

  it('refuses a full project.dataset.table ID in TABLE or DATASET', () => {
    const run = deploy({ ...FILLED, TABLE: `${FILLED.PROJECT_ID}.${FILLED.DATASET}.${FILLED.TABLE}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('TABLE');
    expect(run.calls).toBe('');
  });

  it('refuses a gs:// URL in BUCKET', () => {
    const run = deploy({ ...FILLED, BUCKET: `gs://${FILLED.BUCKET}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('BUCKET');
    expect(run.calls).toBe('');
  });

  it('deploys the table built from PROJECT_ID, DATASET and TABLE, whatever the environment says', () => {
    const run = deploy(FILLED, { PROJECT_ID: 'env-proj', BUCKET: 'env-bucket', FOCUS_TABLE: 'env.ds.tbl' });
    expect(run.stderr).not.toContain('ERROR');
    expect(run.status).toBe(0);
    expect(run.calls).toContain('gcloud config set project billing-proj');
    expect(run.calls).toContain('bq show --format=prettyjson billing-proj:gcp_billing_immutable_ABC_us');
    expect(run.calls).toContain('FOCUS_TABLE=billing-proj.gcp_billing_immutable_ABC_us.gcp_billing_export_focus_ABC;BUCKET=acme-billing;');
    expect(run.calls).toContain('STATE_TABLE=billing-proj.costgoblin_exporter.export_state;BQ_LOCATION=US');
    expect(run.calls).toContain('--region=us-east1');
    for (const leaked of ['env-proj', 'env-bucket', 'env.ds.tbl']) expect(run.calls).not.toContain(leaked);
  });

  it('runs the job in JOB_PROJECT_ID while granting on the export in PROJECT_ID', () => {
    const run = deploy({ ...FILLED, JOB_PROJECT_ID: 'ops-proj' });
    expect(run.status).toBe(0);
    expect(run.calls).toContain('gcloud config set project ops-proj');
    expect(run.calls).toContain('bq show --format=prettyjson billing-proj:gcp_billing_immutable_ABC_us');
    expect(run.calls).toContain('bq show --format=prettyjson ops-proj:costgoblin_exporter');
    expect(run.calls).toContain('FOCUS_TABLE=billing-proj.gcp_billing_immutable_ABC_us.gcp_billing_export_focus_ABC;');
    expect(run.calls).toContain('STATE_TABLE=ops-proj.costgoblin_exporter.export_state;');
  });
});
