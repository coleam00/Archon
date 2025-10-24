/**
 * TanStack Query Hooks for Agent Work Orders
 *
 * This module provides React hooks for fetching and mutating agent work orders.
 * Follows the pattern established in useProjectQueries.ts
 */

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { useSmartPolling } from "@/features/shared/hooks/useSmartPolling";
import { agentWorkOrdersService } from "../services/agentWorkOrdersService";
import type { AgentWorkOrder, AgentWorkOrderStatus, CreateAgentWorkOrderRequest, StepHistory } from "../types";

/**
 * Query key factory for agent work orders
 * Provides consistent query keys for cache management
 */
export const agentWorkOrderKeys = {
  all: ["agent-work-orders"] as const,
  lists: () => [...agentWorkOrderKeys.all, "list"] as const,
  list: (filter: AgentWorkOrderStatus | undefined) => [...agentWorkOrderKeys.lists(), filter] as const,
  details: () => [...agentWorkOrderKeys.all, "detail"] as const,
  detail: (id: string) => [...agentWorkOrderKeys.details(), id] as const,
  stepHistory: (id: string) => [...agentWorkOrderKeys.detail(id), "steps"] as const,
};

/**
 * Hook to fetch list of agent work orders with smart polling
 * Automatically polls when any work order is pending or running
 *
 * @param statusFilter - Optional status to filter work orders
 * @returns Query result with work orders array
 */
export function useWorkOrders(statusFilter?: AgentWorkOrderStatus): UseQueryResult<AgentWorkOrder[], Error> {
  const refetchInterval = useSmartPolling({
    baseInterval: 3000,
    enabled: true,
  });

  return useQuery({
    queryKey: agentWorkOrderKeys.list(statusFilter),
    queryFn: () => agentWorkOrdersService.listWorkOrders(statusFilter),
    staleTime: STALE_TIMES.instant,
    refetchInterval: (query) => {
      const data = query.state.data as AgentWorkOrder[] | undefined;
      const hasActiveWorkOrders = data?.some(
        (wo) => wo.status === "running" || wo.status === "pending"
      );
      return hasActiveWorkOrders ? refetchInterval : false;
    },
  });
}

/**
 * Hook to fetch a single agent work order with smart polling
 * Automatically polls while work order is pending or running
 *
 * @param id - Work order ID (undefined disables query)
 * @returns Query result with work order data
 */
export function useWorkOrder(id: string | undefined): UseQueryResult<AgentWorkOrder, Error> {
  const refetchInterval = useSmartPolling({
    baseInterval: 3000,
    enabled: true,
  });

  return useQuery({
    queryKey: id ? agentWorkOrderKeys.detail(id) : DISABLED_QUERY_KEY,
    queryFn: () => (id ? agentWorkOrdersService.getWorkOrder(id) : Promise.reject(new Error("No ID provided"))),
    enabled: !!id,
    staleTime: STALE_TIMES.instant,
    refetchInterval: (query) => {
      const data = query.state.data as AgentWorkOrder | undefined;
      if (data?.status === "running" || data?.status === "pending") {
        return refetchInterval;
      }
      return false;
    },
  });
}

/**
 * Hook to fetch step execution history for a work order with smart polling
 * Automatically polls until workflow completes
 *
 * @param workOrderId - Work order ID (undefined disables query)
 * @returns Query result with step history
 */
export function useStepHistory(workOrderId: string | undefined): UseQueryResult<StepHistory, Error> {
  const refetchInterval = useSmartPolling({
    baseInterval: 3000,
    enabled: true,
  });

  return useQuery({
    queryKey: workOrderId ? agentWorkOrderKeys.stepHistory(workOrderId) : DISABLED_QUERY_KEY,
    queryFn: () =>
      workOrderId ? agentWorkOrdersService.getStepHistory(workOrderId) : Promise.reject(new Error("No ID provided")),
    enabled: !!workOrderId,
    staleTime: STALE_TIMES.instant,
    refetchInterval: (query) => {
      const history = query.state.data as StepHistory | undefined;
      const lastStep = history?.steps[history.steps.length - 1];
      if (lastStep?.step === "create-pr" && lastStep?.success) {
        return false;
      }
      return refetchInterval;
    },
  });
}

/**
 * Hook to create a new agent work order
 * Automatically invalidates work order lists on success
 *
 * @returns Mutation object with mutate function
 */
export function useCreateWorkOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateAgentWorkOrderRequest) => agentWorkOrdersService.createWorkOrder(request),

    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: agentWorkOrderKeys.lists() });
      queryClient.setQueryData(agentWorkOrderKeys.detail(data.agent_work_order_id), data);
    },

    onError: (error) => {
      console.error("Failed to create work order:", error);
    },
  });
}
