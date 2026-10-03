import type { ProviderFailureClass } from '@archon/provider-contract';
import type { CodexErrorInfo } from './protocol/v2/CodexErrorInfo';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';

/**
 * The failure class of a failed Codex turn, read from `turn.error.codexErrorInfo` on
 * `turn/completed` and never from the message text. A Codex newer than the generated
 * protocol may send variants this table does not know; they are `unknown`.
 */

type StringVariant = Extract<CodexErrorInfo, string>;
type ObjectVariant = Exclude<CodexErrorInfo, string>;
type ObjectVariantKey = ObjectVariant extends infer V
  ? V extends object
    ? keyof V
    : never
  : never;

/**
 * Total over the generated variants, so a Codex bump that adds one fails type-check until
 * it is classified here. `unknown` rows are deliberate: nothing in them says whether
 * another attempt can help.
 */
const CLASS_BY_VARIANT: Record<StringVariant, ProviderFailureClass> = {
  unauthorized: 'auth',
  usageLimitExceeded: 'quota_exhausted',
  rateLimitExceeded: 'rate_limited',
  serverOverloaded: 'transient',
  internalServerError: 'transient',
  flexUnavailable: 'transient',
  // Codex's own per-session spend limit stopped the turn.
  sessionBudgetExceeded: 'budget_exceeded',
  contextWindowExceeded: 'unknown',
  cyberPolicy: 'unknown',
  misalignmentPolicyViolation: 'unknown',
  tooManyDenials: 'unknown',
  badRequest: 'unknown',
  threadRollbackFailed: 'unknown',
  sandboxError: 'unknown',
  other: 'unknown',
};

function isStringVariant(info: string): info is StringVariant {
  return Object.hasOwn(CLASS_BY_VARIANT, info);
}

/** Variants that carry the HTTP status of the request that failed. */
const HTTP_VARIANTS: ReadonlySet<string> = new Set<ObjectVariantKey>([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

function classOfHttpStatus(status: unknown): ProviderFailureClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  // No status means the connection itself failed.
  if (status === null || status === undefined) return 'transient';
  if (typeof status === 'number' && status >= 500) return 'transient';
  return 'unknown';
}

export interface TurnFailureClass {
  failureClass: ProviderFailureClass;
  /** When an exhausted usage window reopens, as an ISO date-time. */
  resetAt?: string;
}

/**
 * @param info `codexErrorInfo` as received; typed `unknown` because the user's Codex
 *   version decides its shape, not the generated type.
 * @param rateLimits the last `account/rateLimits/updated` snapshot this turn received.
 */
export function classifyTurnError(
  info: unknown,
  rateLimits: RateLimitSnapshot | undefined
): TurnFailureClass {
  if (typeof info === 'string') {
    const failureClass = isStringVariant(info) ? CLASS_BY_VARIANT[info] : 'unknown';
    if (failureClass !== 'quota_exhausted') return { failureClass };
    const resetAt = exhaustedWindowReset(rateLimits);
    return resetAt ? { failureClass, resetAt } : { failureClass };
  }
  if (typeof info === 'object' && info !== null) {
    const [variant] = Object.keys(info);
    if (variant && HTTP_VARIANTS.has(variant)) {
      return { failureClass: classOfHttpStatus(httpStatusOf(info, variant)) };
    }
  }
  return { failureClass: 'unknown' };
}

function httpStatusOf(info: object, variant: string): unknown {
  const payload = (info as Record<string, unknown>)[variant];
  return typeof payload === 'object' && payload !== null
    ? (payload as { httpStatusCode?: unknown }).httpStatusCode
    : undefined;
}

/**
 * `codexErrorInfo` as an operator-facing cause: the variant token and, when it carries one,
 * the HTTP status. Never Codex's message text, which can hold the vendor's response body.
 */
export function describeErrorInfo(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (typeof info !== 'object' || info === null) return undefined;
  const [variant] = Object.keys(info);
  if (!variant) return undefined;
  const status = HTTP_VARIANTS.has(variant) ? httpStatusOf(info, variant) : undefined;
  return typeof status === 'number' ? `${variant}, HTTP ${String(status)}` : variant;
}

/**
 * `usageLimitExceeded` carries no reset time; the rate-limit snapshot does, per window.
 * The reset is the latest one among the windows that are full. With no full window the
 * reset is unknown and the engine's fallback delay applies.
 */
function exhaustedWindowReset(rateLimits: RateLimitSnapshot | undefined): string | undefined {
  const resets = [rateLimits?.primary, rateLimits?.secondary].flatMap(window =>
    window && window.usedPercent >= 100 && typeof window.resetsAt === 'number'
      ? [window.resetsAt * 1000]
      : []
  );
  if (resets.length === 0) return undefined;
  const resetAt = new Date(Math.max(...resets));
  return Number.isFinite(resetAt.getTime()) ? resetAt.toISOString() : undefined;
}
