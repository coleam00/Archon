import { formatWatchdogResetDiagnostic, cutOffClause, unsettledTurnError } from '../../ai-turn';
import type { NodeExecutionResult } from '../../../node-record-serialization';
import type { NodeFailureKind } from '../../../schemas/node-execution';
import { validateStructuredOutput } from '../../../structured-output';
import { getWorkflowEventEmitter } from '../../../event-emitter';
import { retryClassOf, getRetryDelayMs, effectiveRetryMaxRetries } from '../../../executor-shared';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { rejectedArtifactPointer } from '../../node-output';
import { waitForNodeRetry } from '../../run-control';
import {
  failLoopNode,
  logIterationEventError,
  loopSpend,
  type LoopRun,
  type LoopState,
} from './loop-state';
import type {
  AttemptVerdict,
  IterationFailed,
  IterationFailure,
  IterationRetry,
  Reask,
  StreamedAttempt,
} from './iteration-stream';

export function failed(result: NodeExecutionResult): IterationFailed {
  return { kind: 'failed', result };
}

export function recordIterationFailed(
  run: LoopRun,
  i: number,
  error: string,
  duration: number
): void {
  const { ctx, node } = run;
  getWorkflowEventEmitter().emit({
    type: 'loop_iteration_failed',
    runId: ctx.workflowRun.id,
    nodeId: node.id,
    iteration: i,
    error,
  });
  ctx.deps.store
    .createWorkflowEvent({
      workflow_run_id: ctx.workflowRun.id,
      event_type: 'loop_iteration_failed',
      step_name: run.stepName,
      data: { iteration: i, error, duration, nodeId: node.id },
    })
    .catch((evtErr: Error) => {
      logIterationEventError(node.id, evtErr, i);
    });
}

export async function retryOrFail(
  run: LoopRun,
  state: LoopState,
  i: number,
  failure: IterationFailure,
  retry: IterationRetry
): Promise<AttemptVerdict> {
  if (await tryIterationTransientRetry(run, i, failure, retry)) return { kind: 'retry' };
  return failed(
    await failLoopNode(
      run.ctx,
      run.node.id,
      state,
      `Loop iteration ${String(i)} failed: ${failure.error}`,
      {
        failureKind: failure.failureKind,
        ...(failure.providerFailure !== undefined
          ? { providerFailure: failure.providerFailure }
          : {}),
        ...loopSpend(state),
        loopIterations: i,
        data: { iteration: i },
      }
    )
  );
}

async function tryIterationTransientRetry(
  run: LoopRun,
  i: number,
  failure: IterationFailure,
  retry: IterationRetry
): Promise<boolean> {
  const { ctx, node } = run;
  const retryClass = retryClassOf(failure.failureKind);
  if (retryClass === 'rate_limited') retry.sawRateLimit = true;
  if (retryClass !== 'transient' && retryClass !== 'rate_limited' && retryClass !== 'overloaded')
    return false;
  const message = failure.error;
  const maxRetries = effectiveRetryMaxRetries(
    run.retryConfig.maxRetries,
    retryClass,
    retry.sawRateLimit
  );
  if (retry.attempt >= maxRetries) return false;
  const delayMs = getRetryDelayMs(retryClass, retry.attempt, run.retryConfig.delayMs);
  getLog().warn(
    {
      nodeId: node.id,
      iteration: i,
      attempt: retry.attempt + 1,
      maxRetries,
      retryClass,
      delayMs,
      error: message,
    },
    'loop_node.iteration_transient_retry'
  );
  await safeSendMessage(
    ctx.platform,
    ctx.conversationId,
    `⚠️ Loop \`${node.id}\` iteration ${String(i)} failed with ${retryClass === 'overloaded' ? 'a provider capacity error' : 'a transient error'} (attempt ${String(retry.attempt + 1)}/${String(maxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
    run.msgContext
  );
  await ctx.deps.store.createWorkflowEvent({
    workflow_run_id: ctx.workflowRun.id,
    event_type: 'node_retry_scheduled',
    step_name: run.stepName,
    data: {
      nodeId: node.id,
      iteration: i,
      retry_class: retryClass,
      retry_attempt: retry.attempt + 1,
      max_retries: maxRetries,
      delay_ms: delayMs,
    },
  });
  await waitForNodeRetry(ctx.deps.store, ctx.workflowRun.id, node.id, delayMs);
  return true;
}

/** A stream that ended cancelled, empty or unsettled; undefined when it finished. */
export async function failedStream(
  run: LoopRun,
  state: LoopState,
  i: number,
  attempt: StreamedAttempt,
  scope: { wantsStructured: boolean; iterationStart: number; retry: IterationRetry }
): Promise<AttemptVerdict | undefined> {
  // Cancelled mid-stream (not idle timeout or an end-turn request): stop the node before signal
  // detection / until_bash / the interactive gate run against a truncated
  // iteration — mirrors both the AI-node 'Cancelled by user' return and
  // this loop's own between-iteration stop path.
  if (attempt.abort.signal.aborted && !attempt.cutOff) {
    return failed(await stoppedDuringStream(run, state, i, attempt));
  }
  // Before a result, the structured gate owns an output_format timeout, naming the
  // missing payload and failing without a reask. After a result, settlement must be
  // checked first even when a schema-valid payload arrived.
  if (scope.wantsStructured && !attempt.sawResult && attempt.cutOff?.kind === 'idle_timeout')
    return undefined;
  const failure =
    emptyOutputFailure(run, i, attempt, scope.iterationStart) ??
    unsettledFailure(run, i, attempt, scope.iterationStart);
  return failure === undefined ? undefined : retryOrFail(run, state, i, failure, scope.retry);
}

async function stoppedDuringStream(
  run: LoopRun,
  state: LoopState,
  i: number,
  attempt: StreamedAttempt
): Promise<NodeExecutionResult> {
  const effectiveStatus = attempt.stopStatus ?? 'cancelled';
  await safeSendMessage(
    run.ctx.platform,
    run.ctx.conversationId,
    `Loop node '${run.node.id}' stopped during iteration ${String(i)} (${effectiveStatus})`,
    run.msgContext
  );
  return failLoopNode(run.ctx, run.node.id, state, `Workflow ${effectiveStatus}`, {
    failureKind: 'cancelled',
    ...loopSpend(state),
    loopIterations: i,
    data: { status: effectiveStatus, iteration: i },
  });
}

/**
 * Empty assistant output is an iteration failure for AI loops — same contract as the
 * single-shot AI-node guard in executeAgentNode. A provider stream that closed cleanly
 * with zero content typically means a silent rejection or interruption; left unchecked,
 * an interactive loop would pause with a blank gate or burn the full max_iterations
 * budget producing nothing. A timeout before any output is the same failure as on a
 * single-shot AI node, so it enters the transient retry path instead of consuming an
 * iteration.
 *
 * A structured payload is also exempt (#2563), matching the agent node's
 * empty-output guard, which also requires `structuredOutput === undefined`: with
 * grammar-constrained decoding the assistant prose is routinely EMPTY because the
 * whole answer arrived as the payload. Failing that would make every Claude/Codex
 * structured loop fail on iteration 1.
 */
function emptyOutputFailure(
  run: LoopRun,
  i: number,
  attempt: StreamedAttempt,
  iterationStart: number
): IterationFailure | undefined {
  if (attempt.sawResult && !attempt.settled) return undefined;
  if (attempt.fullOutput.trim() !== '' || attempt.structured !== undefined) return undefined;
  const { node } = run;
  const iterationDuration = Date.now() - iterationStart;
  const emptyError =
    attempt.cutOff?.kind === 'operator'
      ? `Loop node '${node.id}' iteration ${String(i)} ${cutOffClause()}, before producing output.`
      : attempt.cutOff?.kind === 'idle_timeout'
        ? `Loop node '${node.id}' iteration ${String(i)} timed out with no output (idle for ${String(attempt.cutOff.timeoutMs / 60000)} min).${formatWatchdogResetDiagnostic(attempt.cutOff.lastReset)} Consider increasing idle_timeout or reducing prompt size.`
        : 'Loop iteration produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.';
  getLog().error(
    { nodeId: node.id, iteration: i, durationMs: iterationDuration },
    'loop_node.iteration_empty_output'
  );
  recordIterationFailed(run, i, emptyError, iterationDuration);
  return { failureKind: attempt.cutOff ? 'timeout' : 'transient', error: emptyError };
}

/**
 * Output without `settled` means the iteration's stream was cut off, not finished
 * (see executeAgentNode).
 */
function unsettledFailure(
  run: LoopRun,
  i: number,
  attempt: StreamedAttempt,
  iterationStart: number
): IterationFailure | undefined {
  if (attempt.settled) return undefined;
  const { node } = run;
  const unsettledError = unsettledTurnError(
    attempt.cutOff,
    attempt.providerEvents.liveSubtaskIds(),
    attempt.sawResult ? run.workflowProvider : undefined
  );
  getLog().error({ nodeId: node.id, iteration: i }, 'loop_node.iteration_unsettled');
  recordIterationFailed(run, i, unsettledError, Date.now() - iterationStart);
  return { failureKind: attempt.cutOff ? 'timeout' : 'unknown', error: unsettledError };
}

type StructuredVerdict =
  | { kind: 'accepted'; payload: unknown }
  | { kind: 'reask'; errors: string[] }
  | IterationFailed;

export async function gateStructuredAttempt(
  run: LoopRun,
  state: LoopState,
  i: number,
  attempt: StreamedAttempt,
  reask: Reask,
  maxReasks: number
): Promise<StructuredVerdict> {
  const { ctx, node } = run;
  // An idle timeout, operator cutoff or user abort is a genuine failure, not a validation
  // miss — never spend a reask on it (mirrors the agent node's canReask).
  const canReask = reask.attempt < maxReasks && !attempt.cutOff && !attempt.abort.signal.aborted;

  if (attempt.structured !== undefined) {
    return gateStructuredPayload(run, state, i, attempt.structured, {
      canReask,
      nextReask: reask.attempt + 1,
      maxReasks,
    });
  }

  // No structured payload at all (prose / refusal / parse miss / timeout).
  getLog().warn(
    { nodeId: node.id, workflowRunId: ctx.workflowRun.id, iteration: i },
    'loop_node.structured_output_missing'
  );
  if (canReask) return { kind: 'reask', errors: ['no JSON object was found in the response'] };
  // Report the real cause: a timeout produces no payload either, and calling
  // that "the model replied with prose" would send the author down the wrong path.
  return failed(
    await failLoopNode(
      ctx,
      node.id,
      state,
      attempt.cutOff?.kind === 'idle_timeout'
        ? `Loop node '${node.id}' iteration ${String(i)}: timed out before producing the required structured output.${formatWatchdogResetDiagnostic(attempt.cutOff.lastReset)}`
        : `Loop node '${node.id}' iteration ${String(i)}: output_format declared but the provider returned no schema-valid structured output. The model likely replied with prose, refused, or emitted unparseable JSON.`,
      {
        failureKind: attempt.cutOff?.kind === 'idle_timeout' ? 'timeout' : 'output_contract',
        output: state.lastOutput,
        ...loopSpend(state),
        loopIterations: i,
        data: { iteration: i },
      }
    )
  );
}

async function gateStructuredPayload(
  run: LoopRun,
  state: LoopState,
  i: number,
  structured: unknown,
  reask: { canReask: boolean; nextReask: number; maxReasks: number }
): Promise<StructuredVerdict> {
  const { ctx, node } = run;
  const failStructured = async (
    error: string,
    failureKind: NodeFailureKind
  ): Promise<IterationFailed> =>
    failed(
      await failLoopNode(ctx, node.id, state, error, {
        failureKind,
        output: state.lastOutput,
        ...loopSpend(state),
        loopIterations: i,
        data: { iteration: i },
      })
    );
  // Validate against the declared schema for EVERY provider — an SDK-enforced
  // one still bypasses grammar-constrained decoding on a refusal or a
  // max_tokens truncation. An uncompilable schema FAILS the node (#2453),
  // same contract as the ordinary AI gate: the loader already rejects one,
  // so continuing here would enforce nothing after paying for the iteration.
  let schemaCompileError: string | undefined;
  const validation = validateStructuredOutput(structured, node.output_format ?? {}, compileMsg => {
    schemaCompileError = compileMsg;
  });
  if (schemaCompileError !== undefined) {
    getLog().warn(
      {
        nodeId: node.id,
        workflowRunId: ctx.workflowRun.id,
        iteration: i,
        compileMsg: schemaCompileError,
      },
      'loop_node.structured_output_schema_uncompilable'
    );
    return failStructured(
      `Loop node '${node.id}' iteration ${String(i)}: its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`,
      'config'
    );
  }
  if (validation.valid) {
    // Same gate the ordinary AI node applies before its value is persisted:
    // an unaddressable artifact pointer fails the node rather than riding
    // into this iteration's payload (#2453).
    const badPointer = await rejectedArtifactPointer(ctx.workflowRun, structured);
    if (badPointer !== null) {
      return failStructured(
        `Loop node '${node.id}' iteration ${String(i)}: ${badPointer}.`,
        'output_contract'
      );
    }
    return { kind: 'accepted', payload: structured };
  }
  getLog().warn(
    {
      nodeId: node.id,
      workflowRunId: ctx.workflowRun.id,
      iteration: i,
      attempt: reask.nextReask - 1,
      errors: validation.errors,
    },
    'loop_node.structured_output_invalid'
  );
  if (reask.canReask) {
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Loop \`${node.id}\` iteration ${String(i)}: structured output failed schema validation, re-asking (${String(reask.nextReask)}/${String(reask.maxReasks)}).`,
      run.msgContext
    );
    return { kind: 'reask', errors: validation.errors };
  }
  return failStructured(
    `Loop node '${node.id}' iteration ${String(i)}: output_format declared but the provider's structured output failed schema validation: ${validation.errors.join('; ')}`,
    'output_contract'
  );
}
