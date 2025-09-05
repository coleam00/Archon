/**
 * Priority System Types
 *
 * Defines user-facing priority levels separate from task_order (which handles drag-and-drop positioning).
 * Priority is for display and user understanding, not for ordering logic.
 */

export type TaskPriority = "critical" | "high" | "medium" | "low";

export interface TaskPriorityOption {
  value: number; // Maps to task_order values for backwards compatibility
  label: string;
  color: string;
}

export const TASK_PRIORITY_OPTIONS: readonly TaskPriorityOption[] = [
  { value: 1, label: "Critical", color: "text-red-600" },
  { value: 25, label: "High", color: "text-orange-600" },
  { value: 50, label: "Medium", color: "text-blue-600" },
  { value: 100, label: "Low", color: "text-gray-600" },
] as const;

/**
 * Convert task_order value to TaskPriority enum
 */
export function getTaskPriorityFromTaskOrder(taskOrder: number): TaskPriority {
  if (taskOrder <= 1) return "critical";
  if (taskOrder <= 25) return "high";
  if (taskOrder <= 50) return "medium";
  return "low";
}

/**
 * Get task priority display properties from task_order
 */
export function getTaskPriorityOption(taskOrder: number): TaskPriorityOption {
  const priority = TASK_PRIORITY_OPTIONS.find((p) => p.value >= taskOrder);
  return priority || TASK_PRIORITY_OPTIONS[TASK_PRIORITY_OPTIONS.length - 1]; // Default to 'Low'
}
