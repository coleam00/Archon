/**
 * Priority System Types
 *
 * Defines priority levels independent from task_order (which handles drag-and-drop positioning).
 * Priority represents semantic importance and is stored directly in the database.
 */

export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface TaskPriorityOption {
  value: TaskPriority; // Direct priority values from database enum
  label: string;
  color: string;
}

export const TASK_PRIORITY_OPTIONS: readonly TaskPriorityOption[] = [
  { value: "critical", label: "Critical", color: "text-red-600" },
  { value: "high", label: "High", color: "text-orange-600" },
  { value: "medium", label: "Medium", color: "text-blue-600" },
  { value: "low", label: "Low", color: "text-gray-600" },
] as const;

/**
 * Get task priority display properties from priority value
 */
export function getTaskPriorityOption(priority: TaskPriority): TaskPriorityOption {
  const priorityOption = TASK_PRIORITY_OPTIONS.find((p) => p.value === priority);
  return priorityOption || TASK_PRIORITY_OPTIONS[2]; // Default to 'Medium'
}

/**
 * Validate priority value against allowed enum values
 */
export function isValidTaskPriority(priority: string): priority is TaskPriority {
  return ["critical", "high", "medium", "low"].includes(priority);
}
