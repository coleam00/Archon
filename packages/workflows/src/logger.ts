import type { NodeExecutionMetadata } from './schemas/node-execution';
/**
 * SDK Event Logger - captures workflow execution to JSONL
 */
import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { WorkflowTokenUsage } from './deps';
import type { MessageChunk } from '@archon/providers/types';
import type { SkipCause } from './schemas';
import type { ProviderEventEnvelope } from './schemas/provider-event';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.file-logger');
  return cachedLog;
}

// Track whether we've warned about logging failures (warn once per session)
let logWarningShown = false;

/**
 * A row in a run's JSONL log. Some variants are historical: nothing has emitted
 * `'validation'` (with `check`/`result`) since #805 removed its call site along with
 * sequential execution mode, and its writer is now deleted too. `'assistant'` (with
 * `content`) and `'tool'` (with `tool_name`/`tool_input`) carried agent text and tool
 * starts with no step, id or output until `'provider_event'` replaced them. They stay
 * because logs already on disk contain those rows — keep them when reading, never write
 * a new one.
 */
export interface WorkflowEvent extends Partial<ProviderEventEnvelope> {
  execution?: NodeExecutionMetadata;
  type:
    | 'workflow_start'
    | 'workflow_resume'
    | 'workflow_complete'
    | 'workflow_error'
    | 'assistant'
    | 'tool'
    | 'validation'
    | 'node_suspended'
    | 'gate_decision'
    | 'node_start'
    | 'node_complete'
    | 'node_skipped'
    | 'node_error'
    | 'watchdog_reset'
    | 'exec_output'
    | 'provider_event';
  workflow_id: string;
  workflow_name?: string;
  step?: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  duration_ms?: number;
  tokens?: WorkflowTokenUsage;
  cost_usd?: number;
  check?: string;
  result?: 'pass' | 'fail' | 'warn' | 'unknown';
  cause?: SkipCause;
  error?: string;
  /** `gate_decision` only: the resolution the gate's `approval_received` event records. */
  decision?: string;
  /** `watchdog_reset` only. The chunk content is deliberately never retained. */
  chunk_type?: MessageChunk['type'];
  /**
   * `watchdog_reset` only: renewals this record stands for, see
   * {@link createWatchdogResetRecorder}. Absent on transcripts written before sampling,
   * where every renewal had its own record.
   */
  chunk_count?: number;
  /** `exec_output` only — see {@link logExecOutput}. Absent means the stream was empty. */
  stdout_tail?: string;
  /** `exec_output` only — see {@link logExecOutput}. Absent means the stream was empty. */
  stderr_tail?: string;
  /**
   * `exec_output` only. `0` on success. On failure: the process exit code, or a symbol
   * when there is none — `'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, the signal
   * name for a timeout kill, or `'unknown'`.
   */
  exit_code?: number | string;
  ts: string;
}

/**
 * What a node or a whole run spent, in the transcript's own field names.
 *
 * One carrier, passed whole. The same payload used to be spelled out by hand at every
 * sink, and cost was simply forgotten at the transcript one — an axis added here now
 * reaches the JSONL row and the DB event together or not at all (#2674). A node that
 * failed after spending reports that spend the same way a node that completed does
 * (#2693).
 *
 * A row reports `cost_usd` and `tokens` as its OWN spend only when the record's
 * `accounting` is `'node'`. Every other value restates spend other rows of the same run
 * already carry — a `loop_group` roll-up over its `<groupId>.<nodeId>` body rows, a
 * composed fan-out wrapper over its instances, an instance terminal over its own leaves,
 * an amendment over the attempt it amends — so those rows omit both axes. The durable row
 * keeps its `cost_usd` and marks a restatement `aggregate: true`; the resume fold skips a
 * marked row because its scope's own rows already carry that spend, except a
 * composed-instance terminal, which the fold keeps as the authoritative source for its
 * scope because that instance's inner rows are observability writes that can be missing
 * after a crash. No row restates another's spend, so summing the rows that carry a
 * `cost_usd` lands on `workflow_complete.cost_usd` (#3508); count `node_error` rows in
 * that sum, because a retried attempt that already spent reports on its own. So an absent
 * `cost_usd` says one of two things, and the row's `accounting` says which: on a row that
 * reports its own spend, the provider reported no cost; on a restatement row, that scope's
 * spend is on the rows it names.
 *
 * Do not read an absent `cost_usd` on a run's transcript as "the whole run was free"; read
 * it per row. A `loop:` node's cumulative totals reach its persisted event on either
 * outcome, and a success exit writes the terminal transcript row for the loop's own id just
 * as a failure does; its per-iteration rows carry duration and no usage.
 *
 * Each axis is omitted when nothing was reported for it, so on a row that reports its own
 * spend an absent `cost_usd` means the provider reported no cost (Codex reports none at all
 * — #2334) and `0` means it reported zero. Build it with `!== undefined` tests, never
 * truthiness.
 */
export type WorkflowUsage = Pick<WorkflowEvent, 'tokens' | 'cost_usd'>;

/**
 * Get log file path for a workflow run.
 * @param logDir - The log directory (project-scoped or legacy cwd-based)
 * @param workflowRunId - The workflow run ID
 */
function getLogPath(logDir: string, workflowRunId: string): string {
  return join(logDir, `${workflowRunId}.jsonl`);
}

/**
 * Append event to workflow log.
 * @param logDir - The log directory (project-scoped or legacy cwd-based)
 */
export async function logWorkflowEvent(
  logDir: string,
  workflowRunId: string,
  event: Omit<WorkflowEvent, 'ts' | 'workflow_id'>,
  occurredAt = Date.now()
): Promise<void> {
  const logPath = getLogPath(logDir, workflowRunId);

  try {
    // Ensure logs directory exists
    await mkdir(dirname(logPath), { recursive: true });

    const fullEvent: WorkflowEvent = {
      ...event,
      workflow_id: workflowRunId,
      ts: new Date(occurredAt).toISOString(),
    };

    await appendFile(logPath, JSON.stringify(fullEvent) + '\n');
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, logPath }, 'log_write_failed');

    // Warn user once per session about logging failures
    if (!logWarningShown) {
      getLog().warn({ logPath }, 'workflow_logs_may_be_incomplete');
      logWarningShown = true;
    }
    // Don't throw - logging shouldn't break workflow execution
  }
}

/**
 * Watchdog resets closer together than this belong to one burst, and the transcript
 * records a burst by its two ends. A gap at least this long is always visible as the
 * distance between two records; a shorter one is not a liveness question when the
 * watchdog itself waits minutes.
 */
export const WATCHDOG_RESET_BURST_GAP_MS = 10_000;

/** Samples one stream pass's watchdog renewals into `watchdog_reset` transcript records. */
export interface WatchdogResetRecorder {
  /** Observe one renewal. Never delays the stream: writes are queued, not awaited. */
  observe(chunkType: MessageChunk['type'], resetAt: number): void;
  /** Write any pending burst end, then wait for every queued write. Call once, when the pass ends. */
  flush(): Promise<void>;
}

/**
 * Records a burst's first reset when it arrives, and its last reset once the stream has
 * been quiet for the burst gap, or when the pass ends first. Each record's `chunk_count`
 * is the number of renewals since the previous record, itself included, so the counts
 * of a pass sum to its renewals.
 *
 * A timer writes the burst end instead of leaving it for `flush`: a stalled node's
 * process can be killed before its watchdog fires (Ctrl-C and SIGTERM exit without
 * running the executor's `finally`), and the transcript is then the only record of when
 * the stream went quiet. The timer is unref'd and never touches the watchdog.
 *
 * A burst end lands in the file after rows logged during the burst's final gap. Its
 * `ts` is the renewal time; order by `ts`.
 */
export function createWatchdogResetRecorder(
  logDir: string,
  workflowRunId: string,
  nodeId: string
): WatchdogResetRecorder {
  let writes = Promise.resolve();
  let lastResetAt: number | undefined;
  let burstEnd: { chunkType: MessageChunk['type']; at: number; count: number } | undefined;
  let burstEndTimer: ReturnType<typeof setTimeout> | undefined;

  const write = (chunkType: MessageChunk['type'], at: number, count: number): void => {
    writes = writes.then(() =>
      logWorkflowEvent(
        logDir,
        workflowRunId,
        { type: 'watchdog_reset', step: nodeId, chunk_type: chunkType, chunk_count: count },
        at
      )
    );
  };
  const writeBurstEnd = (): void => {
    clearTimeout(burstEndTimer);
    burstEndTimer = undefined;
    if (burstEnd) write(burstEnd.chunkType, burstEnd.at, burstEnd.count);
    burstEnd = undefined;
  };

  return {
    observe(chunkType, resetAt): void {
      if (lastResetAt !== undefined && resetAt - lastResetAt < WATCHDOG_RESET_BURST_GAP_MS) {
        burstEnd = { chunkType, at: resetAt, count: (burstEnd?.count ?? 0) + 1 };
        clearTimeout(burstEndTimer);
        burstEndTimer = setTimeout(writeBurstEnd, WATCHDOG_RESET_BURST_GAP_MS);
        burstEndTimer.unref();
      } else {
        writeBurstEnd();
        write(chunkType, resetAt, 1);
      }
      lastResetAt = resetAt;
    },
    flush(): Promise<void> {
      writeBurstEnd();
      return writes;
    },
  };
}

/**
 * Log workflow start
 */
export async function logWorkflowStart(
  logDir: string,
  workflowRunId: string,
  workflowName: string,
  userMessage: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_start',
    workflow_name: workflowName,
    content: userMessage,
  });
}

/**
 * Mark where a resumed execution picks the run back up. Written instead of a second
 * `workflow_start`, so that row keeps meaning "the run began" and every resume leaves
 * exactly one boundary: the n-th `workflow_resume` row starts the run's (n+1)-th segment.
 */
export async function logWorkflowResume(
  logDir: string,
  workflowRunId: string,
  workflowName: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_resume',
    workflow_name: workflowName,
  });
}

/**
 * Record how a gate was resolved. The caller derives it from the `approval_received`
 * event its gate transaction already committed, so the row never claims a decision the
 * database does not hold, and `content` is exactly the comment or rejection reason that
 * event stores. That event records no actor, so neither does this row.
 */
export async function logGateDecision(
  logDir: string,
  workflowRunId: string,
  gate: { step: string; decision: string; comment?: string }
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'gate_decision',
    step: gate.step,
    decision: gate.decision,
    ...(gate.comment !== undefined ? { content: gate.comment } : {}),
  });
}

/**
 * Record one provider event in the run's log: the envelope the store row carries, framed
 * by the log's own `workflow_id`, `ts` and `step`. The line parses with
 * `providerEventLineSchema`.
 */
export async function logProviderEvent(
  logDir: string,
  workflowRunId: string,
  stepName: string,
  envelope: ProviderEventEnvelope
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'provider_event',
    step: stepName,
    ...envelope,
  });
}

/**
 * Log workflow error
 */
export async function logWorkflowError(
  logDir: string,
  workflowRunId: string,
  error: string,
  usage?: WorkflowUsage
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_error',
    error,
    ...usage,
  });
}

/**
 * Log workflow completion, with what the whole run spent.
 */
export async function logWorkflowComplete(
  logDir: string,
  workflowRunId: string,
  usage?: WorkflowUsage
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_complete',
    ...usage,
  });
}

/** Log DAG node completion */
export async function logNodeComplete(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  commandName: string,
  meta?: { durationMs?: number } & WorkflowUsage
): Promise<void> {
  const { durationMs, ...usage } = meta ?? {};
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_complete',
    step: nodeId,
    content: commandName,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    // Spread whole: the caller already omitted every unreported axis, and a guard here
    // would have to re-decide that per field — which is how `0` becomes absent.
    ...usage,
  });
}

/** What one deterministic subprocess printed, already redacted and capped. */
export interface RetainedExecOutput {
  stdoutTail?: string;
  stderrTail?: string;
  exitCode: number | string;
}

/**
 * Retain what a deterministic subprocess printed, in the run's own transcript (#2967).
 *
 * The reader is a human auditing the run — "what did this node actually do?" — which is
 * why the evidence lives here and not under `$ARTIFACTS_DIR`, where a workflow would
 * start depending on it as a contract surface.
 *
 * Three properties this row must keep:
 *
 * - **Streams stay separate.** Merging stderr into stdout is how a `git` warning becomes
 *   the branch name a node returns; that bug is the reason this capability exists.
 * - **Both tails arrive redacted and capped.** `runSubprocess` owns both, because it owns
 *   the credential material. An artifact written once and read many times has to be safe
 *   at rest.
 * - **A row is written even when nothing was printed.** Absence of a row would be
 *   ambiguous between "printed nothing" and "not retained"; an absent tail FIELD means
 *   exactly "that stream was empty".
 *
 * This is the evidence copy, never the value channel — `$node.output` keeps its own
 * full-fidelity semantics and is unaffected by the cap applied here.
 */
export async function logExecOutput(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  commandName: string,
  output: RetainedExecOutput
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'exec_output',
    step: nodeId,
    content: commandName,
    exit_code: output.exitCode,
    ...(output.stdoutTail !== undefined ? { stdout_tail: output.stdoutTail } : {}),
    ...(output.stderrTail !== undefined ? { stderr_tail: output.stderrTail } : {}),
  });
}
