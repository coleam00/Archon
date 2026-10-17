import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  collectBundleSources,
  readBundleIndex,
} from '../packages/workflows/src/defaults/bundle-inventory';
import {
  changedFilesBetween,
  diffRange,
  proofFromPullRequestRun,
  shouldRunTestSuite,
  shouldRunWorkflowFixtures,
  type EventPayload,
  type GitHubGet,
} from './should-run-test-suite';

const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';
const SCRIPT = resolve(import.meta.dir, 'should-run-test-suite.ts');

/** Runs the script the way the workflow does: GitHub names the event and hands over its payload. */
function runDecision(
  trackTempRoot: (root: string) => string,
  eventName: string,
  payload: EventPayload,
  cwd = process.cwd(),
  args: readonly string[] = []
): { exitCode: number; stdout: string; stderr: string } {
  const eventDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-event-')));
  const eventPath = join(eventDir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const result = Bun.spawnSync(['bun', SCRIPT, ...args], {
    cwd,
    // An empty token keeps every push decision here away from the GitHub API.
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

describe('test-suite change decision', () => {
  const trackTempRoot = trackTempRoots();

  test.each(['push', 'pull_request'])('%s skips Markdown-only changes', () => {
    expect(shouldRunTestSuite(['README.md', 'packages/core/notes.md'])).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s skips docs-source-only changes', () => {
    expect(
      shouldRunTestSuite([
        'packages/docs-web/src/content/docs/guide.mdx',
        'packages/docs-web/public/logo.svg',
      ])
    ).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s runs when the docs manifest changes', () => {
    expect(shouldRunTestSuite(['packages/docs-web/package.json'])).toBe(true);
  });

  test('runs for a non-documentation change after thousands of documentation files', () => {
    const changedFiles = [
      ...Array.from({ length: 3_001 }, (_, index) => `docs/${index}.md`),
      'packages/docs-web/package.json',
    ];

    expect(shouldRunTestSuite(changedFiles)).toBe(true);
  });

  test.each([
    ['.archon/workflows/sdlc/implement/commands/implement.md', 'a packaged command prompt'],
    ['.archon/workflows/sdlc/.shared/policy/triage.md', 'a pack .shared/ document'],
    ['.claude/skills/archon-cli/SKILL.md', 'the bundled CLI skill'],
    ['packages/docs-web/src/content/docs/reference/provider-capabilities.md', 'a generated doc'],
  ])('runs for %s, which is %s rather than prose', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('still skips genuine prose, inside the docs site and out', () => {
    expect(
      shouldRunTestSuite([
        'README.md',
        'AGENTS.md',
        'packages/docs-web/src/content/docs/guides/authoring-workflows.md',
      ])
    ).toBe(false);
  });

  test.each([
    '.archon/workflows/sdlc/README.md',
    '.archon/workflows/sdlc/CONSTITUTION.md',
    '.archon/workflows/sdlc/validate/README.md',
  ])('skips pack prose %s, which the bundle does not compile', file => {
    expect(shouldRunTestSuite([file])).toBe(false);
  });

  /** `bundle-inventory.ts` selects what `check:bundled` compiles, so it owns this family. */
  test('every Markdown file the bundle compiles runs the suite', async () => {
    const repoRoot = resolve(import.meta.dir, '..');
    const sources = await collectBundleSources(
      join(repoRoot, '.archon/workflows'),
      await readBundleIndex()
    );
    const markdown = sources
      .map(source => relative(repoRoot, source.sourcePath).replaceAll('\\', '/'))
      .filter(path => path.endsWith('.md'));

    expect(markdown.length).toBeGreaterThan(0);
    for (const file of markdown) expect([file, shouldRunTestSuite([file])]).toEqual([file, true]);
  });

  /**
   * The exclusion list above is written by hand, so it can only stay true if something checks it
   * against what the build actually reads. `bundled-skill.ts` compiles each of these files into
   * the CLI with a text import, which makes its import list the owning source for that family.
   */
  test('every Markdown file compiled into the CLI skill runs the suite', () => {
    const bundledSkill = readFileSync(
      resolve(import.meta.dir, '../packages/cli/src/bundled-skill.ts'),
      'utf8'
    );
    const imported = [...bundledSkill.matchAll(/'[^']*\/(\.claude\/skills\/[^']+\.md)'/g)].map(
      match => match[1]
    );

    expect(imported.length).toBeGreaterThan(0);
    for (const file of imported) expect(shouldRunTestSuite([file])).toBe(true);
  });

  test('a push that creates a branch has nothing to compare, so the suite runs', () => {
    expect(diffRange('push', { before: EMPTY_GIT_SHA, after: 'unavailable-head' })).toBeNull();
    expect(diffRange('workflow_dispatch', {})).toBeNull();
  });

  test('a push spans what it added', () => {
    expect(diffRange('push', { before: 'previous-tip', after: 'new-tip' })).toEqual({
      base: 'previous-tip',
      head: 'new-tip',
    });
  });

  test('a pull request is judged on its whole diff, never on the previous push', () => {
    // A `synchronize` payload carries both. `before` is the previous push's head.
    const synchronize: EventPayload = {
      before: 'previous-push-head',
      after: 'pr-head',
      pull_request: { base: { sha: 'pr-base' }, head: { sha: 'pr-head' } },
    };
    expect(diffRange('pull_request', synchronize)).toEqual({ base: 'pr-base', head: 'pr-head' });
  });

  test('a payload missing the commits it needs is fatal rather than a skip', () => {
    expect(() => diffRange('pull_request', { before: 'a', after: 'b' })).toThrow(
      'pull_request.base.sha'
    );
    expect(() => diffRange('push', {})).toThrow('before');
  });

  /**
   * A force-push leaves `github.event.before` unreachable. The decision must still be a decision:
   * an empty stdout here is read as "skip" by every downstream gate.
   */
  test('an unreadable diff resolves to running the fixtures, with the cause on stderr', () => {
    const unreachable = '1'.repeat(40);
    const result = runDecision(
      trackTempRoot,
      'push',
      { before: unreachable, after: 'HEAD' },
      process.cwd(),
      ['--workflow-fixtures']
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
    expect(result.stderr).toContain(`Could not compare ${unreachable}..HEAD`);
  });

  test('a push without API credentials runs the suite and says why', () => {
    const result = runDecision(trackTempRoot, 'push', { before: 'HEAD~1', after: 'HEAD' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
    expect(result.stderr).toContain('No pull request run proves this push');
    expect(result.stderr).toContain('GITHUB_TOKEN');
  });

  test('a bad event stays fatal, so the step cannot publish an empty decision', () => {
    const result = runDecision(trackTempRoot, 'not-a-github-event', {});

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported GitHub event: not-a-github-event');
  });
});

describe('diff mode', () => {
  const trackTempRoot = trackTempRoots();

  const git = (cwd: string, ...args: string[]): void => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  };

  const commit = (repo: string, file: string, message: string): string => {
    writeFileSync(join(repo, file), `${message}\n`);
    git(repo, 'add', file);
    git(repo, 'commit', '-m', message);
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo, stdout: 'pipe' })
      .stdout.toString()
      .trim();
  };

  /**
   * The shape that disabled this filter in production: a docs-only branch whose base moved on.
   * A two-dot `git diff base head` also reports the base's own new commit and forces the suite;
   * the merge-base diff reports only what the branch changed.
   */
  function docsBranchWithMovedBase(): { repo: string; base: string; head: string } {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    commit(repo, 'seed.ts', 'seed');

    git(repo, 'checkout', '-q', '-b', 'docs-branch');
    const head = commit(repo, 'GUIDE.md', 'docs only');

    git(repo, 'checkout', '-q', 'main');
    const base = commit(repo, 'unrelated.ts', 'landed on the base after the branch point');

    return { repo, base, head };
  }

  test('a docs-only branch skips even when the base branch moved on', () => {
    const { repo, base, head } = docsBranchWithMovedBase();
    // Seen red against the previous two-dot call: it also reported `unrelated.ts`.
    expect(changedFilesBetween(base, head, repo)).toEqual(['GUIDE.md']);
    expect(shouldRunTestSuite(changedFilesBetween(base, head, repo))).toBe(false);
    const result = runDecision(
      trackTempRoot,
      'pull_request',
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      repo,
      ['--workflow-fixtures']
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('false');
  });

  test.each(
    process.platform === 'win32'
      ? ['é.yaml']
      : ['é.yaml', 'quote".yaml', 'back\\slash.yaml', 'tab\t.yaml', 'line\n.yaml']
  )('fixture decision preserves Git-quoted filename %j', filename => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-fixture-path-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'core.quotepath', 'true');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const base = commit(repo, 'seed.ts', 'seed');
    mkdirSync(join(repo, '.archon/workflows/sdlc/fixtures'), { recursive: true });
    const file = `.archon/workflows/sdlc/fixtures/${filename}`;
    const head = commit(repo, file, 'fixture change');
    expect(changedFilesBetween(base, head, repo)).toEqual([file]);
    const result = runDecision(
      trackTempRoot,
      'pull_request',
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      repo,
      ['--workflow-fixtures']
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
  });

  test('a code change on the branch still runs the suite', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const base = commit(repo, 'seed.ts', 'seed');
    git(repo, 'checkout', '-q', '-b', 'code-branch');
    const head = commit(repo, 'feature.ts', 'real code');

    expect(shouldRunTestSuite(changedFilesBetween(base, head, repo))).toBe(true);
  });

  /**
   * The PR #3415 shape: a code push, then a docs-only push. Concurrency cancels the first push's
   * run, so the second push's decision is the only one the PR head gets.
   */
  test('a docs-only push on top of a code push still runs the suite for the pull request', () => {
    const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-diff-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    const prBase = commit(repo, 'seed.ts', 'seed');
    git(repo, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(repo, 'packages/workflows/src'), { recursive: true });
    const codePush = commit(repo, 'packages/workflows/src/dry-run.ts', 'real code');
    const docsPush = commit(repo, 'GUIDE.md', 'docs only');

    const result = runDecision(
      trackTempRoot,
      'pull_request',
      {
        before: codePush,
        after: docsPush,
        pull_request: { base: { sha: prBase }, head: { sha: docsPush } },
      },
      repo
    );

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('true');
    const fixtures = runDecision(
      trackTempRoot,
      'pull_request',
      {
        before: codePush,
        after: docsPush,
        pull_request: { base: { sha: prBase }, head: { sha: docsPush } },
      },
      repo,
      ['--workflow-fixtures']
    );
    expect(fixtures.exitCode).toBe(0);
    expect(fixtures.stdout).toBe('true');
  });
});

describe('inert paths', () => {
  test.each([
    '.gitignore',
    'LICENSE',
    '.env.example',
    '.archon/config.example.yaml',
    'assets/logo.png',
  ])('skips %s, which no check reads', file => {
    expect(shouldRunTestSuite([file])).toBe(false);
  });

  test.each([
    ['Dockerfile', 'the docker-build job'],
    ['.dockerignore', 'the docker-build job'],
    ['biome.jsonc', 'lint and format:check'],
    ['homebrew/archon.rb', 'build:checksums'],
    ['scripts/install.ps1', 'test:install'],
    ['.github/workflows/test.yml', 'the gate itself'],
    ['packages/web/public/favicon.png', 'the web build'],
    ['Caddyfile.example', 'reverse-proxy.test.ts and caddy-recipe.test.ts'],
    ['.gitattributes', 'every checkout'],
  ])('runs for %s, which is read by %s', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });
});

describe('workflow fixture selection', () => {
  const track = trackTempRoots();
  test.each([
    '.archon/workflows/sdlc/implement/workflow.yaml',
    '.archon/workflows/sdlc/scripts/route.ts',
    '.archon/workflows/sdlc/commands/implement.md',
    '.archon/workflows/sdlc/fixtures/pass.yaml',
    'packages/workflows/src/fixture-runner.ts',
    'packages/workflows/src/dry-run.ts',
    'packages/cli/src/commands/workflow.ts',
    'packages\\workflows\\src\\schema.ts',
  ])('runs for %s', file => {
    expect(shouldRunWorkflowFixtures([file])).toBe(true);
  });
  test.each([
    'README.md',
    'packages/web/src/app.ts',
    'packages/core/src/index.ts',
    'packages/providers/src/index.ts',
    'scripts/validate.ts',
    '.archon/workflows/sdlc-extra/workflow.yaml',
    'packages/workflows/src-extra/index.ts',
    'packages/cli/src/commands/workflow.test.ts',
  ])('skips %s', file => {
    expect(shouldRunWorkflowFixtures([file])).toBe(false);
  });
  test.each([
    ['workflow_dispatch', {}],
    ['push', { before: EMPTY_GIT_SHA }],
    ['push', { before: 'unreachable', after: 'HEAD' }],
  ] as const)('runs for %s without a usable diff', (event, payload) => {
    const result = runDecision(track, event, payload, process.cwd(), ['--workflow-fixtures']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('true');
  });
  test.each([{ args: ['--unsupported'] }, { args: ['--workflow-fixtures', '--unsupported'] }])(
    'rejects unknown arguments %j',
    ({ args }) => {
      const result = runDecision(track, 'workflow_dispatch', {}, process.cwd(), args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  );
  test('rejects malformed fixture events', () => {
    const result = runDecision(track, 'pull_request', {}, process.cwd(), ['--workflow-fixtures']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('a push proven by its pull request run', () => {
  const PUSH = { head: 'squash-commit' };
  const PR_BASE = 'pr-base';
  const PR_HEAD = 'pr-head';
  const RUN_URL = 'https://github.com/coleam00/Archon/actions/runs/7';
  const JOBS = 'actions/runs/7/jobs?filter=latest&per_page=100';

  /** The API answers for a squash merge of a pull request whose head contained its base. */
  function provenApi(head = PUSH.head): Record<string, unknown> {
    return {
      [`commits/${head}/pulls`]: [
        { number: 3, merge_commit_sha: 'other', head: { sha: 'other-head' } },
        { number: 4, merge_commit_sha: head, base: { sha: PR_BASE }, head: { sha: PR_HEAD } },
      ],
      [`compare/${PR_BASE}...${PR_HEAD}`]: { status: 'ahead' },
      [`git/commits/${head}`]: { tree: { sha: 'tree-a' } },
      [`git/commits/${PR_HEAD}`]: { tree: { sha: 'tree-a' } },
      [`actions/workflows/test.yml/runs?head_sha=${PR_HEAD}&event=pull_request&status=success`]: {
        workflow_runs: [{ id: 7, html_url: RUN_URL }],
      },
      [JOBS]: {
        total_count: 2,
        jobs: [
          { name: 'changes', conclusion: 'success' },
          { name: 'test (windows-latest, packages)', conclusion: 'success' },
        ],
      },
    };
  }

  const getFrom =
    (answers: Record<string, unknown>): GitHubGet =>
    async path => {
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return answers[path];
    };

  const prove = (answers: Record<string, unknown>) =>
    proofFromPullRequestRun(PUSH, getFrom(answers));

  test('a synced squash merge whose run passed every job skips, naming its evidence', async () => {
    const proof = await prove(provenApi());

    expect(proof.proven).toBe(true);
    if (proof.proven) {
      expect(proof.evidence).toContain('#4');
      expect(proof.evidence).toContain(RUN_URL);
    }
  });

  test('a head identical to its base also proves', async () => {
    const answers = provenApi();
    answers[`compare/${PR_BASE}...${PR_HEAD}`] = { status: 'identical' };

    expect((await prove(answers)).proven).toBe(true);
  });

  test.each([
    [
      'a head that diverged from the base its run merged with',
      (answers: Record<string, unknown>) => {
        answers[`compare/${PR_BASE}...${PR_HEAD}`] = { status: 'diverged' };
      },
      'does not contain its base pr-base (diverged)',
    ],
    [
      'a head whose tree differs from the pushed tree',
      (answers: Record<string, unknown>) => {
        answers[`git/commits/${PR_HEAD}`] = { tree: { sha: 'tree-b' } };
      },
      'differ',
    ],
    [
      'a run that skipped a gated job (a prose-only pull request)',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 2,
          jobs: [
            { name: 'changes', conclusion: 'success' },
            { name: 'test (windows-latest, packages)', conclusion: 'skipped' },
          ],
        };
      },
      'test (windows-latest, packages)=skipped',
    ],
    [
      'a run whose latest attempt failed a job',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 1,
          jobs: [{ name: 'static', conclusion: 'failure' }],
        };
      },
      'static=failure',
    ],
    [
      'a run with more jobs than were read',
      (answers: Record<string, unknown>) => {
        answers[JOBS] = {
          total_count: 3,
          jobs: [{ name: 'changes', conclusion: 'success' }],
        };
      },
      '3 jobs, 1 read',
    ],
    [
      'a push no pull request was merged as (a direct push)',
      (answers: Record<string, unknown>) => {
        answers[`commits/${PUSH.head}/pulls`] = [
          { number: 3, merge_commit_sha: 'other', head: { sha: 'other-head' } },
        ];
      },
      'no pull request was merged as squash-commit',
    ],
    [
      'a head with no successful run',
      (answers: Record<string, unknown>) => {
        answers[
          `actions/workflows/test.yml/runs?head_sha=${PR_HEAD}&event=pull_request&status=success`
        ] = { workflow_runs: [] };
      },
      'no successful pull_request run of test.yml at pr-head',
    ],
    [
      'an API answer missing a field',
      (answers: Record<string, unknown>) => {
        answers[`git/commits/${PR_HEAD}`] = {};
      },
      'could not check pull request runs',
    ],
  ])('%s runs the suite', async (_case, change, reason) => {
    const answers = provenApi();
    change(answers);
    const proof = await prove(answers);

    expect(proof.proven).toBe(false);
    if (!proof.proven) expect(proof.reason).toContain(reason);
  });

  test('an API failure runs the suite and carries the cause', async () => {
    const proof = await proofFromPullRequestRun(PUSH, async path => {
      throw new Error(`GET ${path} answered 502`);
    });

    expect(proof).toEqual({
      proven: false,
      reason: `could not check pull request runs: GET commits/${PUSH.head}/pulls answered 502`,
    });
  });

  /**
   * The workflow's own path: the script reads the push event and asks a stub of the GitHub API.
   * The pushed commit only changes Markdown, so a decision that ignored the proof and followed
   * the diff would print `false` for the suite.
   */
  describe('the script', () => {
    const trackTempRoot = trackTempRoots();

    function docsOnlyPush(): { repo: string; before: string; after: string } {
      const repo = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-push-')));
      const git = (...args: string[]): string => {
        const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
        return r.stdout.toString().trim();
      };
      git('init', '-q', '-b', 'dev');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      const commit = (file: string): string => {
        writeFileSync(join(repo, file), `${file}\n`);
        git('add', file);
        git('commit', '-q', '-m', file);
        return git('rev-parse', 'HEAD');
      };
      const before = commit('seed.ts');
      return { repo, before, after: commit('GUIDE.md') };
    }

    async function runPush(
      answers: Record<string, unknown>,
      push: { repo: string; before: string; after: string },
      args: readonly string[] = []
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const prefix = '/repos/owner/repo/';
      using server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname.slice(prefix.length) + url.search;
          return path in answers
            ? Response.json(answers[path])
            : new Response('not found', { status: 404 });
        },
      });
      const eventDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'run-suite-event-')));
      const eventPath = join(eventDir, 'event.json');
      writeFileSync(eventPath, JSON.stringify({ before: push.before, after: push.after }));
      // Async spawn: a synchronous one would block the stub server this test runs.
      const child = Bun.spawn(['bun', SCRIPT, ...args], {
        cwd: push.repo,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: server.url.origin,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout: stdout.trim(), stderr };
    }

    test('a proven push skips the suite and logs its evidence', async () => {
      const push = docsOnlyPush();
      const result = await runPush(provenApi(push.after), push);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('false');
      expect(result.stderr).toContain(RUN_URL);
    });

    test('an unproven push runs the suite even when its diff is prose', async () => {
      const push = docsOnlyPush();
      const answers = provenApi(push.after);
      answers[`git/commits/${PR_HEAD}`] = { tree: { sha: 'tree-b' } };
      const result = await runPush(answers, push);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('true');
      expect(result.stderr).toContain('No pull request run proves this push');
    });

    test('an unproven push decides fixtures from its diff', async () => {
      const push = docsOnlyPush();
      const answers = provenApi(push.after);
      answers[`git/commits/${PR_HEAD}`] = { tree: { sha: 'tree-b' } };
      const result = await runPush(answers, push, ['--workflow-fixtures']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('false');
      expect(result.stderr).toContain('No pull request run proves this push');
    });
  });
});
