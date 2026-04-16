import { useMemo, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { ToolCallItem } from './ToolCallItem';
import { NodeDivider } from './NodeDivider';
import { ArtifactItem } from './ArtifactItem';
import type { InlineToolCall, Message } from '../primitives/message';
import type { RunEvent, NodeTransitionEvent, ArtifactEvent } from '../primitives/event';

interface RunStreamProps {
  messages: Message[];
  events: RunEvent[];
  showToolCalls: boolean;
  showSystem: boolean;
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

type TimelineEntry =
  | { kind: 'message'; key: string; at: number; message: Message }
  | { kind: 'tool'; key: string; at: number; call: InlineToolCall; timestamp: string }
  | { kind: 'node'; key: string; at: number; event: NodeTransitionEvent }
  | { kind: 'artifact'; key: string; at: number; event: ArtifactEvent };

/**
 * Merges conversation messages + workflow events into a single timeline.
 *
 * Tool calls live inside each message's metadata. We break them out into
 * their own timeline entries (keyed under the message's timestamp, with a
 * tiny per-tool offset for stable ordering) so each one renders as its own
 * small card and the `showToolCalls` toggle can hide them cleanly.
 *
 * What we deliberately skip here:
 *   - `tool_call` *events* from workflow_events — conversation metadata is
 *     authoritative, rendering both would double-display.
 *   - `approval` events — the RunDetailPage renders an inline ApprovalPanel
 *     below the stream instead.
 *   - `text` / `error` events — messages are the source of truth for text;
 *     errors surface via the run status + action bar.
 */
export function RunStream({
  messages,
  events,
  showToolCalls,
  showSystem,
}: RunStreamProps): ReactElement {
  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    for (const m of messages) {
      if (!isMeaningful(m)) continue;
      if (!showSystem && m.role === 'system') continue;
      const base = new Date(m.timestamp).getTime();
      entries.push({ kind: 'message', key: `m:${m.id}`, at: base, message: m });
      m.toolCalls.forEach((call, idx) => {
        entries.push({
          kind: 'tool',
          key: `t:${m.id}:${idx.toString()}`,
          // Place tool calls just after the parent message so they appear right
          // below it but don't collide across sibling messages.
          at: base + idx + 1,
          call,
          timestamp: m.timestamp,
        });
      });
    }
    for (const e of events) {
      const at = new Date(e.timestamp).getTime();
      if (e.kind === 'node_transition') {
        entries.push({ kind: 'node', key: `n:${e.id}`, at, event: e });
      } else if (e.kind === 'artifact') {
        entries.push({ kind: 'artifact', key: `a:${e.id}`, at, event: e });
      }
    }
    entries.sort((a, b) => a.at - b.at);
    return entries;
  }, [messages, events, showSystem]);

  const visible = showToolCalls ? timeline : timeline.filter(e => e.kind !== 'tool');

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
    <div className="flex flex-col gap-1.5">
      {visible.map(entry => {
        if (entry.kind === 'message') {
          return <MessageItem key={entry.key} message={entry.message} />;
        }
        if (entry.kind === 'tool') {
          return <ToolCallItem key={entry.key} call={entry.call} timestamp={entry.timestamp} />;
        }
        if (entry.kind === 'node') {
          return (
            <NodeDivider
              key={entry.key}
              nodeName={entry.event.nodeName}
              transition={entry.event.transition}
              durationMs={entry.event.durationMs}
              timestamp={entry.event.timestamp}
            />
          );
        }
        return <ArtifactItem key={entry.key} event={entry.event} />;
      })}
    </div>
  );
}
