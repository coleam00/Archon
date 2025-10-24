/**
 * WorkOrderCard Component
 *
 * Displays a summary card for a single work order with status badge,
 * repository info, and key metadata.
 */

import { formatDistanceToNow } from "date-fns";
import type { AgentWorkOrder } from "../types";

interface WorkOrderCardProps {
  /** Work order to display */
  workOrder: AgentWorkOrder;
  /** Callback when card is clicked */
  onClick?: () => void;
}

const STATUS_STYLES: Record<AgentWorkOrder["status"], { bg: string; text: string; label: string }> = {
  pending: {
    bg: "bg-gray-700",
    text: "text-gray-300",
    label: "Pending",
  },
  running: {
    bg: "bg-blue-600",
    text: "text-blue-100",
    label: "Running",
  },
  completed: {
    bg: "bg-green-600",
    text: "text-green-100",
    label: "Completed",
  },
  failed: {
    bg: "bg-red-600",
    text: "text-red-100",
    label: "Failed",
  },
};

export function WorkOrderCard({ workOrder, onClick }: WorkOrderCardProps) {
  const statusStyle = STATUS_STYLES[workOrder.status];
  const repoName = workOrder.repository_url.split("/").slice(-2).join("/");
  const timeAgo = formatDistanceToNow(new Date(workOrder.created_at), {
    addSuffix: true,
  });

  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className="bg-gray-800 bg-opacity-50 backdrop-blur-sm border border-gray-700 rounded-lg p-4 hover:border-blue-500 transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-white truncate">{repoName}</h3>
          <p className="text-sm text-gray-400 mt-1">{timeAgo}</p>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text} ml-3`}>
          {statusStyle.label}
        </div>
      </div>

      {workOrder.current_phase && (
        <div className="mb-2">
          <p className="text-sm text-gray-300">
            Phase: <span className="text-blue-400">{workOrder.current_phase}</span>
          </p>
        </div>
      )}

      {workOrder.git_branch_name && (
        <div className="mb-2">
          <p className="text-sm text-gray-300">
            Branch: <span className="text-cyan-400 font-mono text-xs">{workOrder.git_branch_name}</span>
          </p>
        </div>
      )}

      {workOrder.github_pull_request_url && (
        <div className="mb-2">
          <a
            href={workOrder.github_pull_request_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-400 hover:text-blue-300 underline"
            onClick={(e) => e.stopPropagation()}
          >
            View Pull Request
          </a>
        </div>
      )}

      {workOrder.error_message && (
        <div className="mt-2 p-2 bg-red-900 bg-opacity-30 border border-red-700 rounded text-xs text-red-300">
          {workOrder.error_message.length > 100
            ? `${workOrder.error_message.substring(0, 100)}...`
            : workOrder.error_message}
        </div>
      )}

      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
        {workOrder.git_commit_count > 0 && <span>{workOrder.git_commit_count} commits</span>}
        {workOrder.git_files_changed > 0 && <span>{workOrder.git_files_changed} files changed</span>}
      </div>
    </div>
  );
}
