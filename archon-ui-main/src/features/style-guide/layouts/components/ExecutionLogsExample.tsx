import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { cn } from "@/features/ui/primitives/styles";
import { Switch } from "@/features/ui/primitives/switch";

interface ExecutionLogsExampleProps {
  /** Work order status to generate appropriate mock logs */
  status: string;
}

interface MockLog {
  timestamp: string;
  level: "info" | "warning" | "error" | "debug";
  event: string;
  step?: string;
  progress?: string;
}

/**
 * Get color class for log level badge - STATIC lookup
 */
const logLevelColors: Record<string, string> = {
  info: "bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-400/30",
  warning: "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-400/30",
  error: "bg-red-500/20 text-red-600 dark:text-red-400 border-red-400/30",
  debug: "bg-gray-500/20 text-gray-600 dark:text-gray-400 border-gray-400/30",
};

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const logTime = new Date(timestamp).getTime();
  const diffSeconds = Math.floor((now - logTime) / 1000);

  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  return `${Math.floor(diffSeconds / 3600)}h ago`;
}

/**
 * Individual log entry component
 */
function LogEntryRow({ log }: { log: MockLog }) {
  const colorClass = logLevelColors[log.level] || logLevelColors.debug;

  return (
    <div className="flex items-start gap-2 py-1 px-2 hover:bg-white/5 dark:hover:bg-black/20 rounded font-mono text-sm">
      <span className="text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
        {formatRelativeTime(log.timestamp)}
      </span>
      <span className={cn("px-1.5 py-0.5 rounded text-xs border uppercase whitespace-nowrap", colorClass)}>
        {log.level}
      </span>
      {log.step && <span className="text-cyan-600 dark:text-cyan-400 text-xs whitespace-nowrap">[{log.step}]</span>}
      <span className="text-gray-900 dark:text-gray-300 flex-1">{log.event}</span>
      {log.progress && (
        <span className="text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">{log.progress}</span>
      )}
    </div>
  );
}

export function ExecutionLogsExample({ status }: ExecutionLogsExampleProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<string>("all");

  // Generate mock logs based on status
  const generateMockLogs = (): MockLog[] => {
    const now = Date.now();
    const baseTime = now - 300000; // 5 minutes ago

    const logs: MockLog[] = [
      { timestamp: new Date(baseTime).toISOString(), level: "info", event: "workflow_started" },
      { timestamp: new Date(baseTime + 1000).toISOString(), level: "info", event: "sandbox_setup_started" },
      {
        timestamp: new Date(baseTime + 3000).toISOString(),
        level: "info",
        event: "repository_cloned",
        step: "setup",
      },
      { timestamp: new Date(baseTime + 5000).toISOString(), level: "info", event: "sandbox_setup_completed" },
    ];

    if (status !== "pending") {
      logs.push(
        {
          timestamp: new Date(baseTime + 10000).toISOString(),
          level: "info",
          event: "step_started",
          step: "create-branch",
          progress: "1/5",
        },
        {
          timestamp: new Date(baseTime + 12000).toISOString(),
          level: "info",
          event: "agent_command_started",
          step: "create-branch",
        },
        {
          timestamp: new Date(baseTime + 45000).toISOString(),
          level: "info",
          event: "branch_created",
          step: "create-branch",
        },
      );
    }

    if (status === "plan" || status === "execute" || status === "commit" || status === "create_pr") {
      logs.push(
        {
          timestamp: new Date(baseTime + 60000).toISOString(),
          level: "info",
          event: "step_started",
          step: "planning",
          progress: "2/5",
        },
        {
          timestamp: new Date(baseTime + 120000).toISOString(),
          level: "debug",
          event: "analyzing_codebase",
          step: "planning",
        },
      );
    }

    return logs;
  };

  const mockLogs = generateMockLogs();
  const filteredLogs = levelFilter === "all" ? mockLogs : mockLogs.filter((log) => log.level === levelFilter);

  return (
    <div className="border border-white/10 dark:border-gray-700/30 rounded-lg overflow-hidden bg-black/20 dark:bg-white/5 backdrop-blur">
      {/* Header with controls */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 dark:border-gray-700/30 bg-gray-900/50 dark:bg-gray-800/30">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-gray-900 dark:text-gray-300">Execution Logs</span>

          {/* Live indicator */}
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-xs text-green-600 dark:text-green-400">Live</span>
          </div>

          <span className="text-xs text-gray-500 dark:text-gray-400">({filteredLogs.length} entries)</span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Level filter using proper Select primitive */}
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="w-32 h-8 text-xs" aria-label="Filter log level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>

          {/* Auto-scroll toggle using Switch primitive */}
          <div className="flex items-center gap-2">
            <label htmlFor="auto-scroll-toggle" className="text-xs text-gray-700 dark:text-gray-300">
              Auto-scroll:
            </label>
            <Switch
              id="auto-scroll-toggle"
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              aria-label="Toggle auto-scroll"
            />
            <span
              className={cn(
                "text-xs font-medium",
                autoScroll ? "text-cyan-600 dark:text-cyan-400" : "text-gray-500 dark:text-gray-400",
              )}
            >
              {autoScroll ? "ON" : "OFF"}
            </span>
          </div>

          {/* Clear logs button */}
          <Button variant="ghost" size="xs" aria-label="Clear logs">
            <Trash2 className="w-3 h-3" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Log content - scrollable area */}
      <div className="max-h-96 overflow-y-auto bg-black/40 dark:bg-black/20">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
            <p>No logs match the current filter</p>
          </div>
        ) : (
          <div className="p-2">
            {filteredLogs.map((log, index) => (
              <LogEntryRow key={`${log.timestamp}-${index}`} log={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
