/**
 * Core Task Types
 *
 * Main task interfaces and types following vertical slice architecture
 */

// Import priority type from priority.ts to avoid duplication
import type { TaskPriority } from "./priority";
export type { TaskPriority };

// Database status enum - using database values directly
export type DatabaseTaskStatus = "todo" | "doing" | "review" | "done";

// Assignee type - simplified to predefined options
export type Assignee = "User" | "Archon" | "AI IDE Agent";

// Task counts for project overview
export interface TaskCounts {
  todo: number;
  doing: number;
  review: number;
  done: number;
}

// Task source and code example types (replacing any)
export type TaskSource =
  | {
      url: string;
      type: string;
      relevance: string;
    }
  | Record<string, unknown>;

export type TaskCodeExample =
  | {
      file: string;
      function: string;
      purpose: string;
    }
  | Record<string, unknown>;

// Base Task interface (matches database schema)
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: DatabaseTaskStatus;
  assignee: Assignee;
  task_order: number;
  feature?: string;
  sources?: TaskSource[];
  code_examples?: TaskCodeExample[];
  created_at: string;
  updated_at: string;

  // Soft delete fields
  archived?: boolean;
  archived_at?: string;
  archived_by?: string;

  // Extended UI properties
  featureColor?: string;
  priority?: TaskPriority;
}

// Request types
export interface CreateTaskRequest {
  project_id: string;
  title: string;
  description: string;
  status?: DatabaseTaskStatus;
  assignee?: Assignee;
  task_order?: number;
  feature?: string;
  featureColor?: string;
  priority?: TaskPriority;
  sources?: TaskSource[];
  code_examples?: TaskCodeExample[];
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: DatabaseTaskStatus;
  assignee?: Assignee;
  task_order?: number;
  feature?: string;
  featureColor?: string;
  priority?: TaskPriority;
  sources?: TaskSource[];
  code_examples?: TaskCodeExample[];
}
