import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/config/api";
import type { LogEntry, SSEConnectionState } from "../types";

export interface UseWorkOrderLogsOptions {
  /** Work order ID to stream logs for */
  workOrderId: string | undefined;

  /** Optional log level filter */
  levelFilter?: "info" | "warning" | "error" | "debug";

  /** Optional step filter */
  stepFilter?: string;

  /** Whether to enable auto-reconnect on disconnect */
  autoReconnect?: boolean;
}

export interface UseWorkOrderLogsReturn {
  /** Array of log entries */
  logs: LogEntry[];

  /** Connection state */
  connectionState: SSEConnectionState;

  /** Whether currently connected */
  isConnected: boolean;

  /** Error if connection failed */
  error: Error | null;

  /** Manually reconnect */
  reconnect: () => void;

  /** Clear logs */
  clearLogs: () => void;
}

const MAX_LOGS = 500; // Limit stored logs to prevent memory issues
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds

/**
 * Hook for streaming work order logs via Server-Sent Events (SSE)
 *
 * Manages EventSource connection lifecycle, handles reconnection with exponential backoff,
 * and maintains a real-time log buffer with automatic cleanup.
 */
export function useWorkOrderLogs({
  workOrderId,
  levelFilter,
  stepFilter,
  autoReconnect = true,
}: UseWorkOrderLogsOptions): UseWorkOrderLogsReturn {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connectionState, setConnectionState] = useState<SSEConnectionState>("disconnected");
  const [error, setError] = useState<Error | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryDelayRef = useRef<number>(INITIAL_RETRY_DELAY);
  const reconnectAttemptRef = useRef<number>(0);

  /**
   * Build SSE endpoint URL with optional query parameters
   */
  const buildUrl = useCallback(() => {
    if (!workOrderId) return null;

    const params = new URLSearchParams();
    if (levelFilter) params.append("level", levelFilter);
    if (stepFilter) params.append("step", stepFilter);

    const queryString = params.toString();
    const baseUrl = `${API_BASE_URL}/agent-work-orders/${workOrderId}/logs/stream`;

    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }, [workOrderId, levelFilter, stepFilter]);

  /**
   * Clear logs from state
   */
  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  /**
   * Connect to SSE endpoint
   */
  const connect = useCallback(() => {
    const url = buildUrl();
    if (!url) return;

    // Cleanup existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setConnectionState("connecting");
    setError(null);

    try {
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnectionState("connected");
        setError(null);
        // Reset retry delay on successful connection
        retryDelayRef.current = INITIAL_RETRY_DELAY;
        reconnectAttemptRef.current = 0;
      };

      eventSource.onmessage = (event) => {
        try {
          const logEntry: LogEntry = JSON.parse(event.data);
          setLogs((prevLogs) => {
            const newLogs = [...prevLogs, logEntry];
            // Keep only the last MAX_LOGS entries
            return newLogs.slice(-MAX_LOGS);
          });
        } catch (err) {
          console.error("Failed to parse log entry:", err, event.data);
        }
      };

      eventSource.onerror = () => {
        setConnectionState("error");
        const errorObj = new Error("SSE connection error");
        setError(errorObj);

        // Close the connection
        eventSource.close();
        eventSourceRef.current = null;

        // Auto-reconnect with exponential backoff
        if (autoReconnect && workOrderId) {
          reconnectAttemptRef.current += 1;
          const delay = Math.min(retryDelayRef.current * 2 ** (reconnectAttemptRef.current - 1), MAX_RETRY_DELAY);

          retryTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };
    } catch (err) {
      setConnectionState("error");
      setError(err instanceof Error ? err : new Error("Failed to create EventSource"));
    }
  }, [buildUrl, autoReconnect, workOrderId]);

  /**
   * Manually trigger reconnection
   */
  const reconnect = useCallback(() => {
    // Cancel any pending retry
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    // Reset retry state
    retryDelayRef.current = INITIAL_RETRY_DELAY;
    reconnectAttemptRef.current = 0;

    connect();
  }, [connect]);

  /**
   * Connect when workOrderId becomes available
   */
  useEffect(() => {
    if (workOrderId) {
      connect();
    }

    // Cleanup on unmount or when workOrderId changes
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      setConnectionState("disconnected");
    };
  }, [workOrderId, connect]);

  /**
   * Reconnect when filters change
   */
  useEffect(() => {
    if (workOrderId && eventSourceRef.current) {
      // Close existing connection and reconnect with new filters
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      connect();
    }
  }, [workOrderId, connect]);

  const isConnected = connectionState === "connected";

  return {
    logs,
    connectionState,
    isConnected,
    error,
    reconnect,
    clearLogs,
  };
}
