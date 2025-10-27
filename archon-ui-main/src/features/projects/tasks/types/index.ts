/**
 * Task Types
 *
 * All task-related types for the projects feature.
 */

// Hook return types
export type { UseTaskActionsReturn, UseTaskEditorReturn } from "./hooks";
// Core task types (vertical slice architecture)
export type {
  Assignee,
  CommonAssignee,
  CreateTaskRequest,
  DatabaseTaskStatus,
  Task,
  TaskCodeExample,
  TaskCounts,
  TaskPriority,
  TaskSource,
  UpdateTaskRequest,
} from "./task";

// Export constants
export { COMMON_ASSIGNEES } from "./task";
