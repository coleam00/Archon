/**
 * The run log's model: what the Log view shows and in which order.
 *
 * Inside a node the order is the engine's: the node's provider-event records, as the
 * store holds them. Agent text opens a turn and the tool calls, hooks and warnings
 * recorded after it belong to that turn. Conversation messages carry no node and their
 * timestamps are flushed in batches, so they are only ever placed between nodes, never
 * against a tool call.
 */
import type { InlineToolCall, Message } from '../primitives/message';
import { isSystemCategory } from '../primitives/message';
import type {
  ArtifactEvent,
  ErrorEvent,
  NodeRun,
  RunEvent,
  SystemEvent,
  TextEvent,
} from '../primitives/event';
import type { ProviderEvent, ProviderEventRecord, RunProviderEvents } from './provider-events';

export interface PairedToolCall {
  record: ProviderEventRecord;
  id: string;
  timestamp: string;
  /** The node that made the call: the record's `stepName`. */
  nodeId: string;
  call: InlineToolCall;
}

/**
 * One entry per `tool_call`, in emission order, completed by the `tool_call_update`
 * with the same `toolCallId` in the same attempt. Concurrent calls of one tool pair
 * correctly because the id, not the name or the order, joins them. A call with no
 * update yet is still running.
 */
export function pairProviderToolCalls(providerEvents: RunProviderEvents): PairedToolCall[] {
  const paired: PairedToolCall[] = [];
  for (const [stepName, records] of providerEvents) {
    const byId = new Map<string, PairedToolCall>();
    for (const record of records) {
      const { event } = record;
      const key = JSON.stringify([record.attemptId, 'toolCallId' in event ? event.toolCallId : '']);
      if (event.type === 'tool_call') {
        const entry = openedToolCall(record, event, stepName, key);
        byId.set(key, entry);
        paired.push(entry);
      } else if (event.type === 'tool_call_update') {
        const entry = byId.get(key);
        if (entry !== undefined) entry.call = completedToolCall(entry, record, event);
      }
    }
  }
  return paired;
}

function openedToolCall(
  record: ProviderEventRecord,
  event: Extract<ProviderEvent, { type: 'tool_call' }>,
  stepName: string,
  key: string
): PairedToolCall {
  return {
    record,
    id: `${stepName}:${key}`,
    timestamp: record.observedAt,
    nodeId: stepName,
    call: {
      name: event.title || event.name,
      input: event.rawInput === undefined ? {} : event.rawInput,
    },
  };
}

function completedToolCall(
  entry: PairedToolCall,
  record: ProviderEventRecord,
  event: Extract<ProviderEvent, { type: 'tool_call_update' }>
): InlineToolCall {
  return {
    ...entry.call,
    status: event.status,
    ...(event.output !== undefined ? { output: event.output } : {}),
    ...(event.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    // A translated legacy row's time is its row's `created_at`, 1 s apart on
    // SQLite, so it cannot time a call.
    ...(record.attemptId !== null
      ? { durationMs: Date.parse(record.observedAt) - Date.parse(entry.timestamp) }
      : {}),
  };
}

/**
 * The tool calls a run view shows. Provider events record every provider's calls with
 * their node; message-inline calls (`message.metadata.toolCalls`) carry no node and are
 * shown only for a run that recorded no tool events, so no call is shown twice.
 */
function runToolCalls(
  messages: readonly Message[],
  providerEvents: RunProviderEvents
): { fromProviderEvents: PairedToolCall[]; showInline: boolean; count: number } {
  const fromProviderEvents = pairProviderToolCalls(providerEvents);
  const showInline = fromProviderEvents.length === 0;
  return {
    fromProviderEvents,
    showInline,
    count: showInline
      ? messages.reduce((acc, m) => acc + m.toolCalls.length, 0)
      : fromProviderEvents.length,
  };
}

export type TurnItem =
  | { kind: 'tool'; key: string; call: InlineToolCall; timestamp: string }
  | {
      kind: 'hook';
      key: string;
      event: Extract<ProviderEvent, { type: 'hook' }>;
      timestamp: string;
    }
  | { kind: 'warning'; key: string; message: string; timestamp: string };

/** One block of agent text and what the engine recorded after it, up to the next block. */
export interface Turn {
  key: string;
  /** Null for what a node recorded before its first text, or for a node that recorded none. */
  text: { text: string; timestamp: string } | null;
  items: TurnItem[];
}

function turnItem(
  record: ProviderEventRecord,
  paired: ReadonlyMap<ProviderEventRecord, PairedToolCall>,
  nodeStatus: NodeRun['status'] | undefined
): TurnItem | null {
  const tool = paired.get(record);
  if (tool !== undefined) {
    const unrecorded =
      tool.call.status === undefined && nodeStatus !== undefined && nodeStatus !== 'running';
    return {
      kind: 'tool',
      key: `pt:${tool.id}`,
      call: unrecorded ? { ...tool.call, outcomeUnrecorded: true } : tool.call,
      timestamp: tool.timestamp,
    };
  }
  const key = JSON.stringify([record.stepName, record.attemptId, record.seq]);
  const { event } = record;
  if (event.type === 'hook') {
    return { kind: 'hook', key: `ph:${key}`, event, timestamp: record.observedAt };
  }
  if (event.type === 'warning') {
    return {
      kind: 'warning',
      key: `pw:${key}`,
      message: event.message,
      timestamp: record.observedAt,
    };
  }
  return null;
}

/** A node's records as turns, in the order the store holds them. */
export function nodeTurns(
  records: readonly ProviderEventRecord[],
  paired: ReadonlyMap<ProviderEventRecord, PairedToolCall>,
  nodeStatus: NodeRun['status'] | undefined
): Turn[] {
  const turns: Turn[] = [];
  let lastText: NonNullable<Turn['text']> | null = null;
  for (const record of records) {
    const { event } = record;
    const key = JSON.stringify([record.stepName, record.attemptId, record.seq]);
    if (event.type === 'agent_message_chunk') {
      if (event.continuesPreviousBlock === true && lastText !== null) {
        lastText.text += event.text;
        continue;
      }
      lastText = { text: event.text, timestamp: record.observedAt };
      turns.push({ key: `pm:${key}`, text: lastText, items: [] });
      continue;
    }
    const item = turnItem(record, paired, nodeStatus);
    if (item === null) continue;
    if (turns.length === 0) turns.push({ key: `pm:${key}`, text: null, items: [] });
    turns[turns.length - 1].items.push(item);
  }
  return turns
    .map(turn =>
      turn.text !== null && turn.text.text.trim() === '' ? { ...turn, text: null } : turn
    )
    .filter(turn => turn.text !== null || turn.items.length > 0);
}

export interface SystemRow {
  label: string;
  detail: string;
  timestamp: string;
}

/**
 * An entry that carries no node: a conversation message, a message-inline tool call, or
 * a run-level event. `at` slots it between nodes and orders it among its own kind.
 */
export type BlindEntry =
  | { kind: 'message'; key: string; at: number; message: Message }
  /**
   * The conversation's copy of agent text a node section already shows from the
   * engine's record, or an engine notice sent to the conversation unmarked; the two
   * cannot be told apart.
   */
  | { kind: 'conversation_copy'; key: string; at: number; message: Message }
  | { kind: 'tool'; key: string; at: number; call: InlineToolCall; timestamp: string }
  | { kind: 'text'; key: string; at: number; event: TextEvent }
  | { kind: 'artifact'; key: string; at: number; event: ArtifactEvent }
  | { kind: 'system'; key: string; at: number; event: SystemEvent | ErrorEvent }
  | { kind: 'system_row'; key: string; at: number; row: SystemRow };

export interface LogSection {
  /** Null for a step with records whose node state has not arrived yet. */
  node: NodeRun | null;
  stepName: string;
  turns: Turn[];
  /** Node-blind entries from this node's start up to the next node's. */
  trailing: BlindEntry[];
}

export interface RunLog {
  /** The engine recorded agent text for this run, so node sections show it. */
  recordedText: boolean;
  /** Every tool call the run made, whether or not the toggles show it. */
  toolCallCount: number;
  /** Node-blind entries from before the first node started. */
  leading: BlindEntry[];
  sections: LogSection[];
}

function hasRecordedText(providerEvents: RunProviderEvents): boolean {
  for (const records of providerEvents.values()) {
    if (records.some(record => record.event.type === 'agent_message_chunk')) return true;
  }
  return false;
}

function systemMessageEntry(m: Message, at: number): BlindEntry {
  // Dispatch metadata gets its own row so the workflow name shows up explicitly.
  if (m.dispatch !== null) {
    return {
      kind: 'system_row',
      key: `sm:dispatch:${m.id}`,
      at,
      row: { label: 'Workflow dispatch', detail: m.dispatch.workflowName, timestamp: m.timestamp },
    };
  }
  return {
    kind: 'system_row',
    key: `sm:${m.id}`,
    at,
    row: {
      label: m.category ?? 'System',
      detail: m.content.split('\n')[0]?.slice(0, 160) ?? '',
      timestamp: m.timestamp,
    },
  };
}

function inlineToolEntries(m: Message, at: number): BlindEntry[] {
  return m.toolCalls.map((call, idx) => ({
    kind: 'tool',
    key: `t:${m.id}:${idx.toString()}`,
    // Just after the parent message, without colliding across sibling messages.
    at: at + idx + 1,
    call,
    timestamp: m.timestamp,
  }));
}

function messageEntries(
  messages: readonly Message[],
  showInline: boolean,
  recordedText: boolean
): BlindEntry[] {
  const entries: BlindEntry[] = [];
  for (const m of messages) {
    const at = new Date(m.timestamp).getTime();
    if (isSystemCategory(m.category) || m.role === 'system') {
      entries.push(systemMessageEntry(m, at));
      continue;
    }
    const inlineTools = showInline ? inlineToolEntries(m, at) : [];
    if (m.content.trim().length === 0 && m.error === null) {
      // A message with no text gets no card. Without calls of its own to show it is
      // plumbing; behind System a row marks the gap.
      if (inlineTools.length === 0) {
        entries.push({
          kind: 'system_row',
          key: `sm:noise:${m.id}`,
          at,
          row: { label: 'Noise', detail: `${m.role} · no content`, timestamp: m.timestamp },
        });
      }
      entries.push(...inlineTools);
      continue;
    }
    const isCopy =
      recordedText && m.role === 'assistant' && m.category === null && m.error === null;
    entries.push({
      kind: isCopy ? 'conversation_copy' : 'message',
      key: `m:${m.id}`,
      at,
      message: m,
    });
    entries.push(...inlineTools);
  }
  return entries;
}

function runEventEntries(events: readonly RunEvent[]): BlindEntry[] {
  const entries: BlindEntry[] = [];
  for (const e of events) {
    const at = new Date(e.timestamp).getTime();
    if (e.kind === 'artifact') {
      entries.push({ kind: 'artifact', key: `a:${e.id}`, at, event: e });
    } else if (e.kind === 'text') {
      entries.push({ kind: 'text', key: `text:${e.id}`, at, event: e });
    } else if (e.kind === 'system' || e.kind === 'error') {
      entries.push({ kind: 'system', key: `s:${e.id}`, at, event: e });
    }
  }
  return entries;
}

/**
 * Approval events are left out: the run page renders the gate below the stream.
 * `nodeRuns` must be in start order, as `foldNodeRuns` returns them.
 */
export function buildRunLog({
  messages,
  events,
  nodeRuns,
  providerEvents,
}: {
  messages: readonly Message[];
  events: readonly RunEvent[];
  nodeRuns: readonly NodeRun[];
  providerEvents: RunProviderEvents;
}): RunLog {
  const toolCalls = runToolCalls(messages, providerEvents);
  const paired = new Map(toolCalls.fromProviderEvents.map(t => [t.record, t]));
  const recordedText = hasRecordedText(providerEvents);

  const sections: LogSection[] = nodeRuns.map(node => ({
    node,
    stepName: node.nodeId,
    turns: nodeTurns(providerEvents.get(node.nodeId) ?? [], paired, node.status),
    trailing: [],
  }));
  const nodeCount = sections.length;
  const known = new Set(nodeRuns.map(node => node.nodeId));
  for (const [stepName, records] of providerEvents) {
    if (known.has(stepName)) continue;
    const turns = nodeTurns(records, paired, undefined);
    if (turns.length > 0) sections.push({ node: null, stepName, turns, trailing: [] });
  }

  const starts = nodeRuns.map(node => new Date(node.startedAt).getTime());
  const leading: BlindEntry[] = [];
  const blind = [
    ...messageEntries(messages, toolCalls.showInline, recordedText),
    ...runEventEntries(events),
  ].sort((a, b) => a.at - b.at);
  for (const entry of blind) {
    let owner = -1;
    while (owner + 1 < nodeCount && starts[owner + 1] <= entry.at) owner += 1;
    (owner === -1 ? leading : sections[owner].trailing).push(entry);
  }
  return { recordedText, toolCallCount: toolCalls.count, leading, sections };
}

function visibleEntries(entries: readonly BlindEntry[], show: LogVisibility): BlindEntry[] {
  return entries.filter(entry => {
    if (entry.kind === 'tool') return show.showToolCalls;
    if (entry.kind === 'system' || entry.kind === 'system_row') return show.showSystem;
    if (entry.kind === 'conversation_copy') return show.showSystem;
    return true;
  });
}

function visibleTurns(turns: readonly Turn[], showToolCalls: boolean): Turn[] {
  if (showToolCalls) return [...turns];
  return turns
    .map(turn => ({ ...turn, items: turn.items.filter(item => item.kind !== 'tool') }))
    .filter(turn => turn.text !== null || turn.items.length > 0);
}

export interface LogVisibility {
  showToolCalls: boolean;
  showSystem: boolean;
  /** null shows every node; otherwise only this node's section, with what it slots. */
  selectedNodeId: string | null;
}

/** The log with the toolbar's toggles and node filter applied. */
export function visibleRunLog(log: RunLog, show: LogVisibility): RunLog {
  const selected = show.selectedNodeId;
  return {
    ...log,
    leading: selected === null ? visibleEntries(log.leading, show) : [],
    sections: log.sections
      .filter(section => selected === null || section.stepName === selected)
      .map(section => ({
        ...section,
        turns: visibleTurns(section.turns, show.showToolCalls),
        trailing: visibleEntries(section.trailing, show),
      })),
  };
}

const QUIET_DURATION_MS = 5000;

/**
 * A node with nothing to read under its divider that was skipped or over in under five
 * seconds. Runs of these are the pre-amble that pushes a run's real work off screen.
 */
function isQuiet(section: LogSection): boolean {
  const { node } = section;
  if (node === null || section.turns.length > 0 || section.trailing.length > 0) return false;
  if (node.fanOutOutcome !== undefined) return false;
  if (node.status === 'skipped') return true;
  return (
    node.status === 'completed' && node.durationMs !== null && node.durationMs < QUIET_DURATION_MS
  );
}

export interface QuietFold {
  /** The first folded node's id: stable while later quiet nodes join the fold. */
  key: string;
  fold: LogSection[];
}

/** Sections with each run of two or more quiet neighbours grouped into a fold. */
export function foldSections(sections: readonly LogSection[]): (LogSection | QuietFold)[] {
  const out: (LogSection | QuietFold)[] = [];
  let quiet: LogSection[] = [];
  const flush = (): void => {
    if (quiet.length >= 2) out.push({ key: quiet[0].stepName, fold: quiet });
    else out.push(...quiet);
    quiet = [];
  };
  for (const section of sections) {
    if (isQuiet(section)) {
      quiet.push(section);
      continue;
    }
    flush();
    out.push(section);
  }
  flush();
  return out;
}

/** `7 steps · 3 done in under 5 s · 4 skipped`; a part that counts nothing is left out. */
export function quietFoldSummary(fold: readonly LogSection[]): string {
  const skipped = fold.filter(section => section.node?.status === 'skipped').length;
  const done = fold.length - skipped;
  return [
    `${fold.length.toString()} steps`,
    ...(done > 0 ? [`${done.toString()} done in under 5 s`] : []),
    ...(skipped > 0 ? [`${skipped.toString()} skipped`] : []),
  ].join(' · ');
}

/** How many message cards the Log shows before any toggle: the toolbar's count. */
export function countLogMessages(log: RunLog): number {
  const cards = (entries: readonly BlindEntry[]): number =>
    entries.filter(entry => entry.kind === 'message').length;
  return log.sections.reduce(
    (count, section) =>
      count + section.turns.filter(turn => turn.text !== null).length + cards(section.trailing),
    cards(log.leading)
  );
}
