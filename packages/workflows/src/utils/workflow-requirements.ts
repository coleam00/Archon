/**
 * Workflow capability requirements gate.
 *
 * A workflow may declare `requires: [github]` in its YAML. When it does, the
 * run must be hard-blocked at invocation — before any worktree, clone, or AI
 * cost — if the originating user hasn't connected the required capability.
 *
 * This module is pure: callers resolve the runtime connection status (a DB
 * check) and pass it in. The orchestrator/CLI/web entrypoints own the I/O; this
 * just encodes the policy so all three behave identically.
 */
import type { WorkflowRequirement, WorkflowInputSpec } from '../schemas/workflow';
import type { DagNode } from '../schemas/dag-node';
import { isApprovalNode, isLoopGroupNode } from '../schemas/dag-node';
import { readComposedMeta } from '../compiled-command';
import { resolveDeclaredInputs, WorkflowInputContractError } from '../workflow-inputs';

/** Minimal shape needed to evaluate requirements — avoids a full WorkflowDefinition dep. */
export interface RequirementBearingWorkflow {
  requires?: readonly WorkflowRequirement[];
}

/** Resolved connection status for the originating user. */
export interface RequirementContext {
  /** True when the originating user has a usable GitHub connection. */
  githubConnected: boolean;
}

/**
 * Thrown when a declared requirement is unmet. `message` is user-facing and
 * actionable (it names the connect step). Callers surface `message` to the
 * platform and abort the invocation without creating a worktree or run row.
 */
export class WorkflowRequirementError extends Error {
  constructor(public readonly requirement: WorkflowRequirement) {
    super(
      `This workflow requires a connected ${requirement} identity, but you haven't connected yours. ` +
        'Connect GitHub (Slack: `/archon connect github`, CLI: `archon auth github`, ' +
        'or the Web UI Settings page) and re-invoke. No worktree was created and no AI cost was incurred.'
    );
    this.name = 'WorkflowRequirementError';
  }
}

/**
 * Throw WorkflowRequirementError if any declared requirement is unmet. A
 * workflow with no `requires` (or an empty array) always passes.
 */
export function assertWorkflowRequirementsMet(
  workflow: RequirementBearingWorkflow,
  ctx: RequirementContext
): void {
  const requires = workflow.requires ?? [];
  if (requires.includes('github') && !ctx.githubConnected) {
    throw new WorkflowRequirementError('github');
  }
}

// ---------------------------------------------------------------------------
// Composed approval gates (#1764)
// ---------------------------------------------------------------------------

/** An approval node that arrived through `include:`, and the workflow that declared it. */
export interface ComposedApprovalGate {
  /** The namespaced node id in the expanded DAG. */
  nodeId: string;
  /** The workflow file the gate was authored in. */
  origin: string;
}

/**
 * Find an approval node that came from a composed workflow, if there is one.
 *
 * Composition namespaces node ids but the gate still belongs to another file, so an
 * author looking at the composing workflow cannot see it. `readComposedMeta().origin` is
 * stamped at expansion, which is what makes this answerable without re-walking includes.
 * A workflow's OWN approval nodes are deliberately not reported: one reader, one file.
 */
export function findComposedApprovalGate(nodes: readonly DagNode[]): ComposedApprovalGate | null {
  for (const node of nodes) {
    const origin = readComposedMeta(node)?.origin;
    if (origin !== undefined && isApprovalNode(node)) return { nodeId: node.id, origin };
    if (isLoopGroupNode(node)) {
      const nested = findComposedApprovalGate(node.loop_group.nodes);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * Thrown when a run would be dispatched to the background with a composed approval gate in
 * it. `message` is user-facing and names the block, the gate and the fix — it reaches the
 * human directly on the console path, and via the agent's tool result on `manage_run`.
 */
export class ComposedApprovalGateError extends Error {
  constructor(public readonly gate: ComposedApprovalGate) {
    super(
      `This workflow composes '${gate.origin}', which contains an approval gate ('${gate.nodeId}'), ` +
        "but it does not declare 'interactive: true'. A background run cannot present that gate " +
        "inline, and the author who wrote it is looking at a different file. Add 'interactive: true' " +
        "to this workflow, or start the block as its own governed run with a 'workflow:' node."
    );
    this.name = 'ComposedApprovalGateError';
  }
}

/**
 * Refuse a background dispatch that carries a composed approval gate.
 *
 * Checked at INVOCATION rather than at load, because "does this run own the gate" is only
 * answerable once a workflow is invoked. Load time sees every discovered workflow, and a
 * reusable building block that composes a gate-bearing block is never the run owner — the
 * earlier load-time form rejected exactly that, making a valid three-level composition
 * unloadable even when the top-level workflow did declare `interactive: true`.
 *
 * Scoped to BACKGROUND dispatch, not to a platform. A foreground run presents the gate and
 * has nothing to refuse; a backgrounded one cannot, whichever platform started it — the
 * `manage_run` tool backgrounds a workflow from Slack, Telegram and Discord as readily as
 * from the console. Its single caller is `dispatchBackgroundWorkflow` (@archon/core), so
 * the rule holds for every entrypoint that backgrounds a run rather than for a list of
 * callers that has to stay complete.
 */
export function assertComposedGateDriveable(nodes: readonly DagNode[]): void {
  const gate = findComposedApprovalGate(nodes);
  if (gate !== null) throw new ComposedApprovalGateError(gate);
}

// ---------------------------------------------------------------------------
// Declared-input resolution for a TOP-LEVEL invocation (#2470, #2554)
// ---------------------------------------------------------------------------

/** Minimal shape needed to evaluate declared inputs — avoids a full WorkflowDefinition dep. */
export interface InputBearingWorkflow {
  name?: string;
  inputs?: Record<string, WorkflowInputSpec>;
}

/**
 * Thrown when a TOP-LEVEL invocation supplies no value for a workflow's `required`
 * input. `message` is user-facing and names the missing inputs plus the channels that
 * can carry them.
 *
 * Before #2554 this said the workflow "is a reusable block" that could only be called
 * from another workflow — that was the defect, not a description of the design. A
 * workflow is a workflow: it runs on its own when its inputs are supplied, and composes
 * unchanged.
 */
export class WorkflowMissingInputsError extends Error {
  constructor(
    public readonly workflowName: string | undefined,
    public readonly missing: readonly string[]
  ) {
    const names = missing.map(n => `'${n}'`).join(', ');
    const plural = missing.length === 1 ? '' : 's';
    super(
      `This workflow requires input${plural} ${names}, and none was supplied. Supply ` +
        `${missing.length === 1 ? 'it' : 'them'} with \`--input ${missing[0]}=<value>\` on the ` +
        'CLI (repeat the flag per input), or fill the run form in the web console. When ' +
        'composing this workflow from another, pass the same values via `with:` on the ' +
        '`include:`/`workflow:` node. Chat platforms cannot supply inputs yet (#2555). ' +
        'No worktree was created and no AI cost was incurred.'
    );
    this.name = 'WorkflowMissingInputsError';
  }
}

/**
 * Resolve a TOP-LEVEL invocation's declared inputs from the values its channel supplied
 * (#2554) — `--input name=value` on the CLI, the `inputs` map on the run route, or the
 * console's run form.
 *
 * Validation delegates to {@link resolveDeclaredInputs}, the same implementation
 * `include:` and `workflow:` use, so a map accepted when composing is accepted here and
 * vice versa. Callers run this BEFORE any worktree, clone, run row, or AI call, matching
 * where the `workflow:` child path resolves its own `with:` map.
 *
 * Returns ONLY the caller-supplied entries — never the declared defaults that
 * `resolveDeclaredInputs` folds in. Defaults stay DERIVED at execution time
 * (`defaultRunInputs` in executor.ts), so they track the workflow's current YAML instead
 * of freezing a snapshot into the run row, and a bare run persists exactly nothing and so
 * behaves byte-for-byte as it did before this feature. The `workflow:` child path
 * persists the resolved map instead; the effective `$INPUTS` is identical either way
 * because the executor layers defaults *under* whatever the row carries — the difference
 * is deliberate, not drift.
 *
 * @returns the supplied map, or undefined when nothing was supplied.
 * @throws WorkflowMissingInputsError when a `required` input has no supplied value.
 * @throws WorkflowInputContractError when a supplied key is not declared.
 */
export function resolveTopLevelInputs(
  workflow: InputBearingWorkflow,
  supplied: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  const suppliedMap = { ...supplied };
  try {
    resolveDeclaredInputs(
      suppliedMap,
      workflow.inputs,
      `Cannot run workflow '${workflow.name ?? 'unknown'}'`,
      'it'
    );
  } catch (err) {
    // Re-shape only the missing-required case: its shared message ends in "Pass them
    // through 'with:'", which is the wrong remediation for a direct run. The undeclared-key
    // message already reads correctly and lists the declared names, so it propagates as-is.
    if (err instanceof WorkflowInputContractError && err.missingRequired.length > 0) {
      throw new WorkflowMissingInputsError(workflow.name, err.missingRequired);
    }
    throw err;
  }
  return Object.keys(suppliedMap).length > 0 ? suppliedMap : undefined;
}
