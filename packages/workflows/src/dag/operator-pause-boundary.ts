import type { WorkflowDeps } from '../deps';
import { operatorPause } from '../schemas';
import { getLog } from './log';

/**
 * Where the top-level walk stops for an operator's pause request (`archon workflow pause`).
 * Only `executeDagWorkflow` creates one, so a nested walk never stops for a request and a
 * `loop`, `loop_group` or `workflow:` node is one unit. `reached` is set once the walk
 * stopped for the request; the caller then pauses the run.
 */
export class OperatorPauseBoundary {
  reached = false;

  constructor(
    private readonly store: Pick<WorkflowDeps['store'], 'getWorkflowRun'>,
    private readonly runId: string
  ) {}

  /**
   * True, and `reached`, when the run carries a pending request. A failed read never stops
   * the walk: failing the run over it would destroy the work the pause exists to keep, and
   * the next boundary reads again.
   */
  async stopsHere(): Promise<boolean> {
    let run;
    try {
      run = await this.store.getWorkflowRun(this.runId);
    } catch (err) {
      getLog().warn({ err, workflowRunId: this.runId }, 'dag.operator_pause_read_failed');
      return false;
    }
    if (run === null || operatorPause(run)?.state !== 'requested') return false;
    getLog().info({ workflowRunId: this.runId }, 'dag.operator_pause_boundary_reached');
    this.reached = true;
    return true;
  }
}
