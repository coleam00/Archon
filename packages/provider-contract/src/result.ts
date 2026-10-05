import { z } from 'zod';
import { providerFailureSchema } from './failure';

/** Token usage statistics from AI provider responses. */
export const tokenUsageSchema = z.object({
  /** Gross prompt input, including cache reads and writes reported separately. */
  input: z.number(),
  output: z.number(),
  /** Provider-reported cached input. Absent means unsupported or unknown; zero is known. */
  cacheRead: z.number().optional(),
  /** Provider-reported cache-creation input. Absent means unsupported or unknown; zero is known. */
  cacheWrite: z.number().optional(),
  /**
   * Set only by aggregation (`mergeTokenUsage` in `@archon/providers`), never by a provider.
   * When true the cache axes on this usage are a FLOOR: at least one contributing usage did
   * not report that axis, so true cache use is at least the reported total and
   * `input - cacheRead - cacheWrite` is an UPPER bound on full-price input rather than an
   * exact figure. Absent means the cache totals are complete, or that no axis is present
   * at all (#2662).
   */
  cachePartial: z.literal(true).optional(),
  /** Total of gross input, output, and any provider-reported reasoning tokens. */
  total: z.number().optional(),
  cost: z.number().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** Concrete model identifier reported by a provider after a request completes. */
export const resolvedModelSchema = z.object({ id: z.string() });
export type ResolvedModel = z.infer<typeof resolvedModelSchema>;

/**
 * Why a turn stopped, in ACP's `StopReason` names. A provider omits a native reason it
 * cannot map rather than inventing one.
 */
export const providerStopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);
export type ProviderStopReason = z.infer<typeof providerStopReasonSchema>;

/** Characters of a session id that may appear outside the node record. */
export const SESSION_PREVIEW_LENGTH = 8;

/**
 * A session id can resume a conversation, so streams and logs carry only this preview.
 * The full id is written to the node record alone.
 */
export function sessionPreview(sessionId: string): string {
  return sessionId.slice(0, SESSION_PREVIEW_LENGTH);
}

/** The terminal result of one provider turn. Providers stream it as the `result` chunk. */
export const providerResultSchema = z.object({
  /** Required on every non-failing turn of a provider that declares `sessionResume`. */
  sessionId: z.string().optional(),
  /** Complete reply for this result, when the runtime reports it. */
  text: z.string().optional(),
  /** Usage of this result; consumers sum usage across results before settlement. */
  tokens: tokenUsageSchema.optional(),
  structuredOutput: z.unknown().optional(),
  /**
   * The provider's classification of a failed turn. Present means the turn failed, and the
   * engine decides retry from `failure.class` rather than from any error text.
   */
  failure: providerFailureSchema.optional(),
  /** Untyped failure marker. A provider that reports `failure` still sets it until every reader moves. */
  isError: z.boolean().optional(),
  errorSubtype: z.string().optional(),
  /** SDK-provided error detail strings. Populated when isError is true. */
  errors: z.array(z.string()).optional(),
  cost: z.number().optional(),
  /** Why the turn stopped, mapped from the SDK's native reason; absent when it has no ACP name. */
  stopReason: providerStopReasonSchema.optional(),
  numTurns: z.number().optional(),
  /** Concrete model reported by the provider; omitted when its SDK does not expose one. */
  resolvedModel: resolvedModelSchema.optional(),
  /**
   * Outcome of a session-resume attempt, so a failed resume is observable
   * instead of silently continuing with a fresh (cold) session:
   *   - `true`   a resume was requested and the prior session was restored
   *   - `false`  a resume was requested but the provider fell back to fresh
   *   - omitted  no resume was requested
   * Set only when `resumeSessionId` was passed. Consumers (the dag-executor)
   * use `false` to surface a warning rather than swallow the loss.
   */
  resumed: z.boolean().optional(),
});
export type ProviderResult = z.infer<typeof providerResultSchema>;
