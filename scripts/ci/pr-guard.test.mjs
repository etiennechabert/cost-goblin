// .claude/hooks/pr-guard.mjs refuses a `gh pr create` without --draft, and a
// `gh pr ready` on a PR that has no comment saying `/code-review xhigh --fix`
// ran (CLAUDE.md, "After pushing — close the review loop").
//
// It can fail in two directions, and both are pinned here. Missing a command
// is a rule that silently stopped holding. Blocking one it misread is worse:
// it runs before every Bash call of every session, so a commit message or a
// PR body that merely mentions `gh pr create` must never be refused.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CREATE_MESSAGE,
  GH_BUDGET_MS,
  REVIEW_COMMENT,
  ShellSyntaxError,
  decide,
  ghPrCalls,
  missingMessage,
  readCommands,
  readyMessage,
} from '../../.claude/hooks/pr-guard.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const hookPath = join(repoRoot, '.claude/hooks/pr-guard.mjs');

const bash = (command, cwd = '/work/repo') => ({ tool_name: 'Bash', tool_input: { command }, cwd });

/**
 * Real git, without the variables that tie it to one repository. The
 * pre-commit hook runs this suite with GIT_DIR and GIT_INDEX_FILE set, which
 * would point every call here at the repository being committed to.
 *
 * Only for commands that read. A `git init` once ran here with that GIT_DIR
 * inherited: it re-initialised this clone as a bare repository, and broke
 * every worktree of it until `core.bare` was set back.
 */
const cleanEnv = { ...process.env };
for (const name of spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).stdout.split('\n')) {
  delete cleanEnv[name];
}
const git = (args, cwd) => spawnSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8' });

/** A `gh` that must not be reached. */
const noGh = () => {
  throw new Error('gh should not have been run');
};

const HERE = '/work/repo';
/** git as these tests see it: this clone and one of its worktrees, and a clone of another repository. */
const CLONES = {
  '/work/repo/.claude/worktrees/x': { gitDir: '/work/repo/.git', origin: 'git@github.com:acme/widgets.git' },
  '/work/repo': { gitDir: '/work/repo/.git', origin: 'git@github.com:acme/widgets.git' },
  '/work/elsewhere': { gitDir: '/work/elsewhere/.git', origin: 'https://github.com/acme/gadgets' },
};
const fakeGit = (clones = CLONES) => (dir, args) => {
  const root = Object.keys(clones).find((path) => dir === path || dir.startsWith(`${path}/`));
  if (root === undefined) return null;
  return args[0] === 'rev-parse' ? clones[root].gitDir : clones[root].origin;
};
/** What `decide` reaches outside itself: no `gh` unless a test gives one, the git above. */
const world = (options = {}) => ({ runGh: noGh, runGit: fakeGit(), here: HERE, ...options });

const REVIEWED = '`/code-review xhigh --fix` ran on 4e0dcea4.\n\n11 findings fixed in fdadc9f4.';

/** A `gh pr view` answering with these comment bodies, recording how it was called. */
function fakeGh(bodies, number = 834) {
  const calls = [];
  const runGh = (args, options) => {
    calls.push({ args, options });
    return { status: 0, stdout: JSON.stringify({ number, comments: bodies.map((body) => ({ body })) }), stderr: '' };
  };
  return { runGh, calls };
}

const words = (command) => readCommands(command).map((c) => c.words.map((w) => w.text));

describe('readCommands', () => {
  it('splits a command line into its simple commands', () => {
    expect(words('git push -u origin HEAD && gh pr create --draft; ls | wc -l')).toEqual([
      ['git', 'push', '-u', 'origin', 'HEAD'],
      ['gh', 'pr', 'create', '--draft'],
      ['ls'],
      ['wc', '-l'],
    ]);
  });

  it('removes quoting, and keeps quoted text in one word', () => {
    expect(words(`git commit -m "run gh pr create" 'and; more' back\\ slash $'ansi\\'c'`)).toEqual([
      ['git', 'commit', '-m', 'run gh pr create', 'and; more', 'back slash', "ansi'c"],
    ]);
  });

  it('marks what only the shell knows as dynamic, and leaves it out of the text', () => {
    // the `echo 1` of the substitution is listed first
    const command = readCommands('gh pr ready "$PR" --repo=${REPO:-o/r} pre$(echo 1)post $((1 + 2))').at(-1);
    expect(command.words.map((w) => [w.text, w.dynamic])).toEqual([
      ['gh', false],
      ['pr', false],
      ['ready', false],
      ['', true],
      ['--repo=', true],
      ['prepost', true],
      ['', true],
    ]);
  });

  it('lists the commands of a substitution, wherever it is quoted', () => {
    expect(words('URL=$(gh pr create --draft) && echo "$(git rev-parse HEAD)" `date +%s`')).toEqual([
      ['gh', 'pr', 'create', '--draft'],
      ['URL='],
      ['git', 'rev-parse', 'HEAD'],
      ['date', '+%s'],
      ['echo', '', ''],
    ]);
  });

  it('reads a heredoc body as data, in a substitution inside double quotes too', () => {
    const command = [
      `gh pr create --draft --title "t" --body "$(cat <<'EOF'`,
      "It's a body with a ) paren, a `backtick` and \"quotes\".",
      'gh pr ready 12',
      'EOF',
      ')" && echo done',
    ].join('\n');
    expect(words(command)).toEqual([['cat'], ['gh', 'pr', 'create', '--draft', '--title', 't', '--body', ''], ['echo', 'done']]);
  });

  it('ends a heredoc at its delimiter line only, tabs stripped for <<-', () => {
    expect(words('cat <<EOF | grep x\nEOF2\n EOF\nEOF\nls')).toEqual([['cat'], ['grep', 'x'], ['ls']]);
    expect(words('cat <<-EOF\n\tgh pr create\n\tEOF\nls')).toEqual([['cat'], ['ls']]);
    expect(words('cat <<"E O F"\ngh pr create\nE O F\nls')).toEqual([['cat'], ['ls']]);
  });

  it('starts a heredoc body at the next newline, even one inside a substitution or a subshell', () => {
    // bash reads line 2 as text of the heredoc, not as a command of the substitution
    expect(words("cat > notes <<'EOF' && r=$(\ngh pr create --title x\nEOF\n  date\n) && ls")).toEqual([['cat'], ['date'], ['r='], ['ls']]);
    expect(words('cat <<EOF && (\ngh pr ready 5\nEOF\necho in\n)')).toEqual([['cat'], ['echo', 'in']]);
    // two heredocs, the second opened inside the substitution: the bodies follow in that order
    expect(words("cat <<'A' && echo \"$(cat <<'B'\nfirst gh pr create\nA\nsecond gh pr create\nB\n)\" && ls")).toEqual([['cat'], ['cat'], ['echo', ''], ['ls']]);
  });

  it('takes a here-string and a redirection target for data, not arguments', () => {
    expect(words('cat <<< "gh pr create" > out.txt 2>&1')).toEqual([['cat']]);
    expect(words('gh pr ready 2>/dev/null')).toEqual([['gh', 'pr', 'ready']]);
    expect(words('gh pr ready 12 &> log >> other')).toEqual([['gh', 'pr', 'ready', '12']]);
    expect(words('diff <(gh pr view 1) <(gh pr view 2)')).toEqual([['gh', 'pr', 'view', '1'], ['gh', 'pr', 'view', '2'], ['diff']]);
  });

  it('skips comments, but not a # inside a word', () => {
    expect(words('ls # gh pr create\n# gh pr ready\necho a#b $#')).toEqual([['ls'], ['echo', 'a#b', '']]);
  });

  it('joins lines continued with a backslash', () => {
    expect(words('gh pr create \\\n  --draft \\\n  --title t')).toEqual([['gh', 'pr', 'create', '--draft', '--title', 't']]);
  });

  it('finds the command after the keywords of if, while and for, and in a subshell or a function', () => {
    expect(words('if ! gh pr ready 1; then echo no; else echo yes; fi')).toEqual([
      ['gh', 'pr', 'ready', '1'],
      ['echo', 'no'],
      ['echo', 'yes'],
      ['fi'],
    ]);
    expect(words('for n in 1 2; do gh pr ready $n; done')).toEqual([['for', 'n', 'in', '1', '2'], ['gh', 'pr', 'ready', ''], ['done']]);
    expect(words('(cd sub && gh pr create) ; f() { gh pr ready; }')).toEqual([
      ['cd', 'sub'],
      ['gh', 'pr', 'create'],
      ['f'],
      ['gh', 'pr', 'ready'],
    ]);
    expect(words('case $x in a) gh pr ready 1 ;; esac')).toEqual([['case', '', 'in', 'a'], ['gh', 'pr', 'ready', '1'], ['esac']]);
  });

  it('takes an array literal for part of its assignment', () => {
    expect(words('args=(gh pr create "a b") && echo ok')).toEqual([['args='], ['echo', 'ok']]);
  });

  it('follows literal cd, and gives up on one it cannot follow', () => {
    const cwds = (command, start = '/work/repo') => readCommands(command, start).map((c) => c.cwd);
    expect(cwds('ls && cd packages/core && ls && cd /tmp && ls')).toEqual(['/work/repo', '/work/repo', '/work/repo/packages/core', '/work/repo/packages/core', '/tmp']);
    expect(cwds('cd "$DIR" && ls')).toEqual(['/work/repo', null]);
    expect(cwds('cd - ; ls ; cd /tmp ; ls')).toEqual(['/work/repo', null, null, '/tmp']);
    expect(cwds('cd sub && ls', null)).toEqual([null, null]);
    // a subshell's cd stays in the subshell
    expect(cwds('(cd /tmp && ls); ls')).toEqual(['/work/repo', '/tmp', '/work/repo']);
    expect(cwds('builtin cd /tmp && ls; command cd /var && ls')).toEqual(['/work/repo', '/tmp', '/tmp', '/var']);
  });

  it.each([
    ['an unclosed double quote', 'gh pr create --title "x'],
    ['an unclosed single quote', "echo 'x"],
    ['an unclosed substitution', 'echo $(gh pr create'],
    ['an unclosed backtick', 'echo `ls'],
    ['an unclosed parameter expansion', 'echo ${x'],
    ['a heredoc with no delimiter', 'cat <<\nx'],
  ])('throws ShellSyntaxError on %s', (_what, command) => {
    expect(() => readCommands(command)).toThrow(ShellSyntaxError);
  });

  it('reads the rest of the input as the body of a heredoc that is never closed', () => {
    expect(words('cat <<EOF\ngh pr create')).toEqual([['cat']]);
  });
});

describe('ghPrCalls', () => {
  const kinds = (command) => ghPrCalls(command, '/work/repo').map((c) => c.kind);

  it.each([
    'gh pr create --title t',
    'gh pr new --title t',
    'git push && gh pr create',
    'command gh pr create',
    'env -u GH_TOKEN GH_HOST=github.com gh pr create',
    'GH_PAGER= gh pr create',
    '/opt/homebrew/bin/gh pr create',
    'gh -R o/r pr create',
    'gh pr --repo o/r create',
    'exec gh pr create',
    `bash -lc 'git push && gh pr create'`,
    'eval "gh pr create --title t"',
    'echo "$(gh pr create)"',
    'time gh pr create',
    'function open { gh pr create; }; open',
    'function open() { gh pr create; }',
    'gh --repo="$REPO" pr create',
    'gh -R"$REPO" pr create',
  ])('sees the create in: %s', (command) => {
    expect(kinds(command)).toEqual(['create']);
  });

  it.each([
    'gh pr list',
    'gh pr view 12 --json comments',
    'gh pr comment 12 --body-file f',
    'gh issue create --title t',
    'gh api repos/o/r/pulls',
    'ghx pr create',
    'echo gh pr create',
    'git commit -m "gh pr create"',
    'gh "$@"',
    'gh pr "$SUB"',
    'bash -c "$SCRIPT"',
    'gh pr',
  ])('sees nothing in: %s', (command) => {
    expect(kinds(command)).toEqual([]);
  });

  it('keeps the directory of the command, and of its own variables only GH_REPO, as the repository', () => {
    expect(ghPrCalls('cd /tmp/x && PATH=/elsewhere GH_REPO=o/r gh pr ready 5', '/work/repo')).toEqual([
      { kind: 'ready', undo: false, exempt: false, selector: { text: '5', dynamic: false, quoted: false }, repo: { text: 'o/r', dynamic: false }, cwd: '/tmp/x' },
    ]);
    // gh puts -R before GH_REPO, and an empty GH_REPO names nothing
    const repoOf = (command) => ghPrCalls(command, '/work/repo')[0].repo;
    expect(repoOf('GH_REPO=o/r gh pr ready 5 -R a/b')).toMatchObject({ text: 'a/b', dynamic: false });
    expect(repoOf('GH_REPO= gh pr ready 5')).toBeNull();
    expect(repoOf('GH_REPO="$R" gh pr ready 5')).toEqual({ text: '', dynamic: true });
    expect(repoOf('gh pr ready 5 -R=a/b')).toEqual({ text: 'a/b', dynamic: false });
  });
});

describe('decide: gh pr create', () => {
  const create = (command) => decide(bash(command), world());

  it.each([
    'gh pr create --title "t" --body "b"',
    'gh pr new --title t --body b',
    'git push -u origin HEAD 2>&1 | tail -4 && gh pr create --base main --title t --body-file body.md',
    'URL=$(gh pr create --title t --body b)',
    // each of these looks like the flag and is not
    'gh pr create --title "--draft" --body b',
    'gh pr create -t d -b b',
    'gh pr create -Bdevelop -t t',
    'gh pr create --draft=false --title t',
    'gh pr create -d=false --title t',
    'gh pr create --web=false --title t --body b',
    'gh pr create --dry-run=0 -w=false --title t --body b',
    'gh pr create --title t -- --draft',
    'gh pr create --title t --body "$(cat <<\'EOF\'\nOpened with --draft, see gh pr create -d\nEOF\n)"',
  ])('refuses: %s', (command) => {
    expect(create(command)).toEqual({ deny: CREATE_MESSAGE });
  });

  it.each([
    'gh pr create --draft --title t --body b',
    'gh pr create -d -t t -b b',
    'gh pr create -fd',
    'gh pr create --title t --body b --draft',
    'gh pr create --draft=true --title t',
    'gh pr create -fd=true',
    'gh pr create "--draft" --title t',
    'gh pr create -t"$TITLE" --draft',
    'gh pr create --title="$TITLE" -d',
    'git push && gh pr create --draft --title t --body-file body.md',
    'gh pr create --draft --title t --body "$(cat <<\'EOF\'\nbody\nEOF\n)"',
    // nothing is opened by these
    'gh pr create --help',
    'gh pr create -h',
    'gh pr create --web',
    'gh pr create --web=true --title t',
    'gh pr create -w=1 --title t',
    'gh pr create --dry-run --title t --body b',
    // a flag out of a variable could be --draft: let it through
    'gh pr create $FLAGS --title t',
    'gh pr create "${ARGS[@]}"',
    'gh pr create --draft="$DRAFT" --title t',
    // not the command at all
    'git commit -m "docs: run gh pr create without --draft"',
    'git commit -F - <<EOF\nOpen it with gh pr create\nEOF',
    'echo "gh pr create" && echo \'gh pr create\'',
    'ls # gh pr create',
    'grep -rn "gh pr create" CLAUDE.md',
    'false || echo gh pr create',
  ])('lets through: %s', (command) => {
    expect(create(command)).toEqual({});
  });

  it('refuses when one create of several lacks the flag', () => {
    expect(create('gh pr create --draft -t a -b b && gh pr create -t c -b d')).toEqual({ deny: CREATE_MESSAGE });
  });

  it.each([
    ['a cd into its checkout', 'cd /work/elsewhere && gh pr create -t t -b b'],
    ['a cd into a directory of its checkout', 'cd /work/elsewhere/docs && gh pr create -t t -b b'],
    ['-R', 'gh pr create -R acme/gadgets --head me:fix -t t -b b'],
    ['--repo, with a host', 'gh pr create --repo=github.com/acme/gadgets -t t -b b'],
    ['-R at the end of a cluster', 'gh pr create -fRacme/gadgets'],
    ['-R before the subcommand', 'gh -R acme/gadgets pr create -t t -b b'],
    ['GH_REPO', 'GH_REPO=acme/gadgets gh pr create -t t -b b'],
    ['a builtin cd into its checkout', 'builtin cd /work/elsewhere && gh pr create -t t -b b'],
  ])('leaves a create in another repository alone, named by %s', (_how, command) => {
    expect(create(command)).toEqual({});
  });

  it.each([
    ['in a worktree of this clone', 'cd /work/repo/.claude/worktrees/x && gh pr create -t t -b b'],
    ['that names this repository', 'gh pr create -R acme/widgets -t t -b b'],
    ['that names it in another case, with a host', 'gh pr create --repo github.com/Acme/Widgets -t t -b b'],
    ['that names it from another checkout', 'cd /work/elsewhere && gh pr create -R acme/widgets --head fix -t t -b b'],
    ['in a directory that is no repository', 'cd /tmp/nowhere && gh pr create -t t -b b'],
    ['in a directory it cannot follow', 'cd "$DIR" && gh pr create -t t -b b'],
    ['whose repository comes out of a variable', 'gh pr create -R "$REPO" -t t -b b'],
    ['whose repository, named before the subcommand, comes out of a variable', 'gh --repo="$REPO" pr create -t t -b b'],
    ['behind a builtin cd it has to follow', 'builtin cd /work/repo/.claude/worktrees/x && gh pr create -t t -b b'],
  ])('still refuses a create %s', (_where, command) => {
    expect(create(command)).toEqual({ deny: CREATE_MESSAGE });
  });

  it('takes a named repository for this one when the checkout has no origin to compare it with', () => {
    const runGit = fakeGit({ '/work/repo': { gitDir: '/work/repo/.git', origin: null } });
    expect(decide(bash('gh pr create -R acme/gadgets -t t -b b'), world({ runGit }))).toEqual({ deny: CREATE_MESSAGE });
  });

  it('says what to do, and how the user can open a ready PR anyway', () => {
    expect(CREATE_MESSAGE).toContain('`--draft`');
    expect(CREATE_MESSAGE).toContain('CLAUDE.md');
    expect(CREATE_MESSAGE).toContain('run the command themselves');
  });
});

describe('decide: gh pr ready', () => {
  it('lets a PR through once a comment says the review ran', () => {
    const gh = fakeGh(['Some other comment', REVIEWED]);
    expect(decide(bash('gh pr ready 834'), world(gh))).toEqual({});
    expect(gh.calls).toEqual([{ args: ['pr', 'view', '834', '--json', 'number,comments'], options: { cwd: '/work/repo', timeout: GH_BUDGET_MS } }]);
  });

  it('refuses a PR with no such comment, naming it', () => {
    const gh = fakeGh(['LGTM', 'Note: `/code-review xhigh --fix` ran earlier'], 12);
    expect(decide(bash('gh pr ready 12'), world(gh))).toEqual({ deny: readyMessage(12) });
    expect(readyMessage(12)).toContain('PR #12');
    expect(readyMessage(12)).toContain('in a command of its own');
  });

  it('refuses a ready chained after the comment that would allow it: GitHub is read before the command starts', () => {
    const gh = fakeGh([]);
    expect(decide(bash('gh pr comment 834 --body-file c.md && gh pr ready 834'), world(gh))).toEqual({ deny: readyMessage(834) });
  });

  const view = (...target) => ['pr', 'view', ...target, '--json', 'number,comments'];
  const URL_HERE = 'https://github.com/acme/widgets/pull/5';

  it.each([
    ['the branch of the working directory', 'gh pr ready', view(), '/work/repo'],
    ['a URL', `gh pr ready ${URL_HERE}`, view(URL_HERE), '/work/repo'],
    ['a branch', 'gh pr ready my-branch', view('my-branch'), '/work/repo'],
    ['this repository, named', 'gh pr ready 5 -R acme/widgets', view('5', '--repo', 'acme/widgets'), '/work/repo'],
    ['this repository, named before the subcommand', 'gh --repo=acme/widgets pr ready 5', view('5', '--repo', 'acme/widgets'), '/work/repo'],
    ['a worktree of this clone', 'cd .claude/worktrees/x && gh pr ready', view(), '/work/repo/.claude/worktrees/x'],
    ['a directory that is no repository', 'cd ../other && gh pr ready 7', view('7'), '/work/other'],
    ['this repository, from the checkout of another', `cd /work/elsewhere && gh pr ready ${URL_HERE}`, view(URL_HERE), '/work/elsewhere'],
    ['no stray descriptor', 'gh pr ready 2>/dev/null', view(), '/work/repo'],
  ])('asks GitHub about %s', (_what, command, args, cwd) => {
    const gh = fakeGh([REVIEWED]);
    expect(decide(bash(command), world(gh))).toEqual({});
    expect(gh.calls.map((c) => [c.args, c.options.cwd])).toEqual([[args, cwd]]);
  });

  it.each([
    ['a pull request URL', 'gh pr ready https://github.com/acme/gadgets/pull/5'],
    ['a URL, which gh puts before -R', 'gh pr ready https://github.com/acme/gadgets/pull/5 -R acme/widgets'],
    ['-R', 'gh pr ready 5 -R acme/gadgets'],
    ['GH_REPO', 'GH_REPO=acme/gadgets gh pr ready 5'],
    ['a cd into its checkout', 'cd /work/elsewhere && gh pr ready 5'],
  ])('leaves the pull request of another repository alone, named by %s', (_how, command) => {
    expect(decide(bash(command), world())).toEqual({});
  });

  it('hands gh nothing of the environment the command sets for itself: it runs before the command is approved', () => {
    const gh = fakeGh([REVIEWED]);
    decide(bash('PATH=/tmp/evil DYLD_INSERT_LIBRARIES=/tmp/x.dylib GH_REPO=acme/widgets gh pr ready 5'), world(gh));
    // GH_REPO only says which repository: it becomes --repo
    expect(gh.calls).toEqual([
      { args: ['pr', 'view', '5', '--repo', 'acme/widgets', '--json', 'number,comments'], options: { cwd: '/work/repo', timeout: GH_BUDGET_MS } },
    ]);
  });

  it.each([
    ['opens it in the same command', 'gh pr create --draft -t t -b b && gh pr ready', 'no pull requests found for branch "claude/x"'],
    ['names a number GitHub does not have', 'gh pr ready 999999', 'GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)'],
  ])('refuses a ready on a PR that is not on GitHub: one that %s', (_what, command, stderr) => {
    const runGh = () => ({ status: 1, stdout: '', stderr: `${stderr}\nmore` });
    expect(decide(bash(command), world({ runGh }))).toEqual({ deny: missingMessage(stderr) });
    expect(missingMessage(stderr)).toContain('in a command of its own');
  });

  it('shares its time for GitHub between the readies of one command', () => {
    const gh = fakeGh([REVIEWED]);
    decide(bash('gh pr ready 1 && gh pr ready 2 && gh pr ready 3'), world(gh));
    expect(gh.calls.map((c) => c.options.timeout)).toEqual([GH_BUDGET_MS / 3, GH_BUDGET_MS / 3, GH_BUDGET_MS / 3]);
  });

  it.each(['gh pr ready --undo 834', 'gh pr ready 834 --undo', 'gh pr ready --help', 'gh pr ready -h'])(
    'does not ask GitHub for: %s',
    (command) => {
      expect(decide(bash(command), world())).toEqual({});
    },
  );

  it.each([
    ['a PR number out of a variable', 'gh pr ready "$PR"', 'comes out of a variable'],
    ['a repository out of a variable', 'gh pr ready 5 -R "$REPO"', 'comes out of a variable'],
    ['a directory it cannot follow', 'cd "$DIR" && gh pr ready 5', 'could not be followed'],
  ])('lets through, saying so, %s', (_what, command, why) => {
    const { note, deny } = decide(bash(command), world());
    expect(deny).toBeUndefined();
    expect(note).toContain('did not check `gh pr ready`');
    expect(note).toContain(why);
  });

  it('still checks a URL or a named repository when the directory is unknown', () => {
    for (const command of [`cd "$DIR" && gh pr ready ${URL_HERE}`, 'cd "$DIR" && gh pr ready 5 -R acme/widgets']) {
      expect(decide(bash(command), world(fakeGh([])))).toEqual({ deny: readyMessage(834) });
    }
  });

  it.each([
    ['gh exits non-zero', () => ({ status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\nmore' }), 'HTTP 502: Bad Gateway'],
    ['gh cannot be started', () => { throw new Error('spawnSync gh ENOENT'); }, 'spawnSync gh ENOENT'],
    ['gh answers something that is not JSON', () => ({ status: 0, stdout: '<html>', stderr: '' }), 'gh could not read the pull request'],
  ])('lets through, saying so, when %s', (_what, runGh, why) => {
    const { note, deny } = decide(bash('gh pr ready 5'), world({ runGh }));
    expect(deny).toBeUndefined();
    expect(note).toContain(why);
  });

  it('checks every ready of the command, and stops at the first PR without the comment', () => {
    const asked = [];
    const runGh = (args) => {
      asked.push(args[2]);
      const comments = args[2] === '1' ? [{ body: REVIEWED }] : [];
      return { status: 0, stdout: JSON.stringify({ number: Number(args[2]), comments }), stderr: '' };
    };
    expect(decide(bash('gh pr ready 1 && gh pr ready 2 && gh pr ready 3'), world({ runGh }))).toEqual({ deny: readyMessage(2) });
    expect(asked).toEqual(['1', '2']);
  });
});

describe('REVIEW_COMMENT', () => {
  it.each([
    '`/code-review xhigh --fix` ran on 4e0dcea4.',
    '/code-review xhigh --fix ran on 4e0dcea4',
    '`/code-review max --fix` ran on 4e0dcea4: nothing found.',
    '\n  `/code-review xhigh --fix` ran on 4e0dcea4.',
  ])('accepts a comment that opens with: %j', (body) => {
    expect(REVIEW_COMMENT.test(body)).toBe(true);
  });

  it.each([
    '`/code-review high --fix` ran on 4e0dcea4.',
    '`/code-review xhigh` ran on 4e0dcea4.',
    '`/code-review xhigh --fix` range',
    'Follow-up: `/code-review xhigh --fix` ran on 4e0dcea4.',
    'I will run `/code-review xhigh --fix` next.',
  ])('rejects: %j', (body) => {
    expect(REVIEW_COMMENT.test(body)).toBe(false);
  });
});

describe('decide: everything else', () => {
  it.each([
    ['another tool', { tool_name: 'Edit', tool_input: { file_path: 'gh pr create' } }],
    ['a Bash call with no command', { tool_name: 'Bash', tool_input: {} }],
    ['no input at all', null],
    ['a command without gh', bash('npm run check')],
    ['a command line it cannot read', bash('gh pr create --title "unclosed')],
  ])('says nothing for %s', (_what, input) => {
    expect(decide(input, world())).toEqual({});
  });

  it('uses the directory of the hook process when the input names none', () => {
    const gh = fakeGh([REVIEWED]);
    decide({ tool_name: 'Bash', tool_input: { command: 'gh pr ready' } }, world(gh));
    expect(gh.calls[0].options.cwd).toBe(process.cwd());
  });
});

describe('the hook as Claude Code runs it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pr-guard-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // A `gh` that prints $FAKE_GH_JSON, or fails when it is unset.
  const fakeBin = join(scratch, 'bin');
  writeFileSync(join(scratch, 'fake-gh.sh'), '#!/bin/sh\n[ -n "$FAKE_GH_JSON" ] || { echo "fake gh: no network" >&2; exit 1; }\nprintf \'%s\' "$FAKE_GH_JSON"\n');
  chmodSync(join(scratch, 'fake-gh.sh'), 0o755);
  mkdirSync(fakeBin);
  symlinkSync(join(scratch, 'fake-gh.sh'), join(fakeBin, 'gh'));

  function runHook(stdin, { script = hookPath, env = {} } = {}) {
    const result = spawnSync(process.execPath, [script], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_GH_JSON: '', ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const withComments = (...bodies) => ({ FAKE_GH_JSON: JSON.stringify({ number: 834, comments: bodies.map((body) => ({ body })) }) });

  it('prints nothing and exits 0 for a command it has no say on', () => {
    expect(runHook(JSON.stringify(bash('npm run check')))).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(runHook(JSON.stringify(bash('gh pr create --draft --title t --body b')))).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(runHook(JSON.stringify(bash('gh pr ready 834', repoRoot)), { env: withComments(REVIEWED) })).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('denies a create without --draft in the shape PreToolUse reads', () => {
    const { status, stdout } = runHook(JSON.stringify(bash('gh pr create --title t --body b')));
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: CREATE_MESSAGE },
    });
  });

  it('denies a ready on a PR without the comment, having asked gh', () => {
    const { status, stdout } = runHook(JSON.stringify(bash('gh pr ready 834', repoRoot)), { env: withComments('LGTM') });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: readyMessage(834),
    });
  });

  it('decides nothing when gh fails, and tells both the user and Claude', () => {
    const { status, stdout } = runHook(JSON.stringify(bash('gh pr ready 834', repoRoot)));
    expect(status).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: output.systemMessage });
    expect(output.systemMessage).toContain('fake gh: no network');
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('starts gh with its own environment, not the one the command sets', () => {
    // were this assignment handed on, the fake gh would answer with a reviewed PR and the hook would say nothing
    const reviewed = JSON.stringify({ number: 834, comments: [{ body: REVIEWED }] });
    const { stdout } = runHook(JSON.stringify(bash(`FAKE_GH_JSON='${reviewed}' gh pr ready 834`, repoRoot)));
    expect(JSON.parse(stdout).systemMessage).toContain('fake gh: no network');
  });

  it('turns a failure of its own into a note, and lets the command through', () => {
    // nested deep enough to overflow the reader's stack
    const { status, stdout, stderr } = runHook(JSON.stringify(bash(`gh pr create ${'$('.repeat(20_000)}`)));
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
    const output = JSON.parse(stdout);
    expect(output.systemMessage).toContain('pr-guard failed and checked nothing');
    expect(output.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: output.systemMessage });
  });

  it.each([['no input', ''], ['input that is not JSON', 'gh pr create'], ['JSON that is not a hook input', '[1, 2]']])(
    'exits 0 without a word on %s',
    (_what, stdin) => {
      expect(runHook(stdin)).toEqual({ status: 0, stdout: '', stderr: '' });
    },
  );

  it('guards this repository and its worktrees, and leaves the checkout of another alone', () => {
    // Real git this time: the hook asks it which repository a directory belongs to.
    // The other repository is made by hand: HEAD, objects/ and refs/ are what git takes for one.
    const other = join(scratch, 'other-repo');
    mkdirSync(join(other, '.git/objects'), { recursive: true });
    mkdirSync(join(other, '.git/refs'));
    writeFileSync(join(other, '.git/HEAD'), 'ref: refs/heads/main\n');
    const create = (cwd, env) => runHook(JSON.stringify(bash('gh pr create --title t --body b', cwd)), { env });
    expect(create(other)).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(create(repoRoot).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.parse(create(join(repoRoot, 'scripts/ci')).stdout).hookSpecificOutput.permissionDecision).toBe('deny');

    // Started under a git hook, it inherits a GIT_DIR that names this
    // repository whatever the directory: the other checkout is still another.
    const thisGitDir = git(['rev-parse', '--absolute-git-dir'], repoRoot).stdout.trim();
    const underGitHook = { GIT_DIR: thisGitDir, GIT_INDEX_FILE: join(thisGitDir, 'index') };
    expect(create(other, underGitHook)).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(create(repoRoot, underGitHook).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('still runs when its path goes through a symlink', () => {
    // Node resolves the main module's real path, so a check that compared it
    // with argv[1] as given would see two different files, and guard nothing.
    const link = join(scratch, 'linked-repo');
    symlinkSync(repoRoot, link);
    try {
      const { stdout } = runHook(JSON.stringify(bash('gh pr create --title t --body b')), { script: join(link, '.claude/hooks/pr-guard.mjs') });
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      // gone before the scratch directory is deleted with everything under it
      unlinkSync(link);
    }
  });
});

describe('.claude/settings.json', () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, '.claude/settings.json'), 'utf8'));
  const bashHooks = (settings.hooks?.PreToolUse ?? []).filter((entry) => entry.matcher === 'Bash').flatMap((entry) => entry.hooks);

  it('runs the guard before every Bash call', () => {
    expect(bashHooks).toHaveLength(1);
    const [hook] = bashHooks;
    expect(hook.type).toBe('command');
    expect(hook.command).toBe('node "$CLAUDE_PROJECT_DIR"/.claude/hooks/pr-guard.mjs');
    // an `if` filter would spare a process per call, but it is matched against
    // the subcommands Claude Code can split out: `env … gh pr create` and
    // `bash -c '…'` would slip past it
    expect(hook.if).toBeUndefined();
    expect(existsSync(hookPath)).toBe(true);
  });

  it('outlasts the time the guard gives GitHub and git: a hook that is killed lets the command through unnoticed', () => {
    const [hook] = bashHooks;
    // the budget for gh, and four git lookups of two seconds at most
    expect(hook.timeout * 1000).toBeGreaterThanOrEqual(GH_BUDGET_MS + 4 * 2000);
    expect(hook.timeout).toBeLessThanOrEqual(30);
  });

  it('is tracked with its hook, while local Claude Code state stays ignored', () => {
    const ignored = (path) => git(['check-ignore', '-q', path], repoRoot).status === 0;
    expect(ignored('.claude/settings.json')).toBe(false);
    expect(ignored('.claude/hooks/pr-guard.mjs')).toBe(false);
    expect(ignored('.claude/settings.local.json')).toBe(true);
    expect(ignored('.claude/worktrees/x/file')).toBe(true);
  });
});
