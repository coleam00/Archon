/**
 * Console SSE wiring.
 *
 * Two streams are exposed by the server:
 *   /api/stream/__dashboard__       — multiplexed workflow events for every run
 *   /api/stream/<conversationId>    — per-conversation events (text/tool_call/tool_result + workflow_*)
 *
 * The console treats them as cache-invalidation triggers: an event lands,
 * the relevant cache key is invalidated, `useEntity` refetches authoritative
 * state from the API. The list+detail surfaces don't need to interpret event
 * payloads — they just need to know "data changed, ask again." This stays
 * loosely coupled to event schemas and avoids partial in-memory mutation.
 */

import { useEffect } from 'react';
import { invalidate } from '../store/cache';
import { K } from './../store/keys';
import { SSE_BASE_URL } from './http';

interface ParsedEvent {
  type?: string;
  runId?: string;
  locked?: boolean;
}

function parse(raw: string): ParsedEvent | null {
  try {
    return JSON.parse(raw) as ParsedEvent;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the dashboard SSE stream and invalidate the runs feed on any
 * lifecycle change. Safe to mount from more than one route — RunsPage and the
 * ChatPage WorkflowDock both do; each opens an independent connection and the
 * invalidations are idempotent.
 *
 * Events we care about:
 *   workflow_status   — run created / status changed / completed / failed
 *   dag_node          — currently-executing-node changes (current_step_name)
 *                       which is rendered on each ActiveRunCard
 */
export function useDashboardSSE(): void {
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
  }, []);
}

/**
 * Subscribe to a single run's conversation stream and invalidate the detail
 * caches on every interesting event. Skips connecting until a platform
 * conversation id is known.
 *
 * Events we care about:
 *   text                  — new assistant text → messages changed
 *   tool_call/tool_result — new tool activity  → messages + run events changed
 *   workflow_status       — run status changed
 *   workflow_tool_activity / dag_node — workflow_events table grew
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
        case 'text':
          messagesDirty = true;
          break;
        case 'tool_call':
        case 'tool_result':
          messagesDirty = true;
          runDirty = true;
          break;
        case 'workflow_status':
        case 'workflow_tool_activity':
        case 'dag_node':
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
