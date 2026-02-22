/**
 * Sprint Service
 *
 * API calls for sprint CRUD operations.
 */

import { callAPIWithETag } from "../../../shared/api/apiClient";
import type { CreateSprintRequest, Sprint, UpdateSprintRequest } from "../types";

export const sprintService = {
  async listSprints(projectId: string): Promise<Sprint[]> {
    return callAPIWithETag<Sprint[]>(`/api/projects/${projectId}/sprints`);
  },

  async getSprint(sprintId: string): Promise<Sprint> {
    return callAPIWithETag<Sprint>(`/api/sprints/${sprintId}`);
  },

  async createSprint(data: CreateSprintRequest): Promise<Sprint> {
    const response = await callAPIWithETag<{ message: string; sprint: Sprint }>("/api/sprints", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return response.sprint;
  },

  async updateSprint(sprintId: string, updates: UpdateSprintRequest): Promise<Sprint> {
    const response = await callAPIWithETag<{ message: string; sprint: Sprint }>(`/api/sprints/${sprintId}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    return response.sprint;
  },

  async deleteSprint(sprintId: string): Promise<void> {
    await callAPIWithETag<void>(`/api/sprints/${sprintId}`, { method: "DELETE" });
  },
};
