/**
 * Core Project Types
 *
 * Properly typed project interfaces following vertical slice architecture
 */

// Project JSONB field types - replacing any with proper unions
export type ProjectPRD = Record<string, unknown>;
export type ProjectDocs = unknown[]; // Will be refined to ProjectDocument[] when fully migrated
export type ProjectFeature = {
  id: string;
  label: string;
  type?: string;
  color?: string;
};

export type ProjectFeatures = ProjectFeature[];
export type ProjectData = unknown[];

// Project creation progress tracking
export interface ProjectCreationProgress {
  progressId: string;
  status:
    | "starting"
    | "initializing_agents"
    | "generating_docs"
    | "processing_requirements"
    | "ai_generation"
    | "finalizing_docs"
    | "saving_to_database"
    | "completed"
    | "error";
  percentage: number;
  logs: string[];
  error?: string;
  step?: string;
  currentStep?: string;
  eta?: string;
  duration?: string;
  project?: Project; // Forward reference - will be resolved
}

// Base Project interface (matches database schema)
export interface Project {
  id: string;
  title: string;
  prd?: ProjectPRD;
  docs?: ProjectDocs;
  features?: ProjectFeatures;
  data?: ProjectData;
  github_repo?: string;
  created_at: string;
  updated_at: string;
  technical_sources?: string[];
  business_sources?: string[];

  // Extended UI properties
  description?: string;
  progress?: number;
  updated?: string; // Human-readable format
  pinned: boolean;

  // Creation progress tracking for inline display
  creationProgress?: ProjectCreationProgress;
}

// Request types
export interface CreateProjectRequest {
  title: string;
  description?: string;
  github_repo?: string;
  pinned?: boolean;
  docs?: ProjectDocs;
  features?: ProjectFeatures;
  data?: ProjectData;
  technical_sources?: string[];
  business_sources?: string[];
}

export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  github_repo?: string;
  prd?: ProjectPRD;
  docs?: ProjectDocs;
  features?: ProjectFeatures;
  data?: ProjectData;
  technical_sources?: string[];
  business_sources?: string[];
  pinned?: boolean;
}

// Utility types
export interface MCPToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
