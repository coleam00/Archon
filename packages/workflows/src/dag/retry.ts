import type { DagNode, NodeOutput, AgentNode, ExecNode, WorkflowRun } from '../schemas';
import {
  type RetryClass,
  retryClassOf,
  effectiveRetryMaxRetries,
  getRetryDelayMs,
} from '../executor-shared';
import { safeSendMessage } from '../platform-messages';
import type { NodeExecutionResult } from '../node-record-serialization';
import {
  admitRunBudgetAttempt,
  RunBudgetRefusedError,
  runBudgetWorkUnitEvent,
  settleRunBudgetAttempt,
} from '../run-budget';
import { persistNodeEvent } from '../node-event-write';
import type { IWorkflowPlatform, WorkflowDeps } from '../deps';
import type { RunLayersContext } from './run-context';
import { shouldContinueStreamingForStatus, waitForNodeRetry } from './run-control';
import { sumTokenUsage } from './usage';
import { getLog } from './log';

/** Default DAG node retry for TRANSIENT errors */
export const DEFAULT_NODE_MAX_RETRIES = 2;

export const DEFAULT_NODE_RETRY_DELAY_MS = 3000;

/**
 * Get effective retry config for a DAG node.
 */
export function getEffectiveNodeRetryConfig(node: DagNode): {
  maxRetries: number;
  delayMs: number;
  onError: 'transient' | 'all';
} {
  if ('retry' in node && node.retry) {
    return {
      maxRetries: node.retry.max_attempts,
      delayMs: node.retry.delay_ms ?? DEFAULT_NODE_RETRY_DELAY_MS,
      onError: node.retry.on_error ?? 'transient',
    };
  }
  return {
    maxRetries: DEFAULT_NODE_MAX_RETRIES,
    delayMs: DEFAULT_NODE_RETRY_DELAY_MS,
    onError: 'transient',
  };
}

/**
 * Retry config for a deterministic (bash/script) node.
 *
 * Same field mapping as {@link getEffectiveNodeRetryConfig}, but deterministic
 * nodes get NO default: an absent `retry:` block returns `undefined` (single
 * attempt) rather than the AI-node default of {@link DEFAULT_NODE_MAX_RETRIES}
 * transient retries. Retry is strictly opt-in so side-effectful scripts (deploys,
 * `gh` mutations, external CLIs) are never silently re-run on a transient-looking
 * failure. Delegates so the two configs can't derive the retry block differently.
 */
export function getExplicitNodeRetryConfig(
  node: DagNode
): ReturnType<typeof getEffectiveNodeRetryConfig> | undefined {
  return 'retry' in node && node.retry ? getEffectiveNodeRetryConfig(node) : undefined;
}

/**
 * The retry class of a failed node output that warrants another attempt, or
 * `undefined` when it does not.
 *
 * Shared by {@link runNodeRetryLoop} for every node type so the retry decision
 * cannot drift. The class comes from {@link retryClassOf}: the kind recorded where
 * the node failed decides, never its error text. Fatal failures (credentials, quota
 * and spend windows, config errors, cancellation) are never retried, even when
 * `on_error: all`; `unknown` is retried only under `on_error: all`.
 */
export function retryableFailureClass(
  output: NodeOutput,
  onError: 'transient' | 'all'
): RetryClass | undefined {
  // Only failed outputs carry `error` (discriminated union); a non-failed output
  // is never retried. Callers already guard on `state === 'failed'`, but narrow
  // here too so `output.error` type-checks and the helper is safe standalone.
  if (output.state !== 'failed') return undefined;
  // A producer that diagnosed its own output (an exec contract failure, #2453) says so
  // in the type: its stdout is deterministically wrong, so no class re-runs it.
  if (output.retryable === false) return undefined;
  const retryClass = retryClassOf(output.failureKind);
  if (retryClass === 'fatal') return undefined;
  if (retryClass === 'unknown' && onError !== 'all') return undefined;
  return retryClass;
}

/**
 * Run one governed attempt under the run budget: admit and reserve a work unit, write
 * its durable record, run the attempt, then charge its spend. The executor reserves
 * after source preparation and before recording its attempt. Admission is synchronous
 * so parallel siblings cannot share the last unit.
 */
export async function runBudgetedAttempt(
  ctx: RunLayersContext,
  node: AgentNode | ExecNode,
  attempt: (reserve: () => Promise<void>) => Promise<NodeExecutionResult>
): Promise<NodeExecutionResult> {
  const ledger = ctx.runBudget;
  if (ledger === undefined) return attempt(async () => undefined);
  const path = ctx.stepNamePrefix + node.id;
  const reserve = async (): Promise<void> => {
    const refusal = admitRunBudgetAttempt(ledger, path);
    if (refusal !== undefined) throw new RunBudgetRefusedError(refusal);
    await persistNodeEvent(ctx.deps.store, runBudgetWorkUnitEvent(ctx.workflowRun.id, path));
  };
  const executionBefore = ctx.currentExecution;
  let result: NodeExecutionResult;
  try {
    result = await attempt(reserve);
  } catch (error) {
    // An agent attempt that started and then threw never reported its cost. One that
    // threw before starting made no provider call.
    if (node.kind === 'agent' && ctx.currentExecution !== executionBefore) {
      ledger.usage.costUnavailable ??= { path, reason: 'interrupted' };
    }
    throw error;
  }
  const settlement = settleRunBudgetAttempt(ledger, node.kind, path, result.execution);
  if (settlement !== undefined) throw new RunBudgetRefusedError(settlement);
  return result;
}

/**
 * Run a node executor with the shared retry loop: exponential backoff, FATAL
 * never retried, and a platform notification before each retry. Used by both the
 * AI-node path in `dispatchAgentNode` and {@link runDeterministicNodeWithRetry} so
 * the backoff math and user-facing wording are defined once and can't drift.
 * `initialOutput` seeds `output` for the unreachable zero-iteration case. Usage is
 * accumulated across failed attempts so a later success still reports all paid work.
 *
 * Each attempt also writes its OWN terminal event carrying only that attempt's usage,
 * so the event log and this accumulated total agree rather than double-counting: two
 * attempts costing $0.02 then $0.03 leave two rows summing to $0.05, which is what this
 * returns. That is the "money burned" reading of a run's total — every attempt counts
 * (#2654 made failed rows contribute; see getDagResumeSnapshot for what that means).
 */
export async function runNodeRetryLoop(
  node: DagNode,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  store: Pick<WorkflowDeps['store'], 'createWorkflowEvent' | 'getWorkflowRunStatus'>,
  stepName: string,
  retryConfig: { maxRetries: number; delayMs: number; onError: 'transient' | 'all' },
  run: () => Promise<NodeExecutionResult>,
  initialOutput: NodeExecutionResult,
  iteration?: number
): Promise<NodeExecutionResult> {
  let output = initialOutput;
  let usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'> = {
    tokensUnknown: false,
  };
  // Once a rate-limited failure is seen, the budget widens to RATE_LIMIT_MAX_RETRIES
  // for the rest of the loop (#2706): load-shedding windows are minutes-scale, so the
  // node's own short maxRetries would exhaust before the provider recovers.
  let sawRateLimit = false;
  let attempt = 0;
  while (true) {
    if (attempt > 0) {
      const status = await store.getWorkflowRunStatus(workflowRun.id);
      if (!shouldContinueStreamingForStatus(status)) {
        output = {
          state: 'failed',
          output: '',
          error: `Workflow ${status ?? 'deleted'}`,
          failureKind: 'cancelled',
        };
        break;
      }
    }
    output = await run();
    usage = accumulateAttemptUsage(usage, output, node.id);
    if (output.state !== 'failed') break;

    const retryClass = retryableFailureClass(output, retryConfig.onError);
    if (retryClass === 'rate_limited') sawRateLimit = true;
    const effectiveMaxRetries = effectiveRetryMaxRetries(
      retryConfig.maxRetries,
      retryClass,
      sawRateLimit
    );
    if (retryClass === undefined || attempt >= effectiveMaxRetries) break;

    await scheduleRetry(retryClass, attempt, effectiveMaxRetries, output.error);
    attempt++;
  }
  output.costUsd = usage.costUsd;
  output.tokens = usage.tokens;
  output.tokensUnknown = usage.tokensUnknown;
  return output;

  async function scheduleRetry(
    retryClass: RetryClass,
    attempt: number,
    effectiveMaxRetries: number,
    error: string
  ): Promise<void> {
    const delayMs = getRetryDelayMs(retryClass, attempt, retryConfig.delayMs);
    getLog().warn(
      {
        nodeId: node.id,
        attempt: attempt + 1,
        maxRetries: effectiveMaxRetries,
        retryClass,
        delayMs,
        error,
      },
      'dag_node_transient_retry'
    );

    const errorKind =
      retryClass === 'overloaded'
        ? 'provider capacity error'
        : retryClass === 'unknown'
          ? 'error'
          : 'transient error';
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Node \`${node.id}\` failed with ${errorKind} (attempt ${String(attempt + 1)}/${String(effectiveMaxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
      { workflowId: workflowRun.id, nodeName: node.id }
    );

    await store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_retry_scheduled',
      step_name: stepName,
      data: {
        nodeId: node.id,
        retry_class: retryClass,
        retry_attempt: attempt + 1,
        max_retries: effectiveMaxRetries,
        delay_ms: delayMs,
        ...(iteration !== undefined ? { iteration } : {}),
      },
    });
    await waitForNodeRetry(store, workflowRun.id, node.id, delayMs);
  }
}

function accumulateAttemptUsage(
  accumulated: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'>,
  output: NodeExecutionResult,
  nodeId: string
): Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'> {
  const costUsd =
    output.costUsd === undefined
      ? accumulated.costUsd
      : (accumulated.costUsd ?? 0) + output.costUsd;
  const tokensUnknown = accumulated.tokensUnknown === true || output.tokensUnknown === true;
  let tokens = accumulated.tokens;
  if (tokensUnknown) {
    tokens = undefined;
  } else if (output.tokens !== undefined) {
    tokens = sumTokenUsage([...(tokens !== undefined ? [tokens] : []), output.tokens], { nodeId });
  }
  return { costUsd, tokens, tokensUnknown };
}

/**
 * Run a deterministic (bash/script) node with opt-in retry.
 *
 * Deterministic nodes get exactly one attempt unless they declare an explicit
 * `retry:` block. When they do, transient/all failures are retried via the shared
 * {@link runNodeRetryLoop} (same exponential-backoff + FATAL-never-retried
 * semantics as AI nodes). The single-attempt default is preserved so scripts with
 * side effects aren't silently re-executed (#2088).
 */
export async function runDeterministicNodeWithRetry(
  node: DagNode,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  store: Pick<WorkflowDeps['store'], 'createWorkflowEvent' | 'getWorkflowRunStatus'>,
  stepName: string,
  run: () => Promise<NodeExecutionResult>,
  iteration?: number
): Promise<NodeExecutionResult> {
  const retryConfig = getExplicitNodeRetryConfig(node);
  // No explicit retry: preserve the single-attempt deterministic-node default.
  if (!retryConfig) {
    return run();
  }
  return runNodeRetryLoop(
    node,
    platform,
    conversationId,
    workflowRun,
    store,
    stepName,
    retryConfig,
    run,
    {
      state: 'failed',
      output: '',
      error: 'Node did not execute',
    },
    iteration
  );
}
