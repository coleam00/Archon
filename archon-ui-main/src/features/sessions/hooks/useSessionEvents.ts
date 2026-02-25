/**
 * Real-Time Session Events Hook
 *
 * Subscribes to Server-Sent Events (SSE) for real-time session updates.
 * Automatically invalidates query cache when session events occur.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { sessionKeys } from "./useSessionQueries";

interface SessionEvent {
  type: "session_created" | "session_updated" | "session_ended";
  timestamp: string;
  data: {
    session_id: string;
    working_on?: string;
    sprint?: string;
    project_name?: string;
    summary?: string;
  };
}

const SSE_ENDPOINT = import.meta.env.VITE_SSE_ENDPOINT || "http://localhost:8000/stream/sessions";

/**
 * Hook to enable real-time session updates via SSE
 */
export function useSessionEvents() {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  useEffect(() => {
    const connect = () => {
      try {
        const eventSource = new EventSource(SSE_ENDPOINT);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          console.log("📡 Real-time session updates connected");
          reconnectAttempts.current = 0;
        };

        eventSource.onmessage = (event) => {
          try {
            const sessionEvent: SessionEvent = JSON.parse(event.data);

            console.log(`🔄 Session event: ${sessionEvent.type}`, sessionEvent.data);

            // Invalidate all session queries to trigger refetch
            queryClient.invalidateQueries({ queryKey: sessionKeys.all });

            // Optionally show notifications based on event type
            if (sessionEvent.type === "session_created") {
              console.log(`✨ New session: ${sessionEvent.data.working_on}`);
            } else if (sessionEvent.type === "session_updated") {
              console.log(`💬 Session updated: ${sessionEvent.data.working_on}`);
            } else if (sessionEvent.type === "session_ended") {
              console.log(`🏁 Session ended: ${sessionEvent.data.summary}`);
            }
          } catch (error) {
            console.error("Failed to parse session event:", error);
          }
        };

        eventSource.onerror = (error) => {
          console.error("SSE connection error:", error);
          eventSource.close();

          // Reconnect with exponential backoff
          if (reconnectAttempts.current < maxReconnectAttempts) {
            const backoffDelay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
            reconnectAttempts.current++;

            console.log(`Reconnecting in ${backoffDelay}ms... (attempt ${reconnectAttempts.current})`);

            reconnectTimeoutRef.current = setTimeout(connect, backoffDelay);
          } else {
            console.error("Max reconnection attempts reached. Falling back to polling.");
          }
        };
      } catch (error) {
        console.error("Failed to establish SSE connection:", error);
      }
    };

    // Initial connection
    connect();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [queryClient]);
}
