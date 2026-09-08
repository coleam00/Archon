import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { changedFilesBetween, shouldRunTestSuite } from './should-run-test-suite';

const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

describe('test-suite change decision', () => {
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
    ['.archon/commands/defaults/archon-assist.md', 'a legacy command prompt'],
    ['.archon/workflows/sdlc/implement/commands/implement.md', 'a packaged command prompt'],
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

  test('runs for a push that creates a branch', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const result = Bun.spawnSync(['bun', script, 'push', EMPTY_GIT_SHA, 'unavailable-head'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('true');
  });

  /**
   * A force-push leaves `github.event.before` unreachable. The decision must still be a decision:
   * an empty stdout here is read as "skip" by every downstream gate.
   */
  test('an unreadable diff resolves to running the suite, with the cause on stderr', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const unreachable = '1'.repeat(40);
    const result = Bun.spawnSync(['bun', script, 'push', unreachable, 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('true');
    expect(result.stderr.toString()).toContain(`Could not compare ${unreachable}..HEAD`);
  });

  test('a bad argument stays fatal, so the step cannot publish an empty decision', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const result = Bun.spawnSync(['bun', script, 'not-a-github-event', 'base', 'head'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString().trim()).toBe('');
    expect(result.stderr.toString()).toContain('Unsupported GitHub event: not-a-github-event');
  });

  test('the workflow delegates both automatic routes to the complete-diff decision', () => {
    // A Windows checkout writes the workflow with CRLF endings, and every assertion below
    // anchors on LF. Normalize at the read site: what is asserted is YAML structure, not
    // the line terminator the working tree happens to carry.
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const changesJob = workflow.slice(workflow.indexOf('  changes:'), workflow.indexOf('  test:'));

    expect(workflow).toContain('  push:\n');
    expect(workflow).toContain('  pull_request:\n');
    expect(workflow).not.toContain('\n    paths:');
    expect(changesJob).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(changesJob).toContain(
      'BASE_SHA: ${{ github.event.before || github.event.pull_request.base.sha }}'
    );
    expect(changesJob).toContain(
      'HEAD_SHA: ${{ github.event.after || github.event.pull_request.head.sha }}'
    );
    expect(changesJob).toContain('fetch-depth: 0');
    expect(changesJob).toContain('uses: oven-sh/setup-bun@v2');

    // Pin the invocation itself, not just its parts. The script reads three positional
    // arguments, so a reordering that sends a SHA into `eventName` has to fail here — and the
    // assignment must stay separate from the `echo`, which is what makes a crash fail the step.
    expect(changesJob).toContain(
      'run_tests=$(bun scripts/should-run-test-suite.ts "$EVENT_NAME" "$BASE_SHA" "$HEAD_SHA")\n'
    );
    expect(changesJob).toContain('echo "run-tests=$run_tests" >> "$GITHUB_OUTPUT"');
  });

  test('the workflow fixture bar runs for every pull request', () => {
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const pullRequestTrigger = workflow.slice(
      workflow.indexOf('  pull_request:'),
      workflow.indexOf('\n\nenv:')
    );
    const fixtureJob = workflow.slice(
      workflow.indexOf('  workflow-fixtures:'),
      workflow.indexOf('  test:')
    );

    expect(pullRequestTrigger).toBe('  pull_request:\n    branches: [main, dev]');
    expect(fixtureJob).toContain("if: github.event_name == 'pull_request'");
    expect(fixtureJob).toContain('runs-on: ubuntu-latest');
    expect(fixtureJob).not.toContain('needs:');
    expect(fixtureJob).not.toContain('changes');
    expect(fixtureJob).toContain('uses: actions/checkout@v4');
    expect(fixtureJob).toContain('uses: oven-sh/setup-bun@v2');
    expect(fixtureJob).toContain('bun-version: ${{ env.BUN_VERSION }}');
    expect(fixtureJob).toContain('uses: astral-sh/setup-uv@v4');
    expect(fixtureJob).toContain('run: bun install --frozen-lockfile');
    expect(fixtureJob).toContain('run: bun run cli workflow test --json');
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
});

describe('inert paths', () => {
  test.each([
    '.gitignore',
    '.gitattributes',
    'LICENSE',
    '.env.example',
    'Caddyfile.example',
    '.archon/config.example.yaml',
    'assets/logo.png',
  ])('skips %s, which no check reads', file => {
    expect(shouldRunTestSuite([file])).toBe(false);
  });

  test.each([
    ['Dockerfile', 'the docker-build job'],
    ['.dockerignore', 'the docker-build job'],
    ['.prettierrc', 'format:check'],
    ['homebrew/archon.rb', 'build:checksums'],
    ['scripts/install.ps1', 'test:install'],
    ['.github/workflows/test.yml', 'the gate itself'],
    ['packages/web/public/favicon.png', 'the web build'],
  ])('runs for %s, which is read by %s', file => {
    expect(shouldRunTestSuite([file])).toBe(true);
  });
});
