/**
 * Project Management Service
 * Focused service for project CRUD operations only
 */

import { callAPIWithETag } from "../../shared/api/apiClient";
import { formatZodErrors, ValidationError } from "../../shared/types/errors";
import { validateCreateProject, validateUpdateProject } from "../schemas";
import { formatRelativeTime } from "../shared/api";
import type { CreateProjectRequest, Project, ProjectFeatures, UpdateProjectRequest } from "../types";

export const projectService = {
  /**
   * Get all projects
   */
  async listProjects(): Promise<Project[]> {
    try {
      // Fetching projects from API
      const response = await callAPIWithETag<{ projects: Project[] }>("/api/projects");
      // API response received

      const projects = response.projects || [];
      // Processing projects array

      // Process raw pinned values

      // Add computed UI properties
      const processedProjects = projects.map((project: Project) => {
        // Process the raw pinned value

        const processed = {
          ...project,
          // Ensure pinned is properly handled as boolean
          pinned: project.pinned === true,
          progress: project.progress || 0,
          updated: project.updated || formatRelativeTime(project.updated_at),
        };
        return processed;
      });

      // All projects processed
      return processedProjects;
    } catch (error) {
      console.error("Failed to list projects:", error);
      throw error;
    }
  },

  /**
   * Get a specific project by ID
   */
  async getProject(projectId: string): Promise<Project> {
    try {
      const project = await callAPIWithETag<Project>(`/api/projects/${projectId}`);

      return {
        ...project,
        progress: project.progress || 0,
        updated: project.updated || formatRelativeTime(project.updated_at),
      };
    } catch (error) {
      console.error(`Failed to get project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new project
   */
  async createProject(projectData: CreateProjectRequest): Promise<{
    project_id: string;
    project: Project;
    status: string;
    message: string;
  }> {
    // Validate input
    // Validate project data
    const validation = validateCreateProject(projectData);
    if (!validation.success) {
      // Validation failed
      throw new ValidationError(formatZodErrors(validation.error));
    }
    // Validation passed

    try {
      // Sending project creation request
      const response = await callAPIWithETag<{
        project_id: string;
        project: Project;
        status: string;
        message: string;
      }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(validation.data),
      });

      // Project creation response received
      return response;
    } catch (error) {
      console.error("[PROJECT SERVICE] Failed to initiate project creation:", error);
      if (error instanceof Error) {
        console.error("[PROJECT SERVICE] Error details:", {
          message: error.message,
          name: error.name,
        });
      }
      throw error;
    }
  },

  /**
   * Update an existing project
   */
  async updateProject(projectId: string, updates: UpdateProjectRequest): Promise<Project> {
    // Validate input
    // Updating project with provided data
    const validation = validateUpdateProject(updates);
    if (!validation.success) {
      // Validation failed
      throw new ValidationError(formatZodErrors(validation.error));
    }

    try {
      // Sending update request to API
      const project = await callAPIWithETag<Project>(`/api/projects/${projectId}`, {
        method: "PUT",
        body: JSON.stringify(validation.data),
      });

      // API update response received

      // Ensure pinned property is properly handled as boolean
      const processedProject = {
        ...project,
        pinned: project.pinned === true,
        progress: project.progress || 0,
        updated: formatRelativeTime(project.updated_at),
      };

      // Project update processed

      return processedProject;
    } catch (error) {
      console.error(`Failed to update project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a project
   */
  async deleteProject(projectId: string): Promise<void> {
    try {
      await callAPIWithETag(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error(`Failed to delete project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get features from a project's features JSONB field
   */
  async getProjectFeatures(projectId: string): Promise<{ features: ProjectFeatures; count: number }> {
    try {
      const response = await callAPIWithETag<{
        features: ProjectFeatures;
        count: number;
      }>(`/api/projects/${projectId}/features`);
      return response;
    } catch (error) {
      console.error(`Failed to get features for project ${projectId}:`, error);
      throw error;
    }
  },
};
