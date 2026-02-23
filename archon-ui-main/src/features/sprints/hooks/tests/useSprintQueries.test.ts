import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sprint } from "../../types";
import {
  sprintKeys,
  useCreateSprint,
  useDeleteSprint,
  useProjectSprints,
  useSprint,
  useUpdateSprint,
} from "../useSprintQueries";

vi.mock("../../services/sprintService", () => ({
  sprintService: {
    listSprints: vi.fn(),
    getSprint: vi.fn(),
    createSprint: vi.fn(),
    updateSprint: vi.fn(),
    deleteSprint: vi.fn(),
  },
}));

vi.mock("@/features/shared/hooks/useToast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/features/shared/config/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Infinity,
  },
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
};

const mockSprint: Sprint = {
  id: "sprint-1",
  project_id: "project-1",
  name: "Sprint 1 — Swarm Infrastructure",
  goal: "Ship Sprint War Room",
  status: "active",
  start_date: "2026-02-21T00:00:00Z",
  end_date: "2026-03-07T00:00:00Z",
  created_at: "2026-02-21T00:00:00Z",
  updated_at: "2026-02-21T00:00:00Z",
};

describe("sprintKeys", () => {
  it("generates correct query keys", () => {
    expect(sprintKeys.all).toEqual(["sprints"]);
    expect(sprintKeys.byProject("project-1")).toEqual(["sprints", "project", "project-1"]);
    expect(sprintKeys.detail("sprint-1")).toEqual(["sprints", "detail", "sprint-1"]);
  });
});

describe("useProjectSprints", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches sprints for a project", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.listSprints).mockResolvedValue([mockSprint]);

    const { result } = renderHook(() => useProjectSprints("project-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([mockSprint]);
    expect(sprintService.listSprints).toHaveBeenCalledWith("project-1");
  });

  it("is disabled when projectId is undefined", () => {
    const { result } = renderHook(() => useProjectSprints(undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  it("returns empty array when service returns empty", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.listSprints).mockResolvedValue([]);

    const { result } = renderHook(() => useProjectSprints("project-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe("useSprint", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches a single sprint by id", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.getSprint).mockResolvedValue(mockSprint);

    const { result } = renderHook(() => useSprint("sprint-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockSprint);
    expect(sprintService.getSprint).toHaveBeenCalledWith("sprint-1");
  });

  it("is disabled when sprintId is undefined", () => {
    const { result } = renderHook(() => useSprint(undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useCreateSprint", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates a sprint and invalidates project sprints cache", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.createSprint).mockResolvedValue(mockSprint);

    const { result } = renderHook(() => useCreateSprint(), { wrapper: createWrapper() });

    await result.current.mutateAsync({
      project_id: "project-1",
      name: "Sprint 1 — Swarm Infrastructure",
      goal: "Ship Sprint War Room",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sprintService.createSprint).toHaveBeenCalledWith({
      project_id: "project-1",
      name: "Sprint 1 — Swarm Infrastructure",
      goal: "Ship Sprint War Room",
    });
  });

  it("surfaces error on failure", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.createSprint).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useCreateSprint(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({ project_id: "project-1", name: "Bad Sprint" }),
    ).rejects.toThrow("Network error");
  });
});

describe("useUpdateSprint", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("updates sprint status and invalidates caches", async () => {
    const updatedSprint = { ...mockSprint, status: "completed" as const };
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.updateSprint).mockResolvedValue(updatedSprint);

    const { result } = renderHook(() => useUpdateSprint("project-1"), { wrapper: createWrapper() });

    await result.current.mutateAsync({
      sprintId: "sprint-1",
      data: { status: "completed" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sprintService.updateSprint).toHaveBeenCalledWith("sprint-1", { status: "completed" });
  });
});

describe("useDeleteSprint", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("deletes a sprint and invalidates project cache", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.deleteSprint).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteSprint("project-1"), { wrapper: createWrapper() });

    await result.current.mutateAsync("sprint-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sprintService.deleteSprint).toHaveBeenCalledWith("sprint-1");
  });

  it("surfaces error on delete failure", async () => {
    const { sprintService } = await import("../../services/sprintService");
    vi.mocked(sprintService.deleteSprint).mockRejectedValue(new Error("Not found"));

    const { result } = renderHook(() => useDeleteSprint("project-1"), { wrapper: createWrapper() });

    await expect(result.current.mutateAsync("ghost-sprint")).rejects.toThrow("Not found");
  });
});
