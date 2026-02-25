import { beforeEach, describe, expect, it, vi } from "vitest";
import { callAPIWithETag } from "../../../shared/api/apiClient";
import type { CreateSprintRequest, Sprint, UpdateSprintRequest } from "../../types";
import { sprintService } from "../sprintService";

vi.mock("../../../shared/api/apiClient", () => ({
  callAPIWithETag: vi.fn(),
}));

const mockSprint: Sprint = {
  id: "sprint-1",
  project_id: "project-1",
  name: "Sprint War Room",
  goal: "Ship Sprint War Room view",
  status: "active",
  start_date: "2026-02-23T00:00:00Z",
  end_date: "2026-03-06T00:00:00Z",
  created_at: "2026-02-23T00:00:00Z",
  updated_at: "2026-02-23T00:00:00Z",
};

describe("sprintService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listSprints", () => {
    it("fetches sprints for a project", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockSprint]);

      const result = await sprintService.listSprints("project-1");

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/projects/project-1/sprints");
      expect(result).toEqual([mockSprint]);
      expect(result).toHaveLength(1);
    });

    it("returns empty array when API returns null", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const result = await sprintService.listSprints("project-1");

      expect(result).toEqual([]);
    });

    it("returns empty array when API returns empty list", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await sprintService.listSprints("project-1");

      expect(result).toEqual([]);
    });

    it("re-throws on API error", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

      await expect(sprintService.listSprints("project-1")).rejects.toThrow("Network error");
    });
  });

  describe("getSprint", () => {
    it("fetches a single sprint by id", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSprint);

      const result = await sprintService.getSprint("sprint-1");

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/sprints/sprint-1");
      expect(result).toEqual(mockSprint);
    });

    it("re-throws on API error", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Not found"));

      await expect(sprintService.getSprint("ghost-sprint")).rejects.toThrow("Not found");
    });
  });

  describe("createSprint", () => {
    const createData: CreateSprintRequest = {
      project_id: "project-1",
      name: "Sprint War Room",
      goal: "Ship Sprint War Room view",
    };

    it("creates a sprint and unwraps the response envelope", async () => {
      const mockResponse = { message: "Sprint created successfully", sprint: mockSprint };
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const result = await sprintService.createSprint(createData);

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/sprints", {
        method: "POST",
        body: JSON.stringify(createData),
      });
      expect(result).toEqual(mockSprint);
      expect(result).not.toHaveProperty("message");
    });

    it("re-throws on API error", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Conflict"));

      await expect(sprintService.createSprint(createData)).rejects.toThrow("Conflict");
    });
  });

  describe("updateSprint", () => {
    const updateData: UpdateSprintRequest = { status: "active", requested_by: "user" };

    it("updates a sprint and unwraps the response envelope", async () => {
      const updatedSprint = { ...mockSprint, status: "active" as const };
      const mockResponse = { message: "Sprint updated successfully", sprint: updatedSprint };
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      const result = await sprintService.updateSprint("sprint-1", updateData);

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/sprints/sprint-1", {
        method: "PUT",
        body: JSON.stringify(updateData),
      });
      expect(result).toEqual(updatedSprint);
      expect(result).not.toHaveProperty("message");
    });

    it("passes requested_by field for PO gate transitions", async () => {
      const poGateUpdate: UpdateSprintRequest = { status: "active", requested_by: "user" };
      const mockResponse = { message: "Sprint updated successfully", sprint: mockSprint };
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResponse);

      await sprintService.updateSprint("sprint-1", poGateUpdate);

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/sprints/sprint-1", {
        method: "PUT",
        body: JSON.stringify(poGateUpdate),
      });
    });

    it("re-throws on API error", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Forbidden"));

      await expect(sprintService.updateSprint("sprint-1", updateData)).rejects.toThrow("Forbidden");
    });
  });

  describe("deleteSprint", () => {
    it("deletes a sprint successfully", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      await sprintService.deleteSprint("sprint-1");

      expect(callAPIWithETag).toHaveBeenCalledWith("/api/sprints/sprint-1", {
        method: "DELETE",
      });
    });

    it("re-throws on API error", async () => {
      (callAPIWithETag as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Not found"));

      await expect(sprintService.deleteSprint("ghost-sprint")).rejects.toThrow("Not found");
    });
  });
});
