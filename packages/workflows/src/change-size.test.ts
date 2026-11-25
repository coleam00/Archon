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

type Run = Pick<
  WorkflowRun,
  'id' | 'status' | 'item_id' | 'checkout_baseline' | 'metadata' | 'adopted_from_run_id'
>;

function itemRun(
  id: string,
  cutFromCommit?: string,
  metadata: Run['metadata'] = {},
  adoptedFrom: string | null = null
): Run {
  return {
    id,
    status: 'completed',
    item_id: 'item-1',
    metadata,
    adopted_from_run_id: adoptedFrom,
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

/** A run started on `source`'s checkout, as a binding with `checkout: ended-run` starts it. */
function handedOn(
  id: string,
  source: Run,
  commit: string,
  lane: 'copy' | 'continue',
  cutFromCommit?: string
): Run {
  return itemRun(id, cutFromCommit, {
    checkout_handoff: { runId: source.id, branch: 'archon/task-1', commit, lane },
  });
}

/** A store that reads back the given runs. */
function store(runs: Run[]) {
  return {
    getWorkflowRun: async (id: string) => (runs.find(run => run.id === id) as WorkflowRun) ?? null,
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
    const run = itemRun('run-1', cutFrom);

    expect(await measureChangeSize(store([run]), run, dir, head)).toEqual({
      base: cutFrom,
      commit: head,
      // The rename is one file with no lines; the deletion removes two.
      files: 4,
      added: 40,
      removed: 2,
    });
  });

  test('a run on a handed-on checkout measures from where the build it took was cut', async () => {
    const { dir, cutFrom } = repo();
    writeFileSync(join(dir, 'a.txt'), lines(40));
    const head = commit(dir);
    const build = itemRun('build-1', cutFrom);
    // A read-only check works on its own copy, cut at the build's commit.
    const check = handedOn('check-1', build, head, 'copy', head);
    const runs = store([build, check]);

    expect(await measureChangeSize(runs, check, dir, head)).toMatchObject({
      base: cutFrom,
      added: 40,
    });
    // A later stage takes the size the run before it recorded as its base.
    const recorded = itemRun('build-2', undefined, {
      change_size: { base: cutFrom, commit: head, files: 1, added: 40, removed: 0 },
    });
    const land = handedOn('land-1', recorded, head, 'continue');
    expect(await measureChangeSize(store([recorded, land]), land, dir, head)).toMatchObject({
      base: cutFrom,
      added: 40,
    });
  });

  test('an adopting run keeps the base of the run it adopted; a supersession does not', async () => {
    const { dir, cutFrom } = repo();
    writeFileSync(join(dir, 'a.txt'), lines(40));
    const head = commit(dir);
    const build = itemRun('build-1', cutFrom);
    const adopted = itemRun('review-1', undefined, { continuation: { mode: 'adopt' } }, build.id);
    const superseding = itemRun(
      'build-2',
      undefined,
      { continuation: { mode: 'supersede' } },
      build.id
    );
    const runs = store([build, adopted, superseding]);

    expect(await measureChangeSize(runs, adopted, dir, head)).toMatchObject({
      base: cutFrom,
      added: 40,
    });
    expect(await measureChangeSize(runs, superseding, dir, head)).toBeUndefined();
  });

  test('records no size, not zero, without an item, a clean end commit or a cut-from', async () => {
    const { dir, cutFrom } = repo();
    const own = itemRun('run-1', cutFrom);
    // A run in place, or on a checkout reused outside a hand-off, has no cut-from.
    const inPlace = itemRun('run-2');

    expect(await measureChangeSize(store([own]), { ...own, item_id: null }, dir, cutFrom)).toBe(
      undefined
    );
    expect(await measureChangeSize(store([own]), own, dir, null)).toBeUndefined();
    expect(await measureChangeSize(store([inPlace]), inPlace, dir, cutFrom)).toBeUndefined();
  });
});
