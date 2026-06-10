/**
 * OMP diagnostics context — a per-query ledger of observed session activity.
 *
 * Tracks the last event type, last stop reason, last error, and a bounded
 * ledger of tool attempts so that failures (prompt rejections, timeouts,
 * missing assistant messages) can explain what the session was doing when
 * it died instead of collapsing into an opaque "SDK failed" error.
 *
 * IMPORTANT: this module must have ZERO SDK runtime imports — it is shared
 * by the lazily-loaded event bridge and the eagerly-loaded provider.
 * All summaries are aggressively bounded; full tool outputs and secrets are
 * never stored.
 */

/** Lifecycle phase of a single tool attempt. */
export type OmpToolPhase = 'started' | 'ended' | 'failed';

export interface OmpToolAttempt {
  toolName: string;
  toolCallId: string;
  phase: OmpToolPhase;
  /** Bounded summary of the tool args (from tool_execution_start). */
  argsSummary?: string;
  /** Bounded summary of the tool result / error (from tool_execution_end). */
  resultSummary?: string;
  startedAt: number;
  endedAt?: number;
  /** True when a tool_execution_end arrived without a matching start. */
  synthesized?: boolean;
}

export interface OmpDiagnosticsInit {
  provider: string;
  modelId: string;
  cwd: string;
  resumed: boolean;
}

/** Max number of tool attempts retained in the ledger (most recent kept). */
const MAX_LEDGER_ENTRIES = 25;
/** Max chars for a single args/result summary. */
const SUMMARY_MAX_LEN = 200;
/** Max chars for the last recorded error message. */
const ERROR_MAX_LEN = 400;
/** Max attempts included when formatting for an error message. */
const FORMAT_MAX_ATTEMPTS = 5;

/**
 * Summarize an arbitrary value to a bounded single-line string.
 * Strings pass through; everything else is JSON-serialized. Always truncated
 * to `maxLen` with an ellipsis marker — never dumps full tool outputs.
 */
export function summarizeUnknown(value: unknown, maxLen: number = SUMMARY_MAX_LEN): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined) {
    text = 'undefined';
  } else {
    try {
      // JSON.stringify returns undefined for functions/symbols.
      text = JSON.stringify(value) ?? `[unserializable ${typeof value}]`;
    } catch {
      text = `[unserializable ${typeof value}]`;
    }
  }
  // Collapse newlines so summaries stay single-line in logs and error messages.
  text = text.replace(/\s*\n\s*/g, ' ');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}… [truncated ${String(text.length - maxLen)} chars]`;
}

function formatAttempt(attempt: OmpToolAttempt): string {
  const parts = [`${attempt.toolName}#${attempt.toolCallId}`, attempt.phase];
  if (attempt.synthesized) parts.push('(end-without-start)');
  if (attempt.argsSummary !== undefined) parts.push(`args=${attempt.argsSummary}`);
  if (attempt.resultSummary !== undefined) parts.push(`result=${attempt.resultSummary}`);
  return parts.join(' ');
}

/**
 * Per-query diagnostics ledger for the OMP provider. Created once per
 * `sendQuery` (after model resolution) and threaded through retry + bridge.
 */
export class OmpDiagnosticsContext {
  readonly provider: string;
  readonly modelId: string;
  readonly cwd: string;
  readonly resumed: boolean;

  private lastEventType: string | undefined;
  private lastStopReason: string | undefined;
  private lastErrorMessage: string | undefined;
  private lastEventAt: number | undefined;
  private eventCount = 0;
  private readonly attempts: OmpToolAttempt[] = [];

  constructor(init: OmpDiagnosticsInit) {
    this.provider = init.provider;
    this.modelId = init.modelId;
    this.cwd = init.cwd;
    this.resumed = init.resumed;
  }

  /** Record an event type (called before mapping, for every OMP event). */
  recordEvent(eventType: string): void {
    this.lastEventType = eventType;
    this.lastEventAt = Date.now();
    this.eventCount += 1;
  }

  recordStopReason(stopReason: string): void {
    this.lastStopReason = stopReason;
  }

  recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : summarizeUnknown(error, ERROR_MAX_LEN);
    this.lastErrorMessage = summarizeUnknown(message, ERROR_MAX_LEN);
  }

  /** Record a tool_execution_start. */
  recordToolStart(toolName: string, toolCallId: string, args: unknown): void {
    this.pushAttempt({
      toolName,
      toolCallId,
      phase: 'started',
      argsSummary: summarizeUnknown(args),
      startedAt: Date.now(),
    });
  }

  /**
   * Record a tool_execution_end. Matches the in-flight attempt by call id
   * (falling back to tool name); an end without a start synthesizes an attempt.
   * Returns the updated attempt so callers can build enriched failure chunks.
   */
  recordToolEnd(
    toolName: string,
    toolCallId: string,
    result: unknown,
    isError: boolean
  ): OmpToolAttempt {
    const now = Date.now();
    const phase: OmpToolPhase = isError ? 'failed' : 'ended';
    const resultSummary = summarizeUnknown(result);

    const existing = this.findInFlight(toolCallId, toolName);
    if (existing) {
      existing.phase = phase;
      existing.resultSummary = resultSummary;
      existing.endedAt = now;
      return existing;
    }

    const synthesized: OmpToolAttempt = {
      toolName,
      toolCallId,
      phase,
      resultSummary,
      startedAt: now,
      endedAt: now,
      synthesized: true,
    };
    this.pushAttempt(synthesized);
    return synthesized;
  }

  /** Find the attempt for a given call id (used by enriched failure chunks). */
  findAttempt(toolCallId: string): OmpToolAttempt | undefined {
    for (let i = this.attempts.length - 1; i >= 0; i -= 1) {
      if (this.attempts[i]?.toolCallId === toolCallId) return this.attempts[i];
    }
    return undefined;
  }

  /** True when at least one tool has started but not yet ended. */
  hasToolInFlight(): boolean {
    return this.attempts.some(a => a.phase === 'started');
  }

  /** Start timestamp of the oldest in-flight tool (for the tool-execution ceiling). */
  getEarliestInFlightStart(): number | undefined {
    let earliest: number | undefined;
    for (const attempt of this.attempts) {
      if (attempt.phase !== 'started') continue;
      if (earliest === undefined || attempt.startedAt < earliest) earliest = attempt.startedAt;
    }
    return earliest;
  }

  /** The in-flight tools (started without end), oldest first. */
  getInFlightAttempts(): OmpToolAttempt[] {
    return this.attempts.filter(a => a.phase === 'started');
  }

  getAttempts(): readonly OmpToolAttempt[] {
    return this.attempts;
  }

  getLastToolAttempt(): OmpToolAttempt | undefined {
    return this.attempts[this.attempts.length - 1];
  }

  getLastEventType(): string | undefined {
    return this.lastEventType;
  }

  getLastEventAt(): number | undefined {
    return this.lastEventAt;
  }

  getLastStopReason(): string | undefined {
    return this.lastStopReason;
  }

  getLastErrorMessage(): string | undefined {
    return this.lastErrorMessage;
  }

  hasActivity(): boolean {
    return this.eventCount > 0;
  }

  /**
   * Bounded structured summary for log payloads (`omp.prompt_failed` etc.).
   * Safe to log: all strings are truncated; no full outputs or secrets.
   */
  toLogSummary(): Record<string, unknown> {
    const lastTool = this.getLastToolAttempt();
    return {
      ompProvider: this.provider,
      modelId: this.modelId,
      cwd: this.cwd,
      resumed: this.resumed,
      eventCount: this.eventCount,
      lastEventType: this.lastEventType ?? null,
      lastStopReason: this.lastStopReason ?? null,
      lastErrorMessage: this.lastErrorMessage ?? null,
      lastTool: lastTool ? formatAttempt(lastTool) : null,
      toolAttempts: this.attempts.slice(-FORMAT_MAX_ATTEMPTS).map(formatAttempt),
      toolAttemptCount: this.attempts.length,
      inFlightToolCount: this.getInFlightAttempts().length,
    };
  }

  /**
   * Bounded single-line summary suitable for inclusion in an Error message.
   */
  formatForErrorMessage(): string {
    const parts: string[] = [
      `model=${this.provider}/${this.modelId}`,
      `lastEvent=${this.lastEventType ?? 'none'}`,
    ];
    if (this.lastStopReason !== undefined) parts.push(`lastStopReason=${this.lastStopReason}`);
    if (this.lastErrorMessage !== undefined) parts.push(`lastError=${this.lastErrorMessage}`);
    if (this.attempts.length > 0) {
      const recent = this.attempts.slice(-FORMAT_MAX_ATTEMPTS).map(formatAttempt);
      const omitted = this.attempts.length - recent.length;
      const prefix = omitted > 0 ? `(${String(omitted)} earlier omitted) ` : '';
      parts.push(`tools=[${prefix}${recent.join('; ')}]`);
    } else {
      parts.push('tools=none');
    }
    return `[omp diagnostics: ${parts.join(', ')}]`;
  }

  private findInFlight(toolCallId: string, toolName: string): OmpToolAttempt | undefined {
    for (let i = this.attempts.length - 1; i >= 0; i -= 1) {
      const attempt = this.attempts[i];
      if (attempt?.phase === 'started' && attempt.toolCallId === toolCallId) {
        return attempt;
      }
    }
    // Fall back to name matching only when the call id is absent/empty.
    if (toolCallId === '') {
      for (let i = this.attempts.length - 1; i >= 0; i -= 1) {
        const attempt = this.attempts[i];
        if (attempt?.phase === 'started' && attempt.toolName === toolName) {
          return attempt;
        }
      }
    }
    return undefined;
  }

  private pushAttempt(attempt: OmpToolAttempt): void {
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_LEDGER_ENTRIES) {
      // Drop the oldest *terminal* attempt first so in-flight tracking survives.
      const idx = this.attempts.findIndex(a => a.phase !== 'started');
      this.attempts.splice(idx === -1 ? 0 : idx, 1);
    }
  }
}

export function createOmpDiagnosticsContext(init: OmpDiagnosticsInit): OmpDiagnosticsContext {
  return new OmpDiagnosticsContext(init);
}

/** Error thrown by the OMP bridge after diagnostics enrichment. */
export class OmpEnrichedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'OmpEnrichedError';
  }
}

/**
 * Wrap an error with the bounded diagnostics summary, preserving the original
 * as `cause`. Idempotent: already-enriched errors pass through unchanged.
 */
export function enrichOmpError(error: unknown, diagnostics: OmpDiagnosticsContext): Error {
  if (error instanceof OmpEnrichedError) return error;
  const base = error instanceof Error ? error.message : summarizeUnknown(error, ERROR_MAX_LEN);
  return new OmpEnrichedError(`${base} ${diagnostics.formatForErrorMessage()}`, error);
}
