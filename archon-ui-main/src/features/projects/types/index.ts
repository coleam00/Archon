/**
 * Project Feature Types
 *
 * Central barrel export for all project-related types.
 * Following vertical slice architecture - types are co-located with features.
 */

// Document-related types from documents feature
export type * from "../documents/types";

// Task-related types from tasks feature
export type * from "../tasks/types";
// Core project types (vertical slice architecture)
export type {
  CreateProjectRequest,
  MCPToolResponse,
  PaginatedResponse,
  Project,
  ProjectCreationProgress,
  ProjectData,
  ProjectDocs,
  ProjectFeatures,
  ProjectPRD,
  UpdateProjectRequest,
} from "./project";
