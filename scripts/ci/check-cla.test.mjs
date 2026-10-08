// check-cla.mjs decides whether a pull request may merge under the CLA, and
// that is what later lets contributed code be relicensed (CLA.md section 2).
// A check that passes when it shouldn't loses that right silently, so these
// cases pin both directions: who must sign, and which signature edits a pull
// request may not make.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_CLA_VERSION,
  LICENSOR,
  MAX_PR_COMMITS,
  checkCla,
  escapeCommandData,
  fetchCommits,
  parseSignatures,
} from '../../.github/scripts/check-cla.mjs';

const repoRoot = new URL('../../', import.meta.url);

const HEADER = `# CLA signatures

Some text.

| GitHub | Full name | Date | CLA version |
|---|---|---|---|
`;

const table = (...rows) => HEADER + rows.map((r) => `${r}\n`).join('');
const ada = '| @ada | Ada Lovelace | 2026-10-08 | 1.0 |';
const alan = '| @alan-t | Alan Turing | 2026-10-09 | 1.0 |';

const commit = (login, extra = {}) => ({
  sha: `${login ?? 'nobody'}0000000000`,
  login,
  name: `${login ?? 'Someone'} Name`,
  email: `${login ?? 'someone'}@example.com`,
  isBot: false,
  ...extra,
});
const owner = commit(LICENSOR);
const dependabot = commit('dependabot[bot]', { isBot: true });
// Claude Code commits as `Claude <noreply@anthropic.com>`, which GitHub links to
// the @claude user account (type User, not Bot).
const agent = commit('claude', { name: 'Claude', email: 'noreply@anthropic.com' });

const byLicensor = { login: LICENSOR, isBot: false };
const by = (login) => ({ login, isBot: false });

describe('parseSignatures', () => {
  it('reads signature rows and skips the header and separator', () => {
    const { rows, problems } = parseSignatures(table(ada, alan));
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { login: 'ada', name: 'Ada Lovelace', date: '2026-10-08', version: '1.0', line: ada },
      { login: 'alan-t', name: 'Alan Turing', date: '2026-10-09', version: '1.0', line: alan },
    ]);
  });

  it('flags a table row it cannot read instead of ignoring it', () => {
    const { rows, problems } = parseSignatures(table('| ada | Ada Lovelace | 2026-10-08 | 1.0 |'));
    expect(rows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('| ada | Ada Lovelace');
  });

  it('flags an empty name and an unknown CLA version', () => {
    const { rows, problems } = parseSignatures(
      table('| @ada |  | 2026-10-08 | 1.0 |', '| @alan-t | Alan Turing | 2026-10-09 | 9.9 |'),
    );
    expect(rows).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain('9.9');
  });

  it('flags the same login signing twice, whatever the case', () => {
    const { problems } = parseSignatures(table(ada, '| @ADA | Ada L. | 2026-10-10 | 1.0 |'));
    expect(problems).toEqual([expect.stringContaining('@ADA')]);
  });
});

describe('checkCla', () => {
  it("passes the licensor's own pull request with no signatures", () => {
    expect(checkCla({ baseText: HEADER, prText: HEADER, commits: [owner], prAuthor: byLicensor })).toEqual([]);
  });

  it('skips bot authors', () => {
    expect(checkCla({ baseText: HEADER, prText: HEADER, commits: [dependabot, owner], prAuthor: byLicensor })).toEqual([]);
  });

  it('fails an author who has not signed, and says which row to add', () => {
    const problems = checkCla({ baseText: HEADER, prText: HEADER, commits: [commit('ada')], prAuthor: by('ada') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ada');
    expect(problems[0]).toContain('| @ada | Your full name |');
  });

  it('passes an author who signs in the same pull request', () => {
    expect(checkCla({ baseText: HEADER, prText: table(ada), commits: [commit('ada')], prAuthor: by('ada') })).toEqual([]);
  });

  it('passes an author who signed earlier, matching the login case-insensitively', () => {
    expect(checkCla({ baseText: table(ada), prText: table(ada), commits: [commit('Ada')], prAuthor: by('ADA') })).toEqual([]);
  });

  it('reports each unsigned author once, however many commits they made', () => {
    const problems = checkCla({
      baseText: HEADER,
      prText: HEADER,
      commits: [commit('ada', { sha: 'a1' }), commit('ada', { sha: 'a2' })],
      prAuthor: by('ada'),
    });
    expect(problems).toHaveLength(1);
  });

  it("passes the licensor's pull request whose commits Claude Code authored", () => {
    expect(checkCla({ baseText: HEADER, prText: HEADER, commits: [agent, owner], prAuthor: byLicensor })).toEqual([]);
  });

  it('requires whoever opens the pull request to sign, even when an AI agent wrote every commit', () => {
    const problems = checkCla({ baseText: HEADER, prText: HEADER, commits: [agent], prAuthor: by('ada') });
    expect(problems).toEqual([expect.stringContaining('@ada')]);
    expect(checkCla({ baseText: HEADER, prText: table(ada), commits: [agent], prAuthor: by('ada') })).toEqual([]);
  });

  it('fails a pull request opened by an AI agent account: a person must open and sign it', () => {
    const problems = checkCla({ baseText: HEADER, prText: HEADER, commits: [agent], prAuthor: by('claude') });
    expect(problems).toEqual([expect.stringContaining('opened by an AI agent account')]);
    expect(problems[0]).not.toContain('Add this row');
  });

  it("requires the opener's signature when they didn't author a commit", () => {
    const problems = checkCla({ baseText: table(ada), prText: table(ada), commits: [commit('ada')], prAuthor: by('alan-t') });
    expect(problems).toEqual([expect.stringContaining('@alan-t')]);
  });

  it('lets the opener sign even if every commit is by someone else', () => {
    expect(checkCla({ baseText: table(ada), prText: table(ada, alan), commits: [commit('ada')], prAuthor: by('alan-t') })).toEqual([]);
  });

  it('skips a pull request opened by a bot', () => {
    expect(checkCla({ baseText: HEADER, prText: HEADER, commits: [dependabot], prAuthor: { login: 'dependabot[bot]', isBot: true } })).toEqual([]);
  });

  it('fails a commit whose author email is not linked to a GitHub account', () => {
    const problems = checkCla({ baseText: HEADER, prText: HEADER, commits: [commit(null)], prAuthor: byLicensor });
    expect(problems).toEqual([expect.stringContaining("isn't linked to a GitHub account")]);
  });

  it('fails a row added for someone who authored no commit in the pull request', () => {
    const problems = checkCla({ baseText: HEADER, prText: table(ada, alan), commits: [commit('ada')], prAuthor: by('ada') });
    expect(problems).toEqual([expect.stringContaining('@alan-t')]);
  });

  it('does not let the licensor sign on behalf of someone else either', () => {
    const problems = checkCla({ baseText: HEADER, prText: table(ada), commits: [owner], prAuthor: byLicensor });
    expect(problems).toEqual([expect.stringContaining('@ada')]);
  });

  it("fails a contributor's pull request that edits or removes an existing row", () => {
    const edited = '| @ada | Someone Else | 2026-10-08 | 1.0 |';
    expect(checkCla({ baseText: table(ada), prText: table(edited), commits: [commit('alan-t')], prAuthor: by('alan-t') })).toEqual(
      expect.arrayContaining([expect.stringContaining('@ada')]),
    );
    expect(checkCla({ baseText: table(ada, alan), prText: table(alan), commits: [commit('alan-t')], prAuthor: by('alan-t') })).toEqual([
      expect.stringContaining('@ada'),
    ]);
  });

  it('lets a pull request authored only by the licensor fix an existing row', () => {
    const fixed = '| @ada | Ada King, Countess of Lovelace | 2026-10-08 | 1.0 |';
    expect(checkCla({ baseText: table(ada), prText: table(fixed), commits: [owner, dependabot], prAuthor: byLicensor })).toEqual([]);
  });

  it("doesn't fail a pull request for a bad row that is already on the base branch", () => {
    const bad = table('| ada | Ada | 2026-10-08 | 1.0 |');
    expect(checkCla({ baseText: bad, prText: bad, commits: [commit('alan-t')], prAuthor: by('alan-t') })).toEqual([
      expect.stringContaining('@alan-t'),
    ]);
  });

  it('fails on rows it cannot read in the pull request', () => {
    const problems = checkCla({ baseText: HEADER, prText: table('| ada | Ada | 2026-10-08 | 1.0 |'), commits: [owner], prAuthor: byLicensor });
    expect(problems).toHaveLength(1);
  });
});

describe('the committed CLA files', () => {
  it('ship a signatures file the check reads without problems', () => {
    const text = readFileSync(new URL('.github/cla-signatures.md', repoRoot), 'utf8');
    expect(parseSignatures(text).problems).toEqual([]);
  });

  it('name, in CLA.md, the version the check accepts last', () => {
    const cla = readFileSync(new URL('CLA.md', repoRoot), 'utf8');
    const version = cla.match(/\*\*Version (\d+\.\d+)\*\*/)?.[1];
    expect(version).toBe(CURRENT_CLA_VERSION);
  });

  it('give the CONTRIBUTING.md example row the current version', () => {
    const guide = readFileSync(new URL('CONTRIBUTING.md', repoRoot), 'utf8');
    expect(guide).toContain(`| YYYY-MM-DD | ${CURRENT_CLA_VERSION} |`);
  });
});

// The GitHub API response for one commit of GET /repos/{repo}/pulls/{n}/commits.
const apiCommit = (sha, author, name = 'Some One', email = 'one@example.com') => ({
  sha,
  author,
  commit: { author: { name, email } },
});

function fakeFetch(pages) {
  const urls = [];
  const impl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const body = pages[page - 1] ?? [];
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  return { impl, urls };
}

describe('fetchCommits', () => {
  it('maps API commits, flagging bots and authors with no linked account', async () => {
    const { impl } = fakeFetch([
      [
        apiCommit('a1', { login: 'ada', type: 'User' }),
        apiCommit('b1', { login: 'dependabot[bot]', type: 'Bot' }),
        apiCommit('c1', { login: 'renovate[bot]', type: 'User' }),
        apiCommit('d1', null, 'Unlinked', 'unlinked@example.com'),
      ],
    ]);
    const commits = await fetchCommits({ repo: 'o/r', pr: '7', token: 't', fetchImpl: impl });
    expect(commits).toEqual([
      { sha: 'a1', login: 'ada', name: 'Some One', email: 'one@example.com', isBot: false },
      { sha: 'b1', login: 'dependabot[bot]', name: 'Some One', email: 'one@example.com', isBot: true },
      { sha: 'c1', login: 'renovate[bot]', name: 'Some One', email: 'one@example.com', isBot: true },
      { sha: 'd1', login: null, name: 'Unlinked', email: 'unlinked@example.com', isBot: false },
    ]);
  });

  it('pages until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => apiCommit(`s${i}`, { login: 'ada', type: 'User' }));
    const { impl, urls } = fakeFetch([full, [apiCommit('last', { login: 'ada', type: 'User' })]]);
    const commits = await fetchCommits({ repo: 'o/r', pr: '7', token: 't', fetchImpl: impl });
    expect(commits).toHaveLength(101);
    expect(urls).toHaveLength(2);
  });

  it('refuses a pull request at the API cap, whose later commits it cannot see', async () => {
    const page = (n) => Array.from({ length: n }, (_, i) => apiCommit(`s${i}`, { login: 'ada', type: 'User' }));
    const { impl } = fakeFetch([page(100), page(100), page(MAX_PR_COMMITS - 200)]);
    await expect(fetchCommits({ repo: 'o/r', pr: '7', token: 't', fetchImpl: impl })).rejects.toThrow(/250/);
  });

  it('throws on an API error instead of checking nothing', async () => {
    const impl = async () => ({ ok: false, status: 403, json: async () => [], text: async () => 'rate limited' });
    await expect(fetchCommits({ repo: 'o/r', pr: '7', token: 't', fetchImpl: impl })).rejects.toThrow(/403/);
  });
});

describe('escapeCommandData', () => {
  it('escapes what a workflow command would otherwise read as structure', () => {
    expect(escapeCommandData('50% done\r\n::warning::x')).toBe('50%25 done%0D%0A::warning::x');
  });
});
