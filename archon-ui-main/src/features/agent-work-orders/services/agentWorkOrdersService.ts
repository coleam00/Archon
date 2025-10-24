/**
 * Agent Work Orders API Service
 *
 * This service handles all API communication for agent work orders.
 * It follows the pattern established in projectService.ts
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { AgentWorkOrder, AgentWorkOrderStatus, CreateAgentWorkOrderRequest, StepHistory } from "../types";

/**
 * Get the base URL for work orders API
 * Work orders CRUD goes to Archon server at /api/work-orders
 */
const getBaseUrl = (): string => {
  return "/api/work-orders";
};

export const agentWorkOrdersService = {
  /**
   * Create a new agent work order
   *
   * @param request - The work order creation request
   * @returns Promise resolving to the created work order
   * @throws Error if creation fails
   */
  async createWorkOrder(request: CreateAgentWorkOrderRequest): Promise<AgentWorkOrder> {
    const baseUrl = getBaseUrl();
    return await callAPIWithETag<AgentWorkOrder>(`${baseUrl}/`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },

  /**
   * List all agent work orders, optionally filtered by status
   *
   * @param statusFilter - Optional status to filter by
   * @returns Promise resolving to array of work orders
   * @throws Error if request fails
   */
  async listWorkOrders(statusFilter?: AgentWorkOrderStatus): Promise<AgentWorkOrder[]> {
    const baseUrl = getBaseUrl();
    const params = statusFilter ? `?status=${statusFilter}` : "";
    return await callAPIWithETag<AgentWorkOrder[]>(`${baseUrl}/${params}`);
  },

  /**
   * Get a single agent work order by ID
   *
   * @param id - The work order ID
   * @returns Promise resolving to the work order
   * @throws Error if work order not found or request fails
   */
  async getWorkOrder(id: string): Promise<AgentWorkOrder> {
    const baseUrl = getBaseUrl();
    return await callAPIWithETag<AgentWorkOrder>(`${baseUrl}/${id}`);
  },

  /**
   * Get the complete step execution history for a work order
   * This comes from the agent service (8053) via proxy
   *
   * @param id - The work order ID
   * @returns Promise resolving to the step history
   * @throws Error if work order not found or request fails
   */
  async getStepHistory(id: string): Promise<StepHistory> {
    return await callAPIWithETag<StepHistory>(`/api/agent-work-orders/${id}/steps`);
  },

  /**
   * List work orders for a specific repository
   *
   * @param repositoryId - The repository ID
   * @returns Promise resolving to array of work orders for the repository
   * @throws Error if request fails
   */
  async listWorkOrdersByRepository(repositoryId: string): Promise<AgentWorkOrder[]> {
    const response = await callAPIWithETag<{ work_orders: AgentWorkOrder[]; count: number }>(`/api/repositories/${repositoryId}/work-orders`);
    return response.work_orders;
  },

  /**
   * Update work order status
   *
   * @param id - The work order ID
   * @param status - The new status
   * @returns Promise resolving to updated work order
   * @throws Error if update fails
   */
  async updateWorkOrderStatus(id: string, status: string): Promise<AgentWorkOrder> {
    const baseUrl = getBaseUrl();
    return await callAPIWithETag<AgentWorkOrder>(`${baseUrl}/${id}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
  },

  /**
   * Delete a work order
   *
   * @param id - The work order ID
   * @returns Promise resolving when delete completes
   * @throws Error if delete fails
   */
  async deleteWorkOrder(id: string): Promise<void> {
    const baseUrl = getBaseUrl();
    await callAPIWithETag<void>(`${baseUrl}/${id}`, {
      method: "DELETE",
    });
  },
};
