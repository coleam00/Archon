/**
 * StepHistoryTimeline Component
 *
 * Displays a vertical timeline of step execution history with status,
 * duration, and error messages.
 */

import { formatDistanceToNow } from "date-fns";
import type { StepExecutionResult } from "../types";

interface StepHistoryTimelineProps {
  /** Array of executed steps */
  steps: StepExecutionResult[];
  /** Current phase being executed */
  currentPhase: string | null;
}

const STEP_LABELS: Record<string, string> = {
  "create-branch": "Create Branch",
  planning: "Planning",
  execute: "Execute",
  commit: "Commit",
  "create-pr": "Create PR",
  "prp-review": "PRP Review",
};

export function StepHistoryTimeline({ steps, currentPhase }: StepHistoryTimelineProps) {
  if (steps.length === 0) {
    return <div className="text-center py-8 text-gray-400">No steps executed yet</div>;
  }

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  };

  return (
    <div className="space-y-4">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        const isCurrent = currentPhase === step.step;
        const timeAgo = formatDistanceToNow(new Date(step.timestamp), {
          addSuffix: true,
        });

        return (
          <div key={`${step.step}-${step.timestamp}`} className="flex gap-4">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${
                  step.success ? "bg-green-500 border-green-400" : "bg-red-500 border-red-400"
                } ${isCurrent ? "animate-pulse" : ""}`}
              >
                {step.success ? (
                  <span className="text-white text-sm">✓</span>
                ) : (
                  <span className="text-white text-sm">✗</span>
                )}
              </div>
              {!isLast && (
                <div className={`w-0.5 flex-1 min-h-[40px] ${step.success ? "bg-green-500" : "bg-red-500"}`} />
              )}
            </div>

            <div className="flex-1 pb-4">
              <div className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="text-white font-semibold">{STEP_LABELS[step.step] || step.step}</h4>
                    <p className="text-sm text-gray-400 mt-1">{step.agent_name}</p>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-xs font-medium px-2 py-1 rounded ${
                        step.success
                          ? "bg-green-900 bg-opacity-30 text-green-400"
                          : "bg-red-900 bg-opacity-30 text-red-400"
                      }`}
                    >
                      {formatDuration(step.duration_seconds)}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{timeAgo}</p>
                  </div>
                </div>

                {step.output && (
                  <div className="mt-3 p-3 bg-gray-900 bg-opacity-50 rounded border border-gray-700">
                    <p className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                      {step.output.length > 500 ? `${step.output.substring(0, 500)}...` : step.output}
                    </p>
                  </div>
                )}

                {step.error_message && (
                  <div className="mt-3 p-3 bg-red-900 bg-opacity-30 border border-red-700 rounded">
                    <p className="text-sm text-red-300 font-mono whitespace-pre-wrap">{step.error_message}</p>
                  </div>
                )}

                {step.session_id && <div className="mt-2 text-xs text-gray-500">Session: {step.session_id}</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
