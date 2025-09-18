/**
 * Project Management Service
 * Focused service for project CRUD operations only
 */

import { callAPIWithETag } from "../../shared/apiWithEtag";
import { formatZodErrors, ValidationError } from "../../shared/errors";
import { validateCreateProject, validateUpdateProject } from "../schemas";
import { formatRelativeTime } from "../shared/api";
import type { CreateProjectRequest, Project, ProjectFeatures, UpdateProjectRequest } from "../types";

export const projectService = {
  /**
   * Get all projects
   */
  async listProjects(signal?: AbortSignal): Promise<Project[]> {
    try {
      // Fetching projects from API
      const response = await callAPIWithETag<{ projects: Project[] }>("/api/projects", { signal });
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
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: list projects`);
        throw error;
      }
      console.error("Failed to list projects:", error);
      throw error;
    }
  },

  /**
   * Get a specific project by ID
   */
  async getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
    try {
      const project = await callAPIWithETag<Project>(`/api/projects/${projectId}`, { signal });

      return {
        ...project,
        progress: project.progress || 0,
        updated: project.updated || formatRelativeTime(project.updated_at),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: get project ${projectId}`);
        throw error;
      }
      console.error(`Failed to get project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new project
   */
  async createProject(
    projectData: CreateProjectRequest,
    signal?: AbortSignal,
  ): Promise<{
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
        signal,
        method: "POST",
        body: JSON.stringify(validation.data),
      });

      // Project creation response received
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: create project`);
        throw error;
      }
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
  async updateProject(projectId: string, updates: UpdateProjectRequest, signal?: AbortSignal): Promise<Project> {
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
        signal,
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
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: update project ${projectId}`);
        throw error;
      }
      console.error(`Failed to update project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a project
   */
  async deleteProject(projectId: string, signal?: AbortSignal): Promise<void> {
    try {
      await callAPIWithETag(`/api/projects/${projectId}`, {
        signal,
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: delete project ${projectId}`);
        throw error;
      }
      console.error(`Failed to delete project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get features from a project's features JSONB field
   */
  async getProjectFeatures(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{ features: ProjectFeatures; count: number }> {
    try {
      const response = await callAPIWithETag<{
        features: ProjectFeatures;
        count: number;
      }>(`/api/projects/${projectId}/features`, { signal });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.debug(`Request cancelled: get project features ${projectId}`);
        throw error;
      }
      console.error(`Failed to get features for project ${projectId}:`, error);
      throw error;
    }
  },
};
