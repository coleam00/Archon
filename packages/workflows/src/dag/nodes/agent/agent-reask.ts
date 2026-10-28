import type { TokenUsage } from '@archon/provider-contract';
import { validateStructuredOutput } from '../../../structured-output';
import { canonicalValueText } from '../../../output-ref';
import { safeSendMessage } from '../../../platform-messages';
import { getLog } from '../../log';
import { sumTokenUsage } from '../../usage';
import {
  formatWatchdogResetDiagnostic,
  STRUCTURED_OUTPUT_MAX_REASKS,
  structuredOutputPass,
  NodeFailure,
} from '../../ai-turn';
import { runStreamPass, type AgentAttemptState, type AgentPassContext } from './agent-stream';

/** The attempt's usage summed over every pass. */
interface AttemptUsage {
  costUsd: number | undefined;
  tokens: TokenUsage | undefined;
}

/** Why a pass's structured output cannot be accepted, and the errors a reask feeds back. */
interface StructuredOutputMiss {
  payload: 'invalid' | 'missing';
  errors: string[];
}

/**
 * Runs the attempt's stream passes. Best-effort providers (Pi/Copilot) get a bounded
 * validate-and-reask loop: a structured output that is missing or fails its schema re-runs the
 * stream with the errors appended, up to STRUCTURED_OUTPUT_MAX_REASKS times. Enforced providers
 * and nodes without output_format run exactly once. Exhaustion throws a NodeFailure.
 */
export async function runUntilStructuredOutputValid(
  pc: AgentPassContext,
  state: AgentAttemptState,
  finalPrompt: string,
  resumeSessionId: string | undefined,
  forksNamedSource: boolean
): Promise<void> {
  const maxReasks =
    pc.capabilities.structuredOutput === 'best-effort' && pc.nodeOptions?.outputFormat
      ? STRUCTURED_OUTPUT_MAX_REASKS
      : 0;
  const total: AttemptUsage = { costUsd: undefined, tokens: undefined };
  let reaskAttempt = 0;
  let reaskPrompt = finalPrompt;
  while (true) {
    try {
      await runStreamPass(
        pc,
        state,
        reaskPrompt,
        structuredOutputPass(reaskAttempt, resumeSessionId, forksNamedSource)
      );
    } finally {
      await state.watchdogResets.flush();
      foldPassUsage(pc.node.id, state, total);
    }

    if (state.cutOff?.kind === 'operator') return;

    // When output_format is set and the provider returned structured_output, use
    // it instead of the concatenated assistant text. Each provider normalizes its
    // own structured output onto the result chunk — no provider branching here.
    if (!pc.nodeOptions?.outputFormat) return;

    const miss = acceptStructuredOutput(pc, state);
    if (miss === undefined) return;
    // Don't reask after an idle-timeout/abort — those are genuine failures, not
    // validation misses; they fall through to a cause-specific throw.
    const canReask =
      reaskAttempt < maxReasks && !state.cutOff && !pc.abortController.signal.aborted;
    if (!canReask) throw structuredOutputFailure(pc, state, miss);
    reaskAttempt++;
    reaskPrompt = buildReaskPrompt(finalPrompt, miss.errors);
    await emitReask(pc, reaskAttempt, maxReasks);
  }
}

/** Adds a pass's usage to the attempt's, and leaves the cumulative usage on the state even when the pass threw. */
function foldPassUsage(nodeId: string, state: AgentAttemptState, total: AttemptUsage): void {
  if (!state.passSawResult) state.costReportMissing = true;
  if (state.costUsd !== undefined) {
    total.costUsd = (total.costUsd ?? 0) + state.costUsd;
  }
  if (state.tokensUnknown) {
    total.tokens = undefined;
  } else if (state.tokens !== undefined) {
    total.tokens = sumTokenUsage(
      [...(total.tokens !== undefined ? [total.tokens] : []), state.tokens],
      { nodeId }
    );
  }
  state.costUsd = total.costUsd;
  state.tokens = total.tokens;
}

/**
 * Accepts a schema-valid structured output as the node's output text, or returns why it cannot.
 * Validates for EVERY provider — SDK-enforced ones still bypass grammar-constrained decoding on a
 * refusal / max_tokens truncation. An uncompilable schema FAILS the node (#2453): the loader
 * compiles every declared `output_format`, so reaching it here means a definition bypassed the
 * loader — continuing would let a declared contract cross the boundary unenforced, after the
 * turn was already paid for.
 */
function acceptStructuredOutput(
  pc: AgentPassContext,
  state: AgentAttemptState
): StructuredOutputMiss | undefined {
  const { node } = pc;
  const workflowRunId = pc.ctx.workflowRun.id;
  if (state.structuredOutput === undefined) {
    // No structured output at all (prose / refusal / parse miss / timeout).
    getLog().warn({ nodeId: node.id, workflowRunId }, 'dag.structured_output_missing');
    return { payload: 'missing', errors: ['no JSON object was found in the response'] };
  }
  let schemaCompileError: string | undefined;
  const validation = validateStructuredOutput(
    state.structuredOutput,
    node.output_format ?? {},
    compileMsg => {
      schemaCompileError = compileMsg;
    }
  );
  if (schemaCompileError !== undefined) {
    getLog().warn(
      { nodeId: node.id, workflowRunId, compileMsg: schemaCompileError },
      'dag.structured_output_schema_uncompilable'
    );
    throw new NodeFailure(
      'config',
      `Node '${node.id}': its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`
    );
  }
  if (!validation.valid) {
    getLog().warn(
      { nodeId: node.id, workflowRunId, errors: validation.errors },
      'dag.structured_output_invalid'
    );
    return { payload: 'invalid', errors: validation.errors };
  }
  try {
    state.outputText = canonicalValueText(state.structuredOutput);
  } catch (serializeErr) {
    const err = serializeErr as Error;
    throw new NodeFailure(
      'output_contract',
      `Node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`
    );
  }
  getLog().debug(
    { nodeId: node.id, streamingMode: pc.streamingMode },
    'dag.structured_output_override'
  );
  return undefined;
}

function structuredOutputFailure(
  pc: AgentPassContext,
  state: AgentAttemptState,
  miss: StructuredOutputMiss
): NodeFailure {
  const nodeId = pc.node.id;
  if (miss.payload === 'invalid') {
    return new NodeFailure(
      'output_contract',
      `Node '${nodeId}': output_format declared but the provider's structured output failed schema validation: ${miss.errors.join('; ')}`
    );
  }
  // Surface the real cause: a timeout/abort produces no structured output too,
  // and reporting it as "the model replied with prose" would mislead.
  if (state.cutOff?.kind === 'idle_timeout') {
    return new NodeFailure(
      'timeout',
      `Node '${nodeId}': timed out (no output for ${String(pc.idleTimeoutMs / 60000)} min) before producing the required structured output.${formatWatchdogResetDiagnostic(state.lastWatchdogReset)}`
    );
  }
  return new NodeFailure(
    'output_contract',
    `Node '${nodeId}': output_format declared but the provider returned no schema-valid structured output. ` +
      'The model likely replied with prose, refused, or emitted unparseable JSON.'
  );
}

// The original prompt plus a correction block listing the schema errors. The provider still
// augments with the JSON schema itself (best-effort providers add their own JSON-only
// instruction), so this only appends the per-attempt feedback.
function buildReaskPrompt(finalPrompt: string, errors: string[]): string {
  return (
    `${finalPrompt}\n\n--- CORRECTION ---\n` +
    `Your previous response did not satisfy the required JSON schema: ${errors.join('; ')}. ` +
    'Respond again with ONLY a JSON object matching the schema — no prose, no code fences.'
  );
}

// Every reask is logged; the user is told once (first reask) so a best-effort provider being
// auto-corrected isn't invisible.
async function emitReask(pc: AgentPassContext, attempt: number, maxReasks: number): Promise<void> {
  const { node, ctx } = pc;
  getLog().warn(
    { nodeId: node.id, workflowRunId: ctx.workflowRun.id, attempt, maxReasks },
    'dag.structured_output_reask'
  );
  if (attempt === 1) {
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `⚠️ Node \`${node.id}\`: structured output didn't match the schema — asking the model to correct it (up to ${maxReasks} attempt(s)).`,
      pc.nodeContext
    );
  }
}
