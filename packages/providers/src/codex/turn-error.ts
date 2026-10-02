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

const CLASS_BY_VARIANT: Partial<Record<StringVariant, ProviderFailureClass>> = {
  unauthorized: 'auth',
  usageLimitExceeded: 'quota_exhausted',
  rateLimitExceeded: 'rate_limited',
  serverOverloaded: 'transient',
  internalServerError: 'transient',
  flexUnavailable: 'transient',
  // Codex's own per-session spend limit stopped the turn.
  sessionBudgetExceeded: 'budget_exceeded',
};

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
    const failureClass = CLASS_BY_VARIANT[info as StringVariant] ?? 'unknown';
    if (failureClass !== 'quota_exhausted') return { failureClass };
    const resetAt = exhaustedWindowReset(rateLimits);
    return resetAt ? { failureClass, resetAt } : { failureClass };
  }
  if (typeof info === 'object' && info !== null) {
    const [variant] = Object.keys(info);
    if (variant && HTTP_VARIANTS.has(variant)) {
      const payload = (info as Record<string, unknown>)[variant];
      const status =
        typeof payload === 'object' && payload !== null
          ? (payload as { httpStatusCode?: unknown }).httpStatusCode
          : undefined;
      return { failureClass: classOfHttpStatus(status) };
    }
  }
  return { failureClass: 'unknown' };
}

/**
 * `usageLimitExceeded` carries no reset time; the rate-limit snapshot does, per window.
 * The reset is the latest one among the windows that are full. With no full window the
 * reset is unknown and the engine's fallback delay applies.
 */
function exhaustedWindowReset(rateLimits: RateLimitSnapshot | undefined): string | undefined {
  const resets = [rateLimits?.primary, rateLimits?.secondary]
    .filter(window => window && window.usedPercent >= 100 && typeof window.resetsAt === 'number')
    .map(window => (window?.resetsAt ?? 0) * 1000);
  if (resets.length === 0) return undefined;
  const resetAt = new Date(Math.max(...resets));
  return Number.isFinite(resetAt.getTime()) ? resetAt.toISOString() : undefined;
}
