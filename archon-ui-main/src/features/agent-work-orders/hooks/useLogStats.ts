import { useMemo } from "react";
import type { LogEntry } from "../types";

export interface LogStats {
  /** Current step being executed */
  currentStep: string | null;

  /** Current step number (e.g., 2 from "2/5") */
  currentStepNumber: number | null;

  /** Total steps */
  totalSteps: number | null;

  /** Progress percentage (0-100) */
  progressPct: number | null;

  /** Elapsed time in seconds */
  elapsedSeconds: number | null;

  /** Last activity timestamp */
  lastActivity: string | null;

  /** Current substep activity description */
  currentActivity: string | null;

  /** Whether workflow has started */
  hasStarted: boolean;

  /** Whether workflow has completed */
  hasCompleted: boolean;

  /** Whether workflow has failed */
  hasFailed: boolean;
}

/**
 * Extract real-time metrics from log entries
 *
 * Analyzes logs to derive current execution status, progress, and activity.
 * Uses memoization to avoid recomputing on every render.
 */
export function useLogStats(logs: LogEntry[]): LogStats {
  return useMemo(() => {
    if (logs.length === 0) {
      return {
        currentStep: null,
        currentStepNumber: null,
        totalSteps: null,
        progressPct: null,
        elapsedSeconds: null,
        lastActivity: null,
        currentActivity: null,
        hasStarted: false,
        hasCompleted: false,
        hasFailed: false,
      };
    }

    // Find most recent log entry
    const latestLog = logs[logs.length - 1];

    // Find most recent step_started event
    let currentStep: string | null = null;
    let currentStepNumber: number | null = null;
    let totalSteps: number | null = null;

    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (log.event === "step_started" && log.step) {
        currentStep = log.step;
        currentStepNumber = log.step_number ?? null;
        totalSteps = log.total_steps ?? null;
        break;
      }
    }

    // Find most recent progress data
    let progressPct: number | null = null;
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (log.progress_pct !== undefined && log.progress_pct !== null) {
        progressPct = log.progress_pct;
        break;
      }
    }

    // Find most recent elapsed time
    let elapsedSeconds: number | null = null;
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (log.elapsed_seconds !== undefined && log.elapsed_seconds !== null) {
        elapsedSeconds = log.elapsed_seconds;
        break;
      }
    }

    // Current activity is the latest event description
    const currentActivity = latestLog.event || null;

    // Last activity timestamp
    const lastActivity = latestLog.timestamp;

    // Check for workflow lifecycle events
    const hasStarted = logs.some((log) => log.event === "workflow_started" || log.event === "step_started");

    const hasCompleted = logs.some((log) => log.event === "workflow_completed" || log.event === "agent_work_order_completed");

    const hasFailed = logs.some(
      (log) => log.event === "workflow_failed" || log.event === "agent_work_order_failed" || log.level === "error",
    );

    return {
      currentStep,
      currentStepNumber,
      totalSteps,
      progressPct,
      elapsedSeconds,
      lastActivity,
      currentActivity,
      hasStarted,
      hasCompleted,
      hasFailed,
    };
  }, [logs]);
}
