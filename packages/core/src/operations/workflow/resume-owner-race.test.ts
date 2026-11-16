import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '@archon/workflows/file-store';
import { checkedResumeCursor } from '@archon/workflows/store';
import type { IIsolationStore } from '@archon/isolation';
import { createWorkflowOperations, ResumeRefusedError } from '../workflow-operations';
import { isRunOwnedByThisProcess, isRunOwnerAnswering } from '../../services/run-live-owner';

const trackTempRoot = trackTempRoots();
let host: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  host?.mockRestore();
  host = undefined;
});

/** Act as the process on `name`: the operation's host check and the owner the store records. */
function onHost(name: string): void {
  host?.mockRestore();
  host = spyOn(os, 'hostname').mockReturnValue(name);
}

// Two hosts share one database. Host 2 resumes a failed run that last ran on host 1; its
// live-owner endpoint is local to host 2, so host 1 cannot reach it. Until the resume
// records host 2 as the owner, host 1 reads its own dead owner, nothing answers, and its
// own resume of the now `running` run would start a second executor.
test('a run another host just resumed is refused, not resumed a second time', async () => {
  const dir = trackTempRoot(mkdtempSync(join(os.tmpdir(), 'archon-resume-race-')));
  const store = await createFileWorkflowStore({ root: join(dir, 'store') });
  const unused = (): never => {
    throw new Error('unused');
  };
  const operations = createWorkflowOperations({
    getUserRole: async () => undefined,
    store: { ...store, deleteWorkflowRun: unused },
    hostStore: { isolation: {} as IIsolationStore },
    requestDetachedRunStop: unused,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimContainerEnv: unused,
    reclaimRunWorktree: unused,
  });

  onHost('host-1');
  const created = await store.createWorkflowRun({
    workflow_name: 'fixture',
    user_message: '',
    working_path: join(dir, 'checkout'),
  });
  await store.claimPendingWorkflowRun(created.id);
  await store.failWorkflowRun(created.id, 'host 1 process died');

  onHost('host-2');
  const read = await operations.resumeWorkflow(created.id, { kind: 'operator' });
  await store.resumeWorkflowRun(created.id, checkedResumeCursor(read));

  onHost('host-1');
  const refusal = await operations.resumeWorkflow(created.id, { kind: 'operator' }).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(ResumeRefusedError);
  expect((refusal as ResumeRefusedError).reason).toBe('owner_unreachable');
  expect((refusal as ResumeRefusedError).message).toContain('host-2');
});
