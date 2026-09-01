/**
 * SDK Event Logger - captures workflow execution to JSONL
 */
import { appendFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { WorkflowTokenUsage } from './deps';
import type { MessageChunk } from '@archon/providers/types';
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
 * sequential execution mode, and its writer is now deleted too. It stays because logs
 * already on disk contain those rows — keep it when reading, never write a new one.
 */
export interface WorkflowEvent {
  type:
    | 'workflow_start'
    | 'workflow_complete'
    | 'workflow_error'
    | 'assistant'
    | 'tool'
    | 'validation'
    | 'node_start'
    | 'node_complete'
    | 'node_skipped'
    | 'node_error'
    | 'watchdog_reset'
    | 'exec_output';
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
  error?: string;
  /** `watchdog_reset` only. The chunk content is deliberately never retained. */
  chunk_type?: MessageChunk['type'];
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
 * That symmetry holds per SINK, not yet across every node type. A `loop:` node's
 * cumulative totals reach its transcript row on failure and its persisted event on
 * either outcome, but no success exit writes a terminal transcript row for the loop's
 * own id — only per-iteration rows, which carry duration and no usage. `workflow:` and
 * fan-out nodes write no transcript rows at all. So do not read an absent `cost_usd` on
 * a run's transcript as "the whole run was free"; read it per row, where it means the
 * provider reported no cost. Completing that coverage is #2614's audit.
 *
 * Each axis is omitted when nothing was reported for it, so an absent `cost_usd` means
 * the provider reported no cost (Codex reports none at all — #2334) and `0` means it
 * reported zero. Build it with `!== undefined` tests, never truthiness.
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

/** Retain the privacy-safe evidence for one watchdog renewal. */
export async function logWatchdogReset(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  chunkType: MessageChunk['type'],
  resetAt: number
): Promise<void> {
  await logWorkflowEvent(
    logDir,
    workflowRunId,
    {
      type: 'watchdog_reset',
      step: nodeId,
      chunk_type: chunkType,
    },
    resetAt
  );
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
 * Log assistant message
 */
export async function logAssistant(
  logDir: string,
  workflowRunId: string,
  content: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'assistant',
    content,
  });
}

/**
 * Log tool call
 */
export async function logTool(
  logDir: string,
  workflowRunId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'tool',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Log workflow error
 */
export async function logWorkflowError(
  logDir: string,
  workflowRunId: string,
  error: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'workflow_error',
    error,
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

/** Log DAG node start */
export async function logNodeStart(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  commandName: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_start',
    step: nodeId,
    content: commandName,
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

/** Log DAG node skipped (when: false or trigger_rule not met) */
export async function logNodeSkip(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  reason: string
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_skipped',
    step: nodeId,
    content: reason,
  });
}

/**
 * Log DAG node error, with what the node spent before it failed.
 *
 * A node that fails mid-stream keeps the usage it already burned, so the failure row
 * carries spend for the same reason the completion row does (#2693). Callers whose
 * failure happens before any provider call — a missing command file, a substitution
 * error, a bash exit code — pass nothing, and the absent keys mean exactly that.
 */
export async function logNodeError(
  logDir: string,
  workflowRunId: string,
  nodeId: string,
  error: string,
  usage?: WorkflowUsage
): Promise<void> {
  await logWorkflowEvent(logDir, workflowRunId, {
    type: 'node_error',
    step: nodeId,
    error,
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
