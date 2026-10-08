// Fails a pull request whose commit authors haven't all accepted CLA.md, the
// agreement that lets the maintainer relicense contributed code (a commercial
// license, a paid edition) while CostGoblin itself stays AGPL.
//
// A contributor signs by adding their own row to .github/cla-signatures.md in
// a pull request, so every signature is a commit in the repository's history.
// cla.yml runs the base branch's copy of this file, never the pull request's,
// so a pull request can't edit the check it is judged by.
//
// Usage (cla.yml): node check-cla.mjs <base signatures file> <pr signatures file>
// with GH_TOKEN, REPO (owner/name), PR_NUMBER, PR_AUTHOR and PR_AUTHOR_TYPE in
// the environment.

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The copyright holder, who grants the licenses and so signs nothing. */
export const LICENSOR = 'etiennechabert';

/**
 * Accounts AI coding agents commit as. Claude Code authors commits as
 * `Claude <noreply@anthropic.com>`, which GitHub links to the @claude *user*
 * account, so they don't show up as bots. Their commits are skipped like a
 * bot's: the person who opens the pull request signs for that code instead.
 */
export const AI_AGENT_LOGINS = ['claude'];

/** CLA.md versions a signature may name; the last is the current one. */
export const ACCEPTED_CLA_VERSIONS = ['1.0'];
export const CURRENT_CLA_VERSION = ACCEPTED_CLA_VERSIONS.at(-1);

/** GET /pulls/{n}/commits lists at most this many commits. */
export const MAX_PR_COMMITS = 250;

const SIGNATURES_PATH = '.github/cla-signatures.md';
const ROW = /^\|\s*@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\s*\|([^|]*)\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|\s]+)\s*\|\s*$/;
const HEADER_OR_SEPARATOR = /^\|\s*(GitHub\s*\||[-:|\s]+$)/;

const sameLogin = (a, b) => a.toLowerCase() === b.toLowerCase();

const tableLines = (text) => text.split('\n').map((raw) => raw.trim());

/**
 * Reads the signature table. A table row it can't read is reported rather than
 * skipped, so a typo fails the check with a message instead of silently not
 * counting as a signature. Lines in `known` (the base branch already has them)
 * aren't reported: a pull request isn't failed for a row it didn't write.
 */
export function parseSignatures(text, { known = new Set() } = {}) {
  const rows = [];
  const problems = [];
  for (const line of tableLines(text)) {
    if (!line.startsWith('|') || HEADER_OR_SEPARATOR.test(line)) continue;
    const report = (problem) => {
      if (!known.has(line)) problems.push(problem);
    };
    const m = line.match(ROW);
    const name = m?.[2].trim();
    if (!m || !name) {
      report(`Can't read this row of ${SIGNATURES_PATH}: \`${line}\`. Expected \`| @login | Full name | YYYY-MM-DD | ${CURRENT_CLA_VERSION} |\`.`);
      continue;
    }
    const [, login, , date, version] = m;
    if (!ACCEPTED_CLA_VERSIONS.includes(version)) {
      report(`@${login} signed CLA version ${version}, which doesn't exist. The current version is ${CURRENT_CLA_VERSION}.`);
      continue;
    }
    if (rows.some((r) => sameLogin(r.login, login))) {
      report(`@${login} appears more than once in ${SIGNATURES_PATH}.`);
      continue;
    }
    rows.push({ login, name, date, version, line });
  }
  return { rows, problems };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every problem that should block the pull request; empty when it may merge.
 *
 * `commits` are the pull request's commits as `{ sha, login, name, email, isBot }`,
 * `login` being null when the author email isn't linked to a GitHub account.
 * `prAuthor` (`{ login, isBot }`) opened the pull request and submits all of
 * it, so they sign too, whoever authored the commits. `baseText` is the base
 * branch's signatures file (trusted), `prText` the pull request's.
 */
export function checkCla({ baseText, prText, commits, prAuthor }) {
  const base = parseSignatures(baseText).rows;
  const { rows: signed, problems } = parseSignatures(prText, { known: new Set(tableLines(baseText)) });

  const isAgent = (login) => login !== null && AI_AGENT_LOGINS.some((a) => sameLogin(a, login));
  const humans = commits.filter((c) => !c.isBot && !isAgent(c.login));
  for (const c of humans.filter((c) => c.login === null)) {
    problems.push(
      `Commit ${c.sha.slice(0, 7)} by ${c.name} <${c.email}> isn't linked to a GitHub account, so the check can't tell who signed. Add that email to your GitHub account (Settings → Emails), or re-author the commit with one that is.`,
    );
  }

  // Who must have signed: every human commit author, and the opener.
  const signers = [];
  const addSigner = (login) => {
    if (!signers.some((a) => sameLogin(a, login))) signers.push(login);
  };
  for (const c of humans) if (c.login !== null) addSigner(c.login);
  if (!prAuthor.isBot) addSigner(prAuthor.login);
  const contributors = signers.filter((a) => !sameLogin(a, LICENSOR));

  for (const login of contributors) {
    if (!signed.some((r) => sameLogin(r.login, login))) {
      problems.push(
        `@${login} hasn't signed the CLA (CLA.md). Add this row to the end of the table in ${SIGNATURES_PATH}: \`| @${login} | Your full name | ${today()} | ${CURRENT_CLA_VERSION} |\``,
      );
    }
  }

  // Everyone signs for themselves: a new row must belong to a commit author
  // or to whoever opened the pull request.
  for (const row of signed) {
    const isNew = !base.some((b) => sameLogin(b.login, row.login));
    if (isNew && !signers.some((a) => sameLogin(a, row.login))) {
      problems.push(`A row for @${row.login} was added, but @${row.login} neither opened this pull request nor authored a commit in it. Everyone adds their own row.`);
    }
  }

  // Existing signatures are records: only the licensor's own pull request may
  // correct one.
  const onlyLicensor = signers.length > 0 && contributors.length === 0;
  if (!onlyLicensor) {
    for (const row of base) {
      const now = signed.find((r) => sameLogin(r.login, row.login));
      if (!now || now.line !== row.line) {
        problems.push(`The existing signature for @${row.login} was ${now ? 'changed' : 'removed'}. Leave other rows as they are.`);
      }
    }
  }

  return problems;
}

/**
 * The pull request's commits, as checkCla takes them. Throws rather than
 * returning a partial list: commits the API doesn't list can't be checked.
 */
export async function fetchCommits({ repo, pr, token, fetchImpl = fetch }) {
  const commits = [];
  for (let page = 1; page <= Math.ceil(MAX_PR_COMMITS / 100); page += 1) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}/commits?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} listing the commits of #${pr}: ${await res.text()}`);
    const batch = await res.json();
    for (const c of batch) {
      const login = c.author?.login ?? null;
      commits.push({
        sha: c.sha,
        login,
        name: c.commit.author.name,
        email: c.commit.author.email,
        isBot: c.author?.type === 'Bot' || (login?.endsWith('[bot]') ?? false),
      });
    }
    if (batch.length < 100) break;
  }
  if (commits.length >= MAX_PR_COMMITS) {
    throw new Error(`#${pr} has ${MAX_PR_COMMITS} or more commits, more than the GitHub API lists, so the later ones can't be checked. Squash or split it.`);
  }
  return commits;
}

/** Escapes text for a workflow command (`::error::…`), per GitHub's spec. */
export function escapeCommandData(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function main() {
  const [basePath, prPath] = process.argv.slice(2);
  const { GH_TOKEN: token, REPO: repo, PR_NUMBER: pr, PR_AUTHOR: author, PR_AUTHOR_TYPE: authorType } = process.env;
  if (!basePath || !prPath || !token || !repo || !pr || !author) {
    process.stderr.write('usage: GH_TOKEN=… REPO=owner/name PR_NUMBER=n PR_AUTHOR=login [PR_AUTHOR_TYPE=Bot] node check-cla.mjs <base signatures> <pr signatures>\n');
    process.exit(2);
  }
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const commits = await fetchCommits({ repo, pr, token });
  const prAuthor = { login: author, isBot: authorType === 'Bot' || author.endsWith('[bot]') };
  const problems = checkCla({ baseText: read(basePath), prText: read(prPath), commits, prAuthor });
  if (problems.length > 0) {
    for (const p of problems) process.stdout.write(`::error::${escapeCommandData(p)}\n`);
    process.stdout.write('\nSee CONTRIBUTING.md for how to sign the CLA.\n');
    process.exit(1);
  }
  process.stdout.write(`CLA: all ${commits.length} commit(s) are covered.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
