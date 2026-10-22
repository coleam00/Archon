/**
 * Retry classification, subprocess failure formatting and completion-signal detection
 * shared by the executors.
 */
import { escapeRegExp } from '@archon/paths/regexp';
import type { DagNode, NodeOutput, WorkflowExecutionResult } from './schemas';
import type { ProviderFailure } from '@archon/provider-contract';
import type { NodeFailureKind } from './schemas/node-execution';

// ─── Retry Classification ────────────────────────────────────────────────────

/** Retry budget for rate-limited failures, replacing the node's own maxRetries when one is seen. */
export const RATE_LIMIT_MAX_RETRIES = 5;

export const OVERLOAD_MAX_RETRIES = 5;
const OVERLOAD_RETRY_DELAY_MS = 45_000;
const OVERLOAD_MAX_DELAY_MS = 300_000;

/** Flat delay center for rate-limit retries; jitter widens it to ±50% in {@link getRetryDelayMs}. */
export const RATE_LIMIT_RETRY_DELAY_MS = 45_000;

/**
 * Center of the wait after a rate limit outlasts its retries and the provider gave no reset;
 * jitter widens it to ±50% in {@link rateLimitResumeAt}.
 */
export const RATE_LIMIT_PAUSE_DELAY_MS = 10 * 60_000;

/**
 * When a run paused by a rate limit that outlasted its retries tries again, in epoch ms:
 * the provider's reported reset while it is still ahead, otherwise a jittered backoff so
 * runs limited together do not wake in lockstep. A seconds-scale `retryAfterMs` hint is
 * deliberately not a deadline here: it would wake the run straight into another full retry
 * cycle.
 */
export function rateLimitResumeAt(failure: ProviderFailure, now: number): number {
  const reportedReset = failure.resetAt === undefined ? Number.NaN : Date.parse(failure.resetAt);
  if (reportedReset > now) return reportedReset;
  return now + Math.round(RATE_LIMIT_PAUSE_DELAY_MS * (0.5 + Math.random()));
}

/** A provider failure the provider-limit wait can pause a run on: a rate or usage limit. */
export type ProviderLimitFailure = ProviderFailure & { class: 'rate_limited' | 'quota_exhausted' };

export function isProviderLimit(
  failure: ProviderFailure | undefined
): failure is ProviderLimitFailure {
  return failure?.class === 'rate_limited' || failure?.class === 'quota_exhausted';
}

/**
 * When the provider-limit wait would try a failed limit again, in epoch ms: a rate limit's
 * {@link rateLimitResumeAt}, a usage limit's reported reset. Undefined for a usage limit
 * without a reported reset, which the run cannot wait on.
 */
export function providerLimitResumeAt(
  failure: ProviderLimitFailure,
  now: number
): number | undefined {
  if (failure.class === 'rate_limited') return rateLimitResumeAt(failure, now);
  return failure.resetAt === undefined ? undefined : Date.parse(failure.resetAt);
}

/**
 * The failed nodes of one scope whose failure is their own: no node they transitively depend
 * on failed, whatever state lies between. A node downstream of a failure ran only because its
 * trigger rule let it run on that failure, with inputs the failure poisoned; continuation
 * runs it again with its upstream, so it cannot hold a run in a provider-limit wait. Once the
 * upstream succeeds, a failure of its own fails the run.
 */
export function ownFailures(
  nodes: readonly Pick<DagNode, 'id' | 'depends_on'>[],
  outputs: ReadonlyMap<string, NodeOutput>
): { nodeId: string; output: Extract<NodeOutput, { state: 'failed' }> }[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const downstreamOfFailure = new Map<string, boolean>();
  const hasFailedAncestor = (id: string): boolean => {
    const known = downstreamOfFailure.get(id);
    if (known !== undefined) return known;
    const result = (byId.get(id)?.depends_on ?? []).some(
      dep => byId.has(dep) && (outputs.get(dep)?.state === 'failed' || hasFailedAncestor(dep))
    );
    downstreamOfFailure.set(id, result);
    return result;
  };
  return nodes.flatMap(node => {
    const output = outputs.get(node.id);
    return output?.state === 'failed' && !hasFailedAncestor(node.id)
      ? [{ nodeId: node.id, output }]
      : [];
  });
}

/**
 * The typed provider failure an aggregate node (a loop group, a composed fan-out instance,
 * the fan-out itself) reports for its failed descendants; the provider-limit wait reads only
 * the aggregate's. Callers pass the {@link ownFailures} of a scope, or the fan-out's sibling
 * instances. A lone failure is the aggregate's, unchanged. Several are reported only when
 * every one is a provider limit, so the wait never pauses a run beside an unrelated failure
 * that each continuation would repeat. Among limits, a usage limit without a reported
 * reset wins because the run cannot wait on it; otherwise the latest
 * {@link providerLimitResumeAt} does, the same deadline the wait ranks top-level nodes by.
 */
export function aggregateProviderFailure(
  failures: readonly (ProviderFailure | undefined)[],
  now: number
): ProviderFailure | undefined {
  if (failures.length <= 1) return failures[0];
  const limits: { failure: ProviderLimitFailure; resumeAt: number | undefined }[] = [];
  for (const failure of failures) {
    if (!isProviderLimit(failure)) return undefined;
    limits.push({ failure, resumeAt: providerLimitResumeAt(failure, now) });
  }
  const unwaitable = limits.find(limit => limit.resumeAt === undefined);
  if (unwaitable !== undefined) return unwaitable.failure;
  return limits.reduce((latest, limit) =>
    (limit.resumeAt ?? 0) > (latest.resumeAt ?? 0) ? limit : latest
  ).failure;
}

export function effectiveRetryMaxRetries(
  configuredMaxRetries: number,
  retryClass: RetryClass | undefined,
  sawRateLimit: boolean
): number {
  return Math.max(
    configuredMaxRetries,
    sawRateLimit ? RATE_LIMIT_MAX_RETRIES : 0,
    retryClass === 'overloaded' ? OVERLOAD_MAX_RETRIES : 0
  );
}

/**
 * Delay before retry attempt N for a failed attempt of this retry class.
 *
 * Rate-limit failures back off FLAT at ~45s ±50% jitter: providers shedding load
 * recover on a minutes-scale window with no retry-after signal (#2706), so exponential
 * from 3s either exhausts before the window opens or over-waits once it does; flat +
 * jitter spreads concurrent nodes apart without thundering-herd re-synchronization.
 * Ordinary failures keep the caller's base × 2^attempt exponential shape.
 */
export function getRetryDelayMs(
  retryClass: RetryClass,
  attempt: number,
  baseDelayMs: number
): number {
  if (retryClass === 'rate_limited') {
    return Math.round(RATE_LIMIT_RETRY_DELAY_MS * (0.5 + Math.random()));
  }
  if (retryClass === 'overloaded') {
    return Math.round(
      Math.min(OVERLOAD_RETRY_DELAY_MS * 2 ** attempt, OVERLOAD_MAX_DELAY_MS) *
        (0.5 + Math.random())
    );
  }
  return baseDelayMs * Math.pow(2, attempt);
}

/** How retry treats a failure; also the failure kinds a provider error can have. */
export type RetryClass = Extract<
  NodeFailureKind,
  'fatal' | 'transient' | 'rate_limited' | 'overloaded' | 'unknown'
>;

/** The node failure kind a provider's typed failure class maps to. */
export function nodeFailureKindOf(failure: ProviderFailure): RetryClass {
  switch (failure.class) {
    case 'auth':
    case 'quota_exhausted':
    case 'budget_exceeded':
    case 'misconfigured':
      return 'fatal';
    case 'overloaded':
    case 'rate_limited':
    case 'transient':
    case 'unknown':
      return failure.class;
    default: {
      const exhaustive: never = failure.class;
      return exhaustive;
    }
  }
}

/**
 * The retry class of every failure kind. Retry reads only the kind recorded where the
 * failure happened, never the error text: for an exec node that text is the script's own
 * output, so matching it would let whatever a script prints decide whether it re-runs.
 */
const RETRY_CLASS = {
  fatal: 'fatal',
  transient: 'transient',
  rate_limited: 'rate_limited',
  overloaded: 'overloaded',
  unknown: 'unknown',
  // A silent provider stream or a hung subprocess; a fresh attempt is the remedy. Each
  // retry of a hung AI node can wait another full idle_timeout.
  timeout: 'transient',
  // A script's exit is no evidence a re-run helps; `on_error: all` opts in.
  exec_failed: 'unknown',
  // A fresh AI attempt can produce valid output under `on_error: all`. An exec contract
  // failure is never retried: it records `retryable: false`.
  output_contract: 'unknown',
  // `fatal` is the class retry never re-runs, even under `on_error: all`.
  config: 'fatal',
  cancelled: 'fatal',
  // Loop and child failures never reach a retry decision; listed for totality.
  max_iterations: 'unknown',
  child_failed: 'unknown',
} as const satisfies Record<NodeFailureKind, RetryClass>;

/**
 * How retry treats a failed attempt of this kind. A record without a kind (written before
 * `failureKind` existed) is `unknown`: retried only under `on_error: all`.
 */
export function retryClassOf(kind: NodeFailureKind | undefined): RetryClass {
  return RETRY_CLASS[kind ?? 'unknown'];
}

// ─── Subprocess Failure Formatting ───────────────────────────────────────────

/** Max characters of combined stdout+stderr we keep in user-facing and logged fields. */
const SUBPROCESS_ERROR_MAX_CHARS = 2000;

function streamTail(text: string, max: number): string | undefined {
  if (text.length === 0) return undefined;
  return text.length > max ? text.slice(-max) : text;
}

/**
 * The retained evidence copy of ONE subprocess stream (#2967): a tail on the same
 * budget the failure diagnostic spends, marked in place when the head was dropped so
 * a reader can tell truncation from absence. `undefined` for an empty stream.
 *
 * The budget applies per stream here, while `formatSubprocessFailure` splits it
 * across both — that one produces a single diagnostic string, whereas retention keeps
 * stdout and stderr apart (merging them is the bug the workflow-side substitute this
 * replaces had to fix), so a chatty stdout must not evict stderr evidence.
 *
 * Callers pass ALREADY-REDACTED text. This caps; it does not sanitize.
 */
export function retainStreamTail(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= SUBPROCESS_ERROR_MAX_CHARS) return trimmed;
  return `…[truncated to last ${String(SUBPROCESS_ERROR_MAX_CHARS)} chars]\n${trimmed.slice(
    -SUBPROCESS_ERROR_MAX_CHARS
  )}`;
}

/**
 * Raw ExecFileException shape from Node's `child_process.execFile`. For inline
 * scripts via `bash -c <body>` / `bun -e <body>` the entire script body is
 * embedded in `err.message`, `err.cmd`, and the first line of `err.stack` —
 * which is why `formatSubprocessFailure` strips the prefix and exposes a
 * controlled `logFields` subset rather than the raw error.
 */
interface RawSubprocessError {
  message?: string;
  stderr?: string;
  stdout?: string;
  // Numeric exit code OR errno symbol (e.g. 'ENOENT') — mirrors ExecFileException.
  code?: number | string | null;
  killed?: boolean;
  cmd?: string;
}

/**
 * Produce a concise, diagnostic-first summary of a failed subprocess.
 *
 * User-visible output strips Node's `"Command failed: <cmd>"` prefix (which for
 * inline scripts contains the full script body) and includes a jointly capped
 * tail of stderr and stdout — stderr keeps budget priority, stdout gets the
 * remainder, so scripts that report failure context on stdout stay visible.
 * Log fields expose a controlled, tail-truncated subset — never the full `err`
 * object, to prevent Pino's default error serializer from emitting three copies
 * of the script body (`err.message`, `err.stack`, `err.cmd`).
 */
export function formatSubprocessFailure(
  err: RawSubprocessError,
  label: string
): { userMessage: string; logFields: Record<string, unknown> } {
  const stderr = (err.stderr ?? '').trim();
  const stdout = (err.stdout ?? '').trim();
  const rawMessage = (err.message ?? '').trim();

  // The first line of Node's ExecFileException.message is `Command failed: <cmd>`,
  // and for `bash -c <body>` / `bun -e <body>` that line embeds the full script
  // body. Strip it so user-facing output never re-leaks the body.
  const hasCommandFailedPrefix = rawMessage.startsWith('Command failed:');
  const bodyAfterPrefix = hasCommandFailedPrefix
    ? rawMessage.split('\n').slice(1).join('\n').trim()
    : rawMessage;

  // Well-behaved scripts print failure context to stdout, so both streams share
  // the cap. stderr keeps budget priority; the leftover goes to stdout, and each
  // stream is labelled only when both are present. The budget accounts for the
  // label overhead so the joined diagnostic never truncates away a label.
  const STDERR_LABEL = '[stderr]\n';
  const STDOUT_LABEL = '\n[stdout]\n';
  const bothPresent = stderr.length > 0 && stdout.length > 0;
  const labelsOverhead = bothPresent ? STDERR_LABEL.length + STDOUT_LABEL.length : 0;
  const halfCap = Math.floor(SUBPROCESS_ERROR_MAX_CHARS / 2);
  const stderrTail = streamTail(stderr, bothPresent ? halfCap : SUBPROCESS_ERROR_MAX_CHARS);
  const stdoutTail = streamTail(
    stdout,
    SUBPROCESS_ERROR_MAX_CHARS - labelsOverhead - (stderrTail?.length ?? 0)
  );

  let diagnostic: string;
  if (stderrTail && stdoutTail) {
    diagnostic = `${STDERR_LABEL}${stderrTail}${STDOUT_LABEL}${stdoutTail}`;
  } else if (stderrTail || stdoutTail) {
    diagnostic = (stderrTail ?? '') + (stdoutTail ?? '');
  } else if (bodyAfterPrefix) {
    diagnostic = bodyAfterPrefix;
  } else if (hasCommandFailedPrefix) {
    // Prefix was the entire message — exit code in the suffix is the only signal.
    diagnostic = 'no diagnostic output';
  } else {
    diagnostic = 'unknown error';
  }

  const truncated =
    diagnostic.length > SUBPROCESS_ERROR_MAX_CHARS
      ? diagnostic.slice(-SUBPROCESS_ERROR_MAX_CHARS) + '\n…[truncated]'
      : diagnostic;

  const exitSuffix = err.code != null ? ` [exit ${String(err.code)}]` : '';

  return {
    userMessage: `${label} failed${exitSuffix}: ${truncated}`,
    logFields: {
      exitCode: err.code ?? undefined,
      killed: err.killed === true,
      stderrTail,
      stdoutTail,
    },
  };
}

// ─── Completion Signal Detection ────────────────────────────────────────────

/**
 * Detect whether the AI output contains a completion signal.
 *
 * Supports three formats, checked in order:
 * 1. <promise>SIGNAL</promise> - Recommended; prevents false positives in prose
 * 2. <anytag>SIGNAL</anytag> - Any XML-wrapped tag; case-insensitive on tag names
 * 3. Plain SIGNAL - Backwards compatibility; only as the final standalone line
 *
 * Tag matching uses a backreference (\1) so opening and closing tag names must
 * agree — `<COMPLETE>X</done>` is not treated as a completion, which avoids
 * false positives when the AI interleaves tags in prose.
 *
 * Plain signal detection requires the final line to contain only the signal.
 */
export function detectCompletionSignal(output: string, signal: string): boolean {
  // Check for XML-like tag wrapping with matching open/close names: <tag>SIGNAL</tag>.
  // Catches <promise>COMPLETE</promise>, <COMPLETE>ALL_CLEAN</COMPLETE>, <done>X</done>.
  // The `([a-zA-Z][\w-]*)` capture plus `</\1>` backreference requires tag names to match.
  const xmlWrappedPattern = new RegExp(
    `<([a-zA-Z][\\w-]*)[^>]*>\\s*${escapeRegExp(signal)}\\s*</\\1>`,
    'i'
  );
  if (xmlWrappedPattern.test(output)) {
    return true;
  }
  // The plain form counts only as the trimmed final line, and the final line is
  // computed with string operations rather than a pattern: a matcher that has to
  // enumerate its own tolerated line endings gets one of them wrong (a single
  // trailing newline was tolerated where two broke the match). Trailing blank
  // lines and whitespace are an artifact of streaming, never a signal.
  const lines = output.trimEnd().split('\n');
  const finalLine = (lines[lines.length - 1] ?? '').trim();
  return finalLine === signal;
}

/**
 * Name the completion channels a loop declared, for the max-iterations failure
 * message (#2563).
 *
 * `loop.until` became optional once `until_bash` alone could end a loop, so a
 * message hard-coding `without completion signal '<until>'` prints `undefined`
 * for a deterministic-only loop and names a channel the author never declared.
 * Both loop variants read this so they can never describe the same loop
 * differently — the divergence between them is exactly what #2563 asked to fix.
 *
 * The schema guarantees at least one channel, so the empty case is unreachable;
 * it is handled rather than asserted because this is only an error message.
 */
export function describeUnmetCompletion(control: {
  until?: string;
  until_bash?: string;
  until_field?: string;
}): string {
  const channels: string[] = [];
  if (control.until) channels.push(`completion signal '${control.until}'`);
  if (control.until_bash) channels.push("a passing 'until_bash' check");
  if (control.until_field) channels.push(`'${control.until_field}' ever being true`);
  if (channels.length === 0) return 'without a completion channel';
  return `without ${channels.join(' or ')}`;
}

/**
 * Strip internal completion signal tags before sending to user-facing output.
 * Always strips `<promise>…</promise>` (any content). When `until` is provided,
 * also strips any XML-wrapped form of that signal with matching tag names
 * (e.g. `<COMPLETE>ALL_CLEAN</COMPLETE>`). Mismatched tag names are left alone
 * so regular prose (`<note>ALL_CLEAN</warning>`) isn't accidentally rewritten.
 */
export function stripCompletionTags(content: string, until?: string): string {
  let result = content.replace(/<promise>[\s\S]*?<\/promise>/gi, '');
  if (until) {
    // Strip XML-tagged completion signals with matching open/close tag names.
    const escapedSignal = escapeRegExp(until);
    result = result.replace(
      new RegExp(`<([a-zA-Z][\\w-]*)[^>]*>\\s*${escapedSignal}\\s*</\\1>`, 'gi'),
      ''
    );
  }
  return result.trim();
}

/**
 * Determine whether a script string is "inline" code or a named script reference.
 * A named script is a simple identifier (no newlines, no whitespace, no shell metacharacters).
 * Used by both the DAG executor (runtime dispatch) and the validator (resource checks).
 */
export function isInlineScript(script: string): boolean {
  return script.includes('\n') || /[;(){}&|<>$`"' ]/.test(script);
}

/** A phase of `executeWorkflow` either hands its value on or ends the execution with a result. */
export type RunPhase<T> =
  | { stopped: false; value: T }
  | { stopped: true; result: WorkflowExecutionResult };
