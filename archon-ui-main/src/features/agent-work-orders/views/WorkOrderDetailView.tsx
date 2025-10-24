/**
 * WorkOrderDetailView Component
 *
 * Detailed view of a single agent work order showing progress, step history,
 * and full metadata.
 */

import { formatDistanceToNow, parseISO } from "date-fns";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/features/ui/primitives/button";
import { StepHistoryTimeline } from "../components/StepHistoryTimeline";
import { WorkOrderProgressBar } from "../components/WorkOrderProgressBar";
import { RealTimeStats } from "../components/RealTimeStats";
import { WorkOrderLogsPanel } from "../components/WorkOrderLogsPanel";
import { useStepHistory, useWorkOrder } from "../hooks/useAgentWorkOrderQueries";

export function WorkOrderDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: workOrder, isLoading: isLoadingWorkOrder, isError: isErrorWorkOrder } = useWorkOrder(id);

  const { data: stepHistory, isLoading: isLoadingSteps, isError: isErrorSteps } = useStepHistory(id);

  if (isLoadingWorkOrder || isLoadingSteps) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-800 rounded w-1/3" />
          <div className="h-40 bg-gray-800 rounded" />
          <div className="h-60 bg-gray-800 rounded" />
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

  // Extract repository name from URL with fallback
  const repoName = workOrder.repository_url
    ? workOrder.repository_url.split("/").slice(-2).join("/")
    : "Unknown Repository";

  // Safely handle potentially invalid dates
  // Backend returns UTC timestamps without 'Z' suffix, so we add it to ensure correct parsing
  const timeAgo = workOrder.created_at
    ? formatDistanceToNow(parseISO(workOrder.created_at.endsWith('Z') ? workOrder.created_at : `${workOrder.created_at}Z`), {
        addSuffix: true,
      })
    : "Unknown";

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <Button variant="ghost" onClick={() => navigate("/agent-work-orders")} className="mb-4">
          ← Back to List
        </Button>
        <h1 className="text-3xl font-bold text-white mb-2">{repoName}</h1>
        <p className="text-gray-400">Created {timeAgo}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Real-Time Stats Panel */}
          <RealTimeStats workOrderId={id} />

          <div className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Workflow Progress</h2>
            <WorkOrderProgressBar steps={stepHistory.steps} currentPhase={workOrder.current_phase} />
          </div>

          <div className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Step History</h2>
            <StepHistoryTimeline steps={stepHistory.steps} currentPhase={workOrder.current_phase} />
          </div>

          {/* Real-Time Logs Panel */}
          <WorkOrderLogsPanel workOrderId={id} />
        </div>

        <div className="space-y-6">
          <div className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Details</h2>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-gray-400">Status</p>
                <p
                  className={`text-lg font-semibold ${
                    workOrder.status === "completed"
                      ? "text-green-400"
                      : workOrder.status === "failed"
                        ? "text-red-400"
                        : workOrder.status === "running"
                          ? "text-blue-400"
                          : "text-gray-400"
                  }`}
                >
                  {workOrder.status.charAt(0).toUpperCase() + workOrder.status.slice(1)}
                </p>
              </div>

              <div>
                <p className="text-sm text-gray-400">Sandbox Type</p>
                <p className="text-white">{workOrder.sandbox_type}</p>
              </div>

              <div>
                <p className="text-sm text-gray-400">Repository</p>
                <a
                  href={workOrder.repository_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline break-all"
                >
                  {workOrder.repository_url}
                </a>
              </div>

              {workOrder.git_branch_name && (
                <div>
                  <p className="text-sm text-gray-400">Branch</p>
                  <p className="text-white font-mono text-sm">{workOrder.git_branch_name}</p>
                </div>
              )}

              {workOrder.github_pull_request_url && (
                <div>
                  <p className="text-sm text-gray-400">Pull Request</p>
                  <a
                    href={workOrder.github_pull_request_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline break-all"
                  >
                    View PR
                  </a>
                </div>
              )}

              {workOrder.github_issue_number && (
                <div>
                  <p className="text-sm text-gray-400">GitHub Issue</p>
                  <p className="text-white">#{workOrder.github_issue_number}</p>
                </div>
              )}

              <div>
                <p className="text-sm text-gray-400">Work Order ID</p>
                <p className="text-white font-mono text-xs break-all">{workOrder.agent_work_order_id}</p>
              </div>

              {workOrder.agent_session_id && (
                <div>
                  <p className="text-sm text-gray-400">Session ID</p>
                  <p className="text-white font-mono text-xs break-all">{workOrder.agent_session_id}</p>
                </div>
              )}
            </div>
          </div>

          {workOrder.error_message && (
            <div className="bg-red-900 bg-opacity-30 border border-red-700 rounded-lg p-6">
              <h2 className="text-xl font-semibold text-red-300 mb-4">Error</h2>
              <p className="text-sm text-red-300 font-mono whitespace-pre-wrap">{workOrder.error_message}</p>
            </div>
          )}

          <div className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Statistics</h2>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-gray-400">Commits</p>
                <p className="text-white text-lg font-semibold">{workOrder.git_commit_count}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">Files Changed</p>
                <p className="text-white text-lg font-semibold">{workOrder.git_files_changed}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">Steps Completed</p>
                <p className="text-white text-lg font-semibold">
                  {stepHistory.steps.filter((s) => s.success).length} / {stepHistory.steps.length}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
