/**
 * Reads the `result` the SDK ends a turn with: this result's share of the session's
 * cumulative spend, whether it is a failure and of which class, and the typed
 * `result` chunk Archon reports for it.
 */
import type {
  ModelUsage,
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  sessionPreview,
  type ProviderFailure,
  type ProviderStopReason,
} from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import type { ResultChunk, TokenUsage } from '../types';
import { classifyClaudeApiError, classifyClaudeErrorResult } from './failure';
import { spendSince, type QuerySpend, type SpendBaseline } from './session-spend';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/** An API error the SDK wrote into a '<synthetic>' assistant message, awaiting the result. */
export interface SyntheticError {
  code: SDKAssistantMessageError;
  text: string;
}

/** The query-lifetime spend facts each result reads and advances. */
export interface ResultSpendState {
  spendBaseline: SpendBaseline;
  queryTokensUnknown: boolean;
}

/** This result's share of the session's cumulative spend. */
export interface ResultUsage {
  spend: QuerySpend;
  tokens: TokenUsage | undefined;
  resolvedModelId: string | undefined;
}

/** How a result ended the turn, read from its structured fields only. */
export interface ResultVerdict {
  failure: ProviderFailure | undefined;
  isRealError: boolean;
  isSuccessWithErrorFlag: boolean;
  apiErrorStatus: number | null | undefined;
  resultText: string | undefined;
  sdkErrors: string[] | undefined;
}

export function resultUsage(state: ResultSpendState, resultMsg: SDKResultMessage): ResultUsage {
  // The SDK's cost and per-model totals are cumulative for the session; report
  // this result's share, advancing the baseline for any later result in this query.
  // Typed as required, but it crosses an IPC boundary (see selectResolvedModelId).
  const modelUsage = (resultMsg.modelUsage as Record<string, ModelUsage> | undefined) ?? {};
  const baselineKind = state.spendBaseline.kind;
  const spend = spendSince(state.spendBaseline, { costUsd: resultMsg.total_cost_usd, modelUsage });
  if (typeof resultMsg.total_cost_usd === 'number') {
    const cumulative = { costUsd: resultMsg.total_cost_usd, modelUsage };
    if (spend.costUsd === undefined) {
      getLog().warn(
        {
          sessionIdPreview: sessionPreview(resultMsg.session_id),
          baseline: state.spendBaseline.kind,
        },
        'claude.query_cost_unknown'
      );
    }
    state.spendBaseline = { kind: 'known', spend: cumulative };
  }
  const resolvedModelId = selectResolvedModelId(spend.modelUsage);
  // Results without per-model totals retain the SDK's query-scoped main-agent usage.
  // With cumulative totals but no usable baseline, omit tokens rather than count earlier turns.
  const resultTokens =
    resultMsg.modelUsage === undefined ? normalizeClaudeUsage(resultMsg.usage) : spend.tokens;
  // Later deltas cannot recover an earlier unknown interval in this query.
  state.queryTokensUnknown ||= resultTokens === undefined;
  if (state.queryTokensUnknown) {
    getLog().warn(
      { sessionIdPreview: sessionPreview(resultMsg.session_id), baseline: baselineKind },
      'claude.query_tokens_unknown'
    );
  }
  return {
    spend,
    tokens: state.queryTokensUnknown ? undefined : resultTokens,
    resolvedModelId,
  };
}

export function judgeResult(
  resultMsg: SDKResultMessage,
  syntheticError: SyntheticError | undefined,
  lastRateLimit: SDKRateLimitInfo | undefined
): ResultVerdict {
  const sdkErrors = 'errors' in resultMsg ? resultMsg.errors : undefined;

  // `is_error: true` + `subtype: 'success'` is ambiguous: it is BOTH the
  // SDK's stop-sequence termination encoding (#1425, a legitimate success)
  // AND its API-failure-as-text encoding (#1797 — auth/billing/rate-limit
  // errors that even set stop_reason: 'stop_sequence').
  const isSuccessWithErrorFlag = resultMsg.is_error && resultMsg.subtype === 'success';

  // Disambiguate structurally: a preceding synthetic error message
  // (primary, typed signal), or the typed terminal_reason 'api_error'
  // (secondary — catches an error result with no preceding synthetic
  // message), marks a real failure. The error prose never becomes output.
  const isApiFailure =
    isSuccessWithErrorFlag &&
    (syntheticError !== undefined || resultMsg.terminal_reason === 'api_error');

  // SDKResultSuccess declares `is_error: boolean` (not literal false). When a
  // model terminates via a configured stop sequence (stop_reason ===
  // 'stop_sequence') the SDK can set is_error: true while keeping
  // subtype: 'success' — its encoding of "non-default termination, not a
  // failure". Treat that pair as a clean success.
  const isRealError = resultMsg.is_error && !isSuccessWithErrorFlag;
  // Only the success-shaped result carries the HTTP status and result text; an API
  // failure the SDK encoded as `success` is where they matter.
  const apiErrorStatus = 'api_error_status' in resultMsg ? resultMsg.api_error_status : undefined;
  const resultText = 'result' in resultMsg ? resultMsg.result : undefined;
  let failure: ProviderFailure | undefined;
  if (isApiFailure || (isRealError && syntheticError !== undefined)) {
    const evidence =
      syntheticError?.text ||
      resultText ||
      sdkErrors?.join('; ') ||
      'API error result with no error text';
    failure = classifyClaudeApiError(
      syntheticError?.code ?? 'unknown',
      apiErrorStatus,
      lastRateLimit,
      evidence
    );
  } else if (isRealError) {
    failure = classifyErrorResult(resultMsg, apiErrorStatus, sdkErrors);
  }
  return { failure, isRealError, isSuccessWithErrorFlag, apiErrorStatus, resultText, sdkErrors };
}

function classifyErrorResult(
  resultMsg: SDKResultMessage,
  apiErrorStatus: number | null | undefined,
  sdkErrors: string[] | undefined
): ProviderFailure {
  // Set when Claude Code refused to start (see CLAUDE_CODE_STARTUP_FAILURE_RESULTS).
  const startupFailureReason =
    'startup_failure_reason' in resultMsg ? resultMsg.startup_failure_reason : undefined;
  const label = startupFailureReason
    ? `${resultMsg.subtype} (${startupFailureReason})`
    : resultMsg.subtype;
  const evidence = sdkErrors?.length ? `${label}: ${sdkErrors.join('; ')}` : label;
  return classifyClaudeErrorResult(
    resultMsg.subtype,
    apiErrorStatus,
    startupFailureReason,
    evidence
  );
}

export function logResultVerdict(
  resultMsg: SDKResultMessage,
  syntheticError: SyntheticError | undefined,
  verdict: ResultVerdict
): void {
  const { failure } = verdict;
  if (failure !== undefined) {
    getLog().error(
      {
        sessionIdPreview: sessionPreview(resultMsg.session_id),
        errorSubtype: resultMsg.subtype,
        errorCode: syntheticError?.code,
        terminalReason: resultMsg.terminal_reason,
        apiErrorStatus: verdict.apiErrorStatus,
        stopReason: resultMsg.stop_reason,
        failureClass: failure.class,
        evidence: failure.evidence,
      },
      'claude.result_failed'
    );
  } else if (verdict.isSuccessWithErrorFlag) {
    getLog().debug(
      {
        sessionIdPreview: sessionPreview(resultMsg.session_id),
        stopReason: resultMsg.stop_reason,
      },
      'claude.result_success_validated'
    );
  }
}

export function resultChunk(
  resultMsg: SDKResultMessage,
  usage: ResultUsage,
  verdict: ResultVerdict,
  tokensUnknown: boolean
): ResultChunk {
  const { failure } = verdict;
  // Built by assignment on a typed value so a misspelled key fails to compile.
  const result: ResultChunk = { type: 'result', sessionId: resultMsg.session_id };
  if (failure === undefined && verdict.resultText !== undefined) result.text = verdict.resultText;
  if (usage.tokens) result.tokens = usage.tokens;
  if (tokensUnknown) result.tokensUnknown = true;
  if ('structured_output' in resultMsg && resultMsg.structured_output !== undefined) {
    result.structuredOutput = resultMsg.structured_output;
  }
  if (failure !== undefined) recordFailure(result, failure, resultMsg, verdict);
  if (usage.spend.costUsd !== undefined) result.cost = usage.spend.costUsd;
  const stopReason = claudeStopReason(resultMsg);
  if (stopReason !== undefined) result.stopReason = stopReason;
  if (resultMsg.num_turns !== undefined) result.numTurns = resultMsg.num_turns;
  if (usage.resolvedModelId) result.resolvedModel = { id: usage.resolvedModelId };
  return result;
}

function recordFailure(
  result: ResultChunk,
  failure: ProviderFailure,
  resultMsg: SDKResultMessage,
  verdict: ResultVerdict
): void {
  result.failure = failure;
  result.isError = true;
  // The SDK's own subtype stays for readers that act on it (chat clears a
  // session on `error_during_execution`); an API failure the SDK encoded as
  // `success` carries none.
  if (verdict.isRealError) result.errorSubtype = resultMsg.subtype;
  result.errors =
    verdict.isRealError && verdict.sdkErrors?.length ? verdict.sdkErrors : [failure.evidence];
}

function normalizeClaudeUsage(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const total = usage.total_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  return {
    input:
      input +
      (typeof cacheRead === 'number' ? cacheRead : 0) +
      (typeof cacheWrite === 'number' ? cacheWrite : 0),
    output,
    ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}),
    ...(typeof total === 'number' ? { total } : {}),
  };
}

/**
 * Pick the concrete model that did the bulk of a turn's work from the SDK's
 * per-model usage record.
 *
 * More than one entry is reachable for a single turn: a subagent pinned to
 * another model via `agents:`, or a `fallbackModel` takeover. Key insertion
 * order happens to put the main model first today, but nothing in the SDK
 * guarantees it — so select by greatest output-token count (the main model
 * produces the bulk of the output) and WARN whenever the record is ambiguous,
 * so a multi-model turn is visible instead of silently collapsed.
 *
 * `modelUsage` is non-optional in the SDK types but arrives over an IPC
 * boundary, so the absent/empty cases stay guarded — absence yields undefined
 * and the caller omits `resolvedModel` entirely rather than inventing a value.
 * On a tie (or output counts the SDK didn't send) the first key wins, which is
 * exactly the pre-#2314 behavior — safe, and the warning still fires.
 */
function selectResolvedModelId(
  modelUsage: Record<string, ModelUsage> | undefined
): string | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0][0];

  const outputTokensOf = (usage: ModelUsage): number =>
    Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  let selected = entries[0];
  for (const entry of entries.slice(1)) {
    if (outputTokensOf(entry[1]) > outputTokensOf(selected[1])) selected = entry;
  }
  getLog().warn(
    { models: entries.map(([id]) => id), selected: selected[0] },
    'claude.resolved_model_ambiguous'
  );
  return selected[0];
}

/** The result's stop reason in ACP's names; `undefined` for a native reason ACP has no name for. */
function claudeStopReason(resultMsg: SDKResultMessage): ProviderStopReason | undefined {
  if (resultMsg.subtype === 'error_max_turns') return 'max_turn_requests';
  switch (resultMsg.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // ACP has no name for it (e.g. `pause_turn`); the native value stays in the log.
      if (resultMsg.stop_reason) {
        getLog().debug({ stopReason: resultMsg.stop_reason }, 'claude.stop_reason_unmapped');
      }
      return undefined;
  }
}
