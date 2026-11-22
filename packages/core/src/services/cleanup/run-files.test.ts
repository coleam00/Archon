import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
} from '@archon/paths/archon-paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createFileWorkflowHost } from '../../workflows/file-host';
import {
  ORPHAN_MIN_AGE_MS,
  findOrphanRunFiles,
  removeOrphanRunFiles,
  removeRunFiles,
} from './run-files';

const roots = trackTempRoots();
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'ARCHON_DOCKER', 'WORKSPACE_PATH', 'DATABASE_URL'].map(key => [
    key,
    process.env[key],
  ])
);
let projectRoot: string;

beforeEach(async () => {
  process.env.ARCHON_HOME = roots(await mkdtemp(join(tmpdir(), 'run-files-')));
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  process.env.DATABASE_URL = '';
  projectRoot = join(getArchonWorkspacesPath(), 'owner', 'repo');
});
afterEach(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const noCodebase = { getCodebase: async () => null };
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** The three paths of a run, each holding `bytes` bytes of file content. */
async function writeRunFiles(root: string, runId: string, bytes = 10): Promise<string[]> {
  const artifacts = getRunArtifactsDirForRoot(root, runId);
  const source = getRunWorkflowSourceDirForRoot(root, runId);
  const log = getRunLogPathForRoot(root, runId);
  await mkdir(join(artifacts, 'nested'), { recursive: true });
  await writeFile(join(artifacts, 'nested', 'out.txt'), 'a'.repeat(bytes));
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'workflow.yaml'), 'b'.repeat(bytes));
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(log, 'c'.repeat(bytes));
  return [artifacts, log, source];
}

async function age(paths: string[], ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  for (const path of paths) await utimes(path, when, when);
}

test("removes a deleted run's artifacts, log and frozen source and counts their bytes", async () => {
  const paths = await writeRunFiles(projectRoot, id(1), 100);
  const kept = await writeRunFiles(projectRoot, id(2));
  const report = await removeRunFiles(
    [{ id: id(1), output_root: projectRoot, codebase_id: null }],
    noCodebase
  );
  for (const path of paths) expect(existsSync(path)).toBe(false);
  for (const path of kept) expect(existsSync(path)).toBe(true);
  expect(report.failed).toEqual([]);
  expect(report.unlocated).toEqual([]);
  // Three files of 100 bytes, plus the directory entries the walk counts.
  expect(report.removedBytes).toBeGreaterThanOrEqual(300);
});

test("locates a run without a recorded root through its project, and reports one it can't", async () => {
  const paths = await writeRunFiles(projectRoot, id(1));
  const report = await removeRunFiles(
    [
      { id: id(1), output_root: null, codebase_id: 'cb' },
      { id: id(2), output_root: null, codebase_id: null },
    ],
    {
      getCodebase: async () => ({
        id: 'cb',
        name: 'owner/repo',
        repository_url: 'https://github.com/owner/repo',
        default_cwd: join(projectRoot, 'source'),
        kind: 'repo',
      }),
    }
  );
  for (const path of paths) expect(existsSync(path)).toBe(false);
  expect(report.unlocated).toEqual([id(2)]);
});

test('builds no path from an id that is not a run id', async () => {
  const removed: string[] = [];
  const report = await removeRunFiles(
    [{ id: '../repo', output_root: projectRoot, codebase_id: null }],
    noCodebase,
    async path => {
      removed.push(path);
    }
  );
  expect(removed).toEqual([]);
  expect(report.unlocated).toEqual(['../repo']);
});

test('a failed removal is reported with its path and the other paths are still removed', async () => {
  const paths = await writeRunFiles(projectRoot, id(1));
  const other = await writeRunFiles(projectRoot, id(2));
  const [artifacts] = paths;
  const { rm } = await import('node:fs/promises');
  const report = await removeRunFiles(
    [
      { id: id(1), output_root: projectRoot, codebase_id: null },
      { id: id(2), output_root: projectRoot, codebase_id: null },
    ],
    noCodebase,
    async path => {
      if (path === artifacts)
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      await rm(path, { recursive: true, force: true });
    }
  );
  expect(report.failed).toEqual([{ path: artifacts ?? '', error: 'EACCES: permission denied' }]);
  expect(existsSync(artifacts ?? '')).toBe(true);
  for (const path of [...paths.slice(1), ...other]) expect(existsSync(path)).toBe(false);
});

test('the orphan sweep lists only old run-id paths without a row, and removes only those', async () => {
  const host = await createFileWorkflowHost(join(process.env.ARCHON_HOME ?? '', 'store'));
  const live = await host.deps.store.createWorkflowRun({ workflow_name: 'w', user_message: '' });
  const day = 24 * 60 * 60 * 1000;
  const orphan = await writeRunFiles(projectRoot, id(1), 50);
  const withRow = await writeRunFiles(projectRoot, live.id);
  const young = await writeRunFiles(projectRoot, id(2));
  const foreign = join(projectRoot, 'artifacts', 'runs', 'not-a-run');
  await mkdir(foreign, { recursive: true });
  await age([...orphan, ...withRow, foreign], day);
  await age(young, ORPHAN_MIN_AGE_MS - 60_000);

  const { orphans: listed, linked } = await findOrphanRunFiles(host.deps.store);
  expect(linked).toEqual([]);
  expect(listed.map(entry => entry.path).sort()).toEqual([...orphan].sort());
  expect(listed.every(entry => entry.bytes >= 50)).toBe(true);
  for (const path of [...orphan, ...withRow, ...young, foreign])
    expect(existsSync(path)).toBe(true);

  const report = await removeOrphanRunFiles(listed);
  expect(report.failed).toEqual([]);
  for (const path of orphan) expect(existsSync(path)).toBe(false);
  for (const path of [...withRow, ...young, foreign]) expect(existsSync(path)).toBe(true);
});

test('a run directory linked outside the workspace is neither scanned nor removed from', async () => {
  const outside = roots(await mkdtemp(join(tmpdir(), 'run-files-outside-')));
  const external = join(outside, `${id(1)}.jsonl`);
  await writeFile(external, 'not the workspace');
  await mkdir(projectRoot, { recursive: true });
  await symlink(outside, join(projectRoot, 'logs'), 'dir');
  const day = 24 * 60 * 60 * 1000;
  await age([external], day);

  const report = await removeRunFiles(
    [{ id: id(1), output_root: projectRoot, codebase_id: null }],
    noCodebase
  );
  expect(existsSync(external)).toBe(true);
  expect(report.failed).toEqual([
    {
      path: getRunLogPathForRoot(projectRoot, id(1)),
      error: expect.stringContaining('outside the project workspace'),
    },
  ]);

  const host = await createFileWorkflowHost(join(process.env.ARCHON_HOME ?? '', 'store'));
  const { orphans, linked } = await findOrphanRunFiles(host.deps.store);
  expect(orphans).toEqual([]);
  expect(linked.map(entry => entry.path)).toEqual([join(projectRoot, 'logs')]);
  expect(existsSync(external)).toBe(true);
});

test('a run that a live run adopted is not deleted, and keeps its files', async () => {
  const host = await createFileWorkflowHost(join(process.env.ARCHON_HOME ?? '', 'store'));
  const store = host.deps.store;
  const source = await store.createWorkflowRun({ workflow_name: 'w', user_message: '' });
  await store.updateWorkflowRun(source.id, { output_root: projectRoot });
  await store.claimPendingWorkflowRun(source.id);
  await store.completeWorkflowRun(source.id, { duration_ms: 1 });
  const paths = await writeRunFiles(projectRoot, source.id);
  const adopter = await store.createWorkflowRun({
    workflow_name: 'w',
    user_message: '',
    adopted_from_run_id: source.id,
  });
  await store.claimPendingWorkflowRun(adopter.id);

  await expect(host.operations.deleteWorkflowRun(source.id, { kind: 'operator' })).rejects.toThrow(
    `${adopter.id} (running)`
  );
  expect(await store.deleteOldWorkflowRuns(0)).toEqual({ runs: [] });
  expect(await store.getWorkflowRunStatus(source.id)).toBe('completed');
  for (const path of paths) expect(existsSync(path)).toBe(true);
});

test("deleting a run through operations removes the run's files", async () => {
  const host = await createFileWorkflowHost(join(process.env.ARCHON_HOME ?? '', 'store'));
  const store = host.deps.store;
  const run: WorkflowRun = await store.createWorkflowRun({ workflow_name: 'w', user_message: '' });
  await store.updateWorkflowRun(run.id, { output_root: projectRoot });
  await store.claimPendingWorkflowRun(run.id);
  await store.completeWorkflowRun(run.id, { duration_ms: 1 });
  const paths = await writeRunFiles(projectRoot, run.id);

  const report = await host.operations.deleteWorkflowRun(run.id, { kind: 'operator' });
  expect(await store.getWorkflowRun(run.id)).toBeNull();
  for (const path of paths) expect(existsSync(path)).toBe(false);
  expect(report.failed).toEqual([]);
});
