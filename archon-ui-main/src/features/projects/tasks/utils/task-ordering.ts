/**
 * Task ordering utilities that ensure integer precision
 *
 * Following alpha principles: detailed errors and no silent failures
 */

import type { Task } from "../types";

export const ORDER_INCREMENT = 1000; // Large increment to avoid precision issues
const MAX_ORDER = Number.MAX_SAFE_INTEGER - ORDER_INCREMENT;

/**
 * Calculate a default task order for new tasks in a status column
 * Always returns an integer to avoid float precision issues
 */
export function getDefaultTaskOrder(existingTasks: Task[]): number {
  if (existingTasks.length === 0) {
    return ORDER_INCREMENT; // Start at 1000 for first task
  }

  // Find the maximum order in the existing tasks
  const maxOrder = Math.max(...existingTasks.map((task) => task.task_order || 0));

  // Ensure we don't exceed safe integer limits
  if (maxOrder >= MAX_ORDER) {
    throw new Error(`Task order limit exceeded. Maximum safe order is ${MAX_ORDER}, got ${maxOrder}`);
  }

  return maxOrder + ORDER_INCREMENT;
}

/**
 * Calculate task order when inserting between two tasks
 * Returns an integer that maintains proper ordering
 */
export function getInsertTaskOrder(beforeTask: Task | null, afterTask: Task | null): number {
  const beforeOrder = beforeTask?.task_order || 0;
  const afterOrder = afterTask?.task_order || beforeOrder + ORDER_INCREMENT * 2;

  // If there's enough space between tasks, insert in the middle
  const gap = afterOrder - beforeOrder;
  if (gap > 1) {
    const middleOrder = beforeOrder + Math.floor(gap / 2);
    return middleOrder;
  }

  // If no gap, push everything after up by increment
  return afterOrder + ORDER_INCREMENT;
}

/**
 * Reorder a task within the same status column
 * Ensures integer precision and proper spacing
 */
export function getReorderTaskOrder(tasks: Task[], taskId: string, newIndex: number): number {
  const filteredTasks = tasks.filter((t) => t.id !== taskId);

  if (filteredTasks.length === 0) {
    return ORDER_INCREMENT;
  }

  // Sort tasks by current order
  const sortedTasks = [...filteredTasks].sort((a, b) => (a.task_order || 0) - (b.task_order || 0));

  // Handle edge cases
  if (newIndex <= 0) {
    // Moving to first position
    const firstOrder = sortedTasks[0]?.task_order || ORDER_INCREMENT;
    return Math.max(ORDER_INCREMENT, firstOrder - ORDER_INCREMENT);
  }

  if (newIndex >= sortedTasks.length) {
    // Moving to last position
    const lastOrder = sortedTasks[sortedTasks.length - 1]?.task_order || 0;
    return lastOrder + ORDER_INCREMENT;
  }

  // Moving to middle position
  const beforeTask = sortedTasks[newIndex - 1];
  const afterTask = sortedTasks[newIndex];

  return getInsertTaskOrder(beforeTask, afterTask);
}

/**
 * Validate task order value
 * Ensures it's a safe integer for database storage
 */
export function validateTaskOrder(order: number): number {
  if (!Number.isInteger(order)) {
    console.warn(`Task order ${order} is not an integer, rounding to ${Math.round(order)}`);
    return Math.round(order);
  }

  if (order > MAX_ORDER || order < 0) {
    throw new Error(`Task order ${order} is outside safe range [0, ${MAX_ORDER}]`);
  }

  return order;
}
