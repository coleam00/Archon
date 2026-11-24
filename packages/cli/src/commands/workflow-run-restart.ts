import {
  type CheckoutHandoffRunMetadata,
  readCheckoutHandoff,
} from '@archon/workflows/schemas/resource-start';
import {
  SUBRUN_METADATA_KEYS,
  readWorkflowSourceState,
} from '@archon/workflows/schemas/run-metadata';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

/**
 * Where a restart runs. A stage given another run's checkout gets the lane its start would
 * have: a `continue` hand-off adopts that run, and a `copy` hand-off supersedes the failed
 * run on a fresh worktree cut at the hand-off's commit, rather than adopting a checkout
 * that may since have moved. Any other run is superseded on a fresh worktree.
 */
export type RestartLane =
  | { kind: 'supersede'; runId: string; copyHandoff?: CheckoutHandoffRunMetadata }
  | { kind: 'adopt'; runId: string };

/** The start `workflow run --supersedes <id>` with no workflow name makes from a run's record. */
export interface RunRestart {
  workflowName: string;
  userMessage: string;
  inputs: Record<string, string> | undefined;
  /** The explicit `--workflow-source` the run's definitions were read from, if any. */
  workflowSource: string | undefined;
  /** The base branch the run's definitions were read from, if they came from a base. */
  baseBranch: string | undefined;
  lane: RestartLane;
}

/**
 * The start a run's record describes. Throws when the record cannot say where the run was
 * meant to start: a malformed hand-off, an unreadable source record, or inputs not stored
 * as text. Restarting without them would run something other than what was started.
 */
export function restartOfRun(run: WorkflowRun): RunRestart {
  const handoff = readCheckoutHandoff(run);
  const source = readWorkflowSourceState(run.metadata);
  if (source.kind === 'unreadable') {
    throw new Error(
      `Cannot restart run '${run.id}': its recorded workflow source cannot be read (${source.detail}).`
    );
  }
  const definitions = source.kind === 'recorded' ? source.record.definitions : undefined;
  return {
    workflowName: run.workflow_name,
    userMessage: run.user_message ?? '',
    inputs: recordedLaunchInputs(run),
    workflowSource: definitions?.from === 'source' ? definitions.root : undefined,
    baseBranch: definitions?.from === 'base' ? definitions.branch : undefined,
    lane:
      handoff?.lane === 'continue'
        ? { kind: 'adopt', runId: handoff.runId }
        : { kind: 'supersede', runId: run.id, ...(handoff ? { copyHandoff: handoff } : {}) },
  };
}

/**
 * The inputs recorded on a run's row, as the canonical text map under `metadata.inputs`.
 * Every start writes that map, also when it records logical values beside it in
 * `inputs_values` (a binding start's number or boolean), and a CLI start takes its inputs
 * as text, so the text map is what a detached child and a restart pass on. A non-string
 * value there means the row was written some other way.
 */
export function recordedLaunchInputs(row: WorkflowRun): Record<string, string> | undefined {
  const recorded = row.metadata[SUBRUN_METADATA_KEYS.inputs];
  if (recorded === undefined) return undefined;
  if (typeof recorded !== 'object' || recorded === null || Array.isArray(recorded)) {
    throw new Error(`Cannot execute run '${row.id}': its recorded inputs are not a map.`);
  }
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(recorded)) {
    if (typeof value !== 'string') {
      throw new Error(`Cannot execute run '${row.id}': its recorded input '${name}' is not text.`);
    }
    inputs[name] = value;
  }
  return inputs;
}
