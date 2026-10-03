import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  annotation,
  blocks,
  componentPath,
  fetchOpenIssues,
  PAGE_SIZE,
  reportedComplexity,
  run,
} from './sonar-new-issues.mjs';

const issue = (overrides = {}) => ({
  rule: 'typescript:S9382',
  severity: 'MINOR',
  component: 'etiennechabert_cost-goblin:packages/core/src/utils/atomic-file.ts',
  line: 26,
  message: 'Unexpected `await` inside a loop.',
  ...overrides,
});

const complexity = (n) => issue({
  rule: 'typescript:S3776',
  severity: 'CRITICAL',
  message: `Refactor this function to reduce its Cognitive Complexity from ${n} to the 15 allowed.`,
});

/** A fetch stand-in serving the given pages in order, recording the URLs asked for. */
function fakeFetch(pages) {
  const urls = [];
  const impl = async (url) => {
    urls.push(new URL(url));
    const body = pages[urls.length - 1];
    return body === undefined
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body };
  };
  return { impl, urls };
}

describe('blocks', () => {
  it('blocks every rule except cognitive complexity within the project limit of 25', () => {
    expect(blocks(issue())).toBe(true);
    expect(blocks(complexity(20))).toBe(false);
    expect(blocks(complexity(25))).toBe(false);
    expect(blocks(complexity(26))).toBe(true);
  });

  it('blocks an S3776 finding whose message it cannot read', () => {
    expect(reportedComplexity('something else')).toBeNull();
    expect(blocks(issue({ rule: 'typescript:S3776', message: 'reworded upstream' }))).toBe(true);
  });
});

describe('annotation', () => {
  it('annotates a blocking issue as an error on its file and line', () => {
    expect(annotation(issue())).toBe(
      '::error file=packages/core/src/utils/atomic-file.ts,line=26,title=Sonar typescript%3AS9382 (MINOR)::Unexpected `await` inside a loop.',
    );
  });

  it('annotates tolerated complexity as a notice, and omits a missing line', () => {
    const a = annotation({ ...complexity(20), line: undefined });
    expect(a.startsWith('::notice file=packages/core/src/utils/atomic-file.ts,title=')).toBe(true);
  });

  it('escapes the message so it cannot start a workflow command of its own', () => {
    const a = annotation(issue({ message: '100% bad\n::error::injected', component: 'k:a,b:c.ts' }));
    expect(a).toContain('file=a%2Cb%3Ac.ts');
    expect(a.endsWith('::100%25 bad%0A::error::injected')).toBe(true);
    expect(a.split('\n')).toHaveLength(1);
  });

  it('strips the project key from a component', () => {
    expect(componentPath('etiennechabert_cost-goblin:packages/x.ts')).toBe('packages/x.ts');
    expect(componentPath('no-key')).toBe('no-key');
  });
});

describe('fetchOpenIssues', () => {
  it('asks for the PR analysis\'s open issues and follows the pages', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => issue({ line: i }));
    const { impl, urls } = fakeFetch([
      { paging: { total: PAGE_SIZE + 1 }, issues: firstPage },
      { paging: { total: PAGE_SIZE + 1 }, issues: [issue({ line: 9999 })] },
    ]);

    const issues = await fetchOpenIssues(639, impl);

    expect(issues).toHaveLength(PAGE_SIZE + 1);
    expect(urls.map((u) => u.searchParams.get('p'))).toEqual(['1', '2']);
    expect(urls[0]?.searchParams.get('pullRequest')).toBe('639');
    expect(urls[0]?.searchParams.get('issueStatuses')).toBe('OPEN,CONFIRMED');
  });

  it('throws when the API does not answer', async () => {
    await expect(fetchOpenIssues(639, fakeFetch([]).impl)).rejects.toThrow('answered 404');
  });
});

describe('run', () => {
  it('fails when a blocking issue is open, annotating every issue and writing a summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonar-new-issues-'));
    try {
      const summaryFile = join(dir, 'summary.md');
      const lines = [];
      const code = await run(639, {
        fetchImpl: fakeFetch([{ paging: { total: 2 }, issues: [issue(), complexity(20)] }]).impl,
        log: (l) => { lines.push(l); },
        summaryFile,
      });

      expect(code).toBe(1);
      expect(lines.filter((l) => l.startsWith('::error '))).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith('::notice '))).toHaveLength(1);
      expect(readFileSync(summaryFile, 'utf8')).toContain('2 new issue(s) on #639');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when only tolerated complexity findings, or nothing, are open', async () => {
    const quiet = { log: () => {} };
    expect(await run(1, { ...quiet, fetchImpl: fakeFetch([{ paging: { total: 1 }, issues: [complexity(24)] }]).impl })).toBe(0);
    expect(await run(1, { ...quiet, fetchImpl: fakeFetch([{ paging: { total: 0 }, issues: [] }]).impl })).toBe(0);
  });
});
