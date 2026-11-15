// What a pull request still owes its review bots. A command, and a Claude
// Code Stop hook:
//
//   node .claude/hooks/pr-feedback.mjs        the PR of the current branch
//   node .claude/hooks/pr-feedback.mjs 834    PR #834
//
// CLAUDE.md's "After pushing — close the review loop" asks a session to
// answer what Sentry, Gitar and SonarCloud say on its pull request. This
// reads GitHub and SonarCloud and lists what is still owed:
//
// - a Sentry or Gitar finding (a review thread the bot opened) that is not
//   resolved and has no reply from a person, or no +1 or -1 from whoever
//   `gh` is signed in as;
// - Gitar's summary comment without that reaction, once its review of the
//   last commit is over (it replaces the comment while it reviews);
// - SonarCloud's open issues and hotspots, and a failed quality gate, once
//   its analysis is of the last commit.
//
// As a Stop hook (`--hook`, wired in .claude/settings.json) it runs when a
// session is about to end its turn. If the branch the session is on has a
// pull request that is ready for review and something is owed, the session is
// sent back with the list. It asks once per turn. What a session can settle
// by itself (a reply, a reaction) it asks again the next turn, until settled.
// A SonarCloud item is asked once per session: a false positive can only be
// closed in SonarCloud's UI, so asking again would never end.
//
// It stays silent for a draft (the bots do not review one), for a branch
// with no pull request, in a directory of another repository, and whenever
// GitHub cannot be read. It only runs while a session is working: feedback
// that arrives after the session stopped is not its business.
//
// Pinned by scripts/ci/pr-feedback.test.mjs.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runGit, slugOf } from './git.mjs';

const run = promisify(execFile);

/** A directory of the repository this hook works for: its own. */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
export const GH_TIMEOUT_MS = 10_000;
/** For each of the three requests SonarCloud can be sent. */
export const SONAR_TIMEOUT_S = 4;
/** Above execFile's 1 MB default: bot comments are long. */
const MAX_OUTPUT = 64 * 1024 * 1024;
const SONAR_HOST = 'https://sonarcloud.io';

/** The bots whose findings a session answers, by GitHub login. */
const BOTS = { sentry: 'Sentry', 'gitar-bot': 'Gitar' };
/** The check each leaves on a commit it has reviewed. Sentry only does on the first commit it reviews. */
const CHECKS = { Sentry: 'Seer Code Review', Gitar: 'Gitar' };

const FEEDBACK = `
fragment feedback on PullRequest {
  number url state isDraft isCrossRepository headRefOid
  reviewThreads(first: 100) { nodes { isResolved path line
    comments(first: 30) { nodes { databaseId url body author { login __typename } reactionGroups { content viewerHasReacted } } } } }
  comments(last: 30) { nodes { databaseId url body author { login __typename } reactionGroups { content viewerHasReacted } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status } ... on StatusContext { context state } } } } } } }
}`;
const BY_BRANCH = `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) {
  pullRequests(headRefName: $branch, states: OPEN, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...feedback } } } }${FEEDBACK}`;
const BY_NUMBER = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
  pullRequest(number: $number) { ...feedback } } }${FEEDBACK}`;

// ---------------------------------------------------------------------------
// What is owed
// ---------------------------------------------------------------------------

const botOf = (author) => (author?.__typename === 'Bot' ? (BOTS[String(author.login).replace(/\[bot\]$/, '')] ?? null) : null);
const isPerson = (author) => author != null && author.__typename !== 'Bot';
const hasVerdict = (comment) =>
  (comment.reactionGroups ?? []).some((group) => group.viewerHasReacted && (group.content === 'THUMBS_UP' || group.content === 'THUMBS_DOWN'));

/** The first line of a bot's comment as a person reads it: no HTML, no Markdown marks. */
export function titleOf(body) {
  const lines = String(body ?? '')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^[\s#>]+/, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim());
  const first = lines.find((line) => line !== '') ?? '';
  return first.length > 140 ? `${first.slice(0, 137)}...` : first;
}

/** 'done', 'running' or 'absent': the state of a check on the PR's last commit. */
export function checkOf(pr, name) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const check = contexts.find((context) => (context.name ?? context.context) === name);
  if (!check) return 'absent';
  const over = check.__typename === 'CheckRun' ? check.status === 'COMPLETED' : check.state !== 'PENDING' && check.state !== 'EXPECTED';
  return over ? 'done' : 'running';
}

/** What the PR owes Sentry and Gitar, from GitHub's answer to the `feedback` fragment. */
export function owedOnGitHub(pr) {
  const owed = [];
  for (const thread of pr.reviewThreads?.nodes ?? []) {
    const [first, ...replies] = thread.comments?.nodes ?? [];
    const bot = botOf(first?.author);
    if (!bot || thread.isResolved) continue;
    const missing = [];
    // the bot's own follow-up on its thread is not an answer
    if (!replies.some((reply) => isPerson(reply.author))) missing.push('reply');
    if (!hasVerdict(first)) missing.push('reaction');
    if (missing.length === 0) continue;
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}` : '';
    owed.push({ id: `comment:${first.databaseId}`, kind: 'finding', bot, where, title: titleOf(first.body), commentId: first.databaseId, url: first.url, missing });
  }
  // Gitar replaces its summary comment while it reviews, and a reaction goes with the old one
  const summary = checkOf(pr, CHECKS.Gitar) === 'running' ? undefined : (pr.comments?.nodes ?? []).filter((comment) => botOf(comment.author) === 'Gitar').at(-1);
  if (summary && !hasVerdict(summary)) {
    owed.push({ id: `comment:${summary.databaseId}`, kind: 'summary', bot: 'Gitar', commentId: summary.databaseId, url: summary.url, missing: ['reaction'] });
  }
  return owed;
}

/** What the PR owes SonarCloud. Nothing until its analysis is of the PR's last commit: an older one may list what is already fixed. */
export function owedOnSonar(sonar, headOid) {
  const analysis = sonar?.analysis;
  if (!analysis || analysis.commit?.sha !== headOid) return [];
  const at = ({ component, line }) => `${String(component ?? '').replace(/^[^:]*:/, '')}${line ? `:${line}` : ''}`;
  const owed = [];
  for (const issue of sonar.issues) owed.push({ id: `sonar:${issue.key}`, kind: 'issue', title: `${issue.rule} at ${at(issue)}: ${issue.message}` });
  for (const spot of sonar.hotspots) owed.push({ id: `sonar:${spot.key}`, kind: 'hotspot', title: `${at(spot)}: ${spot.message}` });
  if (analysis.status?.qualityGateStatus === 'ERROR') owed.push({ id: `sonar-gate:${headOid}`, kind: 'gate' });
  return owed;
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const MISSING = { 'reply,reaction': 'no reply and no +1 or -1 yet', reply: 'no reply yet', reaction: 'no +1 or -1 yet' };

function describe(item) {
  if (item.kind === 'finding') {
    const where = item.where ? ` on ${item.where}` : '';
    return `- ${item.bot} finding${where}: "${item.title}". It has ${MISSING[item.missing.join(',')]}. Comment ${item.commentId}: ${item.url}`;
  }
  if (item.kind === 'summary') return `- Gitar's summary comment has no +1 or -1 yet. Comment ${item.commentId}: ${item.url}`;
  if (item.kind === 'issue') return `- SonarCloud issue ${item.title}`;
  if (item.kind === 'hotspot') return `- SonarCloud security hotspot at ${item.title}`;
  return "- SonarCloud's quality gate failed on the last commit.";
}

/** What a session is told when the Stop hook sends it back. */
export function stopReason(pr, owed) {
  return [
    `PR #${pr.number} of this branch has review feedback that nobody has answered (CLAUDE.md, "After pushing — close the review loop", steps 2 to 4):`,
    '',
    ...owed.map(describe),
    '',
    'If this session is working on that PR, deal with each one before the turn ends: check it against the code, fix it or say why not, reply on its thread and react with +1 or -1. A SonarCloud issue is fixed, or listed in the PR description with the reason it stays.',
    '`node .claude/hooks/pr-feedback.mjs` shows this list again.',
    'If the user asked for something unrelated in this turn, tell them this feedback is waiting, and stop.',
  ].join('\n');
}

const REVIEW = {
  done: 'reviewed the last commit',
  running: 'is reviewing the last commit',
};

function sonarLine(sonar, headOid) {
  if (sonar === undefined) return 'not asked (no sonar.projectKey in sonar-project.properties)';
  if (sonar === null) return 'could not be read';
  if (sonar.analysis === null) return 'has not analysed this pull request';
  const sha = sonar.analysis.commit?.sha;
  if (sha !== headOid) return `has not analysed the last commit yet (its analysis is of ${String(sha ?? 'an unknown commit').slice(0, 8)})`;
  return `analysed the last commit: quality gate ${sonar.analysis.status?.qualityGateStatus === 'ERROR' ? 'failed' : 'passed'}`;
}

/** The report the command prints. */
export function report(pr, sonar) {
  const owed = [...(pr.isDraft ? [] : owedOnGitHub(pr)), ...owedOnSonar(sonar, pr.headRefOid)];
  const sentry = checkOf(pr, CHECKS.Sentry);
  const gitar = checkOf(pr, CHECKS.Gitar);
  const lines = [`PR #${pr.number} (${pr.isDraft ? 'draft' : 'ready for review'}) at ${String(pr.headRefOid).slice(0, 8)}`, pr.url, ''];
  if (pr.isDraft) {
    lines.push('Sentry and Gitar review it once it is ready for review.');
  } else {
    lines.push(`Sentry      ${REVIEW[sentry] ?? 'left no sign of a review of the last commit (it leaves a check only on the first commit it reviews)'}`);
    lines.push(`Gitar       ${REVIEW[gitar] ?? 'has not reviewed the last commit yet'}`);
  }
  lines.push(`SonarCloud  ${sonarLine(sonar, pr.headRefOid)}`, '');
  if (owed.length === 0) lines.push('Nothing to answer.');
  else lines.push('To answer:', ...owed.map(describe));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reading GitHub and SonarCloud
// ---------------------------------------------------------------------------

async function defaultGh(args, cwd) {
  const { stdout } = await run('gh', args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: GH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
  return stdout;
}

async function defaultCurl(url) {
  const { stdout } = await run('curl', ['--silent', '--fail', '--max-time', String(SONAR_TIMEOUT_S), url], { timeout: (SONAR_TIMEOUT_S + 1) * 1000, maxBuffer: MAX_OUTPUT });
  return stdout;
}

const GIT_DIR = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

/** `{ slug, branch }` of the checkout a directory is in: its GitHub repository and its branch (null when detached). Null without an `origin` on GitHub. */
function checkoutOf(cwd, git) {
  const origin = git(cwd, ['config', '--get', 'remote.origin.url']);
  const slug = origin === null ? null : slugOf(origin);
  return slug === null ? null : { slug, branch: git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) };
}

/** The checkout, when its branch can have a pull request in this repository. No network is used to tell. */
function branchForPr(cwd, git, here) {
  const ours = git(here, GIT_DIR);
  if (ours === null || git(cwd, GIT_DIR) !== ours) return null;
  const at = checkoutOf(cwd, git);
  if (at === null || at.branch === null) return null;
  // a pull request needs its branch on the remote, and is never opened from the default branch
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${at.branch}`]) === null) return null;
  const main = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') ?? 'main';
  return at.branch === main || at.branch === 'main' || at.branch === 'master' ? null : at;
}

/** The pull request with its feedback: by number, or the open one of a branch. Null when there is none; throws when GitHub cannot be read. */
async function readPr({ slug, branch, number }, cwd, gh) {
  const [owner, name] = slug.split('/');
  // -f sends a string as it is: -F would read a branch named `@file` from that file
  const args = ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`];
  if (number === undefined) args.push('-f', `branch=${branch}`, '-f', `query=${BY_BRANCH}`);
  else args.push('-F', `number=${number}`, '-f', `query=${BY_NUMBER}`);
  const repository = JSON.parse(await gh(args, cwd)).data?.repository;
  if (number !== undefined) return repository?.pullRequest ?? null;
  // a fork's pull request can come from a branch of the same name
  return (repository?.pullRequests?.nodes ?? []).find((pr) => !pr.isCrossRepository) ?? null;
}

/** `{ analysis, issues, hotspots }` for a pull request, null when SonarCloud cannot be read, undefined when the project names no key. */
async function readSonar(root, number, curl) {
  let projectKey;
  try {
    projectKey = /^sonar\.projectKey=(.+)$/m.exec(readFileSync(join(root, 'sonar-project.properties'), 'utf8'))?.[1].trim();
  } catch {
    // no properties file
  }
  if (!projectKey) return undefined;
  const key = encodeURIComponent(projectKey);
  const get = async (path) => {
    try {
      return JSON.parse(await curl(`${SONAR_HOST}/api/${path}`));
    } catch {
      return null;
    }
  };
  const list = await get(`project_pull_requests/list?project=${key}`);
  if (list === null) return null;
  const analysis = (list.pullRequests ?? []).find((entry) => String(entry.key) === String(number)) ?? null;
  if (analysis === null) return { analysis, issues: [], hotspots: [] };
  // the list already says whether there is anything to fetch
  const { bugs = 0, vulnerabilities = 0, codeSmells = 0, qualityGateStatus } = analysis.status ?? {};
  const issues = bugs + vulnerabilities + codeSmells > 0 ? (await get(`issues/search?componentKeys=${key}&pullRequest=${number}&resolved=false&ps=100`))?.issues : [];
  const hotspots = qualityGateStatus === 'ERROR' ? (await get(`hotspots/search?projectKey=${key}&pullRequest=${number}&status=TO_REVIEW`))?.hotspots : [];
  return { analysis, issues: issues ?? [], hotspots: hotspots ?? [] };
}

// ---------------------------------------------------------------------------
// The Stop hook
// ---------------------------------------------------------------------------

const stateFile = (stateDir, sessionId) => (typeof sessionId === 'string' && /^[\w-]{1,100}$/.test(sessionId) ? join(stateDir, `${sessionId}.json`) : null);

/** The SonarCloud items this session was already sent back for. */
function toldBefore(file) {
  try {
    const ids = JSON.parse(readFileSync(file, 'utf8'));
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

/**
 * What the hook answers for one Stop input: `{ block }`, the reason the
 * session goes on, or `{}` to let it stop. The tests inject what it reaches
 * outside itself.
 */
export async function stopDecision(input, { git = runGit, gh = defaultGh, curl = defaultCurl, here = HOOK_DIR, stateDir = join(tmpdir(), 'claude-pr-feedback') } = {}) {
  // already sent back in this turn: asking twice would never let it end
  if (input?.hook_event_name !== 'Stop' || input.stop_hook_active === true) return {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const at = branchForPr(cwd, git, here);
  if (at === null) return {};
  let pr;
  try {
    pr = await readPr(at, cwd, gh);
  } catch {
    // GitHub not answering is no reason to hold a session
    return {};
  }
  if (pr === null || pr.isDraft) return {};
  const sonar = await readSonar(git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd, pr.number, curl);
  const file = stateFile(stateDir, input.session_id);
  const told = file === null ? new Set() : toldBefore(file);
  const onSonar = owedOnSonar(sonar, pr.headRefOid).filter((item) => !told.has(item.id));
  const owed = [...owedOnGitHub(pr), ...onSonar];
  if (owed.length === 0) return {};
  if (file !== null && onSonar.length > 0) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, JSON.stringify([...told, ...onSonar.map((item) => item.id)]));
    } catch {
      // it will be asked again next turn
    }
  }
  return { block: stopReason(pr, owed) };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** One line on why `gh` failed: what it said, not Node's "Command failed:" followed by the whole command line. */
function failureOf(error) {
  if (error?.killed) return `gh did not answer within ${GH_TIMEOUT_MS / 1000} s`;
  const said = String(error?.stderr ?? '').trim() || String(error instanceof Error ? error.message : error).trim();
  return said.split('\n')[0];
}

/** What the command prints, and its exit code, for `[<number>]` run in `cwd`. */
export async function command(args, cwd, { git = runGit, gh = defaultGh, curl = defaultCurl } = {}) {
  const [number] = args;
  if (args.length > 1 || (number !== undefined && !/^\d+$/.test(number))) {
    return { code: 2, text: 'Usage: node .claude/hooks/pr-feedback.mjs [<pull request number>]' };
  }
  const at = checkoutOf(cwd, git);
  if (at === null) return { code: 1, text: 'This directory is not in a checkout with an `origin` on GitHub.' };
  if (number === undefined && at.branch === null) return { code: 1, text: 'No branch is checked out: name the pull request by its number.' };
  let pr;
  try {
    pr = await readPr({ ...at, number }, cwd, gh);
  } catch (error) {
    return { code: 1, text: `GitHub could not be read: ${failureOf(error)}` };
  }
  if (pr === null) return { code: 1, text: number === undefined ? `The branch ${at.branch} has no open pull request in ${at.slug}.` : `${at.slug} has no pull request #${number}.` };
  if (pr.state !== 'OPEN') return { code: 0, text: `PR #${pr.number} is ${String(pr.state).toLowerCase()}.\n${pr.url}` };
  const sonar = await readSonar(git(cwd, ['rev-parse', '--show-toplevel']) ?? cwd, pr.number, curl);
  return { code: 0, text: report(pr, sonar) };
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(args) {
  if (args[0] !== '--hook') {
    const { code, text } = await command(args, process.cwd());
    process.stdout.write(`${text}\n`);
    process.exitCode = code;
    return;
  }
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // not a hook call
    return;
  }
  try {
    const { block } = await stopDecision(input);
    if (block) process.stdout.write(JSON.stringify({ decision: 'block', reason: block }));
  } catch (error) {
    // a bug here must not hold a session: say so, and let it stop
    process.stdout.write(JSON.stringify({ systemMessage: `pr-feedback failed and checked nothing: ${error instanceof Error ? error.message : String(error)}` }));
  }
}

/** True when Node was started on this file, whatever symlink its path goes through. */
function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) await main(process.argv.slice(2));
