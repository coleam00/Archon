/**
 * Agent Work Order Detail View
 *
 * Detailed view of a single agent work order showing progress, step history,
 * logs, and full metadata.
 */

import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";
import { RealTimeStats } from "../components/RealTimeStats";
import { StepHistoryCard } from "../components/StepHistoryCard";
import { WorkflowStepButton } from "../components/WorkflowStepButton";
import { useStepHistory, useWorkOrder } from "../hooks/useAgentWorkOrderQueries";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";
import type { WorkflowStep } from "../types";

/**
 * All available workflow steps in execution order
 */
const ALL_WORKFLOW_STEPS: WorkflowStep[] = [
  "create-branch",
  "planning",
  "execute",
  "prp-review",
  "commit",
  "create-pr",
];

export function AgentWorkOrderDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showDetails, setShowDetails] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const { data: workOrder, isLoading: isLoadingWorkOrder, isError: isErrorWorkOrder } = useWorkOrder(id);
  const { data: stepHistory, isLoading: isLoadingSteps, isError: isErrorSteps } = useStepHistory(id);

  // Get live progress from SSE for total steps count
  const liveProgress = useAgentWorkOrdersStore((s) => (id ? s.liveProgress[id] : undefined));

  /**
   * Toggle step expansion
   */
  const toggleStepExpansion = (stepId: string) => {
    setExpandedSteps((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(stepId)) {
        newSet.delete(stepId);
      } else {
        newSet.add(stepId);
      }
      return newSet;
    });
  };

  if (isLoadingWorkOrder || isLoadingSteps) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/3" />
          <div className="h-40 bg-gray-200 dark:bg-gray-800 rounded" />
          <div className="h-60 bg-gray-200 dark:bg-gray-800 rounded" />
        </div>
      </div>
    );
  }

  if (isErrorWorkOrder || isErrorSteps || !workOrder || !stepHistory) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center py-12">
          <p className="text-red-400 mb-4">Failed to load work order</p>
          <Button onClick={() => navigate("/agent-work-orders")}>Back to List</Button>
        </div>
      </div>
    );
  }

  // Additional safety check for repository_url
  const repoName = workOrder?.repository_url?.split("/").slice(-2).join("/") || "Unknown Repository";

  return (
    <div className="space-y-6">
      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => navigate("/agent-work-orders")}
          className="text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          Work Orders
        </button>
        <span className="text-gray-400 dark:text-gray-600">/</span>
        <button
          type="button"
          onClick={() => navigate("/agent-work-orders")}
          className="text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          {repoName}
        </button>
        <span className="text-gray-400 dark:text-gray-600">/</span>
        <span className="text-gray-900 dark:text-white">{workOrder.agent_work_order_id}</span>
      </div>

      {/* Real-Time Execution Stats */}
      <RealTimeStats workOrderId={id} />

      {/* Workflow Progress Bar */}
      <Card blur="md" transparency="light" edgePosition="top" edgeColor="cyan" size="lg" className="overflow-visible">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{repoName}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDetails(!showDetails)}
            className="text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
            aria-label={showDetails ? "Hide details" : "Show details"}
          >
            {showDetails ? (
              <ChevronUp className="w-4 h-4 mr-1" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-4 h-4 mr-1" aria-hidden="true" />
            )}
            Details
          </Button>
        </div>

        {/* Workflow Steps - Show all steps, highlight completed */}
        <div className="flex items-center justify-center gap-0">
          {ALL_WORKFLOW_STEPS.map((stepName, index) => {
            // Find if this step has been executed
            const executedStep = stepHistory.steps.find((s) => s.step === stepName);
            const isCompleted = executedStep?.success || false;
            // Mark as active if it's the last executed step and not successful (still running)
            const isActive =
              executedStep &&
              stepHistory.steps[stepHistory.steps.length - 1]?.step === stepName &&
              !executedStep.success;

            return (
              <div key={stepName} className="flex items-center">
                <WorkflowStepButton
                  isCompleted={isCompleted}
                  isActive={isActive}
                  stepName={stepName}
                  color="cyan"
                  size={50}
                />
                {/* Connecting Line - only show between steps */}
                {index < ALL_WORKFLOW_STEPS.length - 1 && (
                  <div className="relative flex-shrink-0" style={{ width: "80px", height: "50px" }}>
                    <div
                      className={
                        isCompleted
                          ? "absolute top-1/2 left-0 right-0 h-[2px] border-t-2 border-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
                          : "absolute top-1/2 left-0 right-0 h-[2px] border-t-2 border-gray-600 dark:border-gray-700"
                      }
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Collapsible Details Section */}
        <AnimatePresence>
          {showDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                height: {
                  duration: 0.3,
                  ease: [0.04, 0.62, 0.23, 0.98],
                },
                opacity: {
                  duration: 0.2,
                  ease: "easeInOut",
                },
              }}
              style={{ overflow: "hidden" }}
              className="mt-6"
            >
              <motion.div
                initial={{ y: -20 }}
                animate={{ y: 0 }}
                exit={{ y: -20 }}
                transition={{
                  duration: 0.2,
                  ease: "easeOut",
                }}
                className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-gray-200/50 dark:border-gray-700/30"
              >
                {/* Left Column - Details */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Details
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Status</p>
                        <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mt-0.5">
                          {workOrder.status.charAt(0).toUpperCase() + workOrder.status.slice(1)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Sandbox Type</p>
                        <p className="text-sm font-medium text-gray-900 dark:text-white mt-0.5">
                          {workOrder.sandbox_type}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Repository</p>
                        <a
                          href={workOrder.repository_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-cyan-600 dark:text-cyan-400 hover:underline inline-flex items-center gap-1 mt-0.5"
                        >
                          {workOrder.repository_url}
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      </div>
                      {workOrder.git_branch_name && (
                        <div>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Branch</p>
                          <p className="text-sm font-medium font-mono text-gray-900 dark:text-white mt-0.5">
                            {workOrder.git_branch_name}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Work Order ID</p>
                        <p className="text-sm font-medium font-mono text-gray-700 dark:text-gray-300 mt-0.5">
                          {workOrder.agent_work_order_id}
                        </p>
                      </div>
                      {workOrder.agent_session_id && (
                        <div>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Session ID</p>
                          <p className="text-sm font-medium font-mono text-gray-700 dark:text-gray-300 mt-0.5">
                            {workOrder.agent_session_id}
                          </p>
                        </div>
                      )}
                      {workOrder.github_pull_request_url && (
                        <div>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Pull Request</p>
                          <a
                            href={workOrder.github_pull_request_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-cyan-600 dark:text-cyan-400 hover:underline inline-flex items-center gap-1 mt-0.5"
                          >
                            View PR
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          </a>
                        </div>
                      )}
                      {workOrder.github_issue_number && (
                        <div>
                          <p className="text-xs text-gray-500 dark:text-gray-400">GitHub Issue</p>
                          <p className="text-sm font-medium text-gray-900 dark:text-white mt-0.5">
                            #{workOrder.github_issue_number}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right Column - Statistics */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Statistics
                    </h4>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Commits</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">
                          {workOrder.git_commit_count}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Files Changed</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">
                          {workOrder.git_files_changed}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Steps Completed</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">
                          {stepHistory.steps.filter((s) => s.success).length} / {liveProgress?.totalSteps ?? stepHistory.steps.length}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* Step History */}
      <div className="space-y-4">
        {stepHistory.steps.map((step, index) => {
          const stepId = `${step.step}-${index}`;
          const isExpanded = expandedSteps.has(stepId);

          return (
            <StepHistoryCard
              key={stepId}
              step={{
                id: stepId,
                stepName: step.step,
                timestamp: new Date(step.timestamp).toLocaleString(),
                output: step.output || "No output",
                session: step.session_id || "Unknown session",
                collapsible: true,
                isHumanInLoop: false,
              }}
              isExpanded={isExpanded}
              onToggle={() => toggleStepExpansion(stepId)}
            />
          );
        })}
      </div>
    </div>
  );
}
