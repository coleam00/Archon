/**
 * The rule that a node whose outcome is unknown is not run again by itself. A node failure
 * recording `outcome_unknown` says a side effect may or may not have happened, so the walk
 * that holds it starts nothing more and the pass ends failed with stop reason
 * `outcome_unknown`: no wait, release, budget refusal or completion is chosen instead.
 * Only an operator's hand resume continues the run, and that resume is the operator
 * accepting the unknown.
 */
import type { WorkflowRun } from './schemas/workflow-run';
import { readRunStopReason } from './schemas/run-metadata';
import type { NodeOutput } from './schemas';

/**
 * The step paths that failed with an unknown outcome in this pass. One record per pass,
 * filled where every node of every walk settles (`runLayerPhase`), before an aggregate
 * rewrites the kind to `child_failed`; a failure replayed on a later pass settles there too.
 * Each pass starts empty, so a hand resume needs no bookkeeping. A `workflow:` child runs
 * its own pass with its own record, so the reason lands on the child.
 */
export class UnknownOutcomes {
  private readonly held: string[] = [];

  /** Record a settled node's result: held when it failed with an unknown outcome. */
  settle(stepPath: string, output: NodeOutput): void {
    if (output.state === 'failed' && output.failureKind === 'outcome_unknown')
      this.held.push(stepPath);
  }

  /**
   * Whether a step under `prefix` is held: `''` for the top-level walk, a loop body's
   * `group.` or a composed instance's `scope__id__`. Prefixes end in a separator, so a
   * sibling instance is never matched and an `all_done` join's other instances still run.
   */
  heldWithin(prefix: string): boolean {
    return this.held.some(step => step.startsWith(prefix));
  }

  steps(): readonly string[] {
    return this.held;
  }
}

/** A run that failed with an unknown outcome: listed in attention until resumed or abandoned. */
export function isOutcomeUnknownRun(run: Pick<WorkflowRun, 'status' | 'metadata'>): boolean {
  return run.status === 'failed' && readRunStopReason(run.metadata)?.reason === 'outcome_unknown';
}

/** Why the run stopped, naming the steps whose outcome is unknown. */
export function outcomeUnknownMessage(workflowName: string, steps: readonly string[]): string {
  const nodes = steps.map(step => `'${step}'`).join(', ');
  return `DAG workflow '${workflowName}' stopped: the outcome of node${steps.length > 1 ? 's' : ''} ${nodes} is unknown, so it does not continue by itself. Check what ${steps.length > 1 ? 'they' : 'it'} did, then resume or abandon the run.`;
}
