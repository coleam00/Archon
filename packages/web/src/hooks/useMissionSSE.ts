import { useEffect } from 'react';
import { missionSSEHandlers } from '@/stores/mission-store';

/**
 * Connects to the Mission Control SSE stream and forwards parsed events to the
 * Zustand store. Mirrors `useDashboardSSE` but routes both workflow events and
 * Symphony dispatch events through `missionSSEHandlers.onEvent`.
 */
export function useMissionSSE(): void {
  useEffect(() => {
    const es = new EventSource('/api/mission/stream');

    es.onmessage = (e: MessageEvent<string>): void => {
      let event: Record<string, unknown> & { type?: string };
      try {
        event = JSON.parse(e.data) as Record<string, unknown> & { type?: string };
      } catch {
        return;
      }
      if (!event.type || event.type === 'heartbeat') return;
      missionSSEHandlers.onEvent(event as Parameters<typeof missionSSEHandlers.onEvent>[0]);
    };

    es.onerror = (): void => {
      // EventSource auto-reconnects on error; no explicit handling needed.
    };

    return (): void => {
      es.close();
    };
  }, []);
}
