/**
 * Work Order Table Component
 *
 * Displays work orders in a table with start buttons, status indicators,
 * and expandable real-time stats.
 */

import { useEffect, useRef, useState } from "react";
import { useRepositories } from "../hooks/useRepositoryQueries";
import type { AgentWorkOrder } from "../types";
import { WorkOrderRow } from "./WorkOrderRow";

export interface WorkOrderTableProps {
  /** Array of work orders to display */
  workOrders: AgentWorkOrder[];

  /** Optional repository ID to filter work orders */
  selectedRepositoryId?: string;

  /** Callback when start button is clicked */
  onStartWorkOrder: (id: string) => void;
}

/**
 * Enhanced work order with repository display name
 */
interface EnhancedWorkOrder extends AgentWorkOrder {
  repositoryDisplayName?: string;
}

export function WorkOrderTable({ workOrders, selectedRepositoryId, onStartWorkOrder }: WorkOrderTableProps) {
  const [justStartedId, setJustStartedId] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { data: repositories = [] } = useRepositories();

  // Create a map of repository URL to display name for quick lookup
  const repoUrlToDisplayName = repositories.reduce(
    (acc, repo) => {
      acc[repo.repository_url] = repo.display_name || repo.repository_url.split("/").slice(-2).join("/");
      return acc;
    },
    {} as Record<string, string>,
  );

  // Filter work orders based on selected repository
  // Find the repository URL from the selected repository ID, then filter work orders by that URL
  const filteredWorkOrders = selectedRepositoryId
    ? (() => {
        const selectedRepo = repositories.find((r) => r.id === selectedRepositoryId);
        return selectedRepo ? workOrders.filter((wo) => wo.repository_url === selectedRepo.repository_url) : workOrders;
      })()
    : workOrders;

  // Enhance work orders with display names
  const enhancedWorkOrders: EnhancedWorkOrder[] = filteredWorkOrders.map((wo) => ({
    ...wo,
    repositoryDisplayName: repoUrlToDisplayName[wo.repository_url],
  }));

  /**
   * Handle start button click with auto-expand tracking
   */
  const handleStart = (id: string) => {
    setJustStartedId(id);
    onStartWorkOrder(id);

    // Clear any existing timeout before scheduling a new one
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Clear the tracking after animation
    timeoutRef.current = setTimeout(() => {
      setJustStartedId(null);
      timeoutRef.current = null;
    }, 1000);
  };

  // Cleanup timeout on unmount to prevent setState after unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  // Show empty state if no work orders
  if (filteredWorkOrders.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-gray-500 dark:text-gray-400 mb-2">No work orders found</p>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {selectedRepositoryId
              ? "Create a work order for this repository to get started"
              : "Create a work order to get started"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto scrollbar-hide">
      <table className="w-full">
        <thead>
          <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
            <th className="w-12" aria-label="Status indicator" />
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">WO ID</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-40">
              Repository
            </th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
              Branch
            </th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Status</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Actions</th>
          </tr>
        </thead>
        <tbody>
          {enhancedWorkOrders.map((workOrder, index) => (
            <WorkOrderRow
              key={workOrder.agent_work_order_id}
              workOrder={workOrder}
              repositoryDisplayName={workOrder.repositoryDisplayName}
              index={index}
              onStart={handleStart}
              wasJustStarted={workOrder.agent_work_order_id === justStartedId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
