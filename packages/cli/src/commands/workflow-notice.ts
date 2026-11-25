/**
 * `archon workflow notice`: a node of a run says what the run did, for whoever watches
 * the attention stream at the notices level. It is valid only inside a workflow node:
 * the engine names the run and node in the node's environment, as it does for `state`.
 */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { parseAttentionLabelPairs } from '@archon/workflows/attention-queue';
import { emitWorkflowNotice, WorkflowNoticeRefusedError } from '@archon/workflows/workflow-notice';
import { readCallingNode } from '../utils/calling-node';
import { writeJsonLine } from '../utils/stdout';

export const WORKFLOW_NOTICE_USAGE =
  'Usage: archon workflow notice <text> [--label k=v]... [--json]';

async function emit(
  host: Pick<WorkflowHost, 'deps'>,
  text: string,
  labels: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<Awaited<ReturnType<typeof emitWorkflowNotice>>> {
  const runId = env.WORKFLOW_ID;
  if (!runId)
    throw new Error(
      'workflow notice runs inside a workflow node: WORKFLOW_ID is not set. A notice is what a run says it did.'
    );
  const { nodePath } = readCallingNode(runId, env);
  if ((await host.deps.store.getWorkflowRun(runId)) === null)
    throw new Error(`This install's store does not know run ${runId}.`);
  return emitWorkflowNotice(host.deps.store, {
    runId,
    node: nodePath,
    text,
    labels: parseAttentionLabelPairs(labels),
  });
}

export async function workflowNoticeCommand(
  host: Pick<WorkflowHost, 'deps'>,
  text: string,
  labels: readonly string[],
  json: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  try {
    const result = await emit(host, text, labels, env);
    if (json) await writeJsonLine({ ok: true, action: 'notice', ...result });
    else
      console.log(
        `Notice recorded (${String(result.count)} of ${String(result.limit)} for this run).`
      );
    return 0;
  } catch (error) {
    // No message here repeats the notice text.
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof WorkflowNoticeRefusedError ? { reason: error.reason } : {};
    if (json) await writeJsonLine({ ok: false, action: 'notice', error: message, ...reason });
    else console.error(`Error: ${message}`);
    return 1;
  }
}
