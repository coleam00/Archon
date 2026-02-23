import { useEffect, useRef, useState } from "react";
import { telemetryService } from "../services/telemetryService";
import type { TelemetrySnapshot } from "../types";

export type WsConnectionStatus = "connecting" | "connected" | "reconnecting" | "polling";

// Exponential backoff delays in ms: 3s → 10s → 30s (cap)
const BACKOFF_DELAYS = [3_000, 10_000, 30_000] as const;
const POLL_INTERVAL_MS = 5_000;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  // Backend runs on 8181; Vite dev proxy only covers /api so we target backend directly
  const port = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_PORT ?? "8181";
  return `${proto}//${host}:${port}/ws/telemetry`;
}

export interface UseTelemetrySocketResult {
  snapshot: TelemetrySnapshot | null;
  status: WsConnectionStatus;
}

/**
 * Manages a single shared WebSocket connection to /ws/telemetry.
 * Merges partial server-push updates into the local TelemetrySnapshot state.
 * Falls back to 5s HTTP polling when WebSocket is unavailable, and retries
 * WS with exponential backoff (3s → 10s → 30s cap).
 */
export function useTelemetrySocket(): UseTelemetrySocketResult {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [status, setStatus] = useState<WsConnectionStatus>("connecting");

  // Stable ref so inner closures always call the latest setter
  const setSnapshotRef = useRef(setSnapshot);
  const setStatusRef = useRef(setStatus);

  useEffect(() => {
    let mounted = true;
    let ws: WebSocket | null = null;
    let attemptCount = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function stopPolling() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function fetchOnce() {
      telemetryService
        .getSnapshot()
        .then((data) => {
          if (mounted) setSnapshotRef.current(data);
        })
        .catch(() => {
          // Silently ignore — WS reconnect will take over eventually
        });
    }

    function startPolling() {
      if (pollTimer !== null) return;
      setStatusRef.current("polling");
      fetchOnce();
      pollTimer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    }

    function connect() {
      if (!mounted) return;
      setStatusRef.current(attemptCount === 0 ? "connecting" : "reconnecting");

      try {
        ws = new WebSocket(getWsUrl());

        ws.onopen = () => {
          if (!mounted) {
            ws?.close();
            return;
          }
          attemptCount = 0;
          setStatusRef.current("connected");
          stopPolling();
        };

        ws.onmessage = (event: MessageEvent<string>) => {
          if (!mounted) return;
          try {
            const partial = JSON.parse(event.data) as Partial<TelemetrySnapshot>;
            setSnapshotRef.current((prev) =>
              prev !== null ? { ...prev, ...partial } : (partial as TelemetrySnapshot),
            );
          } catch {
            // Ignore malformed frames
          }
        };

        ws.onclose = () => {
          if (!mounted) return;
          ws = null;
          const delay = BACKOFF_DELAYS[Math.min(attemptCount, BACKOFF_DELAYS.length - 1)];
          attemptCount++;
          // Fall back to polling while waiting to reconnect
          startPolling();
          reconnectTimer = setTimeout(connect, delay);
        };

        ws.onerror = () => {
          // onerror is always followed by onclose — close will handle reconnect
          ws?.close();
        };
      } catch {
        // WebSocket constructor threw (e.g., invalid URL in test env)
        startPolling();
      }
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      stopPolling();
      if (ws !== null) {
        // Null out onclose to prevent the reconnect loop on intentional unmount
        ws.onclose = null;
        ws.close();
        ws = null;
      }
    };
  }, []); // intentionally empty — runs once, self-manages reconnect lifecycle

  return { snapshot, status };
}
