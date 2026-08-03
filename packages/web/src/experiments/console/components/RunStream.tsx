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
  NodeRun,
  ArtifactEvent,
  ToolCallEvent,
  SystemEvent,
  ErrorEvent,
} from '../primitives/event';
import { StreamCard } from './StreamCard';

interface RunStreamProps {
  messages: Message[];
  events: RunEvent[];
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
  // `nodeId` carries the owning node (workflow-event tools) or null (message-inline
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

/**
 * Pairs `tool_called` events with their matching `tool_completed` so each
 * call surfaces as a single InlineToolCall with input + duration.
 *
 * Pairing key: step name. The orchestrator emits the events sequentially
 * within a step, so taking the next unclaimed `tool_completed` after each
 * `tool_called` for the same step is correct.
 *
 * Returns one InlineToolCall per `tool_called` event, in event order. The
 * `tool_completed` event contributes only `durationMs`.
 */
interface PairedToolCall {
  id: string;
  timestamp: string;
  /** Owning node (`step_name`) so the call can be filtered by node; null if unattributed. */
  nodeId: string | null;
  call: InlineToolCall;
}

export function pairToolEvents(events: RunEvent[]): PairedToolCall[] {
  const toolEvents = events.filter((e): e is ToolCallEvent => e.kind === 'tool_call');
  // Track unclaimed completed events per step so each call gets exactly one.
  const completedByStep = new Map<string, ToolCallEvent[]>();
  for (const e of toolEvents) {
    if (e.result === null) continue; // start event; skip here
    const key = e.nodeId ?? '';
    const list = completedByStep.get(key) ?? [];
    list.push(e);
    completedByStep.set(key, list);
  }

  const paired: PairedToolCall[] = [];
  for (const e of toolEvents) {
    if (e.result !== null) continue; // only seed from start events
    const key = e.nodeId ?? '';
    const pool = completedByStep.get(key);
    const match = pool !== undefined && pool.length > 0 ? pool.shift() : undefined;
    const input =
      typeof e.args === 'object' && e.args !== null ? (e.args as Record<string, unknown>) : {};
    paired.push({
      id: e.id,
      timestamp: e.timestamp,
      nodeId: e.nodeId,
      call: {
        name: e.tool || '(unknown)',
        input,
        durationMs: match?.result?.ok === true ? match.result.durationMs : undefined,
      },
    });
  }
  return paired;
}

/**
 * Merges conversation messages + workflow events into a single timeline.
 *
 * Tool-call source-of-truth depends on the workflow's provider:
 *   - Claude runs persist tool calls in `message.metadata.toolCalls`
 *   - Pi / Codex / bash nodes persist them as `tool_called`/`tool_completed`
 *     workflow events
 *
 * When any message has inline tool calls we treat the conversation as
 * authoritative (avoids double-display on Claude). Otherwise we surface the
 * paired workflow tool events.
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
  showToolCalls,
  showSystem,
  selectedNodeId,
}: RunStreamProps): ReactElement {
  // Single source for the folded nodes — consumed by both the timeline (one
  // divider per node) and the node-filter window so they can't drift.
  const nodeRuns = useMemo(() => foldNodeRuns(events), [events]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    let inlineToolCount = 0;
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
      m.toolCalls.forEach((call, idx) => {
        inlineToolCount += 1;
        entries.push({
          kind: 'tool',
          key: `t:${m.id}:${idx.toString()}`,
          // Place tool calls just after the parent message so they appear right
          // below it but don't collide across sibling messages.
          at: base + idx + 1,
          call,
          timestamp: m.timestamp,
          // Message-inline tools (Claude) are node-blind — messages carry no step.
          nodeId: null,
        });
      });
    }

    // If no inline tool calls came from messages, surface workflow tool events.
    if (inlineToolCount === 0) {
      for (const t of pairToolEvents(events)) {
        entries.push({
          kind: 'tool',
          key: `wt:${t.id}`,
          at: new Date(t.timestamp).getTime(),
          call: t.call,
          timestamp: t.timestamp,
          nodeId: t.nodeId,
        });
      }
    }

    // One divider per node: fold each node's 2–3 transitions (started + terminal,
    // plus a resume-time skipped_prior_success) into a single NodeRun, positioned
    // at its first transition so it heads that node's events in the stream.
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
  }, [messages, events, nodeRuns, showSystem]);

  // The selected node's execution slice `[startedAt, nextNode.startedAt)`. Used as
  // a positional fallback so node-blind entries (message-inline tools, prose,
  // artifacts, system rows — anything carrying no nodeId) still resolve to a node
  // when filtering — without it, selecting a node on a message-inline-tool run
  // (e.g. Claude) would blank the stream.
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
    // Node filter: isolate one node. Node markers and node-attributed (workflow-
    // event) tools match by identity; every node-blind entry (message-inline
    // tools, prose, artifacts, system rows) falls back to the node's time window
    // so a node's whole slice of the timeline stays visible regardless of provider.
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
