/**
 * `archon workflow cleanup`: the runs the store deleted lose their files, nothing else does,
 * and `--orphans` lists before it removes.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getArchonHome,
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { DeletedWorkflowRun } from '@archon/workflows/store';
import { workflowCleanupCommand, workflowOrphanCleanupCommand } from './workflow-cleanup';

const roots = trackTempRoots();
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'ARCHON_DOCKER', 'WORKSPACE_PATH'].map(key => [key, process.env[key]])
);
let out: string[];
let err: string[];
let spies: ReturnType<typeof spyOn>[];
let root: string;

beforeEach(async () => {
  process.env.ARCHON_HOME = roots(await mkdtemp(join(tmpdir(), 'workflow-cleanup-')));
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  root = join(getArchonWorkspacesPath(), 'owner', 'repo');
  out = [];
  err = [];
  spies = [
    spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line))),
    spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line))),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

async function writeRunFiles(runId: string): Promise<string[]> {
  const artifacts = getRunArtifactsDirForRoot(root, runId);
  const source = getRunWorkflowSourceDirForRoot(root, runId);
  const log = getRunLogPathForRoot(root, runId);
  for (const dir of [artifacts, source, join(root, 'logs')]) await mkdir(dir, { recursive: true });
  await writeFile(join(artifacts, 'out.txt'), 'x'.repeat(2048));
  await writeFile(join(source, 'workflow.yaml'), 'y');
  await writeFile(log, 'z');
  return [artifacts, log, source];
}

/** A store whose age delete returns `deleted`, the rows it would have removed. */
function storeDeleting(deleted: DeletedWorkflowRun[], prune = async () => ({ count: 0 })) {
  return {
    deps: {
      store: {
        deleteOldWorkflowRuns: async () => ({ runs: deleted }),
        pruneStateRevisions: prune,
        getCodebase: async () => null,
      },
    },
  };
}

test('removes the files of the runs the store deleted and reports runs and bytes', async () => {
  const deleted = await writeRunFiles(id(1));
  // A run the store kept (recent, or a parent whose sub-run is live) is not in its result.
  const kept = await writeRunFiles(id(2));
  const code = await workflowCleanupCommand(
    storeDeleting([{ id: id(1), output_root: root, codebase_id: null }]),
    7
  );
  expect(code).toBe(0);
  for (const path of deleted) expect(existsSync(path)).toBe(false);
  for (const path of kept) expect(existsSync(path)).toBe(true);
  expect(out).toContainEqual(
    expect.stringMatching(
      /^Deleted 1 workflow run\(s\) older than 7 days and removed \d+\.\d KB of their files\.$/
    )
  );
  expect(err).toEqual([]);
});

// A read-only directory stops neither root nor Windows from removing its entries.
const permissionsHold = process.platform !== 'win32' && process.getuid?.() !== 0;

test.skipIf(!permissionsHold)('a path it cannot remove is printed and exits 1', async () => {
  const [artifacts] = await writeRunFiles(id(1));
  // An artifacts path that is a file inside a read-only directory cannot be removed.
  const { chmod } = await import('node:fs/promises');
  const parent = join(artifacts ?? '', '..');
  await chmod(parent, 0o500);
  try {
    const code = await workflowCleanupCommand(
      storeDeleting([{ id: id(1), output_root: root, codebase_id: null }]),
      7
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain(artifacts ?? '');
    expect(err.join('\n')).toContain('--orphans --yes');
  } finally {
    await chmod(parent, 0o700);
  }
});

test('reports deleted rows when pruning state revisions fails', async () => {
  await expect(
    workflowCleanupCommand(
      storeDeleting([{ id: id(1), output_root: root, codebase_id: null }], async () => {
        throw new Error('state unavailable');
      }),
      7
    )
  ).rejects.toThrow(
    'Deleted 1 workflow run(s) older than 7 days, but failed to prune state revisions: state unavailable'
  );
});

test('--orphans lists without removing, and --yes removes only what it listed', async () => {
  const orphan = await writeRunFiles(id(1));
  const withRow = await writeRunFiles(id(2));
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const path of [...orphan, ...withRow]) await utimes(path, old, old);
  const host = {
    deps: { store: { getWorkflowRun: async (runId: string) => (runId === id(2) ? {} : null) } },
  } as Parameters<typeof workflowOrphanCleanupCommand>[0];

  expect(await workflowOrphanCleanupCommand(host, { yes: false, storeKind: 'sqlite' })).toBe(0);
  for (const path of [...orphan, ...withRow]) expect(existsSync(path)).toBe(true);
  expect(out).toContainEqual(expect.stringMatching(/^Found 3 path\(s\), .* of runs this store/));
  for (const path of orphan) expect(out.join('\n')).toContain(path);

  expect(await workflowOrphanCleanupCommand(host, { yes: true, storeKind: 'sqlite' })).toBe(0);
  for (const path of orphan) expect(existsSync(path)).toBe(false);
  for (const path of withRow) expect(existsSync(path)).toBe(true);
});

test('--orphans --yes refuses while another store history is on this ARCHON_HOME', async () => {
  const orphan = await writeRunFiles(id(1));
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const path of orphan) await utimes(path, old, old);
  await writeFile(join(getArchonHome(), 'archon.db'), '');
  const host = { deps: { store: { getWorkflowRun: async () => null } } };

  expect(await workflowOrphanCleanupCommand(host, { yes: true, storeKind: 'files' })).toBe(1);
  for (const path of orphan) expect(existsSync(path)).toBe(true);
  expect(err.join('\n')).toContain('a SQLite database');
});
