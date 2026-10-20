import { type NodeFailureKind } from '../schemas/node-execution';
import type { MessageChunk } from '@archon/provider-contract';
import { type ProviderFailure } from '@archon/provider-contract';
import { nodeFailureKindOf } from '../executor-shared';
import { getLog } from './log';

export interface WatchdogReset {
  type: MessageChunk['type'];
  at: number;
}

export function formatWatchdogResetDiagnostic(lastReset: WatchdogReset | undefined): string {
  return lastReset
    ? ` Last watchdog reset: ${new Date(lastReset.at).toISOString()} from chunk type '${lastReset.type}'.`
    : ' No provider chunk reset the watchdog after the stream opened.';
}

/**
 * Max validate-and-reask attempts for a `best-effort` provider whose structured
 * output fails schema validation (separate from the transient-error retries in dag/retry.ts).
 * Enforced providers don't reask — a validation failure there is a genuine edge
 * (refusal / max_tokens truncation) and fails fast.
 */
export const STRUCTURED_OUTPUT_MAX_REASKS = 3;

/**
 * The session one structured-output pass resumes, and whether the session it ends in
 * becomes the node's thread. A reask runs in a fresh throwaway session so an invalid
 * turn is never carried forward. That session holds one repaired turn and none of the
 * node's work, so it never becomes the thread: attempt 0's session stays the one the
 * next iteration, the next node, and the node record continue (#2563, #3584). A named
 * `context: resume` is the exception: every pass forks the declared source itself and
 * must prove that fork on its own, so each pass ends in a real fork of the source.
 */
export function structuredOutputPass(
  reaskAttempt: number,
  resumeSessionId: string | undefined,
  forksNamedSource: boolean
): { resumeSessionId: string | undefined; threadsSession: boolean } {
  const threadsSession = forksNamedSource || reaskAttempt === 0;
  return { resumeSessionId: threadsSession ? resumeSessionId : undefined, threadsSession };
}

export type TurnCutOff =
  | { kind: 'operator' }
  | { kind: 'idle_timeout'; timeoutMs: number; lastReset: WatchdogReset | undefined };

export function cutOffClause(): string {
  return 'was ended by the operator after its tool call or reported work stalled';
}

/**
 * Why a turn that produced output is not finished: its provider never sent `settled`.
 * A cut-off says what ended the stream; otherwise the stream simply ended.
 * The caller names the node or iteration in front of it.
 */
export function unsettledTurnError(
  cutOff: TurnCutOff | undefined,
  liveTaskIds: readonly string[]
): string {
  const cause =
    cutOff?.kind === 'idle_timeout'
      ? `timed out after ${String(cutOff.timeoutMs / 60000)} min without an event, before the provider signalled that its turn settled.${formatWatchdogResetDiagnostic(cutOff.lastReset)}`
      : cutOff !== undefined
        ? `${cutOffClause()}, before the provider signalled that its turn settled.`
        : 'the provider stream ended without signalling that its turn settled.';
  const tasks =
    liveTaskIds.length > 0 ? ` Subtask(s) still running: ${liveTaskIds.join(', ')}.` : '';
  return `${cause}${tasks} Its work may be incomplete.`;
}

/** A node failure whose cause the engine detected itself, carried to the failure record. */
export class NodeFailure extends Error {
  constructor(
    readonly kind: NodeFailureKind,
    message: string,
    /** The provider's typed failure, recorded unchanged on the failed node. */
    readonly providerFailure?: ProviderFailure
  ) {
    super(message);
  }
}

/**
 * A provider's typed failure on its result chunk. The kind comes from the class, so retry
 * never reads the evidence text, which stays in the message for the operator.
 */
export function providerReportedFailure(
  subject: string,
  failure: ProviderFailure,
  maxBudgetUsd: number | undefined,
  logContext: Record<string, unknown>
): NodeFailure {
  let message: string;
  switch (failure.class) {
    case 'budget_exceeded':
      getLog().warn({ ...logContext, maxBudgetUsd }, 'dag.node_budget_cap_exceeded');
      message = `${subject} exceeded cost cap${maxBudgetUsd !== undefined ? ` of $${maxBudgetUsd.toFixed(2)}` : ''}.`;
      break;
    case 'misconfigured':
      message = `${subject} failed: the provider's configuration must be fixed before it can run; retrying will not help: ${failure.evidence}`;
      break;
    case 'quota_exhausted':
      // With a reported reset the run usually waits for it and continues by itself, so the
      // text gives no resume advice: resuming before the reset spends a provider call.
      message =
        failure.resetAt !== undefined
          ? `${subject} failed: the provider's usage or credit limit is used up until ${failure.resetAt}: ${failure.evidence}`
          : `${subject} failed: the provider's usage or credit limit is used up. Resume the run once it reopens: ${failure.evidence}`;
      break;
    default:
      message = `${subject} failed: provider reported ${failure.class}: ${failure.evidence}`;
  }
  return new NodeFailure(nodeFailureKindOf(failure), message, failure);
}
