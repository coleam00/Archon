import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { planEndTurn } from '@archon/workflows/end-turn-request';

import { writeJsonLine } from '../utils/stdout';
import { resolveRunIdArg } from './workflow-shared';

const REFUSALS = {
  not_found: 'Workflow run not found',
  not_running: 'Run is not running, so it has no turn to end',
  nothing_stalled:
    'Run has no stalled tool calls or background work to end. Inspect it with archon workflow get',
} as const;

/**
 * Ends the turns behind a run's `stalled_tool_calls` attention. The owning process reads
 * the request at its next status check and fails each stalled node attempt as a timeout,
 * so the node's retry policy runs and the run continues. Nothing is killed from here.
 */
export async function workflowEndTurnCommand(
  host: WorkflowHost,
  runIdArg: string,
  json = false,
  cwd?: string
): Promise<number> {
  const runId = await resolveRunIdArg(host, runIdArg, cwd);
  const run = await host.deps.store.getWorkflowRun(runId);
  const plan = run ? planEndTurn(run) : ({ kind: 'refused', reason: 'not_found' } as const);
  if (plan.kind === 'refused') {
    const error = `${REFUSALS[plan.reason]}: ${runId}`;
    if (json) await writeJsonLine({ ok: false, runId, action: 'end_turn', error: plan.reason });
    else console.error(error);
    return 1;
  }
  await host.deps.store.updateWorkflowRun(runId, { metadata: plan.metadata });
  const nodes = [...new Set(plan.calls.map(call => call.nodeId))];
  if (json) {
    await writeJsonLine({ ok: true, runId, action: 'end_turn', nodes });
  } else {
    console.log(
      `Requested the end of the stalled turn in ${nodes.join(', ')}. The run's process ends it at its next status check; the node fails as a timeout and its retry policy decides what runs next.`
    );
  }
  return 0;
}
