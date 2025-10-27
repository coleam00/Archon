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

// Assignee type - flexible string to support any agent name
export type Assignee = string;

// Common assignee options for UI suggestions
export const COMMON_ASSIGNEES = ["User", "Archon", "Coding Agent"] as const;
export type CommonAssignee = (typeof COMMON_ASSIGNEES)[number];

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
  assignee: Assignee; // Can be any string - agent names, "User", etc.
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

  // Priority field (required database field)
  priority: TaskPriority;

  // Extended UI properties
  featureColor?: string;
}

// Request types
export interface CreateTaskRequest {
  project_id: string;
  title: string;
  description: string;
  status?: DatabaseTaskStatus;
  assignee?: Assignee; // Optional assignee string
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
  assignee?: Assignee; // Optional assignee string
  task_order?: number;
  feature?: string;
  featureColor?: string;
  priority?: TaskPriority;
  sources?: TaskSource[];
  code_examples?: TaskCodeExample[];
}
