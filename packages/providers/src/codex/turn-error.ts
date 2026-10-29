import type { ProviderFailureClass } from '@archon/provider-contract';
import { failureClassOfThrown } from '../shared/failure';
import { ConnectionClosedError } from './app-server';
import type { CodexErrorInfo } from './protocol/v2/CodexErrorInfo';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';

/**
 * The failure class of a failed Codex turn, read from `turn.error.codexErrorInfo` on
 * `turn/completed` and never from the message text. A variant this table does not know,
 * which the generated type allows, is `unknown`.
 */

type ObjectVariant = Exclude<CodexErrorInfo, string>;
/** The named object variants; the open `{ [key: string]: unknown }` member adds none. */
type ObjectVariantKey = ObjectVariant extends infer V
  ? V extends object
    ? string extends keyof V
      ? never
      : keyof V
    : never
  : never;

/**
 * One row per string variant Codex generates. The generated union ends in `| string`,
 * which absorbs its literals, so `turn-error.test.ts` reads them from the generated file
 * and fails a Codex bump that adds one until it is classified here. `unknown` rows are
 * deliberate: nothing in them says whether another attempt can help.
 */
export const CLASS_BY_VARIANT = {
  unauthorized: 'auth',
  usageLimitExceeded: 'quota_exhausted',
  rateLimitExceeded: 'rate_limited',
  serverOverloaded: 'overloaded',
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
} as const satisfies Record<string, ProviderFailureClass>;

type StringVariant = keyof typeof CLASS_BY_VARIANT;

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

/**
 * Why an auth failure happened on a managed ChatGPT login. Codex's protocol lets it ask
 * the client for a new token when its access token is rejected; `AppServerConnection`
 * declines that request, because Archon mints the token only when a run starts or
 * resumes, or per chat turn. Shown on any `auth` failure of a managed login, whether or
 * not Codex sent the request.
 */
export const MANAGED_CHATGPT_TOKEN_REJECTED =
  'The ChatGPT access token Archon delivered from the connected subscription was rejected ' +
  '(expired or revoked), and Archon cannot refresh it during a turn. Resuming the run, or ' +
  'sending the chat message again, delivers a fresh token; if this repeats, reconnect with ' +
  '`archon ai login openai`.';

// Maps slugs that ChatGPT-plan accounts now reject (previously shipped as Archon
// suggestions/defaults) to a current, plan-accepted slug to suggest instead.
const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.6-sol',
  'gpt-5.2-codex': 'gpt-5.6-sol',
  'gpt-5.2': 'gpt-5.6-sol',
};

// A display-only heuristic over vendor text: it decides whether the operator sees
// model-access advice, never the failure class.
function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `❌ Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
}

/**
 * @param scanned the text that decides whether the advice applies: Codex's own message,
 *   never a stderr tail, whose log lines can mention a model for unrelated reasons.
 */
export function withModelAccessAdvice(
  evidence: string,
  model: string | undefined,
  scanned = evidence
): string {
  return isModelAccessError(scanned)
    ? `${buildModelAccessMessage(model)}\n\n${evidence}`
    : evidence;
}

/**
 * Spawn errnos that fail the same way every time: the binary path is missing, not
 * executable, the wrong architecture, not a file, blocked by policy, too long or a
 * symlink loop, or the environment is too large to exec. Others, such as EMFILE, EAGAIN
 * and ENOMEM, are the machine running short and may clear.
 */
const MISCONFIGURED_SPAWN_ERRNOS: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'ENOEXEC',
  'EISDIR',
  'ENOTDIR',
  'EPERM',
  'E2BIG',
  'ENAMETOOLONG',
  'ELOOP',
]);

/**
 * The class of a failure that ended a turn before `turn/completed`, from how the process
 * ended. A process that exits on its own before answering any request never ran a turn:
 * the binary has no `app-server` or rejects a flag, and another attempt fails the same
 * way. Any other process end is a process failure, which is what `transient` names.
 *
 * JSON-RPC errors are not classified by code, because one code covers setups that need
 * different classes. Probed against Codex 0.160.0 on 2026-10-03, every one of these came
 * back as -32600 with only the message differing: an unknown method ("Invalid request:
 * unknown variant ..."), `thread/resume` of a missing thread ("no rollout found for
 * thread id ..."), a malformed thread id ("invalid session id: ..."), and `thread/start`
 * with an unparseable config.toml ("failed to load configuration: ...").
 */
export function failureClassOfStop(error: unknown): ProviderFailureClass {
  if (!(error instanceof ConnectionClosedError)) return failureClassOfThrown(error);
  const { end } = error;
  if (end.kind === 'cleanup_failed') return 'unknown';
  if (end.kind === 'spawn_failed') {
    return end.error.code !== undefined && MISCONFIGURED_SPAWN_ERRNOS.has(end.error.code)
      ? 'misconfigured'
      : 'transient';
  }
  return error.beforeFirstResponse && end.signal === null ? 'misconfigured' : 'transient';
}
