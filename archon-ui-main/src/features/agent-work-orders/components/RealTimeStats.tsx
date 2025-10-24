/**
 * RealTimeStats Component
 *
 * Displays real-time execution statistics derived from log stream.
 * Shows current step, progress percentage, elapsed time, and current activity.
 */

import { Activity, Clock, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { useLogStats } from "../hooks/useLogStats";
import { useWorkOrderLogs } from "../hooks/useWorkOrderLogs";

interface RealTimeStatsProps {
  /** Work order ID to stream logs for */
  workOrderId: string | undefined;
}

/**
 * Format elapsed seconds to human-readable duration
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Format relative time from ISO timestamp
 */
function formatRelativeTime(timestamp: string): string {
  const now = new Date().getTime();
  const logTime = new Date(timestamp).getTime();
  const diffSeconds = Math.floor((now - logTime) / 1000);

  if (diffSeconds < 1) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  return `${Math.floor(diffSeconds / 3600)}h ago`;
}

export function RealTimeStats({ workOrderId }: RealTimeStatsProps) {
  const { logs } = useWorkOrderLogs({ workOrderId, autoReconnect: true });
  const stats = useLogStats(logs);

  // Live elapsed time that updates every second
  const [currentElapsedSeconds, setCurrentElapsedSeconds] = useState<number | null>(null);

  /**
   * Update elapsed time every second if work order is running
   */
  useEffect(() => {
    if (!stats.hasStarted || stats.hasCompleted || stats.hasFailed) {
      setCurrentElapsedSeconds(stats.elapsedSeconds);
      return;
    }

    // Start from last known elapsed time or 0
    const startTime = Date.now();
    const initialElapsed = stats.elapsedSeconds || 0;

    const interval = setInterval(() => {
      const additionalSeconds = Math.floor((Date.now() - startTime) / 1000);
      setCurrentElapsedSeconds(initialElapsed + additionalSeconds);
    }, 1000);

    return () => clearInterval(interval);
  }, [stats.hasStarted, stats.hasCompleted, stats.hasFailed, stats.elapsedSeconds]);

  // Don't render if no logs yet
  if (logs.length === 0 || !stats.hasStarted) {
    return null;
  }

  return (
    <div className="border border-white/10 rounded-lg p-4 bg-black/20 backdrop-blur">
      <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
        <Activity className="w-4 h-4" />
        Real-Time Execution
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Current Step */}
        <div className="space-y-1">
          <div className="text-xs text-gray-500 uppercase tracking-wide">Current Step</div>
          <div className="text-sm font-medium text-gray-200">
            {stats.currentStep || "Initializing..."}
            {stats.currentStepNumber !== null && stats.totalSteps !== null && (
              <span className="text-gray-500 ml-2">
                ({stats.currentStepNumber}/{stats.totalSteps})
              </span>
            )}
          </div>
        </div>

        {/* Progress */}
        <div className="space-y-1">
          <div className="text-xs text-gray-500 uppercase tracking-wide flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            Progress
          </div>
          {stats.progressPct !== null ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500 ease-out"
                    style={{ width: `${stats.progressPct}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-cyan-400">{stats.progressPct}%</span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Calculating...</div>
          )}
        </div>

        {/* Elapsed Time */}
        <div className="space-y-1">
          <div className="text-xs text-gray-500 uppercase tracking-wide flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Elapsed Time
          </div>
          <div className="text-sm font-medium text-gray-200">
            {currentElapsedSeconds !== null ? formatDuration(currentElapsedSeconds) : "0s"}
          </div>
        </div>
      </div>

      {/* Current Activity */}
      {stats.currentActivity && (
        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="flex items-start gap-2">
            <div className="text-xs text-gray-500 uppercase tracking-wide whitespace-nowrap">Latest Activity:</div>
            <div className="text-sm text-gray-300 flex-1">
              {stats.currentActivity}
              {stats.lastActivity && (
                <span className="text-gray-500 ml-2 text-xs">{formatRelativeTime(stats.lastActivity)}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Status Indicators */}
      <div className="mt-3 flex items-center gap-4 text-xs">
        {stats.hasCompleted && (
          <div className="flex items-center gap-1 text-green-400">
            <div className="w-2 h-2 bg-green-500 rounded-full" />
            <span>Completed</span>
          </div>
        )}
        {stats.hasFailed && (
          <div className="flex items-center gap-1 text-red-400">
            <div className="w-2 h-2 bg-red-500 rounded-full" />
            <span>Failed</span>
          </div>
        )}
        {!stats.hasCompleted && !stats.hasFailed && stats.hasStarted && (
          <div className="flex items-center gap-1 text-blue-400">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span>Running</span>
          </div>
        )}
      </div>
    </div>
  );
}
