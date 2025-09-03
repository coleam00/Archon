import { Task } from '../types/project';

export interface TaskOrderingOptions {
  position: 'first' | 'last' | 'between';
  existingTasks: Task[];
  beforeTaskOrder?: number;
  afterTaskOrder?: number;
}

/**
 * Calculate the optimal task_order value for positioning a task
 * Uses integer-based ordering system with bounds checking for database compatibility
 */
export function calculateTaskOrder(options: TaskOrderingOptions): number {
  const { position, existingTasks, beforeTaskOrder, afterTaskOrder } = options;
  
  // Sort tasks by order for consistent calculations (without mutating input)
  const sortedTasks = [...existingTasks].sort((a, b) => a.task_order - b.task_order);
  
  switch (position) {
    case 'first':
      if (sortedTasks.length === 0) {
        return 65536; // Large seed value for better spacing
      }
      const firstOrder = sortedTasks[0].task_order;
      // Always use half for first position to maintain predictable spacing
      return Math.max(1, Math.floor(firstOrder / 2));
      
    case 'last':
      if (sortedTasks.length === 0) {
        return 65536; // Large seed value for better spacing
      }
      return sortedTasks[sortedTasks.length - 1].task_order + 1024;
      
    case 'between':
      if (beforeTaskOrder !== undefined && afterTaskOrder !== undefined) {
        // Bounds checking - if equal or inverted, push forward
        if (beforeTaskOrder >= afterTaskOrder) {
          return beforeTaskOrder + 1024;
        }
        
        const midpoint = Math.floor((beforeTaskOrder + afterTaskOrder) / 2);
        // If no integer gap exists, push forward instead of fractional
        if (midpoint === beforeTaskOrder) {
          return beforeTaskOrder + 1024;
        }
        return midpoint;
      }
      if (beforeTaskOrder !== undefined) {
        return beforeTaskOrder + 1024;
      }
      if (afterTaskOrder !== undefined) {
        return Math.max(1, Math.floor(afterTaskOrder / 2));
      }
      // Fallback when both bounds are missing
      return 65536;
      
    default:
      return 65536;
  }
}

/**
 * Calculate task order for drag-and-drop reordering
 */
export function calculateReorderPosition(
  statusTasks: Task[],
  movingTaskIndex: number,
  targetIndex: number
): number {
  // Create filtered array without the moving task to avoid self-references
  const withoutMoving = statusTasks.filter((_, i) => i !== movingTaskIndex);
  
  if (targetIndex === 0) {
    // Moving to first position
    return calculateTaskOrder({
      position: 'first',
      existingTasks: withoutMoving
    });
  }
  
  if (targetIndex === statusTasks.length - 1) {
    // Moving to last position
    return calculateTaskOrder({
      position: 'last',
      existingTasks: withoutMoving
    });
  }
  
  // Moving between two items - compute neighbors from filtered array
  // Need to adjust target index for the filtered array
  const adjustedTargetIndex = movingTaskIndex < targetIndex ? targetIndex - 1 : targetIndex;
  
  // Get bounds from the filtered array
  const beforeTask = withoutMoving[adjustedTargetIndex - 1];
  const afterTask = withoutMoving[adjustedTargetIndex];
  
  return calculateTaskOrder({
    position: 'between',
    existingTasks: withoutMoving,
    beforeTaskOrder: beforeTask?.task_order,
    afterTaskOrder: afterTask?.task_order
  });
}

/**
 * Get default task order for new tasks (always first position)
 */
export function getDefaultTaskOrder(existingTasks: Task[]): number {
  return calculateTaskOrder({
    position: 'first',
    existingTasks
  });
}