import { useMemo, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { ToolCallItem } from './ToolCallItem';
import { NodeDivider } from './NodeDivider';
import { ArtifactItem } from './ArtifactItem';
import type { InlineToolCall, Message } from '../primitives/message';
import { isSystemCategory } from '../primitives/message';
import { foldNodeRuns } from '../primitives/event';
import type {
  RunEvent,
  RunNodeState,
  NodeRun,
  ArtifactEvent,
  SystemEvent,
  ErrorEvent,
} from '../primitives/event';
import type { RunProviderEvents } from '../lib/provider-events';
import { StreamCard } from './StreamCard';

interface RunStreamProps {
  messages: Message[];
  events: RunEvent[];
  /** The engine's node states (`run.nodes`); the only source of node status. */
  nodes: readonly RunNodeState[];
  /** The run's provider events by node (lib/provider-events.ts). */
  providerEvents: RunProviderEvents;
  showToolCalls: boolean;
  showSystem: boolean;
  /** `'all'` shows every node; otherwise restrict the stream to one node's entries. */
  selectedNodeId: string;
}

/**
 * Drop messages that carry no signal — no prose, no tool calls, no error.
 * These are usually workflow-plumbing artifacts that render as "(no content)"
 * cards otherwise.
 */
function isMeaningful(m: Message): boolean {
  if (m.content.trim().length > 0) return true;
  if (m.toolCalls.length > 0) return true;
  if (m.error !== null) return true;
  return false;
}

interface SystemRow {
  label: string;
  detail: string;
  timestamp: string;
}

type TimelineEntry =
  | { kind: 'message'; key: string; at: number; message: Message }
  // `nodeId` carries the owning node (provider-event tools) or null (message-inline
  // tools are node-blind) — used only by the node filter, not for display.
  | {
      kind: 'tool';
      key: string;
      at: number;
      call: InlineToolCall;
      timestamp: string;
      nodeId: string | null;
    }
  | { kind: 'node'; key: string; at: number; node: NodeRun; showDetail: boolean }
  | { kind: 'artifact'; key: string; at: number; event: ArtifactEvent }
  | { kind: 'system'; key: string; at: number; event: SystemEvent | ErrorEvent }
  | { kind: 'system_row'; key: string; at: number; row: SystemRow };

interface PairedToolCall {
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
        const entry: PairedToolCall = {
          id: `${stepName}:${key}`,
          timestamp: record.observedAt,
          nodeId: stepName,
          call: { name: event.title || event.name, input: event.rawInput ?? {} },
        };
        byId.set(key, entry);
        paired.push(entry);
      } else if (event.type === 'tool_call_update') {
        const entry = byId.get(key);
        if (entry === undefined) continue;
        entry.call = {
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
    }
  }
  return paired;
}

/**
 * The tool calls a run view shows. Provider events record every provider's calls with
 * their node; message-inline calls (`message.metadata.toolCalls`) carry no node and are
 * shown only for a run that recorded no tool events, so no call is shown twice.
 */
export function runToolCalls(
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

/**
 * Merges conversation messages + workflow events into a single timeline. Tool calls
 * come from {@link runToolCalls}.
 *
 * What we deliberately skip here:
 *   - `approval` events — RunDetailPage renders an inline ApprovalPanel
 *     below the stream instead.
 *   - `text` / `error` events — messages are the source of truth for text;
 *     errors surface via the run status + action bar.
 */
export function RunStream({
  messages,
  events,
  nodes,
  providerEvents,
  showToolCalls,
  showSystem,
  selectedNodeId,
}: RunStreamProps): ReactElement {
  // Single source for the folded nodes — consumed by both the timeline (one
  // divider per node) and the node-filter window so they can't drift.
  const nodeRuns = useMemo(() => foldNodeRuns(events, nodes), [events, nodes]);
  const toolCalls = useMemo(
    () => runToolCalls(messages, providerEvents),
    [messages, providerEvents]
  );

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    for (const m of messages) {
      const base = new Date(m.timestamp).getTime();
      const meaningful = isMeaningful(m);
      const isSystemy = isSystemCategory(m.category) || m.role === 'system';

      if (isSystemy) {
        // Framework chatter — surface as a compact system row instead of
        // rendering as agent prose. Dispatch metadata gets its own row when
        // present so the workflow name shows up explicitly.
        if (m.dispatch !== null) {
          entries.push({
            kind: 'system_row',
            key: `sm:dispatch:${m.id}`,
            at: base,
            row: {
              label: 'Workflow dispatch',
              detail: m.dispatch.workflowName,
              timestamp: m.timestamp,
            },
          });
        } else {
          entries.push({
            kind: 'system_row',
            key: `sm:${m.id}`,
            at: base,
            row: {
              label: m.category ?? 'System',
              detail: m.content.split('\n')[0]?.slice(0, 160) ?? '',
              timestamp: m.timestamp,
            },
          });
        }
        continue;
      }

      if (!meaningful) {
        // Empty / no-signal messages — usually plumbing the SDK emits. Hide
        // by default; behind System the user gets a noise row to see the
        // gap that would otherwise be invisible.
        entries.push({
          kind: 'system_row',
          key: `sm:noise:${m.id}`,
          at: base,
          row: {
            label: 'Noise',
            detail: `${m.role} · no content`,
            timestamp: m.timestamp,
          },
        });
        continue;
      }

      entries.push({ kind: 'message', key: `m:${m.id}`, at: base, message: m });
      if (!toolCalls.showInline) continue;
      m.toolCalls.forEach((call, idx) => {
        entries.push({
          kind: 'tool',
          key: `t:${m.id}:${idx.toString()}`,
          // Place tool calls just after the parent message so they appear right
          // below it but don't collide across sibling messages.
          at: base + idx + 1,
          call,
          timestamp: m.timestamp,
          // Message-inline tools are node-blind — messages carry no step.
          nodeId: null,
        });
      });
    }

    const nodeStatus = new Map(nodeRuns.map(r => [r.nodeId, r.status]));
    for (const t of toolCalls.fromProviderEvents) {
      const status = nodeStatus.get(t.nodeId);
      const unrecorded =
        t.call.status === undefined && status !== undefined && status !== 'running';
      entries.push({
        kind: 'tool',
        key: `pt:${t.id}`,
        at: new Date(t.timestamp).getTime(),
        call: unrecorded ? { ...t.call, outcomeUnrecorded: true } : t.call,
        timestamp: t.timestamp,
        nodeId: t.nodeId,
      });
    }

    // One divider per node, positioned at its first transition so it heads that
    // node's events in the stream.
    for (const nr of nodeRuns) {
      entries.push({
        kind: 'node',
        key: `n:${nr.nodeId}`,
        at: new Date(nr.startedAt).getTime(),
        node: nr,
        showDetail: showSystem,
      });
    }

    for (const e of events) {
      const at = new Date(e.timestamp).getTime();
      if (e.kind === 'artifact') {
        entries.push({ kind: 'artifact', key: `a:${e.id}`, at, event: e });
      } else if (e.kind === 'system' || e.kind === 'error') {
        entries.push({ kind: 'system', key: `s:${e.id}`, at, event: e });
      }
    }
    entries.sort((a, b) => a.at - b.at);
    return entries;
  }, [messages, events, nodeRuns, toolCalls, showSystem]);

  // The selected node's execution slice `[startedAt, nextNode.startedAt)`. Used as
  // a positional fallback so node-blind entries (prose, artifacts, system rows, and
  // message-inline tools of a run with no recorded tool events) still resolve to a
  // node when filtering.
  const nodeWindow = useMemo<{ start: number; end: number } | null>(() => {
    if (selectedNodeId === 'all') return null;
    const idx = nodeRuns.findIndex(r => r.nodeId === selectedNodeId);
    if (idx === -1) return null;
    const start = new Date(nodeRuns[idx].startedAt).getTime();
    const next = nodeRuns[idx + 1];
    return { start, end: next !== undefined ? new Date(next.startedAt).getTime() : Infinity };
  }, [nodeRuns, selectedNodeId]);

  const visible = timeline.filter(e => {
    if (e.kind === 'tool' && !showToolCalls) return false;
    if (e.kind === 'system' && !showSystem) return false;
    if (e.kind === 'system_row' && !showSystem) return false;
    // Node filter: isolate one node. Node markers and tools from provider events
    // match by identity; every node-blind entry (prose, artifacts, system rows,
    // legacy message-inline tools) falls back to the node's time window so a
    // node's whole slice of the timeline stays visible.
    if (selectedNodeId !== 'all') {
      if (e.kind === 'node') return e.node.nodeId === selectedNodeId;
      if (e.kind === 'tool' && e.nodeId !== null) return e.nodeId === selectedNodeId;
      return nodeWindow !== null && e.at >= nodeWindow.start && e.at < nodeWindow.end;
    }
    return true;
  });

  if (visible.length === 0) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-center">
        <div className="flex flex-col items-center gap-2 text-text-tertiary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--running)]" />
          <p className="text-sm">Waiting for first event…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {visible.map(entry => {
        if (entry.kind === 'message') {
          return (
            <div key={entry.key} className="py-4">
              <MessageItem message={entry.message} variant="log" />
            </div>
          );
        }
        if (entry.kind === 'tool') {
          return <ToolCallItem key={entry.key} call={entry.call} timestamp={entry.timestamp} />;
        }
        if (entry.kind === 'node') {
          return (
            <NodeDivider
              key={entry.key}
              nodeId={entry.node.nodeId}
              nodeName={entry.node.nodeName}
              status={entry.node.status}
              durationMs={entry.node.durationMs}
              timestamp={entry.node.startedAt}
              costUsd={entry.node.costUsd}
              costScope={entry.node.costScope}
              numTurns={entry.node.numTurns}
              stopReason={entry.node.stopReason}
              skipReason={entry.node.skipReason}
              skipExpr={entry.node.skipExpr}
              showDetail={entry.showDetail}
            />
          );
        }
        if (entry.kind === 'system') {
          const ev = entry.event;
          const isError = ev.kind === 'error';
          const label = isError ? 'Error' : ev.label;
          const detail = isError ? ev.message : ev.detail;
          return (
            <div key={entry.key} className="py-1">
              <StreamCard
                timestamp={ev.timestamp}
                kind={isError ? 'error' : 'system'}
                compact
                label={label}
                headerRight={
                  detail.length > 0 ? (
                    <span className="truncate font-mono text-[11px] text-text-secondary">
                      {detail}
                    </span>
                  ) : null
                }
              />
            </div>
          );
        }
        if (entry.kind === 'system_row') {
          return (
            <div key={entry.key} className="py-1">
              <StreamCard
                timestamp={entry.row.timestamp}
                kind="system"
                compact
                label={entry.row.label}
                headerRight={
                  entry.row.detail.length > 0 ? (
                    <span className="truncate font-mono text-[11px] text-text-secondary">
                      {entry.row.detail}
                    </span>
                  ) : null
                }
              />
            </div>
          );
        }
        return (
          <div key={entry.key} className="py-1">
            <ArtifactItem event={entry.event} />
          </div>
        );
      })}
    </div>
  );
}
