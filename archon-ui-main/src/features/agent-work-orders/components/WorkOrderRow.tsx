/**
 * Work Order Row Component
 *
 * Individual table row for a work order with status indicator, start/details buttons,
 * and expandable real-time stats section.
 */

import { ChevronDown, ChevronUp, Eye, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/features/ui/primitives/button";
import { type PillColor, StatPill } from "@/features/ui/primitives/pill";
import { cn } from "@/features/ui/primitives/styles";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";
import type { AgentWorkOrder } from "../types";
import { RealTimeStats } from "./RealTimeStats";

export interface WorkOrderRowProps {
  /** Work order data */
  workOrder: AgentWorkOrder;

  /** Repository display name (from configured repository) */
  repositoryDisplayName?: string;

  /** Row index for alternating backgrounds */
  index: number;

  /** Callback when start button is clicked */
  onStart: (id: string) => void;

  /** Whether this row was just started (auto-expand) */
  wasJustStarted?: boolean;
}

/**
 * Status color configuration
 * Static lookup to avoid dynamic class construction
 */
interface StatusConfig {
  color: PillColor;
  edge: string;
  glow: string;
  label: string;
  stepNumber: number;
}

const STATUS_COLORS: Record<string, StatusConfig> = {
  pending: {
    color: "pink",
    edge: "bg-pink-500 dark:bg-pink-400",
    glow: "rgba(236,72,153,0.5)",
    label: "Pending",
    stepNumber: 0,
  },
  running: {
    color: "cyan",
    edge: "bg-cyan-500 dark:bg-cyan-400",
    glow: "rgba(34,211,238,0.5)",
    label: "Running",
    stepNumber: 1,
  },
  completed: {
    color: "green",
    edge: "bg-green-500 dark:bg-green-400",
    glow: "rgba(34,197,94,0.5)",
    label: "Completed",
    stepNumber: 5,
  },
  failed: {
    color: "orange",
    edge: "bg-orange-500 dark:bg-orange-400",
    glow: "rgba(249,115,22,0.5)",
    label: "Failed",
    stepNumber: 0,
  },
} as const;

/**
 * Get status configuration with fallback
 */
function getStatusConfig(status: string): StatusConfig {
  return STATUS_COLORS[status] || STATUS_COLORS.pending;
}

export function WorkOrderRow({
  workOrder: cachedWorkOrder,
  repositoryDisplayName,
  index,
  onStart,
  wasJustStarted = false,
}: WorkOrderRowProps) {
  const [isExpanded, setIsExpanded] = useState(wasJustStarted);
  const navigate = useNavigate();

  // Subscribe to live progress from Zustand SSE slice
  const liveProgress = useAgentWorkOrdersStore((s) => s.liveProgress[cachedWorkOrder.agent_work_order_id]);

  // Merge: SSE data overrides cached data
  const workOrder = {
    ...cachedWorkOrder,
    ...(liveProgress?.status && { status: liveProgress.status as AgentWorkOrder["status"] }),
  };

  const statusConfig = getStatusConfig(workOrder.status);

  const handleStartClick = () => {
    setIsExpanded(true); // Auto-expand when started
    onStart(workOrder.agent_work_order_id);
  };

  const handleDetailsClick = () => {
    navigate(`/agent-work-orders/${workOrder.agent_work_order_id}`);
  };

  const isPending = workOrder.status === "pending";
  const canExpand = !isPending; // Only non-pending rows can be expanded

  // Use display name if available, otherwise extract from URL
  const displayRepo = repositoryDisplayName || workOrder.repository_url.split("/").slice(-2).join("/");

  return (
    <>
      {/* Main row */}
      <tr
        className={cn(
          "group transition-all duration-200",
          index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
          "hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20",
          "border-b border-gray-200 dark:border-gray-800",
        )}
      >
        {/* Status indicator - glowing circle with optional collapse button */}
        <td className="px-3 py-2 w-12">
          <div className="flex items-center justify-center gap-1">
            {canExpand && (
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                aria-label={isExpanded ? "Collapse details" : "Expand details"}
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronUp className="w-3 h-3 text-gray-600 dark:text-gray-400" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-gray-600 dark:text-gray-400" aria-hidden="true" />
                )}
              </button>
            )}
            <div
              className={cn("w-3 h-3 rounded-full", statusConfig.edge)}
              style={{ boxShadow: `0 0 8px ${statusConfig.glow}` }}
            />
          </div>
        </td>

        {/* Work Order ID */}
        <td className="px-4 py-2">
          <span className="font-mono text-sm text-gray-700 dark:text-gray-300">{workOrder.agent_work_order_id}</span>
        </td>

        {/* Repository */}
        <td className="px-4 py-2 w-40">
          <span className="text-sm text-gray-900 dark:text-white">{displayRepo}</span>
        </td>

        {/* Branch */}
        <td className="px-4 py-2">
          <p className="text-sm text-gray-900 dark:text-white line-clamp-2">
            {workOrder.git_branch_name || <span className="text-gray-400 dark:text-gray-500">-</span>}
          </p>
        </td>

        {/* Status Badge - using StatPill */}
        <td className="px-4 py-2 w-32">
          <StatPill color={statusConfig.color} value={statusConfig.label} size="sm" />
        </td>

        {/* Actions */}
        <td className="px-4 py-2 w-32">
          {isPending ? (
            <Button
              onClick={handleStartClick}
              size="xs"
              variant="green"
              className="w-full text-xs"
              aria-label="Start work order"
            >
              <Play className="w-3 h-3 mr-1" aria-hidden="true" />
              Start
            </Button>
          ) : (
            <Button
              onClick={handleDetailsClick}
              size="xs"
              variant="blue"
              className="w-full text-xs"
              aria-label="View work order details"
            >
              <Eye className="w-3 h-3 mr-1" aria-hidden="true" />
              Details
            </Button>
          )}
        </td>
      </tr>

      {/* Expanded row with real-time stats - shows live or historical data */}
      {isExpanded && canExpand && (
        <tr
          className={cn(
            index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
            "border-b border-gray-200 dark:border-gray-800",
          )}
        >
          <td colSpan={6} className="px-4 py-4">
            <RealTimeStats workOrderId={workOrder.agent_work_order_id} />
          </td>
        </tr>
      )}
    </>
  );
}
