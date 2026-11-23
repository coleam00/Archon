import { formatDuration } from '@archon/paths/duration';
import { toolCallDisplayName } from '@archon/provider-contract';
import {
  describeStallMessage,
  stallMessageEventDataSchema,
  type WorkflowEventRow,
} from '@archon/workflows/schemas/workflow-event';
import { providerEventEnvelopeSchema } from '@archon/workflows/schemas/provider-event';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import type { NodeExecutionMetadata } from '@archon/workflows/schemas/node-execution';
import { readNodeEmitterEvent } from '@archon/workflows/node-event-write';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { deadlineWaitCursor, resumeCursorMatches } from '@archon/workflows/store';
import type { ResolvedWorkflow, WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import {
  isApprovalContext,
  runAttention,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { isOperatorPaused } from '@archon/workflows/schemas/pause-cause';
import { attentionAnswerLines } from '@archon/workflows/deps';
import type { CLIAdapter } from '../adapters/cli-adapter';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { WorkflowRunFailedError } from '../utils/workflow-exit-code';
import { formatRunUsage } from './workflow-usage';
import { formatSkipCause } from './workflow-node-summaries';
import { getLog, NAME_ITEM_HINT, type RunDestination } from './workflow-shared';
import { pendingDurableWait, type PendingWaitContinuation } from './workflow-wait-continuation';

/**
 * Tool calls this subscription saw start and not yet close, keyed by attempt and call id,
 * so a completion line can name its tool and duration. One per run subscription.
 */
export type OpenToolCalls = Map<string, { name: string; observedAt: string }>;

/**
 * The wording of a node's progress lines. A foreground run renders them from persisted
 * event rows and `workflow logs --format text` from transcript rows; both call these so
 * the lines are worded alike. The label differs: the foreground names a command node by
 * its command, the transcript by its node id, which is all its failure and skip rows record.
 */
export const nodeLine = {
  started: (name: string, detail = ''): string => `[${name}] Started${detail}`,
  completed: (name: string, durationMs?: number): string =>
    `[${name}] Completed${durationMs === undefined ? '' : ` (${formatDuration(durationMs)})`}`,
  // The recorded failure kind is the name a `retry.on_error` policy targets, so it is shown.
  failed: (name: string, error: string, execution?: NodeExecutionMetadata): string => {
    // A transcript row is unvalidated JSON, so a row without a lifecycle prints no kind.
    const lifecycle = execution?.lifecycle as NodeExecutionMetadata['lifecycle'] | undefined;
    const kind = lifecycle?.status === 'failed' ? lifecycle.failureKind : undefined;
    return `[${name}] Failed${kind === undefined ? '' : ` (${kind})`}: ${error}`;
  },
  skipped: (name: string, why: string): string => `[${name}] Skipped (${why})`,
};

function nodeEventLine(event: WorkflowEmitterEvent): string | undefined {
  switch (event.type) {
    case 'node_started': {
      let suffix = '';
      if (event.provider !== undefined && event.model !== undefined) {
        const tierPart = event.tier !== undefined ? ` ← ${event.tier}` : '';
        suffix = `  (${event.provider}/${event.model}${tierPart})`;
      }
      return nodeLine.started(event.nodeName, suffix);
    }
    case 'node_completed':
      return nodeLine.completed(event.nodeName, event.duration);
    case 'node_failed':
      return nodeLine.failed(event.nodeName, event.error, event.execution);
    case 'node_skipped':
      return nodeLine.skipped(event.nodeName, formatSkipCause(event.cause));
    case 'node_skipped_prior_success':
      return nodeLine.skipped(event.nodeName, 'prior_success');
    default:
      return undefined;
  }
}

/** What a `stall_message` row says: the engine's message to a stalled session, or why there was none. */
export function stallMessageLine(row: WorkflowEventRow): string | undefined {
  // A row another build wrote and this one cannot read is skipped, as provider rows are.
  const parsed = stallMessageEventDataSchema.safeParse(row.data);
  if (!parsed.success) return undefined;
  return describeStallMessage(row.step_name ?? '?', row.workflow_run_id, parsed.data);
}

function containerLine(phase: string, data: Record<string, unknown>): string {
  const id = typeof data.containerId === 'string' ? data.containerId : '';
  const idPart = id ? ` ${id.slice(0, 12)}` : '';
  return `[container] ${phase}${idPart}`;
}

function toolLine(row: WorkflowEventRow, openToolCalls: OpenToolCalls): string | undefined {
  // A row this build cannot read (another build's provider events) is skipped, as the
  // transcript reader does; a throw here would only log once per row.
  const parsed = providerEventEnvelopeSchema.safeParse(row.data);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  const providerEvent = envelope.event;
  // A call id is unique within its attempt; parallel nodes can repeat one.
  const callKey = JSON.stringify([
    envelope.attemptId,
    'toolCallId' in providerEvent ? providerEvent.toolCallId : '',
  ]);
  if (providerEvent.type === 'tool_call') {
    const name = toolCallDisplayName(providerEvent);
    openToolCalls.set(callKey, { name, observedAt: envelope.observedAt });
    return `[${row.step_name}] tool: ${name} (started, ${providerEvent.toolCallId})`;
  }
  if (providerEvent.type !== 'tool_call_update') return undefined;
  const started = openToolCalls.get(callKey);
  openToolCalls.delete(callKey);
  const duration =
    started === undefined
      ? ''
      : `${String(Date.parse(envelope.observedAt) - Date.parse(started.observedAt))}ms, `;
  const exitCode =
    providerEvent.exitCode !== undefined ? `, exit ${String(providerEvent.exitCode)}` : '';
  return `[${row.step_name}] tool: ${started?.name ?? providerEvent.toolCallId} (${duration}${providerEvent.toolCallId}, ${providerEvent.status}${exitCode})`;
}

/** The progress line a persisted workflow event renders as, if any. */
export function workflowEventLine(
  row: WorkflowEventRow,
  verbose: boolean,
  openToolCalls: OpenToolCalls
): string | undefined {
  const nodeEvent = readNodeEmitterEvent(row);
  if (nodeEvent !== undefined) return nodeEventLine(nodeEvent);
  switch (row.event_type) {
    case 'workflow_started':
      return typeof row.data.transcriptPath === 'string'
        ? `[workflow] Transcript: ${row.data.transcriptPath}`
        : undefined;
    case 'approval_requested':
      return typeof row.data.message === 'string'
        ? `[${row.step_name}] Waiting for approval: ${row.data.message}`
        : undefined;
    case 'pause_notice_undelivered':
      return `[${row.step_name}] Pause notice not delivered; the run is still waiting`;
    case 'container_created':
    case 'container_stopped':
    case 'container_resumed':
    case 'container_destroyed':
      return containerLine(row.event_type.slice('container_'.length), row.data);
    case 'writeback_requested':
    case 'writeback_applied':
    case 'writeback_discarded':
      return containerLine(row.event_type, row.data);
    case 'provider_event':
      return verbose ? toolLine(row, openToolCalls) : undefined;
    case 'stall_message':
      return stallMessageLine(row);
    default:
      // Workflow-level, loop, artifact, and cancelled events are intentionally not rendered.
      return undefined;
  }
}

/** What a settled foreground run reports, and where. */
export interface RunResultPresentation {
  host: WorkflowHost;
  workflow: ResolvedWorkflow;
  result: WorkflowExecutionResult;
  adapter: CLIAdapter;
  conversationId: string;
  destination: RunDestination;
  detachedProcessOwner: boolean;
}

/**
 * Report a settled run: its pause, its completion with a result card, or its failure,
 * which throws. Returns the continuation when the run paused on a wait whose deadline
 * this process owns.
 */
export async function presentRunResult(
  input: RunResultPresentation
): Promise<PendingWaitContinuation | undefined> {
  const { host, workflow, result, adapter, conversationId, destination, detachedProcessOwner } =
    input;
  if ('handedOff' in result) return presentHandoff(result, detachedProcessOwner);
  const run = await readRunForPresentation(host, result);

  // Check result and exit appropriately
  if ('paused' in result) {
    // A durable wait with a deadline (time, event or usage limit) is this process's own
    // cursor to wake; a gate or `attention` pause has no deadline and stays with whoever resolves it.
    if (result.waitCursor !== undefined) {
      return presentDurableWait(host, result.workflowRunId, result.waitCursor, destination);
    }
    // A paused run has no outcome: it is written only when the run completes.
    if (result.byOperator)
      console.log(
        `\nWorkflow paused by an operator. Resume: archon workflow resume ${result.workflowRunId}`
      );
    else printPausedRun(run, result.workflowRunId);
  } else if (result.success) {
    // Surface workflow result to Web UI as a result card (mirrors the background dispatch
    // result message in core's orchestrator/dispatch/background-run.ts).
    // Paused workflows are handled in the branch above and intentionally do not get a result card.
    if ('summary' in result && result.summary) {
      await sendResultCard(
        adapter,
        conversationId,
        workflow.name,
        result.workflowRunId,
        result.summary
      );
    }
    if (!printRunFacts(workflow, run, '\nWorkflow finished.')) {
      console.log('\nWorkflow completed successfully.');
    }
    printRunUsage(run);
  } else {
    printRunUsage(run);
    throw new WorkflowRunFailedError(failureReason(result), detachedProcessOwner);
  }
  return undefined;
}

function printPausedRun(run: WorkflowRun | null, runId: string): void {
  if (run !== null && isOperatorPaused(run)) {
    console.log(`\nWorkflow paused by an operator. Resume: archon workflow resume ${runId}`);
    return;
  }
  const attention = run === null ? null : runAttention(run);
  if (attention?.kind === 'attention') {
    console.log('\nWorkflow paused — waiting for an answer to its ask.');
    console.log(`  Read the full question: archon workflow attention ${runId}`);
    for (const line of attentionAnswerLines(CLI_WORKFLOW_SURFACE, attention))
      console.log(`  ${line}`);
    return;
  }
  if (attention?.kind === 'awaiting_response') {
    const approval = run?.metadata.approval;
    const interactive = isApprovalContext(approval) && approval.type === 'interactive_loop';
    console.log(
      interactive
        ? '\nWorkflow paused — waiting for interactive input.'
        : '\nWorkflow paused — waiting for approval.'
    );
    console.log(`  Read the gate: archon workflow attention ${runId}`);
    console.log(
      `  Respond: archon workflow approve ${runId} --occurrence ${attention.occurrence} ` +
        (interactive ? '<your feedback>' : '[comment]') +
        ', or reject or respond <decision> the same way.'
    );
    return;
  }
  // An unavailable row or unclassified pause must not invent an approval request.
  const detail =
    attention?.kind === 'unreadable'
      ? ` — ${attention.detail}`
      : run === null
        ? ' — persisted pause details unavailable'
        : '';
  console.log(`\nWorkflow paused${detail}. Inspect: archon workflow get ${runId}`);
}

/** Why the run failed, with this surface's way to name an item when that was refused. */
function failureReason(result: Extract<WorkflowExecutionResult, { success: false }>): string {
  return 'continuedItemRefused' in result ? `${result.error} ${NAME_ITEM_HINT}` : result.error;
}

function presentHandoff(
  result: Extract<WorkflowExecutionResult, { handedOff: true }>,
  detachedProcessOwner: boolean
): undefined {
  console.log(
    `\nWorkflow execution handed off. Observed status: ${result.observedStatus ?? 'run removed'}.`
  );
  if (!result.success) throw new WorkflowRunFailedError(result.error, detachedProcessOwner);
  return undefined;
}

async function readRunForPresentation(
  host: WorkflowHost,
  result: WorkflowExecutionResult
): Promise<WorkflowRun | null> {
  if (
    result.success &&
    'paused' in result &&
    (result.waitCursor !== undefined || result.byOperator)
  )
    return null;
  const { workflowRunId } = result;
  if (workflowRunId === undefined) return null;
  try {
    return await host.deps.store.getWorkflowRun(workflowRunId);
  } catch (error) {
    getLog().warn({ err: error as Error, workflowRunId }, 'cli.workflow_summary_lookup_failed');
    return null;
  }
}

/** The outcome a completed run declared, which only the completing write records. */
function printRunFacts(workflow: ResolvedWorkflow, run: WorkflowRun | null, lead: string): boolean {
  if (workflow.result?.outcome === undefined) return false;
  if (run === null) {
    console.log(
      `${lead}\n  Status: completed\n  Authored outcome: unavailable — failed to read persisted run`
    );
    return true;
  }
  if (run.completed_outcome === null) return false;
  console.log(`${lead}\n  Status: ${run.status}\n  Authored outcome: ${run.completed_outcome}`);
  return true;
}

function printRunUsage(run: WorkflowRun | null): void {
  const lines =
    run === null
      ? ['  Usage: unavailable (persisted run unavailable)']
      : formatRunUsage(run.metadata);
  for (const line of lines) console.log(line);
}

async function presentDurableWait(
  host: WorkflowHost,
  runId: string,
  waitCursor: ReturnType<typeof deadlineWaitCursor>,
  destination: RunDestination
): Promise<PendingWaitContinuation | undefined> {
  const pausedRun = await host.deps.store.getWorkflowRun(runId);
  if (pausedRun === null || !resumeCursorMatches(pausedRun, waitCursor)) return;
  const wait = pendingDurableWait(pausedRun);
  if (wait === undefined) return;
  console.log(
    `\nWorkflow paused — waiting for '${wait.stepName}' until ${wait.cursor.resumeAt}; ` +
      'this process resumes the run at its deadline.'
  );
  return { run: pausedRun, wait: { ...wait, cursor: waitCursor }, destination };
}

async function sendResultCard(
  adapter: CLIAdapter,
  conversationId: string,
  workflowName: string,
  runId: string,
  summary: string
): Promise<void> {
  try {
    await adapter.sendMessage(conversationId, summary, {
      category: 'workflow_result',
      segment: 'new',
      workflowResult: { workflowName, runId },
    });
  } catch (surfaceError) {
    getLog().warn(
      { err: surfaceError as Error, conversationId },
      'cli.workflow_result_surface_failed'
    );
  }
}
