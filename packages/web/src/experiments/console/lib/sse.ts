/**
 * Console SSE wiring.
 *
 * Two streams are exposed by the server:
 *   /api/stream/__dashboard__       — multiplexed workflow events for every run
 *   /api/stream/<conversationId>    — per-conversation events (text/tool_call/tool_result + workflow_*)
 *
 * The console treats most of them as cache-invalidation triggers: an event lands,
 * the relevant cache key is invalidated, `useEntity` refetches authoritative
 * state from the API. The list+detail surfaces don't need to interpret event
 * payloads — they just need to know "data changed, ask again."
 *
 * Provider events are the exception. A run streams thousands, and each frame carries
 * the engine's record unchanged, so `workflow_provider_event` frames are appended to
 * the provider-event store (lib/provider-events.ts) instead of triggering a refetch.
 */

import { useEffect } from 'react';
import { invalidate } from '../store/cache';
import { K } from './../store/keys';
import { SSE_BASE_URL } from './http';
import { providerEventStore, type ProviderEventRecord } from './provider-events';

interface ParsedEvent {
  type?: string;
  runId?: string;
  locked?: boolean;
  nodeId?: string;
  status?: string;
}

function parse(raw: string): ParsedEvent | null {
  try {
    return JSON.parse(raw) as ParsedEvent;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the dashboard SSE stream, invalidate the runs feed on any
 * lifecycle change, and report the changed run to `onRunChanged` (keep it
 * stable: a new callback reconnects). Mounted once, at the console root, so
 * every route stays live: the server keeps a single `__dashboard__` stream, and
 * a second connection replaces the first.
 *
 * Events we care about:
 *   workflow_status   — run created / status changed / completed / failed
 *   dag_node          — active-node lifecycle changes, rendered together on
 *                       each ActiveRunCard
 */
export function useDashboardSSE(onRunChanged: (runId: string) => void): void {
  useEffect(() => {
    // Use SSE_BASE_URL so dev bypasses the Vite proxy (which buffers SSE).
    const es = new EventSource(`${SSE_BASE_URL}/api/stream/__dashboard__`);

    es.onmessage = (e: MessageEvent<string>): void => {
      const ev = parse(e.data);
      if (ev?.type === undefined || ev.type === 'heartbeat') return;
      if (ev.type === 'workflow_status' || ev.type === 'dag_node') {
        // Refetch every runs:* key (runs:all, runs:project:<id>).
        invalidate('runs');
        // Also refresh any open run-detail cache so the detail page picks
        // up status / node-transition changes without its own SSE round-trip.
        if (typeof ev.runId === 'string') {
          invalidate(K.run(ev.runId));
          onRunChanged(ev.runId);
        }
      }
    };

    // EventSource auto-reconnects on transient errors; we only surface a
    // warn when the connection has permanently closed so dropped streams
    // aren't completely silent (the 30s safety-net poll in RunDetailPage
    // covers the actual recovery; this is purely an observability hook).
    es.onerror = (): void => {
      if (es.readyState === EventSource.CLOSED) {
        console.warn('[console-sse] dashboard stream closed');
      }
    };

    return (): void => {
      es.close();
    };
  }, [onRunChanged]);
}

/**
 * Subscribe to a single run's conversation stream and invalidate the detail
 * caches on every interesting event. Skips connecting until a platform
 * conversation id is known.
 *
 * Events we care about:
 *   text / tool_call / tool_result — chat-message activity → messages changed
 *   workflow_provider_event        — appended to the provider-event store, no refetch
 *   workflow_status / dag_node     — run status or node lifecycle changed
 *
 * A reconnect, or a node reaching a terminal state, asks the provider-event store to
 * fetch whatever frames the page may have missed.
 */
export function useRunStreamSSE(conversationPlatformId: string | null, runId: string | null): void {
  useEffect(() => {
    if (conversationPlatformId === null || runId === null) return;

    const es = new EventSource(
      `${SSE_BASE_URL}/api/stream/${encodeURIComponent(conversationPlatformId)}`
    );

    let messagesDirty = false;
    let runDirty = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let opened = false;

    es.onopen = (): void => {
      // EventSource reconnects on its own; frames sent while it was away are lost.
      if (opened) providerEventStore.catchUp(runId);
      opened = true;
    };

    // Coalesce bursts. Streamed text can arrive at >10Hz; we don't want a
    // refetch per chunk. 100ms is fast enough to feel live and slow enough
    // to dedupe.
    const scheduleFlush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (messagesDirty) {
          invalidate(K.messages(conversationPlatformId));
          messagesDirty = false;
        }
        if (runDirty) {
          invalidate(K.run(runId));
          runDirty = false;
        }
      }, 100);
    };

    es.onmessage = (e: MessageEvent<string>): void => {
      const ev = parse(e.data);
      if (ev?.type === undefined || ev.type === 'heartbeat') return;

      switch (ev.type) {
        case 'workflow_provider_event': {
          // The frame is the engine's record plus the channel's `type`.
          const frame = JSON.parse(e.data) as ProviderEventRecord;
          providerEventStore.receive({
            runId: frame.runId,
            stepName: frame.stepName,
            attemptId: frame.attemptId,
            seq: frame.seq,
            observedAt: frame.observedAt,
            event: frame.event,
          });
          return;
        }
        case 'text':
        case 'tool_call':
        case 'tool_result':
          messagesDirty = true;
          break;
        case 'dag_node':
          if (
            typeof ev.nodeId === 'string' &&
            (ev.status === 'completed' || ev.status === 'failed')
          ) {
            providerEventStore.nodeFinished(runId, ev.nodeId);
          }
          runDirty = true;
          break;
        case 'workflow_status':
        case 'workflow_step':
        case 'workflow_artifact':
        case 'workflow_dispatch':
          runDirty = true;
          break;
        // Other event types (system_status, retract, etc.) don't change
        // persisted state we render — ignore.
        default:
          return;
      }
      scheduleFlush();
    };

    es.onerror = (): void => {
      if (es.readyState === EventSource.CLOSED) {
        console.warn('[console-sse] conversation stream closed', { conversationPlatformId });
      }
    };

    return (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      es.close();
    };
  }, [conversationPlatformId, runId]);
}

/**
 * Subscribe to a conversation stream for a pure chat view (no associated run).
 * Identical to {@link useRunStreamSSE} minus the run-detail branches: it only
 * invalidates the message cache on text/tool events, and surfaces the
 * conversation lock so the composer can disable while the agent is responding.
 *
 *   text / tool_call / tool_result → messages changed (debounced refetch)
 *   conversation_lock              → onLockChange(locked)
 */
export function useConversationSSE(
  conversationPlatformId: string | null,
  onLockChange?: (locked: boolean) => void
): void {
  useEffect(() => {
    if (conversationPlatformId === null) return;

    const es = new EventSource(
      `${SSE_BASE_URL}/api/stream/${encodeURIComponent(conversationPlatformId)}`
    );

    let messagesDirty = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (messagesDirty) {
          invalidate(K.messages(conversationPlatformId));
          messagesDirty = false;
        }
      }, 100);
    };

    es.onmessage = (e: MessageEvent<string>): void => {
      const ev = parse(e.data);
      if (ev?.type === undefined || ev.type === 'heartbeat') return;

      switch (ev.type) {
        case 'text':
        case 'tool_call':
        case 'tool_result':
          messagesDirty = true;
          scheduleFlush();
          break;
        case 'conversation_lock':
          if (typeof ev.locked === 'boolean') onLockChange?.(ev.locked);
          break;
        // No run-detail cache here; ignore workflow_* and everything else.
        default:
          return;
      }
    };

    es.onerror = (): void => {
      if (es.readyState === EventSource.CLOSED) {
        console.warn('[console-sse] conversation stream closed', { conversationPlatformId });
      }
    };

    return (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      es.close();
    };
  }, [conversationPlatformId, onLockChange]);
}
