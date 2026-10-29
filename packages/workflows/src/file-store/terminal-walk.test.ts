/**
 * Every file-store terminal writer walks the run's artifacts before it takes the store
 * lock, so other processes wait on the lock only for store reads and writes.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths/archon-paths';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import type { IWorkflowStore } from '../store';
import { approval } from '../store-conformance/fixtures';
import { getTerminalRecord } from '../terminal-record';
import { createFileWorkflowStore } from './store';

const roots = trackTempRoots();
// The walk compares realpaths, so the home (and every output root under it) must be one.
const home = await realpath(await mkdtemp(join(tmpdir(), 'archon-file-walk-home-')));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = home;
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(home);
});

const writers = {
  complete: {
    paused: false,
    write: (s: IWorkflowStore, id: string) => s.completeWorkflowRun(id, { duration_ms: 1 }),
  },
  fail: { paused: false, write: (s: IWorkflowStore, id: string) => s.failWorkflowRun(id, 'boom') },
  cancel: { paused: false, write: (s: IWorkflowStore, id: string) => s.cancelWorkflowRun(id) },
  'fan-out': {
    paused: false,
    write: (s: IWorkflowStore, id: string) => s.cancelFanOutRun(id, 'fan_out_sibling'),
  },
  reject: {
    paused: true,
    write: (s: IWorkflowStore, id: string) =>
      s.resolveAndCancelApprovalGate(id, [], { step_name: 'review' }),
  },
  reset: {
    paused: true,
    write: (s: IWorkflowStore, _id: string, conversationId: string) =>
      s.cancelResumableRunsForConversation(conversationId),
  },
} as const;

describe('file-store terminal writers walk artifacts outside the store lock', () => {
  test.each(Object.keys(writers) as (keyof typeof writers)[])('%s', async name => {
    const { paused, write } = writers[name];
    const root = roots(await mkdtemp(join(tmpdir(), 'file-terminal-walk-')));
    const store = await createFileWorkflowStore({ root });
    const conversationId = `walk-${name}-${crypto.randomUUID()}`;
    const run = await store.createWorkflowRun({
      workflow_name: 'implement',
      user_message: 'msg',
      origin: { conversationId },
    });
    await store.claimPendingWorkflowRun(run.id);
    const outputRoot = join(home, 'workspaces', 'owner', name);
    await store.updateWorkflowRun(run.id, { output_root: outputRoot });
    if (paused) await store.pauseWorkflowRun(run.id, approval);
    const artifacts = getRunArtifactsDirForRoot(outputRoot, run.id);
    await mkdir(join(artifacts, 'evidence', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(artifacts, 'report.md'), 'report');
    await writeFile(join(artifacts, 'evidence', 'node_modules', 'pkg', 'index.js'), '');
    await store.persistWorkflowEvent({
      workflow_run_id: run.id,
      event_type: 'node_completed',
      step_name: 'late',
      data: { node_output: 'ok' },
    });

    const lockHeldDuringWalk: boolean[] = [];
    const observe = (path: unknown): void => {
      if (String(path).startsWith(artifacts))
        lockHeldDuringWalk.push(existsSync(join(root, 'lock')));
    };
    const readdir = fsPromises.readdir;
    const lstat = fsPromises.lstat;
    const readdirSpy = spyOn(fsPromises, 'readdir').mockImplementation(((
      ...args: Parameters<typeof readdir>
    ) => {
      observe(args[0]);
      return readdir(...args);
    }) as typeof readdir);
    const lstatSpy = spyOn(fsPromises, 'lstat').mockImplementation(((
      ...args: Parameters<typeof lstat>
    ) => {
      observe(args[0]);
      return lstat(...args);
    }) as typeof lstat);
    try {
      await write(store, run.id, conversationId);
    } finally {
      readdirSpy.mockRestore();
      lstatSpy.mockRestore();
    }

    expect(lockHeldDuringWalk.length).toBeGreaterThan(0);
    expect(lockHeldDuringWalk.filter(Boolean)).toEqual([]);

    const status = (await store.getWorkflowRunStatus(run.id)) ?? 'pending';
    expect(status).toBe(
      name === 'complete' ? 'completed' : name === 'fail' ? 'failed' : 'cancelled'
    );
    const record = getTerminalRecord(status, await store.listWorkflowEvents(run.id));
    expect(record?.artifacts.files.map(file => file.path)).toEqual(['report.md']);
    expect(record?.artifacts.limitations).toEqual([
      { path: 'evidence/node_modules', kind: 'unsupported_entry', code: 'excluded_directory' },
    ]);
    expect(record?.nodes).toContainEqual(
      expect.objectContaining({ node_id: 'late', state: 'completed' })
    );
  });
});
