import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { measureChangeSize } from './change-size';
import type { WorkflowRun } from './schemas/workflow-run';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}\n`).join('');
}

/** A repository with one commit, which the work is cut from. */
function repo(): { dir: string; cutFrom: string } {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'change-size-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'moved.txt'), lines(30));
  writeFileSync(join(dir, 'old.txt'), lines(2));
  return { dir, cutFrom: commit(dir) };
}

function commit(dir: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return git(dir, 'rev-parse', 'HEAD');
}

type Run = Pick<WorkflowRun, 'id' | 'item_id' | 'working_path' | 'checkout_baseline'>;

function itemRun(id: string, path: string, cutFromCommit?: string): Run {
  return {
    id,
    item_id: 'item-1',
    working_path: path,
    checkout_baseline: {
      kind: 'git',
      sampledAt: '2026-11-25T10:00:00.000Z',
      commit: null,
      tree: null,
      worktree: { status: 'clean' },
      ...(cutFromCommit === undefined ? {} : { cutFromCommit }),
    },
  };
}

/** A store holding the item's runs, oldest first. */
function store(runs: Run[]) {
  return {
    getItem: async () => ({ id: 'item-1', projectKey: 'acme/web', key: 'issue-1' }),
    getItemRuns: async () => ({
      item: { id: 'item-1', projectKey: 'acme/web', key: 'issue-1' },
      runs: runs as WorkflowRun[],
      descendantIds: [],
    }),
  };
}

describe('measureChangeSize', () => {
  test('counts the change from the cut-from commit, with renames, deletions and binary files', async () => {
    const { dir, cutFrom } = repo();
    git(dir, 'mv', 'moved.txt', 'renamed.txt');
    git(dir, 'rm', '-q', 'old.txt');
    writeFileSync(join(dir, 'a.txt'), lines(40));
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
    const head = commit(dir);
    const run = itemRun('run-1', dir, cutFrom);

    expect(await measureChangeSize(store([run]), run, dir, head)).toEqual({
      base: cutFrom,
      commit: head,
      // The rename is one file with no lines; the deletion removes two.
      files: 4,
      added: 40,
      removed: 2,
    });
  });

  test('a later run on the same checkout keeps the cut-from the creating run recorded', async () => {
    const { dir, cutFrom } = repo();
    writeFileSync(join(dir, 'a.txt'), lines(40));
    const head = commit(dir);
    const creator = itemRun('run-1', dir, cutFrom);
    const elsewhere = itemRun('run-2', '/elsewhere', head);
    const later = itemRun('run-3', dir);

    expect(
      await measureChangeSize(store([creator, elsewhere, later]), later, dir, head)
    ).toMatchObject({ base: cutFrom, added: 40 });
  });

  test('records no size, not zero, without an item, a clean end commit or a cut-from', async () => {
    const { dir, cutFrom } = repo();
    const own = itemRun('run-1', dir, cutFrom);
    const inPlace = itemRun('run-2', dir);

    expect(await measureChangeSize(store([own]), { ...own, item_id: null }, dir, cutFrom)).toBe(
      undefined
    );
    expect(await measureChangeSize(store([own]), own, dir, null)).toBeUndefined();
    expect(await measureChangeSize(store([inPlace]), inPlace, dir, cutFrom)).toBeUndefined();
  });
});
