// Lists the SonarCloud issues a pull request introduces, and fails when any of
// them should block the merge.
//
// The project's quality gate only checks ratings, coverage, duplication and
// hotspot review, so new code smells — and bugs or vulnerabilities too minor to
// move a rating — pass it: the PR comment reports "N New issues" beside a green
// gate, and nothing turns red. The `sonarcloud` job in ci.yml runs this after
// the scan (which waits for the analysis on PRs), so each issue becomes an
// annotation on its line and the required check fails until the issue is fixed
// or marked accepted / false positive in SonarCloud.
//
// Locally: `node scripts/ci/sonar-new-issues.mjs <pr-number>` (public API, no
// token needed).
//
// Cognitive complexity (typescript:S3776) is held to 25 by project policy while
// the SonarCloud profile still reports against Sonar's default of 15, so a
// finding at 16–25 is reported as a notice and doesn't fail the run.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROJECT_KEY = 'etiennechabert_cost-goblin';
const ISSUES_API = 'https://sonarcloud.io/api/issues/search';
export const PAGE_SIZE = 500;
export const COMPLEXITY_RULE = 'typescript:S3776';
export const COMPLEXITY_LIMIT = 25;

/** The complexity an S3776 message reports ("…from 20 to the 15 allowed."), or null. */
export function reportedComplexity(message) {
  const m = /from (\d+) to the \d+ allowed/.exec(message);
  return m === null ? null : Number(m[1]);
}

/** Whether the issue fails the run (everything but S3776 within the project limit). */
export function blocks(issue) {
  if (issue.rule !== COMPLEXITY_RULE) return true;
  const complexity = reportedComplexity(issue.message ?? '');
  return complexity === null || complexity > COMPLEXITY_LIMIT;
}

/** Repo-relative path of a Sonar component key (`<projectKey>:<path>`). */
export function componentPath(component) {
  const i = component.indexOf(':');
  return i === -1 ? component : component.slice(i + 1);
}

// GitHub workflow-command escaping: without it a message containing a newline
// could start a command of its own.
function escapeData(s) {
  return s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(s) {
  return escapeData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/** The workflow command that annotates the issue on its line. */
export function annotation(issue) {
  const level = blocks(issue) ? 'error' : 'notice';
  const props = [`file=${escapeProperty(componentPath(issue.component))}`];
  if (typeof issue.line === 'number') props.push(`line=${issue.line}`);
  props.push(`title=${escapeProperty(`Sonar ${issue.rule} (${issue.severity})`)}`);
  return `::${level} ${props.join(',')}::${escapeData(issue.message ?? '')}`;
}

/** Every open issue on the PR's analysis (resolved, accepted and false-positive ones excluded). */
export async function fetchOpenIssues(pullRequest, fetchImpl = fetch, page = 1) {
  const url = new URL(ISSUES_API);
  url.search = new URLSearchParams({
    componentKeys: PROJECT_KEY,
    pullRequest: String(pullRequest),
    issueStatuses: 'OPEN,CONFIRMED',
    ps: String(PAGE_SIZE),
    p: String(page),
  }).toString();
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`SonarCloud issues API answered ${res.status} for pull request ${pullRequest}`);
  const body = await res.json();
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const total = body.paging?.total ?? body.total ?? issues.length;
  if (issues.length === 0 || page * PAGE_SIZE >= total) return issues;
  return [...issues, ...(await fetchOpenIssues(pullRequest, fetchImpl, page + 1))];
}

function summaryMarkdown(pullRequest, issues) {
  if (issues.length === 0) return `### SonarCloud: no new issues on #${pullRequest}\n`;
  const rows = issues.map((i) => {
    const where = `${componentPath(i.component)}${typeof i.line === 'number' ? `:${i.line}` : ''}`;
    const cell = (s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
    return `| ${blocks(i) ? '❌' : 'ℹ️'} | \`${cell(i.rule)}\` | ${cell(i.severity ?? '')} | \`${cell(where)}\` | ${cell(i.message ?? '')} |`;
  });
  return [
    `### SonarCloud: ${issues.length} new issue(s) on #${pullRequest}`,
    '',
    '| | Rule | Severity | Where | Message |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Prints the annotations and a summary; resolves to the process exit code. */
export async function run(pullRequest, { fetchImpl = fetch, log = console.log, summaryFile } = {}) {
  const issues = await fetchOpenIssues(pullRequest, fetchImpl);
  for (const issue of issues) log(annotation(issue));
  const blocking = issues.filter(blocks);
  log(`SonarCloud: ${issues.length} open issue(s) on pull request ${pullRequest}, ${blocking.length} blocking.`);
  if (summaryFile) appendFileSync(summaryFile, summaryMarkdown(pullRequest, issues));
  return blocking.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pr = process.argv[2] ?? '';
  if (!/^\d+$/.test(pr)) {
    console.error('usage: node scripts/ci/sonar-new-issues.mjs <pull-request-number>');
    process.exit(2);
  }
  process.exitCode = await run(Number(pr), { summaryFile: process.env.GITHUB_STEP_SUMMARY });
}
