/**
 * WorkOrderList Component
 *
 * Displays a filterable list of agent work orders with status filters and search.
 */

import { useMemo, useState } from "react";
import { useWorkOrders } from "../hooks/useAgentWorkOrderQueries";
import type { AgentWorkOrderStatus } from "../types";
import { WorkOrderCard } from "./WorkOrderCard";

interface WorkOrderListProps {
  /** Callback when a work order card is clicked */
  onWorkOrderClick?: (workOrderId: string) => void;
}

const STATUS_OPTIONS: Array<{
  value: AgentWorkOrderStatus | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export function WorkOrderList({ onWorkOrderClick }: WorkOrderListProps) {
  const [statusFilter, setStatusFilter] = useState<AgentWorkOrderStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const queryFilter = statusFilter === "all" ? undefined : statusFilter;
  const { data: workOrders, isLoading, isError } = useWorkOrders(queryFilter);

  const filteredWorkOrders = useMemo(() => {
    if (!workOrders) return [];

    return workOrders.filter((wo) => {
      const matchesSearch =
        searchQuery === "" ||
        wo.repository_url.toLowerCase().includes(searchQuery.toLowerCase()) ||
        wo.agent_work_order_id.toLowerCase().includes(searchQuery.toLowerCase());

      return matchesSearch;
    });
  }, [workOrders, searchQuery]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div
            key={`skeleton-${
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton loading
              i
            }`}
            className="h-40 bg-gray-800 bg-opacity-50 rounded-lg animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400">Failed to load work orders</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by repository or ID..."
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AgentWorkOrderStatus | "all")}
            className="w-full sm:w-auto px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filteredWorkOrders.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400">{searchQuery ? "No work orders match your search" : "No work orders found"}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredWorkOrders.map((workOrder) => (
            <WorkOrderCard
              key={workOrder.agent_work_order_id}
              workOrder={workOrder}
              onClick={() => onWorkOrderClick?.(workOrder.agent_work_order_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
