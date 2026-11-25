import { type NodeFailureKind, type NodeProviderFailure } from '../schemas/node-execution';
import type { MessageChunk, ProviderCapabilities, ProviderEvent } from '@archon/provider-contract';
import { providerEventSchema, type ProviderFailure } from '@archon/provider-contract';
import { nodeFailureKindOf } from '../executor-shared';
import { getLog } from './log';

export function assertResultBeforeSettlement(
  chunk: MessageChunk,
  awaitingSettlement: boolean,
  provider: string
): void {
  if (chunk.type === 'settled' && !awaitingSettlement) {
    throw new NodeFailure('unknown', `provider '${provider}' sent settled before result`);
  }
}

const PROVIDER_EVENT_TYPES: ReadonlySet<MessageChunk['type']> = new Set(
  providerEventSchema.options.map(schema => schema.shape.type.value)
);

/**
 * Whether a chunk is an event the node records. `result`, `settled` and `session` are turn
 * metadata the stream loop reads itself; a new non-event chunk is skipped by default.
 */
export function isProviderEvent(chunk: MessageChunk): chunk is ProviderEvent {
  return PROVIDER_EVENT_TYPES.has(chunk.type);
}

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
 * Max validate-and-reask attempts for a provider that declares `structuredOutputCorrection`,
 * when its structured output is missing or fails schema validation (separate from the
 * transient-error retries in dag/retry.ts). A provider that declares none is not asked
 * again: Claude's SDK retries an invalid answer itself, so a miss that reaches Archon is a
 * genuine edge (refusal / max_tokens truncation) and fails fast.
 */
export const STRUCTURED_OUTPUT_MAX_REASKS = 3;

/** How many times a node's structured output may be asked again on this provider. */
export function structuredOutputMaxReasks(
  capabilities: ProviderCapabilities,
  wantsStructured: boolean
): number {
  return wantsStructured && capabilities.structuredOutputCorrection !== undefined
    ? STRUCTURED_OUTPUT_MAX_REASKS
    : 0;
}

/** The schema errors a correction feeds back, with nothing else around them. */
export function structuredOutputCorrectionBlock(errors: readonly string[]): string {
  return (
    '--- CORRECTION ---\n' +
    `Your previous response did not satisfy the required JSON schema: ${errors.join('; ')}. ` +
    'Respond again with ONLY a JSON object matching the schema — no prose, no code fences.'
  );
}

export interface StructuredOutputPass {
  resumeSessionId: string | undefined;
  /** Whether the session this pass ends in becomes the node's thread. */
  threadsSession: boolean;
  /**
   * A same-session correction: the pass continues the thread an earlier pass of this
   * attempt ended in. It never forks and never falls back to a fresh session, and it is
   * not the node's own resume, so it does not change whether the node counts as resumed.
   */
  continuesThread: boolean;
}

/**
 * The session one structured-output pass resumes, and whether the session it ends in
 * becomes the node's thread.
 *
 * A 'fresh-session' correction (`correctionThreadId` undefined) runs in a throwaway
 * session so an invalid turn is never carried forward. That session holds one repaired
 * turn and none of the node's work, so it never becomes the thread: attempt 0's session
 * stays the one the next iteration, the next node, and the node record continue (#2563,
 * #3584). A named `context: resume` is the exception: every pass forks the declared
 * source itself and must prove that fork on its own, so each pass ends in a real fork of
 * the source.
 *
 * A 'same-session' correction (`correctionThreadId` set) continues the thread the failed
 * answer ended in, so the agent's work is kept and the thread stays the node's. It wins
 * over a named fork: the correction continues the fork, it does not fork the source again.
 */
export function structuredOutputPass(
  reaskAttempt: number,
  resumeSessionId: string | undefined,
  forksNamedSource: boolean,
  correctionThreadId?: string
): StructuredOutputPass {
  if (reaskAttempt > 0 && correctionThreadId !== undefined) {
    return { resumeSessionId: correctionThreadId, threadsSession: true, continuesThread: true };
  }
  const threadsSession = forksNamedSource || reaskAttempt === 0;
  return {
    resumeSessionId: threadsSession ? resumeSessionId : undefined,
    threadsSession,
    continuesThread: false,
  };
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
  liveTaskIds: readonly string[],
  provider: string,
  awaitingSettlement: boolean
): string {
  const cause =
    cutOff?.kind === 'idle_timeout'
      ? `timed out after ${String(cutOff.timeoutMs / 60000)} min without an event while waiting for ${awaitingSettlement ? 'turn settlement after result' : 'result'} from provider '${provider}', before the provider signalled that its turn settled.${formatWatchdogResetDiagnostic(cutOff.lastReset)}`
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
    /** The provider's typed failure and the provider that reported it, recorded on the failed node. */
    readonly providerFailure?: NodeProviderFailure
  ) {
    super(message);
  }
}

/**
 * A provider's typed failure on its result chunk, from `provider`. The kind comes from the
 * class, so retry never reads the evidence text, which stays in the message for the operator.
 */
export function providerReportedFailure(
  subject: string,
  failure: ProviderFailure,
  provider: string,
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
  return new NodeFailure(nodeFailureKindOf(failure), message, { ...failure, provider });
}
