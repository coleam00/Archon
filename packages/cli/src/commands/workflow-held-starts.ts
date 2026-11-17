import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { HeldStart } from '@archon/workflows/resource-start-store';
import type { InstallHold } from '@archon/workflows/schemas/resource-start';

/** A start the install hold keeps: a trigger's or queued start, or a waiting hand start. */
type StatusHeldStart = HeldStart | { kind: 'run'; runId: string; workflow: string };

/**
 * The install hold and the starts it keeps, none while no hold is set. Trigger and queued
 * starts are listed install-wide: a binding has no project until it is prepared. A hand
 * start is a pending top-level run in scope that nothing admitted; it waits in its own
 * process until the lift.
 */
export async function readHeldStarts(
  host: WorkflowHost,
  codebaseId: string | undefined
): Promise<{ hold: InstallHold | null; heldStarts: StatusHeldStart[] }> {
  const hold = await host.deps.store.getInstallHold();
  if (!hold) return { hold: null, heldStarts: [] };
  const { runs } = await host.deps.store.listWorkflowRuns({
    status: ['pending'],
    ...(codebaseId ? { codebaseId } : {}),
  });
  const handStarts: StatusHeldStart[] = [];
  for (const run of runs) {
    if (run.parent_run_id || (await host.deps.store.getResourceStartRequest(run.id))) continue;
    handStarts.push({ kind: 'run', runId: run.id, workflow: run.workflow_name });
  }
  return { hold, heldStarts: [...(await host.deps.store.listHeldStarts()), ...handStarts] };
}

export function heldStartLine(start: StatusHeldStart): string {
  switch (start.kind) {
    case 'trigger':
      return `  ${start.workflow ?? '(binding unreadable)'}  receipt ${start.receiptId} binding ${start.bindingId}${start.itemKey === null ? '' : ` on ${start.itemKey}`}, received ${start.receivedAt}`;
    case 'queued':
      return `  ${start.workflow ?? '(launch unreadable)'}  queued request ${start.requestId} on ${start.resource}, queued ${start.queuedAt}`;
    case 'run':
      return `  ${start.workflow}  run ${start.runId}, waiting in the process that started it`;
  }
}
