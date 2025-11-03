/**
 * Agent Work Orders API Service
 *
 * This service handles all API communication for agent work orders.
 * It follows the pattern established in projectService.ts
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type {
  AgentWorkOrder,
  AgentWorkOrderStatus,
  CreateAgentWorkOrderRequest,
  StepHistory,
  WorkflowStep,
  WorkOrderLogsResponse,
} from "../types";

/**
 * Get the base URL for agent work orders API
 * Defaults to /api/agent-work-orders (proxy through main server)
 * Can be overridden with VITE_AGENT_WORK_ORDERS_URL for direct connection
 */
const getBaseUrl = (): string => {
  const directUrl = import.meta.env.VITE_AGENT_WORK_ORDERS_URL;
  if (directUrl) {
    // Direct URL should include the full path
    return `${directUrl}/api/agent-work-orders`;
  }
  // Default: proxy through main server
  return "/api/agent-work-orders";
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
   *
   * @param id - The work order ID
   * @returns Promise resolving to the step history
   * @throws Error if work order not found or request fails
   */
  async getStepHistory(id: string): Promise<StepHistory> {
    const baseUrl = getBaseUrl();
    return await callAPIWithETag<StepHistory>(`${baseUrl}/${id}/steps`);
  },

  /**
   * Start a pending work order (transition from pending to running)
   * This triggers backend execution by updating the status to "running"
   *
   * @param id - The work order ID to start
   * @returns Promise resolving to the updated work order
   * @throws Error if work order not found, already running, or request fails
   */
  async startWorkOrder(id: string): Promise<AgentWorkOrder> {
    const baseUrl = getBaseUrl();
    // Note: Backend automatically starts execution when status transitions to "running"
    // This is a conceptual API - actual implementation may vary based on backend
    return await callAPIWithETag<AgentWorkOrder>(`${baseUrl}/${id}/start`, {
      method: "POST",
    });
  },

  /**
   * Get historical logs for a work order
   * Fetches buffered logs from backend (not live streaming)
   *
   * @param id - The work order ID
   * @param options - Optional filters (limit, offset, level, step)
   * @returns Promise resolving to logs response
   * @throws Error if work order not found or request fails
   */
  async getWorkOrderLogs(
    id: string,
    options?: {
      limit?: number;
      offset?: number;
      level?: "info" | "warning" | "error" | "debug";
      step?: WorkflowStep;
    },
  ): Promise<WorkOrderLogsResponse> {
    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();

    if (options?.limit) params.append("limit", options.limit.toString());
    if (options?.offset) params.append("offset", options.offset.toString());
    if (options?.level) params.append("level", options.level);
    if (options?.step) params.append("step", options.step);

    const queryString = params.toString();
    const url = queryString ? `${baseUrl}/${id}/logs?${queryString}` : `${baseUrl}/${id}/logs`;

    return await callAPIWithETag<WorkOrderLogsResponse>(url);
  },
};
