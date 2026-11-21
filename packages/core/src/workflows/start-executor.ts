import { hostname } from 'node:os';
import { createLogger } from '@archon/paths';
import {
  START_EXECUTOR_METADATA_KEY,
  type StartExecutorRecord,
} from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';

const log = createLogger('start-executor');

/**
 * The process a host handed an admitted start to (`ResourceStartHost.startAdmitted`). A
 * host returns null when the start already ran to its end in that call, and rejects only
 * when it started nothing, so a rejection is recorded as a failed hand-off.
 */
export interface StartedExecutor {
  pid: number;
}

/**
 * Hand one admitted start to its host and record how that ended on the pending run (an
 * admitted request's id is its run's id), so a reader can prove a start nobody runs. A
 * rejection is recorded as `hand_off_failed` and then rethrown.
 */
export async function handOffAdmitted(
  host: {
    startAdmitted(requestId: string): Promise<StartedExecutor | null>;
    deps: { store: Pick<IWorkflowStore, 'updateWorkflowRunMetadataIfPending'> };
  },
  requestId: string
): Promise<void> {
  let executor: StartedExecutor | null;
  try {
    executor = await host.startAdmitted(requestId);
  } catch (error) {
    await record(host.deps.store, requestId, { kind: 'hand_off_failed' });
    throw error;
  }
  if (executor === null) return;
  const uid = process.getuid?.();
  await record(host.deps.store, requestId, {
    kind: 'handed_off',
    host: hostname(),
    pid: executor.pid,
    ...(uid === undefined ? {} : { uid }),
  });
}

/**
 * A false write means the executor already claimed the run. A failed write leaves the run
 * without the record, which a reader takes as `unknown`, never as absence, so it is logged
 * and does not fail a hand-off that already happened.
 */
async function record(
  store: Pick<IWorkflowStore, 'updateWorkflowRunMetadataIfPending'>,
  requestId: string,
  value: StartExecutorRecord
): Promise<void> {
  try {
    await store.updateWorkflowRunMetadataIfPending(requestId, {
      [START_EXECUTOR_METADATA_KEY]: value,
    });
  } catch (error) {
    log.error({ err: error as Error, requestId }, 'resource_start.executor_record_failed');
  }
}
