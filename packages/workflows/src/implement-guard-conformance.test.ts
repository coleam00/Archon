/**
 * The bundled implement pack's `assert-changed` guard reads the engine's checkout
 * observations but cannot import the engine's schema. These tests are the enforced
 * conformance between the two: the real observer produces every observation, and the
 * real guard script consumes it.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { observeCheckout } from './checkout-observation';
import type { CheckoutObservation } from './schemas/checkout-observation';

const GUARD = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.archon',
  'workflows',
  'sdlc',
  'implement',
  'scripts',
  'assert-changed.ts'
);
const RUN_ID = 'guard-run';
const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

interface Scratch {
  repo: string;
  artifacts: string;
  write(path: string, text: string): void;
  observe(): Promise<CheckoutObservation>;
}

function scratch(initial: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' }): Scratch {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'implement-guard-')));
  const repo = join(root, 'repo');
  const artifacts = join(root, 'artifacts');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const write = (path: string, text: string): void => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  for (const [path, text] of Object.entries(initial)) write(path, text);
  if (Object.keys(initial).length > 0) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  }
  return {
    repo,
    artifacts,
    write,
    observe: () =>
      observeCheckout(repo, { kind: 'host' }, { runId: RUN_ID, artifactsDir: artifacts }),
  };
}

interface Verdict {
  green?: boolean;
  redCause?: string;
  summary?: string;
}

async function guard(
  s: Scratch,
  baseline: CheckoutObservation,
  verdict: Verdict = {}
): Promise<{ passed: boolean; output: string }> {
  const current = await s.observe();
  const result = Bun.spawnSync(['bun', '--no-env-file', 'run', GUARD], {
    cwd: s.repo,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ARTIFACTS_DIR: s.artifacts,
      BASE_BRANCH: '',
      INPUTS_GREEN: String(verdict.green ?? false),
      INPUTS_RED_CAUSE: verdict.redCause ?? '',
      INPUTS_SUMMARY: verdict.summary ?? '',
      INPUTS_BASELINE: JSON.stringify(baseline),
      ARCHON_NODE_EXECUTION: JSON.stringify({
        runId: RUN_ID,
        path: 'assert-changed',
        invocation: { checkoutStart: current },
        attempt: { checkoutStart: current },
      }),
    },
  });
  return {
    passed: result.exitCode === 0,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

describe('implement assert-changed guard over engine checkout observations', () => {
  test('a clean start that changes nothing is refused', async () => {
    const s = scratch();
    const baseline = await s.observe();
    const verdict = await guard(s, baseline);
    expect(verdict.passed).toBe(false);
    expect(verdict.output).toContain('changed no content');
  });

  // The original defect: the guard compared against HEAD, so dirt that existed before
  // implement started passed as new work with no implementation activity at all.
  test.each([
    ['unstaged', (s: Scratch): void => s.write('a.txt', 'dirty\n')],
    [
      'staged',
      (s: Scratch): void => {
        s.write('a.txt', 'dirty\n');
        git(s.repo, 'add', 'a.txt');
      },
    ],
    ['untracked', (s: Scratch): void => s.write('new.txt', 'new\n')],
  ])('pre-existing %s dirt with no new work is refused', async (_label, dirty) => {
    const s = scratch();
    dirty(s);
    const baseline = await s.observe();
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test.each([
    ['editing an already-dirty file', (s: Scratch): void => s.write('a.txt', 'again\n')],
    ['editing an already-dirty untracked file', (s: Scratch): void => s.write('new.txt', 'more\n')],
    ['adding a file', (s: Scratch): void => s.write('added.txt', 'x\n')],
    ['deleting a tracked file', (s: Scratch): void => unlinkSync(join(s.repo, 'b.txt'))],
    [
      'deleting a pre-existing untracked file',
      (s: Scratch): void => unlinkSync(join(s.repo, 'new.txt')),
    ],
    // Git on Windows ignores the executable bit (core.fileMode=false), so there is no
    // mode change to see there.
    ...(process.platform === 'win32'
      ? []
      : [
          [
            'changing the executable bit',
            (s: Scratch): void => chmodSync(join(s.repo, 'b.txt'), 0o755),
          ] as const,
        ]),
    [
      'replacing a file with a symlink',
      (s: Scratch): void => {
        rmSync(join(s.repo, 'b.txt'));
        symlinkSync('a.txt', join(s.repo, 'b.txt'));
      },
    ],
    [
      'committing a new change',
      (s: Scratch): void => {
        s.write('b.txt', 'committed\n');
        git(s.repo, 'commit', '-q', '-am', 'change');
      },
    ],
  ])('%s from a dirty start passes', async (_label, change) => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    s.write('new.txt', 'new\n');
    const baseline = await s.observe();
    change(s);
    const verdict = await guard(s, baseline);
    expect(verdict.output).toContain('changed since this implement invocation started');
    expect(verdict.passed).toBe(true);
  });

  test('committing bytes that were already dirty at the start is not new work', async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    s.write('new.txt', 'new\n');
    const baseline = await s.observe();
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'commit what was already there');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('an empty commit moves HEAD but is not new work', async () => {
    const s = scratch();
    const baseline = await s.observe();
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'empty');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('an edit reverted to the starting content is not new work', async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    const baseline = await s.observe();
    s.write('a.txt', 'changed\n');
    s.write('a.txt', 'dirty\n');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('committing CRLF worktree bytes the clean filter normalizes is not new work', async () => {
    const s = scratch({ '.gitattributes': '*.txt text eol=crlf\n', 'a.txt': 'a\n' });
    s.write('a.txt', 'dirty\r\n');
    const baseline = await s.observe();
    git(s.repo, 'commit', '-q', '-am', 'commit the pre-existing change');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('uncommitted .archon changes never count', async () => {
    const s = scratch();
    const baseline = await s.observe();
    s.write('.archon/workflows/new.yaml', 'name: x\n');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('an unrelated empty commit does not make a pre-existing .archon file count', async () => {
    const s = scratch();
    s.write('.archon/workflows/copied.yaml', 'name: copied\n');
    const baseline = await s.observe();
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'empty');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('committing a pre-existing uncommitted .archon file is not new work', async () => {
    const s = scratch();
    s.write('.archon/workflows/copied.yaml', 'name: copied\n');
    const baseline = await s.observe();
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'commit the copied workflow');
    expect((await guard(s, baseline)).passed).toBe(false);
  });

  test('a newly committed .archon change is new work', async () => {
    const s = scratch();
    s.write('.archon/workflows/copied.yaml', 'name: copied\n');
    const baseline = await s.observe();
    s.write('.archon/workflows/copied.yaml', 'name: edited\n');
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'edit the workflow');
    expect((await guard(s, baseline)).passed).toBe(true);
  });

  test('a later correction invocation cannot borrow an earlier invocation’s progress', async () => {
    const s = scratch();
    const first = await s.observe();
    s.write('a.txt', 'first round\n');
    expect((await guard(s, first)).passed).toBe(true);
    // The next correction round starts from where the first left the checkout.
    const second = await s.observe();
    const verdict = await guard(s, second, { redCause: 'introduced', summary: 'test x fails' });
    expect(verdict.passed).toBe(false);
  });

  test('an unborn start that gains a commit is new work', async () => {
    const s = scratch({});
    const baseline = await s.observe();
    expect(baseline).toMatchObject({ kind: 'git', commit: null });
    s.write('first.txt', 'x\n');
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'first');
    expect((await guard(s, baseline)).passed).toBe(true);
  });

  test('an incomplete start cannot prove new work, but an evidenced honest decline passes', async () => {
    const child = scratch();
    const s = scratch();
    git(s.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child.repo, 'sub');
    git(s.repo, 'commit', '-q', '-m', 'add submodule');
    s.write('sub/a.txt', 'dirty inside the submodule\n');
    const baseline = await s.observe();
    expect(baseline).toMatchObject({ worktree: { content: 'incomplete' } });
    s.write('b.txt', 'real change\n');
    const refused = await guard(s, baseline);
    expect(refused.passed).toBe(false);
    expect(refused.output).toContain('cannot be established');
    const declined = await guard(s, baseline, {
      redCause: 'inherited',
      summary: 'lint was already red at the base',
    });
    expect(declined.passed).toBe(true);
  });

  test('a start from outside Git cannot prove new work', async () => {
    const s = scratch();
    const notGit: CheckoutObservation = { kind: 'not_git', sampledAt: new Date().toISOString() };
    s.write('a.txt', 'changed\n');
    expect((await guard(s, notGit)).passed).toBe(false);
  });
});
