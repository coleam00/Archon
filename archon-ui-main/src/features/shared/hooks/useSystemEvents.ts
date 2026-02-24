/**
 * System Events Hook
 *
 * Subscribes to the Archon SSE event stream and surfaces error/warning
 * events from events:error as toast notifications.
 */

import { useEffect, useRef } from "react";
import { useToast } from "./useToast";

interface SystemEvent {
  event_type: string;
  entity_type?: string;
  service?: string;
  severity?: string;
  _channel: string;
  timestamp: string;
  data?: {
    message?: string;
    [key: string]: unknown;
  };
}

const SSE_ENDPOINT = "/api/events/stream";
const MAX_RECONNECT_ATTEMPTS = 10;

export function useSystemEvents() {
  const { showToast } = useToast();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  useEffect(() => {
    const connect = () => {
      try {
        const eventSource = new EventSource(SSE_ENDPOINT);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          reconnectAttempts.current = 0;
        };

        eventSource.onmessage = (event) => {
          try {
            const sysEvent: SystemEvent = JSON.parse(event.data);
            if (sysEvent._channel !== "events:error") return;

            const severity = sysEvent.severity ?? "error";
            const message = sysEvent.data?.message ?? sysEvent.event_type ?? "System event";
            const prefix = sysEvent.service ? `[${sysEvent.service}] ` : "";

            if (severity === "critical" || severity === "error") {
              showToast(`${prefix}${message}`, "error", 8000);
            } else if (severity === "warning") {
              showToast(`${prefix}${message}`, "warning", 6000);
            }
          } catch {
            // Ignore parse errors
          }
        };

        eventSource.onerror = () => {
          eventSource.close();
          if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30_000);
            reconnectAttempts.current++;
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          }
        };
      } catch {
        // SSE unavailable — silently skip
      }
    };

    connect();

    return () => {
      eventSourceRef.current?.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [showToast]);
}
