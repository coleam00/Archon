import { resumeTransition } from '../resume-transition';
import type { WorkflowRun } from '../schemas/workflow-run';
import type { WorkflowEventInput } from '../store';

export function resumeRun(
  run: WorkflowRun,
  record: (input: WorkflowEventInput) => void
): WorkflowRun {
  const { metadataPatch, events } = resumeTransition(run);
  for (const [key, value] of Object.entries(metadataPatch)) {
    if (value === null) delete run.metadata[key];
    else run.metadata[key] = value;
  }
  for (const event of events) record(event);
  run.status = 'running';
  run.completed_at = null;
  run.started_at = new Date();
  run.last_activity_at = new Date();
  return structuredClone(run);
}
