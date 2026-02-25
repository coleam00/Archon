import { callAPIWithETag } from "../../shared/api/apiClient";
import type { CreateSprintRequest, Sprint, UpdateSprintRequest } from "../types";

interface SprintMutationResponse {
  message: string;
  sprint: Sprint;
}

export const sprintService = {
  async listSprints(projectId: string): Promise<Sprint[]> {
    try {
      // Defensive fallback: guards against null response if the project has no sprints yet
      const sprints = await callAPIWithETag<Sprint[]>(`/api/projects/${projectId}/sprints`);
      return sprints || [];
    } catch (error) {
      console.error(`Failed to list sprints for project ${projectId}:`, error);
      throw error;
    }
  },

  async getSprint(sprintId: string): Promise<Sprint> {
    try {
      const sprint = await callAPIWithETag<Sprint>(`/api/sprints/${sprintId}`);
      return sprint;
    } catch (error) {
      console.error(`Failed to get sprint ${sprintId}:`, error);
      throw error;
    }
  },

  async createSprint(data: CreateSprintRequest): Promise<Sprint> {
    try {
      const response = await callAPIWithETag<SprintMutationResponse>("/api/sprints", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return response.sprint;
    } catch (error) {
      console.error(`Failed to create sprint for project ${data.project_id}:`, error);
      throw error;
    }
  },

  async updateSprint(sprintId: string, data: UpdateSprintRequest): Promise<Sprint> {
    try {
      const response = await callAPIWithETag<SprintMutationResponse>(`/api/sprints/${sprintId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      return response.sprint;
    } catch (error) {
      console.error(`Failed to update sprint ${sprintId}:`, error);
      throw error;
    }
  },

  async deleteSprint(sprintId: string): Promise<void> {
    try {
      await callAPIWithETag<void>(`/api/sprints/${sprintId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error(`Failed to delete sprint ${sprintId}:`, error);
      throw error;
    }
  },
};
