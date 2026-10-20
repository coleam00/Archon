import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { planEndTurn } from '@archon/workflows/end-turn-request';

import { writeJsonLine } from '../utils/stdout';
import { resolveRunIdArg } from './workflow-shared';

const REFUSALS = {
  not_found: 'Workflow run not found',
  not_running: 'Run is not live, so it has no turn to end',
  unreadable_attention: 'Run attention is unreadable. Inspect it with archon workflow get',
  nothing_stalled:
    'Run has no stalled turns, tools or background work to end. Inspect it with archon workflow get',
} as const;

export async function workflowEndTurnCommand(
  host: WorkflowHost,
  runIdArg: string,
  json = false,
  cwd?: string
): Promise<number> {
  let runId = runIdArg;
  try {
    runId = await resolveRunIdArg(host, runIdArg, cwd);
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
      await writeJsonLine({ ok: true, runId, action: 'end_turn', requestRecorded: true, nodes });
    } else {
      console.log(
        `Recorded an end-turn request for ${nodes.join(', ')}. A live owner ends the observed stall if it is still active at its next status check. Use archon workflow wait ${runId} to check progress or detect owner_lost.`
      );
    }
    return 0;
  } catch (error) {
    if (!json) throw error;
    await writeJsonLine({
      ok: false,
      runId,
      action: 'end_turn',
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}
