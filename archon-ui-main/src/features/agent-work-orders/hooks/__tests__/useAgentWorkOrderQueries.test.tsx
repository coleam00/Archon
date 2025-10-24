/**
 * Tests for Agent Work Order Query Hooks
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentWorkOrderKeys } from "../useAgentWorkOrderQueries";

vi.mock("../../services/agentWorkOrdersService", () => ({
  agentWorkOrdersService: {
    listWorkOrders: vi.fn(),
    getWorkOrder: vi.fn(),
    getStepHistory: vi.fn(),
    createWorkOrder: vi.fn(),
  },
}));

vi.mock("@/features/shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Number.POSITIVE_INFINITY,
  },
}));

vi.mock("@/features/shared/hooks/useSmartPolling", () => ({
  useSmartPolling: vi.fn(() => 3000),
}));

describe("agentWorkOrderKeys", () => {
  it("should generate correct query keys", () => {
    expect(agentWorkOrderKeys.all).toEqual(["agent-work-orders"]);
    expect(agentWorkOrderKeys.lists()).toEqual(["agent-work-orders", "list"]);
    expect(agentWorkOrderKeys.list("running")).toEqual(["agent-work-orders", "list", "running"]);
    expect(agentWorkOrderKeys.list(undefined)).toEqual(["agent-work-orders", "list", undefined]);
    expect(agentWorkOrderKeys.details()).toEqual(["agent-work-orders", "detail"]);
    expect(agentWorkOrderKeys.detail("wo-123")).toEqual(["agent-work-orders", "detail", "wo-123"]);
    expect(agentWorkOrderKeys.stepHistory("wo-123")).toEqual(["agent-work-orders", "detail", "wo-123", "steps"]);
  });
});

describe("useWorkOrders", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it("should fetch work orders without filter", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useWorkOrders } = await import("../useAgentWorkOrderQueries");

    const mockWorkOrders = [
      {
        agent_work_order_id: "wo-1",
        status: "running",
      },
    ];

    vi.mocked(agentWorkOrdersService.listWorkOrders).mockResolvedValue(mockWorkOrders as never);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWorkOrders(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentWorkOrdersService.listWorkOrders).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(mockWorkOrders);
  });

  it("should fetch work orders with status filter", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useWorkOrders } = await import("../useAgentWorkOrderQueries");

    const mockWorkOrders = [
      {
        agent_work_order_id: "wo-1",
        status: "completed",
      },
    ];

    vi.mocked(agentWorkOrdersService.listWorkOrders).mockResolvedValue(mockWorkOrders as never);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWorkOrders("completed"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentWorkOrdersService.listWorkOrders).toHaveBeenCalledWith("completed");
    expect(result.current.data).toEqual(mockWorkOrders);
  });
});

describe("useWorkOrder", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it("should fetch single work order", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useWorkOrder } = await import("../useAgentWorkOrderQueries");

    const mockWorkOrder = {
      agent_work_order_id: "wo-123",
      status: "running",
    };

    vi.mocked(agentWorkOrdersService.getWorkOrder).mockResolvedValue(mockWorkOrder as never);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWorkOrder("wo-123"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentWorkOrdersService.getWorkOrder).toHaveBeenCalledWith("wo-123");
    expect(result.current.data).toEqual(mockWorkOrder);
  });

  it("should not fetch when id is undefined", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useWorkOrder } = await import("../useAgentWorkOrderQueries");

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useWorkOrder(undefined), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(agentWorkOrdersService.getWorkOrder).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});

describe("useStepHistory", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it("should fetch step history", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useStepHistory } = await import("../useAgentWorkOrderQueries");

    const mockHistory = {
      agent_work_order_id: "wo-123",
      steps: [
        {
          step: "create-branch",
          success: true,
        },
      ],
    };

    vi.mocked(agentWorkOrdersService.getStepHistory).mockResolvedValue(mockHistory as never);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useStepHistory("wo-123"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentWorkOrdersService.getStepHistory).toHaveBeenCalledWith("wo-123");
    expect(result.current.data).toEqual(mockHistory);
  });

  it("should not fetch when workOrderId is undefined", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useStepHistory } = await import("../useAgentWorkOrderQueries");

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useStepHistory(undefined), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(agentWorkOrdersService.getStepHistory).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});

describe("useCreateWorkOrder", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  it("should create work order and invalidate queries", async () => {
    const { agentWorkOrdersService } = await import("../../services/agentWorkOrdersService");
    const { useCreateWorkOrder } = await import("../useAgentWorkOrderQueries");

    const mockRequest = {
      repository_url: "https://github.com/test/repo",
      sandbox_type: "git_branch" as const,
      user_request: "Test",
    };

    const mockCreated = {
      agent_work_order_id: "wo-new",
      ...mockRequest,
      status: "pending" as const,
    };

    vi.mocked(agentWorkOrdersService.createWorkOrder).mockResolvedValue(mockCreated as never);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useCreateWorkOrder(), { wrapper });

    result.current.mutate(mockRequest);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(agentWorkOrdersService.createWorkOrder).toHaveBeenCalledWith(mockRequest);
    expect(result.current.data).toEqual(mockCreated);
  });
});
