import type { WorkflowDeps } from '../deps';
import { readOutcomeUnknownSteps } from '../outcome-unknown';
import { getLog } from './log';

/**
 * Where the top-level walk stops after a node recorded an `outcome_unknown` failure: before
 * each layer, beside the operator pause (`OperatorPauseBoundary`). Only `executeDagWorkflow`
 * creates one, so a nested walk never consults it and a `loop`, `loop_group` or `workflow:`
 * node is one unit. Checking before the first layer too stops a continuation pass whose
 * wait paused in the failing layer. `held` names the steps once the walk stopped here.
 */
export class OutcomeUnknownBoundary {
  held: string[] = [];

  constructor(
    private readonly store: Pick<WorkflowDeps['store'], 'listEventsForRuns'>,
    private readonly runId: string
  ) {}

  /**
   * True when the run holds such a failure. A failed read throws to the run's failure
   * boundary rather than read as "not held", unlike the operator pause's read: continuing a
   * run whose write may have happened is the unsafe direction.
   */
  async stopsHere(): Promise<boolean> {
    this.held = await readOutcomeUnknownSteps(this.store, this.runId);
    if (this.held.length === 0) return false;
    getLog().info(
      { workflowRunId: this.runId, steps: this.held },
      'dag.outcome_unknown_boundary_reached'
    );
    return true;
  }
}
