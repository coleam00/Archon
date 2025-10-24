/**
 * WorkOrderProgressBar Component
 *
 * Displays visual progress of a work order through its workflow steps.
 * Shows 5 steps with visual indicators for pending, running, success, and failed states.
 */

import type { StepExecutionResult, WorkflowStep } from "../types";

interface WorkOrderProgressBarProps {
  /** Array of executed steps */
  steps: StepExecutionResult[];
  /** Current phase/step being executed */
  currentPhase: string | null;
}

const WORKFLOW_STEPS: WorkflowStep[] = ["create-branch", "planning", "execute", "commit", "create-pr"];

const STEP_LABELS: Record<WorkflowStep, string> = {
  "create-branch": "Create Branch",
  planning: "Planning",
  execute: "Execute",
  commit: "Commit",
  "create-pr": "Create PR",
  "prp-review": "PRP Review",
};

export function WorkOrderProgressBar({ steps, currentPhase }: WorkOrderProgressBarProps) {
  const getStepStatus = (stepName: WorkflowStep): "pending" | "running" | "success" | "failed" => {
    const stepResult = steps.find((s) => s.step === stepName);

    if (!stepResult) {
      return currentPhase === stepName ? "running" : "pending";
    }

    return stepResult.success ? "success" : "failed";
  };

  const getStepStyles = (status: string): string => {
    switch (status) {
      case "success":
        return "bg-green-500 border-green-400 text-white";
      case "failed":
        return "bg-red-500 border-red-400 text-white";
      case "running":
        return "bg-blue-500 border-blue-400 text-white animate-pulse";
      default:
        return "bg-gray-700 border-gray-600 text-gray-400";
    }
  };

  const getConnectorStyles = (status: string): string => {
    switch (status) {
      case "success":
        return "bg-green-500";
      case "failed":
        return "bg-red-500";
      case "running":
        return "bg-blue-500";
      default:
        return "bg-gray-700";
    }
  };

  return (
    <div className="w-full py-4">
      <div className="flex items-center justify-between">
        {WORKFLOW_STEPS.map((step, index) => {
          const status = getStepStatus(step);
          const isLast = index === WORKFLOW_STEPS.length - 1;

          return (
            <div key={step} className="flex items-center flex-1">
              <div className="flex flex-col items-center">
                <div
                  className={`w-10 h-10 rounded-full border-2 flex items-center justify-center font-semibold transition-all ${getStepStyles(status)}`}
                >
                  {status === "success" ? (
                    <span>✓</span>
                  ) : status === "failed" ? (
                    <span>✗</span>
                  ) : status === "running" ? (
                    <span className="text-sm">•••</span>
                  ) : (
                    <span className="text-xs">{index + 1}</span>
                  )}
                </div>
                <div className="mt-2 text-xs text-center text-gray-300 max-w-[80px]">{STEP_LABELS[step]}</div>
              </div>
              {!isLast && <div className={`flex-1 h-1 mx-2 transition-all ${getConnectorStyles(status)}`} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
