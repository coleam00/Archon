/**
 * Tests for Agent Work Orders Service
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "@/features/shared/api/apiClient";
import type { AgentWorkOrder, CreateAgentWorkOrderRequest, StepHistory } from "../../types";
import { agentWorkOrdersService } from "../agentWorkOrdersService";

vi.mock("@/features/shared/api/apiClient", () => ({
  callAPIWithETag: vi.fn(),
}));

describe("agentWorkOrdersService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockWorkOrder: AgentWorkOrder = {
    agent_work_order_id: "wo-123",
    repository_url: "https://github.com/test/repo",
    sandbox_identifier: "sandbox-abc",
    git_branch_name: "feature/test",
    agent_session_id: "session-xyz",
    sandbox_type: "git_branch",
    github_issue_number: null,
    status: "running",
    current_phase: "planning",
    created_at: "2025-01-15T10:00:00Z",
    updated_at: "2025-01-15T10:05:00Z",
    github_pull_request_url: null,
    git_commit_count: 0,
    git_files_changed: 0,
    error_message: null,
  };

  describe("createWorkOrder", () => {
    it("should create a work order successfully", async () => {
      const request: CreateAgentWorkOrderRequest = {
        repository_url: "https://github.com/test/repo",
        sandbox_type: "git_branch",
        user_request: "Add new feature",
      };

      vi.mocked(apiClient.callAPIWithETag).mockResolvedValue(mockWorkOrder);

      const result = await agentWorkOrdersService.createWorkOrder(request);

      expect(apiClient.callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders", {
        method: "POST",
        body: JSON.stringify(request),
      });
      expect(result).toEqual(mockWorkOrder);
    });

    it("should throw error on creation failure", async () => {
      const request: CreateAgentWorkOrderRequest = {
        repository_url: "https://github.com/test/repo",
        sandbox_type: "git_branch",
        user_request: "Add new feature",
      };

      vi.mocked(apiClient.callAPIWithETag).mockRejectedValue(new Error("Creation failed"));

      await expect(agentWorkOrdersService.createWorkOrder(request)).rejects.toThrow("Creation failed");
    });
  });

  describe("listWorkOrders", () => {
    it("should list all work orders without filter", async () => {
      const mockList: AgentWorkOrder[] = [mockWorkOrder];

      vi.mocked(apiClient.callAPIWithETag).mockResolvedValue(mockList);

      const result = await agentWorkOrdersService.listWorkOrders();

      expect(apiClient.callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders");
      expect(result).toEqual(mockList);
    });

    it("should list work orders with status filter", async () => {
      const mockList: AgentWorkOrder[] = [mockWorkOrder];

      vi.mocked(apiClient.callAPIWithETag).mockResolvedValue(mockList);

      const result = await agentWorkOrdersService.listWorkOrders("running");

      expect(apiClient.callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders?status=running");
      expect(result).toEqual(mockList);
    });

    it("should throw error on list failure", async () => {
      vi.mocked(apiClient.callAPIWithETag).mockRejectedValue(new Error("List failed"));

      await expect(agentWorkOrdersService.listWorkOrders()).rejects.toThrow("List failed");
    });
  });

  describe("getWorkOrder", () => {
    it("should get a work order by ID", async () => {
      vi.mocked(apiClient.callAPIWithETag).mockResolvedValue(mockWorkOrder);

      const result = await agentWorkOrdersService.getWorkOrder("wo-123");

      expect(apiClient.callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders/wo-123");
      expect(result).toEqual(mockWorkOrder);
    });

    it("should throw error on get failure", async () => {
      vi.mocked(apiClient.callAPIWithETag).mockRejectedValue(new Error("Not found"));

      await expect(agentWorkOrdersService.getWorkOrder("wo-123")).rejects.toThrow("Not found");
    });
  });

  describe("getStepHistory", () => {
    it("should get step history for a work order", async () => {
      const mockHistory: StepHistory = {
        agent_work_order_id: "wo-123",
        steps: [
          {
            step: "create-branch",
            agent_name: "Branch Agent",
            success: true,
            output: "Branch created",
            error_message: null,
            duration_seconds: 5,
            session_id: "session-1",
            timestamp: "2025-01-15T10:00:00Z",
          },
          {
            step: "planning",
            agent_name: "Planning Agent",
            success: true,
            output: "Plan created",
            error_message: null,
            duration_seconds: 30,
            session_id: "session-2",
            timestamp: "2025-01-15T10:01:00Z",
          },
        ],
      };

      vi.mocked(apiClient.callAPIWithETag).mockResolvedValue(mockHistory);

      const result = await agentWorkOrdersService.getStepHistory("wo-123");

      expect(apiClient.callAPIWithETag).toHaveBeenCalledWith("/api/agent-work-orders/wo-123/steps");
      expect(result).toEqual(mockHistory);
    });

    it("should throw error on step history failure", async () => {
      vi.mocked(apiClient.callAPIWithETag).mockRejectedValue(new Error("History failed"));

      await expect(agentWorkOrdersService.getStepHistory("wo-123")).rejects.toThrow("History failed");
    });
  });
});
