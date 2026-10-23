import { isWorktreeSetupEventType } from '@archon/workflows/schemas/worktree-setup';
import { toolCallDisplayName } from '@archon/provider-contract';
import { open as openFile } from 'node:fs/promises';
import type { WorkflowEvent } from '@archon/workflows/logger';
import {
  providerEventLineSchema,
  type ProviderEventLine,
} from '@archon/workflows/schemas/provider-event';
import { formatToolInputBrief } from '@archon/workflows/utils/tool-formatter';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { formatSkipCause } from './workflow-node-summaries';
import { writeStdout } from '../utils/stdout';
import { nodeLine } from './workflow-run-output';

export const TRANSCRIPT_POLL_INTERVAL_MS = 500;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

/** How `workflow logs` prints a transcript: its exact JSONL, or rendered for a human. */
export type TranscriptFormat = 'jsonl' | 'text';

export interface TranscriptReadState {
  offset: number;
  decoder: TextDecoder;
  output: TranscriptOutput;
}

/** Where decoded transcript text goes. `end` flushes anything held back at a line boundary. */
interface TranscriptOutput {
  write(text: string): Promise<void>;
  end(): Promise<void>;
}

/** Longest line a tool call renders to; a Codex tool name can be a whole shell script. */
const TRANSCRIPT_TOOL_LINE_MAX = 160;

function indentLines(text: string, prefix: string): string {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .map(line => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Compile-time check only: a new row or provider event type must be decided where it renders. */
function typeDecided(_type: never): void {
  // Nothing to do at runtime.
}

/** Output lines a tool call's outcome shows: the end of its output, where errors land. */
const TRANSCRIPT_TOOL_OUTPUT_LINES = 3;

/** What rendering a row needs from the rows before it. One per rendered transcript. */
interface TranscriptRenderState {
  /** Tool names by attempt and call id, so a call's outcome can name its tool. */
  toolNames: Map<string, string>;
  /** The node of the last rendered row, so a switch to another node's activity is labelled. */
  lastStep?: string;
}

function toolCallKey(attemptId: string, toolCallId: string): string {
  // A call id is unique within its attempt; parallel nodes can repeat one.
  return JSON.stringify([attemptId, toolCallId]);
}

function toolOutputTail(output: string): string | undefined {
  const lines = output.replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return undefined;
  const shown = lines.slice(-TRANSCRIPT_TOOL_OUTPUT_LINES);
  const hidden = lines.length - shown.length;
  return [
    ...(hidden > 0 ? [`(${String(hidden)} earlier lines)`] : []),
    ...shown.map(line =>
      line.length > TRANSCRIPT_TOOL_LINE_MAX
        ? `${line.slice(0, TRANSCRIPT_TOOL_LINE_MAX - 3)}...`
        : line
    ),
  ]
    .map(line => `    ${line}`)
    .join('\n');
}

type ProviderEvent = ProviderEventLine['event'];
type ProviderEventOf<T extends ProviderEvent['type']> = Extract<ProviderEvent, { type: T }>;

/**
 * One provider event, indented under its node like the node's other activity. Events that
 * only mark progress (a running subtask, a hook that started or succeeded, a connected MCP
 * server) render nothing, so a transcript reads as what the agent said and did.
 */
function formatProviderEvent(
  line: ProviderEventLine,
  state: TranscriptRenderState
): string | undefined {
  const event = line.event;
  switch (event.type) {
    case 'agent_message_chunk':
      return indentLines(event.text, '  ');
    case 'agent_thought_chunk':
      return `  ${oneLine(`thinking: ${event.text}`, TRANSCRIPT_TOOL_LINE_MAX)}`;
    case 'tool_call':
      return formatToolCall(event, line.attemptId, state);
    case 'tool_call_update':
      return formatToolCallUpdate(event, line.attemptId, state);
    case 'warning':
      return `  ${oneLine(`warning: ${event.message} (${event.code})`, TRANSCRIPT_TOOL_LINE_MAX)}`;
    case 'mcp_server_status':
      return formatMcpServerStatus(event);
    case 'compaction':
      return formatCompaction(event);
    case 'subtask':
      return formatSubtask(event);
    case 'hook':
      return formatHook(event);
    case 'state_update':
      return event.state === 'requires_action' ? '  waiting on the user' : undefined;
    default:
      typeDecided(event);
      return undefined;
  }
}

function formatToolCall(
  event: ProviderEventOf<'tool_call'>,
  attemptId: string,
  state: TranscriptRenderState
): string {
  const name = toolCallDisplayName(event);
  state.toolNames.set(toolCallKey(attemptId, event.toolCallId), name);
  // A title is already what the call does, such as the command a Codex shell runs.
  const brief =
    !event.title && event.rawInput !== undefined
      ? formatToolInputBrief(name, event.rawInput)
      : null;
  return `  ${oneLine(`tool: ${name}${brief && brief !== '{}' ? ` ${brief}` : ''}`, TRANSCRIPT_TOOL_LINE_MAX)}`;
}

function formatToolCallUpdate(
  event: ProviderEventOf<'tool_call_update'>,
  attemptId: string,
  state: TranscriptRenderState
): string {
  const key = toolCallKey(attemptId, event.toolCallId);
  const name = state.toolNames.get(key) ?? event.toolCallId;
  state.toolNames.delete(key);
  const details = [
    ...(event.exitCode !== undefined ? [`exit ${String(event.exitCode)}`] : []),
    ...(event.outputTruncated ? ['output truncated'] : []),
  ];
  const outcome = `  ${oneLine(`${event.status}: ${name}`, TRANSCRIPT_TOOL_LINE_MAX / 2)}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  const tail = event.output ? toolOutputTail(event.output) : undefined;
  return tail ? `${outcome}\n${tail}` : outcome;
}

function formatMcpServerStatus(event: ProviderEventOf<'mcp_server_status'>): string | undefined {
  if (event.status === 'connected' || event.status === 'pending') return undefined;
  return `  ${oneLine(`mcp ${event.server}: ${event.status}${event.error ? ` (${event.error})` : ''}`, TRANSCRIPT_TOOL_LINE_MAX)}`;
}

function formatCompaction(event: ProviderEventOf<'compaction'>): string {
  const tokens =
    event.tokensBefore !== undefined && event.tokensAfter !== undefined
      ? `: ${String(event.tokensBefore)} -> ${String(event.tokensAfter)} tokens`
      : '';
  return `  compaction ${event.phase}${event.trigger ? ` (${event.trigger})` : ''}${tokens}`;
}

function formatSubtask(event: ProviderEventOf<'subtask'>): string | undefined {
  if (event.status === 'running') return undefined;
  const about =
    event.status === 'started' ? event.description : (event.summary ?? event.description);
  return `  ${oneLine(`subtask ${event.status}: ${about ?? event.taskId}`, TRANSCRIPT_TOOL_LINE_MAX)}`;
}

function formatHook(event: ProviderEventOf<'hook'>): string | undefined {
  if (event.status === 'started' || event.status === 'succeeded') return undefined;
  return `  hook ${event.status}: ${event.hookName} (${event.hookEvent}${event.exitCode !== undefined ? `, exit ${String(event.exitCode)}` : ''})`;
}

/**
 * One transcript row as the text `workflow logs --format text` prints, or `undefined` for a
 * row that renders nothing. Node lines share their wording with the foreground renderer.
 * A node's agent text and tool calls are indented beneath it. A `provider_event` row names
 * its node, so when activity switches to another node (parallel nodes interleave) a
 * `[node]` line labels it. The historical `assistant` and `tool` rows record no node and
 * stay unlabelled rather than attributed to a guessed one.
 */
function formatTranscriptRow(row: WorkflowEvent, state: TranscriptRenderState): string | undefined {
  if (isWorktreeSetupEventType(row.type)) return row.setup?.message;
  const step = row.step ?? '?';
  switch (row.type) {
    case 'workflow_start':
      return `[workflow] Started ${row.workflow_name ?? ''}`.trimEnd();
    case 'workflow_resume':
      return `[workflow] Resumed ${row.workflow_name ?? ''}`.trimEnd();
    case 'workflow_complete':
      return '[workflow] Completed';
    case 'workflow_error':
      return `[workflow] Failed: ${row.error ?? ''}`;
    case 'node_start':
      return formatNodeStart(row, step);
    case 'node_complete':
      return nodeLine.completed(step, row.duration_ms);
    case 'node_error':
      return nodeLine.failed(step, row.error ?? '');
    case 'node_skipped':
      return formatNodeSkipped(row, step);
    case 'node_suspended':
      return `[${step}] Waiting (${row.content ?? 'wait'})`;
    case 'gate_decision':
      return formatGateDecision(row, step);
    case 'provider_event':
      return formatProviderEventRow(row, state);
    case 'assistant':
      return row.content ? indentLines(row.content, '  ') : undefined;
    case 'tool':
      return formatToolRow(row);
    case 'exec_output':
      return formatExecOutput(row, step);
    // Liveness bookkeeping and a historical row: nothing a reader of the run needs.
    case 'watchdog_reset':
    case 'validation':
      return undefined;
    default:
      // At runtime a type this build does not know (an older or newer transcript)
      // renders nothing.
      typeDecided(row.type);
      return undefined;
  }
}

function formatNodeStart(row: WorkflowEvent, step: string): string {
  // `content` is the command a command node runs, or a `<inline>`-style kind marker.
  return nodeLine.started(
    step,
    row.content && !row.content.startsWith('<') ? ` (${row.content})` : ''
  );
}

function formatNodeSkipped(row: WorkflowEvent, step: string): string {
  return nodeLine.skipped(
    step,
    row.cause ? formatSkipCause(row.cause) : (row.content ?? 'skipped')
  );
}

function formatGateDecision(row: WorkflowEvent, step: string): string {
  // The comment is the operator's verbatim text and may span lines.
  const decision = `[${step}] Gate: ${row.decision ?? ''}`;
  if (!row.content) return decision;
  return row.content.includes('\n')
    ? `${decision}\n${indentLines(row.content, '  ')}`
    : `${decision} (${row.content})`;
}

function formatProviderEventRow(
  row: WorkflowEvent,
  state: TranscriptRenderState
): string | undefined {
  // Unlike other rows, a provider event is read field by field, so a line that does not
  // match the schema this build knows renders nothing instead of throwing.
  const parsed = providerEventLineSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const text = formatProviderEvent(parsed.data, state);
  if (text === undefined) return undefined;
  return parsed.data.step === state.lastStep ? text : `[${parsed.data.step}]\n${text}`;
}

function formatToolRow(row: WorkflowEvent): string {
  const name = row.tool_name ?? '?';
  const brief = row.tool_input ? formatToolInputBrief(name, row.tool_input) : null;
  return `  ${oneLine(`tool: ${name}${brief && brief !== '{}' ? ` ${brief}` : ''}`, TRANSCRIPT_TOOL_LINE_MAX)}`;
}

function formatExecOutput(row: WorkflowEvent, step: string): string {
  const lines = [`[${step}] Output (exit ${String(row.exit_code ?? '?')})`];
  if (row.stdout_tail) lines.push(indentLines(row.stdout_tail, '  '));
  if (row.stderr_tail) lines.push('  stderr:', indentLines(row.stderr_tail, '    '));
  return lines.join('\n');
}

/**
 * A JSONL line rendered for a human. A line that is not a JSON object, or a row type this
 * build does not know (older transcripts hold `step_start`, newer engines may add more),
 * renders nothing: the text view is a reading aid, and the JSONL default keeps every row.
 */
function renderTranscriptLine(line: string, state: TranscriptRenderState): string | undefined {
  if (line.trim().length === 0) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return undefined;
  const event = row as WorkflowEvent;
  const text = formatTranscriptRow(event, state);
  if (text !== undefined && event.step !== undefined) state.lastStep = event.step;
  return text;
}

export function transcriptOutput(format: TranscriptFormat): TranscriptOutput {
  if (format === 'jsonl') {
    return { write: writeStdout, end: (): Promise<void> => Promise.resolve() };
  }
  // A read can end mid-row while the run is still appending, so only whole lines render.
  let partial = '';
  const state: TranscriptRenderState = { toolNames: new Map() };
  const render = async (lines: string[]): Promise<void> => {
    const rendered = lines.flatMap(line => renderTranscriptLine(line, state) ?? []);
    if (rendered.length > 0) await writeStdout(`${rendered.join('\n')}\n`);
  };
  return {
    async write(text: string): Promise<void> {
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      await render(lines);
    },
    async end(): Promise<void> {
      const last = partial;
      partial = '';
      await render([last]);
    },
  };
}

export async function drainTranscript(
  transcriptPath: string,
  state: TranscriptReadState
): Promise<boolean> {
  let file;
  try {
    file = await openFile(transcriptPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  try {
    const { size } = await file.stat();
    if (size < state.offset) {
      throw new Error(
        `Transcript was truncated from ${String(state.offset)} to ${String(size)} bytes: ${transcriptPath}`
      );
    }

    const buffer = new Uint8Array(TRANSCRIPT_READ_CHUNK_BYTES);
    while (state.offset < size) {
      const bytesToRead = Math.min(buffer.byteLength, size - state.offset);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, state.offset);
      if (bytesRead === 0) break;
      state.offset += bytesRead;
      const text = state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      if (text.length > 0) await state.output.write(text);
    }
    return true;
  } finally {
    await file.close();
  }
}

export async function finishTranscriptDecode(state: TranscriptReadState): Promise<void> {
  const text = state.decoder.decode();
  if (text.length > 0) await state.output.write(text);
  await state.output.end();
}

export function transcriptUnavailableMessage(
  run: WorkflowRun,
  transcriptPath: string,
  follow: boolean
): string {
  if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
    return `Run ${run.id} is ${run.status}, but its transcript is missing or empty: ${transcriptPath}`;
  }
  return follow
    ? `Run ${run.id} ended before producing transcript content: ${transcriptPath}`
    : `Transcript is not available yet for ${run.id}. Use --follow to wait for it: ${transcriptPath}`;
}
