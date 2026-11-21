import { hostname } from 'node:os';
import { createLogger } from '@archon/paths';
import {
  START_EXECUTOR_METADATA_KEY,
  type StartExecutorRecord,
} from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';

const log = createLogger('start-executor');

/**
 * The process a host handed an admitted start to (`ResourceStartHost.startAdmitted`), or
 * null from a host whose start already ran to its end in that call, leaving nothing to
 * record. The drain adds this host and user.
 */
export type StartedExecutor = Pick<StartExecutorRecord, 'pid' | 'dedicated'>;

/**
 * Record who runs the admitted start on its pending run (an admitted request's id is its
 * run's id), so a reader can tell an executor still booting from a start nobody runs. A
 * false write means the executor already claimed the run. A failed write does not fail
 * the start, which is already running: the read then shows the start as unowned. A null
 * executor (a start that already ran to its end) records nothing.
 */
export async function recordStartExecutor(
  store: Pick<IWorkflowStore, 'updateWorkflowRunMetadataIfPending'>,
  requestId: string,
  executor: StartedExecutor | null
): Promise<void> {
  if (executor === null) return;
  const uid = process.getuid?.();
  const record: StartExecutorRecord = {
    host: hostname(),
    ...executor,
    ...(uid === undefined ? {} : { uid }),
  };
  try {
    await store.updateWorkflowRunMetadataIfPending(requestId, {
      [START_EXECUTOR_METADATA_KEY]: record,
    });
  } catch (error) {
    log.error({ err: error as Error, requestId }, 'resource_start.executor_record_failed');
  }
}
