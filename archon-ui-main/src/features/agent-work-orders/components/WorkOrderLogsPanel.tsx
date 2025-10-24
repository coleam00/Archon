/**
 * WorkOrderLogsPanel Component
 *
 * Terminal-style log viewer for real-time work order execution logs.
 * Connects to SSE endpoint and displays logs with filtering and auto-scroll capabilities.
 */

import { ChevronDown, ChevronUp, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { useWorkOrderLogs } from "../hooks/useWorkOrderLogs";
import type { LogEntry } from "../types";

interface WorkOrderLogsPanelProps {
  /** Work order ID to stream logs for */
  workOrderId: string | undefined;
}

/**
 * Get color class for log level badge
 */
function getLogLevelColor(level: string): string {
  switch (level) {
    case "info":
      return "bg-blue-500/20 text-blue-400 border-blue-400/30";
    case "warning":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-400/30";
    case "error":
      return "bg-red-500/20 text-red-400 border-red-400/30";
    case "debug":
      return "bg-gray-500/20 text-gray-400 border-gray-400/30";
    default:
      return "bg-gray-500/20 text-gray-400 border-gray-400/30";
  }
}

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const logTime = new Date(timestamp).getTime();
  const diffSeconds = Math.floor((now - logTime) / 1000);

  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

/**
 * Individual log entry component
 */
function LogEntryRow({ log }: { log: LogEntry }) {
  return (
    <div className="flex items-start gap-2 py-1 px-2 hover:bg-white/5 rounded font-mono text-sm">
      <span className="text-gray-500 text-xs whitespace-nowrap">{formatRelativeTime(log.timestamp)}</span>
      <span
        className={`px-1.5 py-0.5 rounded text-xs border uppercase whitespace-nowrap ${getLogLevelColor(log.level)}`}
      >
        {log.level}
      </span>
      {log.step && <span className="text-cyan-400 text-xs whitespace-nowrap">[{log.step}]</span>}
      <span className="text-gray-300 flex-1">{log.event}</span>
      {log.progress && <span className="text-gray-500 text-xs whitespace-nowrap">{log.progress}</span>}
    </div>
  );
}

export function WorkOrderLogsPanel({ workOrderId }: WorkOrderLogsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<"info" | "warning" | "error" | "debug" | undefined>(undefined);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const { logs, connectionState, isConnected, error, reconnect, clearLogs } = useWorkOrderLogs({
    workOrderId,
    levelFilter,
    autoReconnect: true,
  });

  /**
   * Auto-scroll to bottom when new logs arrive
   */
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [autoScroll]);

  /**
   * Detect manual scroll and disable auto-scroll
   */
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    } else if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    }
  }, [autoScroll]);

  /**
   * Filter logs by level if filter is active
   */
  const filteredLogs = levelFilter ? logs.filter((log) => log.level === levelFilter) : logs;

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden bg-black/20 backdrop-blur">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="font-semibold">Execution Logs</span>
          </button>

          {/* Connection status indicator */}
          <div className="flex items-center gap-2">
            {connectionState === "connecting" && <span className="text-xs text-gray-500">Connecting...</span>}
            {isConnected && (
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs text-green-400">Live</span>
              </div>
            )}
            {connectionState === "error" && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-red-500 rounded-full" />
                <span className="text-xs text-red-400">Disconnected</span>
              </div>
            )}
          </div>

          <span className="text-xs text-gray-500">({filteredLogs.length} entries)</span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Level filter */}
          <select
            value={levelFilter || ""}
            onChange={(e) => setLevelFilter((e.target.value as "info" | "warning" | "error" | "debug") || undefined)}
            className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-gray-300 hover:bg-white/10 transition-colors"
          >
            <option value="">All Levels</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="debug">Debug</option>
          </select>

          {/* Auto-scroll toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoScroll(!autoScroll)}
            className={autoScroll ? "text-cyan-400" : "text-gray-500"}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
          >
            Auto-scroll: {autoScroll ? "ON" : "OFF"}
          </Button>

          {/* Clear logs */}
          <Button variant="ghost" size="sm" onClick={clearLogs} title="Clear logs">
            <Trash2 className="w-4 h-4" />
          </Button>

          {/* Reconnect button */}
          {connectionState === "error" && (
            <Button variant="ghost" size="sm" onClick={reconnect} title="Reconnect">
              <RefreshCw className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Log content */}
      {isExpanded && (
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="max-h-96 overflow-y-auto bg-black/40"
          style={{ scrollBehavior: autoScroll ? "smooth" : "auto" }}
        >
          {/* Empty state */}
          {filteredLogs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              {connectionState === "connecting" && <p>Connecting to log stream...</p>}
              {connectionState === "error" && (
                <div className="text-center">
                  <p className="text-red-400">Failed to connect to log stream</p>
                  {error && <p className="text-xs text-gray-500 mt-1">{error.message}</p>}
                  <Button onClick={reconnect} className="mt-4">
                    Retry Connection
                  </Button>
                </div>
              )}
              {isConnected && logs.length === 0 && <p>No logs yet. Waiting for execution...</p>}
              {isConnected && logs.length > 0 && filteredLogs.length === 0 && <p>No logs match the current filter</p>}
            </div>
          )}

          {/* Log entries */}
          {filteredLogs.length > 0 && (
            <div className="p-2">
              {filteredLogs.map((log, index) => (
                <LogEntryRow key={`${log.timestamp}-${index}`} log={log} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
