/**
 * How a DAG pass ends once its layers have run: the node-outcome tally, the failure and
 * usage-limit dispositions, the evidence and write-back gates, and the completion write.
 */
import { executionClaim, WorkflowRunPauseConflictError } from '../store';
import { existsSync } from 'fs';
import { join as joinPath } from 'path';
import type { WorkflowDeps } from '../deps';
import type {
  NodeOutput,
  ResolvedWorkflow,
  WorkflowRun,
  WorkflowUsageLimitWaitContext,
} from '../schemas';
import { SUBRUN_METADATA_KEYS } from '../schemas';
import type { RunExitReason } from '../schemas/run-terminal-reason';
import {
  WORKTREE_DISPOSITION_METADATA_KEY,
  type WorktreeDisposition,
} from '../schemas/terminal-record';
import { getWorkflowEventEmitter } from '../event-emitter';
import { requireTerminalStatusWrite } from '../terminal-status-write';
import { rootOutputFields, type DeclaredOutputPaths } from '../output-ref';
import { logWorkflowComplete, logWorkflowError, type WorkflowUsage } from '../logger';
import {
  providerLimitResumeAt,
  isProviderLimit,
  type ProviderLimitFailure,
} from '../executor-shared';
import { safeSendMessage } from '../platform-messages';
import type { ContainerRunContext } from '../container-context';
import { randomUUID } from 'node:crypto';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';
import { runContainerWriteBackGate } from './container-gate';
import { statusAfterPauseFailure } from './pause';

/** What the terminal tally reads: the run's estate, and the outputs and usage its pass left. */
export type RunTerminalContext = Pick<
  RunLayersContext,
  | 'deps'
  | 'platform'
  | 'conversationId'
  | 'config'
  | 'workflowRun'
  | 'artifactsDir'
  | 'logDir'
  | 'execContext'
  | 'nodeOutputs'
  | 'totalCostUsd'
  | 'totalTokens'
> & {
  workflow: ResolvedWorkflow;
  containerCtx: ContainerRunContext | undefined;
  /** When this pass began (`Date.now()`); the completion write records its duration. */
  startedAt: number;
};

type NodeCounts = { completed: number; failed: number; skipped: number; total: number };

interface TerminalOutput {
  output: string | undefined;
  structuredOutput: unknown;
  declaredOutputPaths: DeclaredOutputPaths | undefined;
}

/**
 * Settle a pass whose layers ran to the end: fail it on node failures (or pause it on a
 * provider-limit wait), refuse completion at the evidence and write-back gates, or complete
 * it. Returns the run's terminal output, the summary for the parent conversation and the
 * `workflow:` re-entry path.
 */
export async function finishRun(
  ctx: RunTerminalContext
): Promise<string | undefined | { kind: 'container_pause' }> {
  const { deps, workflow, workflowRun, nodeOutputs } = ctx;
  const nodeCounts = countNodeStates(nodeOutputs, workflow.nodes.length);
  const anyCompleted = nodeCounts.completed > 0;
  const anyFailed = nodeCounts.failed > 0;
  const runTranscriptUsage: WorkflowUsage = {
    ...(ctx.totalCostUsd !== undefined ? { cost_usd: ctx.totalCostUsd } : {}),
    ...(ctx.totalTokens !== undefined ? { tokens: ctx.totalTokens } : {}),
  };

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted || anyFailed) {
    await failOnNodeOutcome(ctx, nodeCounts, runTranscriptUsage);
    return;
  }

  // Check if status was changed externally (e.g. cancelled) before marking complete.
  if (await skipIfStatusChanged(deps, workflowRun, 'dag.skip_complete_status_changed')) return;

  if (await failsEvidenceGate(ctx, runTranscriptUsage)) return;

  // Container write-back gate (Phase C): all nodes succeeded — before completing,
  // present the overlay diff and (unless auto) pause for approval. This is an
  // ENGINE-level gate with no DAG node. On the FIRST arrival it either pauses
  // (approve policy, non-empty diff) or applies (auto / has changes) / skips
  // (empty diff). On a RESUME after the decision, the DAG re-ran with every node
  // skipped and lands here again with `pending_writeback` set — it applies or
  // discards and falls through to completion. `paused` short-circuits (the gate
  // attempted suspension); any other outcome falls through to completeWorkflowRun.
  if (ctx.execContext.kind === 'container' && ctx.containerCtx) {
    const gate = await runContainerWriteBackGate(
      deps,
      ctx.platform,
      ctx.conversationId,
      workflowRun.id,
      ctx.containerCtx,
      ctx.execContext,
      executionClaim(workflowRun.metadata)
    );
    if (gate === 'paused') return { kind: 'container_pause' };
  }

  const terminal = selectTerminalOutput(workflow, workflowRun, nodeOutputs);
  await completeRun(ctx, nodeCounts, terminal, runTranscriptUsage);
  return terminal.output;
}

function countNodeStates(nodeOutputs: ReadonlyMap<string, NodeOutput>, total: number): NodeCounts {
  const nodeCounts = { completed: 0, failed: 0, skipped: 0, total };
  for (const o of nodeOutputs.values()) {
    if (o.state === 'completed') nodeCounts.completed++;
    else if (o.state === 'failed') nodeCounts.failed++;
    else if (o.state === 'skipped') nodeCounts.skipped++;
  }
  return nodeCounts;
}

/** Fail a pass that completed no node or had a node fail, unless it waits on a provider limit. */
async function failOnNodeOutcome(
  ctx: RunTerminalContext,
  nodeCounts: NodeCounts,
  runTranscriptUsage: WorkflowUsage
): Promise<void> {
  const { deps, platform, conversationId, workflow, workflowRun, logDir, nodeOutputs } = ctx;
  const anyFailed = nodeCounts.failed > 0;
  if (nodeCounts.completed === 0) {
    if (await skipIfStatusChanged(deps, workflowRun, 'dag.skip_fail_status_changed')) return;
    if (anyFailed && (await pauseForUsageLimit(ctx))) return;
    const failedNodes: string[] = [];
    for (const [nodeId, o] of nodeOutputs) {
      if (o.state === 'failed') failedNodes.push(nodeId);
    }
    const failMsg =
      failedNodes.length > 0
        ? `DAG workflow '${workflow.name}' failed: node${failedNodes.length > 1 ? 's' : ''} ${failedNodes.join(', ')} failed. ` +
          `${nodeCounts.skipped} downstream node${nodeCounts.skipped !== 1 ? 's were' : ' was'} skipped.`
        : `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
          'Check node conditions, trigger rules, and upstream failures.';
    // Note: nodeCounts not stored for failed runs — failWorkflowRun only stores { error }.
    // Frontend guards with isValidNodeCounts so missing node_counts is safe. (Usage IS
    // stored: persistRunUsage wrote it at the run tail, before this branch — #2469.)
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(
      deps,
      workflowRun,
      workflow.name,
      failMsg,
      // A first-node failure completes nothing, but it is still a node failure.
      anyFailed ? 'node_error' : 'no_nodes_completed',
      'dag.no_nodes_completed_fail'
    );
    return;
  }

  if (await skipIfStatusChanged(deps, workflowRun, 'dag.skip_fail_status_changed')) return;
  if (await pauseForUsageLimit(ctx)) return;
  const failedNodes = [...nodeOutputs.entries()]
    .filter(([, o]) => o.state === 'failed')
    .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
    .join('; ');
  const failMsg = `DAG workflow '${workflow.name}' completed with failures: ${failedNodes}`;
  await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
    (logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    }
  );
  await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
    workflowId: workflowRun.id,
  });
  await failRun(deps, workflowRun, workflow.name, failMsg, 'node_error', 'dag.node_failure_fail');
}

/**
 * Evidence gate (#2230): thin terminal file-presence gate, a sibling of the
 * approval/write-back gates (run-status transitions are engine governance).
 * When the workflow declares `evidence_policy.required: true`, refuse to flip
 * the run to `completed` unless `$ARTIFACTS_DIR/evidence.json` exists — the
 * engine checks presence only (no schema validation, no content checks, no
 * git/gh I/O). Any contents satisfy this convention; deterministic checks
 * and authored outcomes remain separate. Placed BEFORE
 * the container write-back gate so a run that cannot complete never pauses
 * for (or applies) write-back — mirroring how node-failure runs skip that
 * gate entirely. Resume-safe: the run id (and therefore artifactsDir) is
 * stable across resume, so a failed run resumed after evidence.json is
 * produced re-enters here with all nodes prior-completed and completes.
 */
async function failsEvidenceGate(
  ctx: RunTerminalContext,
  runTranscriptUsage: WorkflowUsage
): Promise<boolean> {
  const { deps, platform, conversationId, workflow, workflowRun, artifactsDir, logDir } = ctx;
  if (workflow.evidence_policy?.required !== true) return false;
  const evidencePath = joinPath(artifactsDir, 'evidence.json');
  if (!existsSync(evidencePath)) {
    const failMsg =
      `DAG workflow '${workflow.name}' failed the evidence marker gate: ` +
      `evidence_policy.required is true but its conventional marker file is absent at ${evidencePath}. ` +
      'The policy checks only that path; create the marker in the host artifacts directory, ' +
      'then resume the run.';
    getLog().error({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_failed');
    // Structured, machine-readable note first (metadata merge), then the
    // failed-status write — so metadata.evidence_validation is already present
    // the moment the run reads as failed.
    await deps.store
      .updateWorkflowRun(workflowRun.id, {
        metadata: {
          evidence_validation: {
            status: 'missing',
            policy: 'evidence_policy.required',
            expected_path: evidencePath,
            checked_at: new Date().toISOString(),
          },
        },
      })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id },
          'dag.evidence_metadata_write_failed'
        );
      });
    // Persist the reason into the workflow-events log (contract: never throws).
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'evidence_validation_failed',
      data: { policy: 'evidence_policy.required', expected_path: evidencePath },
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // The metadata merge above precedes the terminal write, so
    // `metadata.evidence_validation` is present the moment the run reads as failed.
    await failRun(
      deps,
      workflowRun,
      workflow.name,
      failMsg,
      'evidence_missing',
      'dag.evidence_gate_fail'
    );
    return true;
  }
  getLog().info({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_passed');
  return false;
}

/**
 * Terminal output (the run's "summary"). Computed BEFORE completeWorkflowRun so a
 * sub-run can persist it into its own metadata: a `workflow:` parent re-reads it from
 * there on auto-resume (the child's executeWorkflow return value is discarded across the
 * human gate).
 *
 * #2470: when a CHILD run's workflow declares `returns:`, its terminal output is THAT
 * node's output — even a non-sink — instead of the positional first-sink scan. Gated on
 * parent_run_id: a top-level run's summary stays the sink-scan chat/CLI affordance, not a
 * caller contract. A `returns` node that didn't complete / produced blank output threads
 * '' with a WARN and does NOT fall through to the sink scan (that would resurrect the
 * positional accident under a new name). The loop_group per-iteration terminal scan
 * (~executeLoopGroupNode) is byte-identical and DELIBERATELY unchanged — its result is
 * the iteration's, never a caller's.
 */
function selectTerminalOutput(
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): TerminalOutput {
  let terminalOutput: string | undefined;
  // The selected terminal node's structured payload (#2637), stamped beside the text
  // summary as `metadata.summary_value` so a parent `workflow:` node threads the
  // LOGICAL value back (fan-out aggregation and `.field` access keep the type).
  let terminalStructuredOutput: unknown;
  // The selected node's declared field paths (#2453) — the callee-owned half of the
  // result contract. Stamped beside `summary_value` so the parent's `workflow:` node can
  // authorize `$<node>.output.a.b` from the CHILD's schema instead of requiring the
  // caller to repeat it. Only the projection travels; the schema stays in captured source.
  let terminalDeclaredOutputPaths: DeclaredOutputPaths | undefined;
  if (workflow.returns !== undefined && workflowRun.parent_run_id) {
    const returnsOutput = nodeOutputs.get(workflow.returns);
    const value = returnsOutput?.state === 'completed' ? returnsOutput.output : undefined;
    if (value !== undefined && value.trim().length > 0) {
      terminalOutput = value;
      terminalStructuredOutput =
        returnsOutput !== undefined && 'structuredOutput' in returnsOutput
          ? returnsOutput.structuredOutput
          : undefined;
      // Taken from the completed node rather than re-derived from the definition: the
      // node already resolved its own contract (a wait node's fixed schema, a resumed
      // node's persisted projection), and re-deriving here would silently disagree.
      terminalDeclaredOutputPaths =
        returnsOutput?.state === 'completed' ? returnsOutput.declaredOutputPaths : undefined;
    } else {
      getLog().warn(
        { workflowRunId: workflowRun.id, returns: workflow.returns },
        'workflow.returns_node_blank_output'
      );
      terminalOutput = '';
    }
  } else {
    const terminalSink = workflow.plan.sinks
      .map(nodeId => nodeOutputs.get(nodeId))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0);
    terminalOutput = terminalSink?.output;
    // The sink scan's node owns its contract exactly as a `returns:` node does. Stamping
    // it here too keeps the two channels together: a child without `returns:` has threaded
    // its terminal LOGICAL value to the parent since #2637, and a value whose field
    // authorization stayed behind would read as schemaless downstream.
    terminalDeclaredOutputPaths =
      terminalSink?.state === 'completed' ? terminalSink.declaredOutputPaths : undefined;
    terminalStructuredOutput =
      terminalSink !== undefined && 'structuredOutput' in terminalSink
        ? terminalSink.structuredOutput
        : undefined;
  }

  return {
    output: terminalOutput,
    structuredOutput: terminalStructuredOutput,
    declaredOutputPaths: terminalDeclaredOutputPaths,
  };
}

async function completeRun(
  ctx: RunTerminalContext,
  nodeCounts: NodeCounts,
  terminal: TerminalOutput,
  runTranscriptUsage: WorkflowUsage
): Promise<void> {
  const { deps, workflow, workflowRun, logDir } = ctx;
  const duration = Date.now() - ctx.startedAt;

  // Emit completion, then record it. The transcript and the live event do not depend
  // on the status write and used to run whether or not it succeeded, so the
  // (now-throwing) write goes last. Terminal telemetry is reported by the run store
  // after the write commits.
  await logWorkflowComplete(logDir, workflowRun.id, runTranscriptUsage);
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  emitter.unregisterRun(workflowRun.id);

  const { completedRun, worktreeDisposition } = await assessCompletedWorktree(deps, workflowRun);

  await requireTerminalStatusWrite(
    deps.store.completeWorkflowRun(
      workflowRun.id,
      { duration_ms: duration },
      {
        node_counts: nodeCounts,
        // Cost and token totals are NOT written here — `persistRunUsage` already wrote
        // them at the run tail, before this branch was chosen (#2469). Keeping a second
        // copy here would be two writers of the same three keys, free to drift.
        // A sub-run persists its terminal summary so the parent can thread it as
        // `$<node>.output` on re-entry. Gated on parent_run_id to bound metadata
        // growth to child runs only (top-level runs return the summary directly).
        // `summary_value` is the additive logical sibling (#2637): old binaries keep
        // reading `summary`, new parents prefer the typed value when present.
        ...(workflowRun.parent_run_id && terminal.output ? { summary: terminal.output } : {}),
        ...(workflowRun.parent_run_id && terminal.output && terminal.structuredOutput !== undefined
          ? { [SUBRUN_METADATA_KEYS.summaryValue]: terminal.structuredOutput }
          : {}),
        // The callee-owned field contract (#2453). Gated on the same terminal output as
        // the two keys above, so a blank/incomplete `returns:` node stamps no contract
        // at all rather than one nothing satisfies. `summary_declared_fields` is derived
        // from the paths and still written for older binaries, which read only it.
        ...(workflowRun.parent_run_id &&
        terminal.output &&
        terminal.declaredOutputPaths !== undefined
          ? {
              [SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths]: terminal.declaredOutputPaths,
              [SUBRUN_METADATA_KEYS.summaryDeclaredFields]: rootOutputFields(
                terminal.declaredOutputPaths
              ),
            }
          : {}),
        ...(worktreeDisposition
          ? { [WORKTREE_DISPOSITION_METADATA_KEY]: worktreeDisposition }
          : {}),
      }
    ),
    { workflowRunId: workflowRun.id, site: 'dag_db_complete_failed' }
  );

  // The terminal record already carries the decision. Removing the checkout is cleanup
  // of terminal data, so a refusal or failure leaves it in place and the run completed.
  if (worktreeDisposition?.disposition === 'release') {
    try {
      await deps.completedRunWorktree?.release(completedRun);
      getLog().info({ workflowRunId: workflowRun.id }, 'workflow.completed_worktree_released');
    } catch (err) {
      getLog().warn(
        { err, workflowRunId: workflowRun.id },
        'workflow.completed_worktree_release_failed'
      );
    }
  }
}

/**
 * The wait a failed pass takes instead of failing, when every failed node either hit a
 * provider usage limit whose reset the provider reported, or hit a
 * rate limit that outlasted its retries (deadline: its reported reset when still ahead,
 * else a jittered backoff). The run cannot progress before the last of those deadlines, so
 * it waits for it if it is still ahead. An expired usage reset does not prevent waiting
 * for another node's later deadline: continuation retries both failed nodes. Any other
 * failure, a usage limit without a reported reset, no deadline still ahead,
 * `autoResumeOnQuotaReset: false`, or a container run (the continuation host does not
 * continue one) leaves the run to fail. Only the typed class says a limit is hit; the
 * error text never does.
 */
async function usageLimitWait(
  ctx: RunTerminalContext
): Promise<
  { wait: WorkflowUsageLimitWaitContext; cause: ProviderLimitFailure['class'] } | undefined
> {
  const { deps, workflowRun, config, execContext } = ctx;
  const skip = async (
    nodeId: string,
    reason: 'reset_unavailable' | 'disabled' | 'reset_passed' | 'container_unsupported'
  ): Promise<undefined> => {
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'quota_resume_skipped',
      step_name: nodeId,
      data: { reason },
    });
    return undefined;
  };
  const now = Date.now();
  let latest:
    | { nodeId: string; resumeAt: number; cause: ProviderLimitFailure['class'] }
    | undefined;
  for (const [nodeId, output] of ctx.nodeOutputs) {
    if (output.state !== 'failed') continue;
    const failure = output.providerFailure;
    if (!isProviderLimit(failure)) return undefined;
    const resumeAt = providerLimitResumeAt(failure, now);
    if (resumeAt === undefined) return skip(nodeId, 'reset_unavailable');
    if (latest === undefined || resumeAt > latest.resumeAt)
      latest = { nodeId, resumeAt, cause: failure.class };
  }
  if (latest === undefined) return undefined;
  if (config.workflows?.autoResumeOnQuotaReset === false) return skip(latest.nodeId, 'disabled');
  if (latest.resumeAt <= now) return skip(latest.nodeId, 'reset_passed');
  if (execContext.kind === 'container') return skip(latest.nodeId, 'container_unsupported');
  return {
    wait: {
      owner: 'node',
      nodeId: latest.nodeId,
      kind: 'quota',
      pauseId: randomUUID(),
      waitingSince: new Date(now).toISOString(),
      resumeAt: new Date(latest.resumeAt).toISOString(),
    },
    cause: latest.cause,
  };
}

/** Pause the run on a provider-limit wait. False when the pass must fail instead. */
async function pauseForUsageLimit(ctx: RunTerminalContext): Promise<boolean> {
  const { deps, workflowRun, workflow, platform, conversationId } = ctx;
  const limit = await usageLimitWait(ctx);
  if (limit === undefined) return false;
  const { wait, cause } = limit;
  try {
    await deps.store.pauseWorkflowRunForWait(workflowRun.id, wait, {
      kind: 'started',
      stepName: wait.nodeId,
    });
  } catch (pauseError) {
    if (!(pauseError instanceof WorkflowRunPauseConflictError)) throw pauseError;
    // A run cancelled or paused meanwhile keeps that status, exactly as the failure
    // branches below leave it.
    const status = await statusAfterPauseFailure(deps.store, workflowRun.id, pauseError);
    if (status === 'running') throw pauseError;
    getLog().warn({ workflowRunId: workflowRun.id }, 'dag.usage_limit_wait_status_changed');
    return true;
  }
  getLog().info(
    { workflowRunId: workflowRun.id, nodeId: wait.nodeId, resumeAt: wait.resumeAt, cause },
    'dag.usage_limit_wait_started'
  );
  await safeSendMessage(
    platform,
    conversationId,
    cause === 'rate_limited'
      ? `⏸️ Workflow '${workflow.name}' hit a provider rate limit at node '${wait.nodeId}' ` +
          `and ran out of retries. It tries again at ${wait.resumeAt}; resume it to try ` +
          'sooner, or abandon it to stop it.'
      : `⏸️ Workflow '${workflow.name}' hit a provider usage limit at node '${wait.nodeId}'. ` +
          `It waits until the limit resets at ${wait.resumeAt}, then continues.`,
    { workflowId: workflowRun.id }
  );
  return true;
}

/**
 * The engine's terminal failure write. The live `workflow_failed` event is published only
 * when this call committed the failure: a run another writer already finished (a
 * cancellation during the failure notification, or a competing failure) keeps that
 * writer's outcome and announcement. A rejected write throws the typed marker, which the
 * outer executor catch rethrows without emitting.
 */
export async function failRun(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  workflowName: string,
  failMsg: string,
  exitReason: RunExitReason,
  site: string
): Promise<void> {
  const emitter = getWorkflowEventEmitter();
  try {
    const { failed } = await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(workflowRun.id, failMsg, { exitReason }),
      { workflowRunId: workflowRun.id, site }
    );
    if (failed) {
      emitter.emit({
        type: 'workflow_failed',
        runId: workflowRun.id,
        workflowName,
        error: failMsg,
      });
    }
  } finally {
    emitter.unregisterRun(workflowRun.id);
  }
}

/**
 * Bail out of the final completion/failure write if the run was transitioned
 * externally. Strict `!== 'running'` check is correct here because we don't
 * want to mark a paused run as complete — the approval gate is still live.
 *
 * Emitter unregister is conditional: terminal states (cancelled / deleted /
 * completed / failed) unregister to release subscription resources, but
 * `paused` keeps the emitter registered so SSE stays connected while the
 * approval gate awaits the user — crucial for resume observability.
 */
export async function skipIfStatusChanged(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun,
  logEvent: string
): Promise<boolean> {
  const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
  if (status === 'running') return false;
  getLog().info({ workflowRunId: workflowRun.id, status: status ?? 'deleted' }, logEvent);
  if (status !== 'paused') {
    getWorkflowEventEmitter().unregisterRun(workflowRun.id);
  }
  return true;
}

/**
 * Decide what happens to a completed run's worktree. The check is optional cleanup, so a
 * failure leaves the disposition unset and never blocks the completion write.
 */
async function assessCompletedWorktree(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun
): Promise<{ completedRun: WorkflowRun; worktreeDisposition?: WorktreeDisposition | null }> {
  if (!deps.completedRunWorktree) return { completedRun: workflowRun };
  try {
    // Read fresh: a pre-created run's `owned_worktree` proof is stamped on the row after
    // this object was loaded.
    const completedRun = (await deps.store.getWorkflowRun(workflowRun.id)) ?? workflowRun;
    return {
      completedRun,
      worktreeDisposition: await deps.completedRunWorktree.assess(completedRun),
    };
  } catch (err) {
    getLog().warn(
      { err, workflowRunId: workflowRun.id },
      'workflow.completed_worktree_assess_failed'
    );
    return { completedRun: workflowRun };
  }
}
