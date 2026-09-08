import { readFile } from 'node:fs/promises';
import { deliverWorkflowTrigger, loadTriggerBindings } from '@archon/core/workflows/trigger-launch';
import { getWorkflowRun } from '@archon/core/db/workflows';
import { writeJsonLine } from '../utils/stdout';
import { triggerEventSchema } from '@archon/workflows/trigger';

/** One scheduler invocation drives one explicit tick through native execution. */
export async function workflowTriggerCommand(
  triggerId: string,
  eventPath: string
): Promise<number> {
  const binding = (await loadTriggerBindings()).find(candidate => candidate.id === triggerId);
  if (!binding) throw new Error(`Unknown trigger '${triggerId}' in ARCHON_HOME/triggers.json`);
  if (binding.kind !== 'schedule')
    throw new Error('CLI trigger delivery accepts schedule bindings only');
  const event = triggerEventSchema.parse(JSON.parse(await readFile(eventPath, 'utf8')));
  const delivery = await deliverWorkflowTrigger(binding, event);
  const result = await delivery.completion;
  const run = await getWorkflowRun(delivery.admission.runId);
  await writeJsonLine({
    ok: result?.success ?? true,
    triggerId,
    eventId: event.eventId,
    ...delivery.admission,
    status: run?.status,
    outcome: run?.outcome,
  });
  return result?.success === false ? 1 : 0;
}
