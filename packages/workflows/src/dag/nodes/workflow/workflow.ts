import { reportedChildUsage, unreportedChildUsage } from '../../child-usage';
import { isWorkflowExecutionInterruption } from '../../../execution-interruption';
import { runOrStagePause, pauseGateRespectingExternalTransition } from '../../pause';
import { finishNodeExecution } from '../../../node-execution';
import {
  serializeNodeStateRecord,
  serializeNodeOutput,
  type NodeExecutionResult,
} from '../../../node-record-serialization';
import { type ExecutionDiagnostics, type NodeFailureKind } from '../../../schemas/node-execution';
import {
  NodeEventWriteError,
  recordDerivedExecution,
  recordNodeState,
} from '../../../node-event-write';
import { WorkflowSourceUnavailableError } from '../../../workflow-source';
import type { WorkflowCommandSurface } from '../../../deps';
import { spellWorkflowCommand } from '../../../deps';
import type { TokenUsage } from '@archon/provider-contract';
import type { WorkflowNode, WorkflowRun, WorkflowRunStatus } from '../../../schemas';
import {
  workflowRunStatusSchema,
  terminalWorkflowRunStatusSchema,
} from '../../../schemas/run-status';
import { readSubrunMetadata } from '../../../schemas';
import { type JsonValue } from '../../../output-ref';
import { substituteWorkflowVariables } from '../../../workflow-variables';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { executeFanOutWorkflowNode } from './fan-out';
import { childOutcomeFromRun, type ChildWorkflowOutcome } from '../../child-run';
import { RunSourceUnreadableError } from '../../node-source';
import { beginExecution, type RunLayersContext } from '../../run-context';
import {
  resolveRunInputs,
  nodeTemplateReferences,
  type ShellInputContext,
  resolveWorkflowValue,
} from '../../references';

const LIVE_CHILD_STATUSES: readonly WorkflowRunStatus[] = workflowRunStatusSchema.exclude(
  terminalWorkflowRunStatusSchema.options
).options;

/**
 * Execute a `workflow:` (sub-run) node (#2121 Phase 2). Starts — or, on parent
 * resume, re-inspects — a CHILD workflow run and threads its terminal output back
 * as this node's output. The re-entry table (D5) makes this idempotent and
 * cross-process-safe:
 *  - no child yet        → start one in-process, interpret the outcome.
 *  - child completed     → thread its summary/cost and persist node_completed here.
 *  - child failed        → resume-through-parent ONCE, then re-interpret.
 *  - child cancelled     → fail the node.
 *  - child paused/running → pause the PARENT "blocked on child" WITHOUT writing
 *    node_completed (mirrors executeApprovalNode), so the node re-runs when the
 *    parent auto-resumes after the child terminates.
 */
export async function executeWorkflowNode(
  node: WorkflowNode,
  ctx: RunLayersContext
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const executionNodeId = ctx.stepNamePrefix + node.id;
  const execution = beginExecution(ctx, node);
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

  let childUsage: ExecutionDiagnostics['childUsage'];

  // Build the failed result AND persist a node_failed event with the reason. Unlike
  // command/prompt/bash/script nodes (which write their own node_failed inside their
  // executor), the workflow node returns a failed NodeExecutionResult that runLayers
  // does NOT turn into an event — so without this the sub-run failure reason (cycle,
  // unknown target, cancelled child, …) would be swallowed into the run-level DAG
  // summary and never auditable per-node.
  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    tokensUnknown?: boolean
  ): Promise<NodeExecutionResult> => {
    // A settled child can fail after spending money. Keep those measurements on the
    // failed node so the run-level accumulator includes the work already performed.
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'failed', error, failureKind },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { childUsage },
        }
      )
    );
  };

  if (ctx.unattributedChildUsagePaths?.has(executionNodeId)) {
    return failResult(
      `Cannot re-execute workflow node '${executionNodeId}': historical child usage lacks unambiguous attribution; cumulative child totals would count earlier spend again.`,
      'config'
    );
  }

  if (!ctx.runChildWorkflow) {
    // Fail fast: executor.ts MUST inject the closure. A missing one means a caller
    // wired executeDagWorkflow without sub-run support — never silently no-op.
    return failResult(
      "Internal error: 'workflow:' node cannot run — runChildWorkflow closure was not injected.",
      'config'
    );
  }

  // Dynamic fan-out (slice 2, PR-C): a `fan_out:` node expands into N governed child
  // runs over a data-driven item list, joined into one node outcome. This is a
  // distinct execution path from the slice-1 single-child node below — branch here so
  // the 1:1 pause/resume machinery stays untouched for non-fan-out nodes.
  if (node.fan_out) {
    return executeFanOutWorkflowNode(node, ctx, node.fan_out, ctx.runChildWorkflow, execution);
  }

  const childArgs = resolveChildArguments(node, ctx, executionNodeId);

  // Build the completed result AND write the node_completed event. Unlike
  // command/prompt/bash/script nodes (which write their own inside their executor)
  // and unlike approval nodes (written by the approve handler), the workflow node
  // writes node_completed HERE — and ONLY on true completion, never on the paused
  // branch — so the resume snapshot skips a truly-finished sub-run on resume
  // but re-runs one still blocked on its child.
  const asCompleted = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    // The contract this node completes under is the CHILD's (#2453): its `returns:` node
    // certified the value and stamped the field projection beside it. Nothing is
    // re-validated here — a `workflow:` node cannot declare a schema of its own (that is
    // a load error), so there is no caller side to check against.
    const declaredOutputPaths = outcome.declaredOutputPaths;
    // The same holds for an artifact pointer in the child's value (#2453): the child's
    // producer proved it against the child's own run, and this node relays it unchanged.
    if (outcome.output === undefined) {
      // A completed child with no non-blank terminal output threads '' into
      // $<node>.output — legal, but indistinguishable downstream from an
      // intentional empty result, so leave a trace for the author.
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id, childRunId: outcome.childRunId },
        'workflow.subrun_completed_without_output'
      );
    }
    const output = outcome.output ?? '';
    // The parent's terminal record and resume snapshot require this committed result.
    // Storage rejection fails the parent run without reclassifying the completed child.
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: {
            text: output,
            ...(outcome.structuredOutput !== undefined
              ? { structured: outcome.structuredOutput }
              : {}),
            ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
          },
          costUsd: outcome.costUsd,
          tokens: outcome.tokens,
          tokensUnknown: outcome.tokensUnknown,
          diagnostics: { childRunId: outcome.childRunId, childUsage },
        }
      )
    );
  };

  // Pause the PARENT "blocked on child" via the shared pause primitive — mirrors
  // executeApprovalNode's PAUSE primitives: pause, emit, return {completed, ''}
  // WITHOUT node_completed so the node re-runs on the parent's resume (the
  // resume snapshot reads only node_completed). The RESUME side deliberately
  // differs: an approval gate is resolved externally by the approve handler,
  // while this node re-runs and re-inspects its child. Also unlike the
  // approval node, no approval_requested workflow_event row is persisted here
  // — the block reason lives on the run itself (metadata.approval), and there
  // is no human decision to audit for a gate that resolves automatically on
  // child completion.
  const pauseParentOnChild = async (childRunId: string): Promise<NodeExecutionResult> => {
    const blocked = `Sub-run \`${node.workflow}\` (run \`${childRunId.slice(0, 8)}\`) is paused awaiting review. `;
    const approveChild = (surface: WorkflowCommandSurface): string =>
      `${blocked}Approve it by run id: \`${spellWorkflowCommand(surface, `approve ${childRunId}`)}\``;
    const suspended = finishNodeExecution(
      execution,
      { status: 'suspended', point: 'child_workflow' },
      { output: { text: '' }, diagnostics: { childRunId } }
    );
    return runOrStagePause(
      ctx,
      async () => {
        const paused = await pauseGateRespectingExternalTransition(
          deps,
          parentRun.id,
          {
            message: blocked.trimEnd(),
            nodeId: executionNodeId,
            type: 'child_workflow',
            childRunId,
          },
          { event: serializeNodeStateRecord(suspended), boundary: ctx.containerPause }
        );
        if (!paused) return serializeNodeOutput(execution);
        await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
        await safeSendMessage(
          platform,
          conversationId,
          `⏸ **Blocked on sub-run** \`${node.workflow}\`: ${approveChild(platform)}`,
          msgContext
        );
        return serializeNodeOutput(suspended);
      },
      () => serializeNodeOutput(execution)
    );
  };

  const interpret = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    childUsage = [reportedChildUsage(outcome)];
    outcome = {
      ...outcome,
      ...unreportedChildUsage(outcome, ctx.reportedChildUsage, outcome.childRunId),
    };
    switch (outcome.status) {
      case 'completed':
        return await asCompleted(outcome);
      case 'paused':
        return pauseParentOnChild(outcome.childRunId);
      case 'failed':
        return failResult(
          outcome.error ?? `Sub-run '${node.workflow}' failed`,
          'child_failed',
          outcome.costUsd,
          outcome.tokens,
          outcome.tokensUnknown
        );
      case 'cancelled':
        return failResult(
          `Sub-run '${node.workflow}' was cancelled`,
          'cancelled',
          outcome.costUsd,
          outcome.tokens,
          outcome.tokensUnknown
        );
      default: {
        // Compile-time exhaustiveness + runtime fail-loud: without this, a status
        // outside the union would silently return `undefined` into runLayers.
        const unreachable: never = outcome.status;
        return failResult(
          `Sub-run '${node.workflow}' returned unexpected status '${String(unreachable)}'`,
          'unknown'
        );
      }
    }
  };

  // Re-entry: find THIS node's child (a parent may run several workflow: nodes, so
  // filter by parent_node_id). At most one child per node in slice 1; if somehow
  // several, the most recent wins.
  let existing: WorkflowRun | undefined;
  try {
    existing = await findExistingChild(ctx, executionNodeId);
  } catch (err) {
    return failResult(
      `Failed to look up child runs for node '${node.id}': ${(err as Error).message}`,
      'unknown'
    );
  }

  try {
    if (existing === undefined) {
      return await interpret(await ctx.runChildWorkflow(childArgs));
    }
    if (existing.status === 'failed') {
      // Resume-through-parent recovery (D5/#1764): re-drive the failed child once.
      return await interpret(
        await ctx.runChildWorkflow({ ...childArgs, resumeChild: { kind: 'failed', run: existing } })
      );
    }
    if (LIVE_CHILD_STATUSES.includes(existing.status)) {
      // Still in progress (awaiting a human or a concurrent run). Re-pause the
      // parent; NEVER resume a paused child.
      return await pauseParentOnChild(existing.id);
    }
    // completed / cancelled — thread the outcome through the same state table a
    // freshly-run child uses (interpret handles both).
    return await interpret(childOutcomeFromRun(existing));
  } catch (err) {
    if (isWorkflowExecutionInterruption(err) || err instanceof NodeEventWriteError) throw err;

    // Only a read of the parent's source releases the parent; a child's fault stays the
    // child's, so the launch types those reads (see runChildWorkflow).
    if (err instanceof WorkflowSourceUnavailableError)
      throw new RunSourceUnreadableError(executionNodeId, err);

    return failResult(
      `Sub-run '${node.workflow}' errored: ${(err as Error).message}`,
      'child_failed'
    );
  }
}

function resolveChildArguments(node: WorkflowNode, ctx: RunLayersContext, executionNodeId: string) {
  const parentRun = ctx.workflowRun;
  const parentInputs = resolveRunInputs(parentRun);

  const rawInput = node.input ?? '';
  const { prompt: input } = substituteWorkflowVariables(
    rawInput,
    parentRun.id,
    parentRun.user_message ?? '',
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    undefined, // loopUserInput
    undefined, // rejectionReason
    undefined, // loopPrevOutput
    {
      stateDir: ctx.stateDir,
      inputs: parentInputs,
      references: nodeTemplateReferences(rawInput, ctx),
    }
  );

  // `with:` delivers logical JSON data to the child, never shell source.
  const withResolutionCtx: ShellInputContext = {
    workflowRun: parentRun,
    artifactsDir: ctx.artifactsDir,
    stateDir: ctx.stateDir,
    baseBranch: ctx.baseBranch,
    docsDir: ctx.docsDir,
    issueContext: ctx.issueContext,
    nodeOutputs: ctx.nodeOutputs,
    loopBodyScopes: ctx.loopBodyScopes,
  };
  let resolvedInputs: Record<string, JsonValue> | undefined;
  if (node.with !== undefined) {
    resolvedInputs = {};
    for (const [name, rawValue] of Object.entries(node.with)) {
      resolvedInputs[name] = resolveWorkflowValue(rawValue, withResolutionCtx, parentInputs, false);
    }
  }

  return {
    parentRun,
    nodeId: executionNodeId,
    childWorkflowName: node.workflow,
    input,
    cwd: ctx.cwd,
    conversationId: ctx.conversationId,
    userId: parentRun.user_id ?? undefined,
    codebaseId: parentRun.codebase_id ?? undefined,
    isolation: node.isolation,
    ...(resolvedInputs !== undefined ? { inputs: resolvedInputs } : {}),
  };
}

async function findExistingChild(
  ctx: RunLayersContext,
  executionNodeId: string
): Promise<WorkflowRun | undefined> {
  const children = (await ctx.deps.store.findChildRuns(ctx.workflowRun.id)).filter(
    c =>
      readSubrunMetadata(c.metadata as Record<string, unknown> | undefined).parentNodeId ===
      executionNodeId
  );
  return children.length > 0 ? children[children.length - 1] : undefined;
}
