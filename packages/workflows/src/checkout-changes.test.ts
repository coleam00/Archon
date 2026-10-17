import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { computeCheckoutChanges } from './checkout-changes';
import { observeCheckout } from './checkout-observation';
import {
  checkoutChangesManifestSchema,
  type CheckoutChanges,
  type CheckoutObservation,
} from './schemas/checkout-observation';

const RUN_ID = 'changes-run';
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
  /** The delta from `start` to a fresh observation of the checkout now. */
  changesSince(start: CheckoutObservation): Promise<CheckoutChanges>;
  /** The changed paths a known delta's manifest lists. */
  paths(changes: CheckoutChanges): unknown[];
}

function scratch(initial: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' }): Scratch {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'checkout-changes-')));
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
  const run = { runId: RUN_ID, artifactsDir: artifacts };
  const observe = (): Promise<CheckoutObservation> => observeCheckout(repo, { kind: 'host' }, run);
  return {
    repo,
    artifacts,
    write,
    observe,
    changesSince: async start => computeCheckoutChanges(repo, start, await observe(), run),
    paths: changes => {
      if (changes.status !== 'known' || changes.manifest === undefined) return [];
      const bytes = readFileSync(join(artifacts, ...changes.manifest.pointer.path.split('/')));
      return checkoutChangesManifestSchema.parse(JSON.parse(bytes.toString('utf8'))).paths;
    },
  };
}

describe('computeCheckoutChanges', () => {
  test('a clean start that changes nothing is an empty known delta', async () => {
    const s = scratch();
    expect(await s.changesSince(await s.observe())).toEqual({ status: 'known', changed: 0 });
  });

  // A dirty start the step left untouched is part of where it started, not its change.
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
  ])('pre-existing %s dirt the step left untouched is not counted', async (_label, dirty) => {
    const s = scratch();
    dirty(s);
    expect(await s.changesSince(await s.observe())).toEqual({ status: 'known', changed: 0 });
  });

  test.each([
    ['editing an already-dirty file', 'a.txt', (s: Scratch): void => s.write('a.txt', 'again\n')],
    [
      'editing an already-dirty untracked file',
      'new.txt',
      (s: Scratch): void => s.write('new.txt', 'more\n'),
    ],
    ['adding a file', 'added.txt', (s: Scratch): void => s.write('added.txt', 'x\n')],
    ['removing a tracked file', 'b.txt', (s: Scratch): void => unlinkSync(join(s.repo, 'b.txt'))],
    [
      'removing a pre-existing untracked file',
      'new.txt',
      (s: Scratch): void => unlinkSync(join(s.repo, 'new.txt')),
    ],
    // Git on Windows ignores the executable bit (core.fileMode=false), so there is no
    // mode change to see there.
    ...(process.platform === 'win32'
      ? []
      : [
          [
            'changing the executable bit',
            'b.txt',
            (s: Scratch): void => chmodSync(join(s.repo, 'b.txt'), 0o755),
          ] as const,
        ]),
    [
      'replacing a file with a symlink',
      'b.txt',
      (s: Scratch): void => {
        rmSync(join(s.repo, 'b.txt'));
        symlinkSync('a.txt', join(s.repo, 'b.txt'));
      },
    ],
    [
      'committing a new change',
      'b.txt',
      (s: Scratch): void => {
        s.write('b.txt', 'committed\n');
        git(s.repo, 'commit', '-q', '-am', 'change');
      },
    ],
  ])('%s from a dirty start is the one changed path', async (_label, path, change) => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    s.write('new.txt', 'new\n');
    const start = await s.observe();
    change(s);
    const changes = await s.changesSince(start);
    expect(changes).toMatchObject({ status: 'known', changed: 1 });
    expect(s.paths(changes)).toEqual([path]);
  });

  test('committing bytes that were already dirty at the start changes nothing', async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    s.write('new.txt', 'new\n');
    const start = await s.observe();
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'commit what was already there');
    expect(await s.changesSince(start)).toEqual({ status: 'known', changed: 0 });
  });

  test('an empty commit moves HEAD but changes nothing', async () => {
    const s = scratch();
    const start = await s.observe();
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'empty');
    expect(await s.changesSince(start)).toEqual({ status: 'known', changed: 0 });
  });

  test('an edit reverted to the starting content changes nothing', async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    const start = await s.observe();
    s.write('a.txt', 'changed\n');
    s.write('a.txt', 'dirty\n');
    expect(await s.changesSince(start)).toEqual({ status: 'known', changed: 0 });
  });

  test('committing CRLF worktree bytes the clean filter normalizes changes nothing', async () => {
    const s = scratch({ '.gitattributes': '*.txt text eol=crlf\n', 'a.txt': 'a\n' });
    s.write('a.txt', 'dirty\r\n');
    const start = await s.observe();
    git(s.repo, 'commit', '-q', '-am', 'commit the pre-existing change');
    expect(await s.changesSince(start)).toEqual({ status: 'known', changed: 0 });
  });

  test('committed and uncommitted changes together are each counted once', async () => {
    const s = scratch();
    const start = await s.observe();
    s.write('a.txt', 'committed\n');
    git(s.repo, 'commit', '-q', '-am', 'commit a');
    s.write('a.txt', 'then edited\n');
    s.write('c.txt', 'uncommitted\n');
    const changes = await s.changesSince(start);
    expect(changes).toMatchObject({ status: 'known', changed: 2 });
    expect(s.paths(changes)).toEqual(['a.txt', 'c.txt']);
  });

  test('an unborn start that gains a commit lists every committed path', async () => {
    const s = scratch({});
    const start = await s.observe();
    expect(start).toMatchObject({ kind: 'git', commit: null });
    s.write('first.txt', 'x\n');
    s.write('second.txt', 'y\n');
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-q', '-m', 'first');
    expect(s.paths(await s.changesSince(start))).toEqual(['first.txt', 'second.txt']);
  });

  // Committed paths come from raw tree diffs, so bytes that are not UTF-8 survive.
  test.skipIf(process.platform !== 'linux')(
    'a committed non-UTF-8 path is reported byte-exact',
    async () => {
      const s = scratch();
      const start = await s.observe();
      const raw = Buffer.from([0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74]);
      const blob = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], {
        cwd: s.repo,
        stdin: Buffer.from('x\n'),
      })
        .stdout.toString()
        .trim();
      // The index takes the raw name through stdin; no filesystem name is needed.
      const indexInfo = Bun.spawnSync(['git', 'update-index', '--add', '-z', '--index-info'], {
        cwd: s.repo,
        stdin: Buffer.concat([Buffer.from(`100644 ${blob}\t`), raw, Buffer.from([0])]),
      });
      expect(indexInfo.exitCode).toBe(0);
      git(s.repo, 'commit', '-q', '-m', 'non-utf8 path');
      // Check the file out so the end observation is clean rather than missing that path.
      git(s.repo, 'reset', '-q', '--hard');
      expect(s.paths(await s.changesSince(start))).toEqual([{ base64: raw.toString('base64') }]);
    }
  );

  test('an incomplete observation is unknown, never an empty list', async () => {
    const child = scratch();
    const s = scratch();
    git(s.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child.repo, 'sub');
    git(s.repo, 'commit', '-q', '-m', 'add submodule');
    s.write('sub/a.txt', 'dirty inside the submodule\n');
    const start = await s.observe();
    expect(start).toMatchObject({ worktree: { content: 'incomplete' } });
    s.write('b.txt', 'real change\n');
    expect(await s.changesSince(start)).toEqual({
      status: 'unknown',
      reason: 'incomplete',
      side: 'start',
    });
  });

  test.each([
    ['not_git' as const, { kind: 'not_git' as const, sampledAt: new Date().toISOString() }],
    [
      'unavailable' as const,
      {
        kind: 'unavailable' as const,
        sampledAt: new Date().toISOString(),
        reason: 'git_failed' as const,
      },
    ],
  ])('a %s start is unknown', async (reason, start) => {
    const s = scratch();
    s.write('a.txt', 'changed\n');
    expect(await s.changesSince(start)).toEqual({ status: 'unknown', reason, side: 'start' });
  });

  test('a manifest that no longer matches its digest is unknown', async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    const start = await s.observe();
    if (start.kind !== 'git' || start.worktree.status !== 'dirty') throw new Error('not dirty');
    writeFileSync(join(s.artifacts, ...start.worktree.manifest.pointer.path.split('/')), '{}');
    expect(await s.changesSince(start)).toEqual({
      status: 'unknown',
      reason: 'manifest_unreadable',
      side: 'start',
    });
  });

  test("another run's manifest is unknown", async () => {
    const s = scratch();
    s.write('a.txt', 'dirty\n');
    const start = await s.observe();
    expect(
      await computeCheckoutChanges(s.repo, start, await s.observe(), {
        runId: 'other-run',
        artifactsDir: s.artifacts,
      })
    ).toEqual({ status: 'unknown', reason: 'manifest_unreadable', side: 'start' });
  });
});
