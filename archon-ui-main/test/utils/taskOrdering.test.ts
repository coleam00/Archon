import { describe, it, expect } from 'vitest';
import { calculateTaskOrder, calculateReorderPosition, getDefaultTaskOrder } from '../../src/utils/taskOrdering';
import { Task } from '../../src/types/project';

// Mock task factory
const createMockTask = (id: string, task_order: number): Task => ({
  id,
  title: `Task ${id}`,
  description: '',
  status: 'todo',
  assignee: { name: 'Test User', avatar: '' },
  feature: '',
  featureColor: '#3b82f6',
  task_order,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  project_id: 'test-project'
});

describe('taskOrdering utilities', () => {
  describe('calculateTaskOrder', () => {
    it('does not mutate existingTasks', () => {
      const existingTasks = [createMockTask('1', 200), createMockTask('2', 100)];
      const snapshot = existingTasks.map(t => t.task_order);
      calculateTaskOrder({ position: 'first', existingTasks });
      expect(existingTasks.map(t => t.task_order)).toEqual(snapshot);
    });

    it('should return seed value for first task when no existing tasks', () => {
      const result = calculateTaskOrder({
        position: 'first',
        existingTasks: []
      });
      expect(result).toBe(65536);
    });

    it('should calculate first position correctly', () => {
      const existingTasks = [createMockTask('1', 100), createMockTask('2', 200)];
      const result = calculateTaskOrder({
        position: 'first',
        existingTasks
      });
      expect(result).toBe(50); // Math.floor(100 / 2)
    });

    it('should calculate last position correctly', () => {
      const existingTasks = [createMockTask('1', 100), createMockTask('2', 200)];
      const result = calculateTaskOrder({
        position: 'last',
        existingTasks
      });
      expect(result).toBe(1224); // 200 + 1024
    });

    it('should calculate between position correctly', () => {
      const result = calculateTaskOrder({
        position: 'between',
        existingTasks: [],
        beforeTaskOrder: 100,
        afterTaskOrder: 200
      });
      expect(result).toBe(150); // Math.floor((100 + 200) / 2)
    });
  });

  describe('getDefaultTaskOrder', () => {
    it('should return seed value when no existing tasks', () => {
      const result = getDefaultTaskOrder([]);
      expect(result).toBe(65536);
    });

    it('should return first position when existing tasks present', () => {
      const existingTasks = [createMockTask('1', 100), createMockTask('2', 200)];
      const result = getDefaultTaskOrder(existingTasks);
      expect(result).toBe(50); // Math.floor(100 / 2)
    });
  });

  describe('calculateReorderPosition', () => {
    const statusTasks = [
      createMockTask('1', 100),
      createMockTask('2', 200), 
      createMockTask('3', 300)
    ];

    it('should calculate position for moving to first', () => {
      const result = calculateReorderPosition(statusTasks, 1, 0);
      expect(result).toBeLessThan(statusTasks[0].task_order);
    });

    it('should calculate position for moving to last', () => {
      const result = calculateReorderPosition(statusTasks, 0, 2);
      expect(result).toBeGreaterThan(statusTasks[2].task_order);
    });

    it('should calculate position for moving down within middle (1 -> 2)', () => {
      const result = calculateReorderPosition(statusTasks, 1, 2);
      // After excluding moving index 1, insert between 300 and end => should be >300 (or handled by "last" path)
      expect(result).toBeGreaterThan(statusTasks[2].task_order);
    });

    it('should calculate position for moving up within middle (2 -> 1)', () => {
      const result = calculateReorderPosition(statusTasks, 2, 1);
      // With fixed neighbor calculation, this should work correctly
      expect(result).toBeGreaterThan(statusTasks[0].task_order);  // > 100
      expect(result).toBeLessThan(statusTasks[1].task_order);     // < 200
    });

    it('should calculate position for moving between items', () => {
      const result = calculateReorderPosition(statusTasks, 0, 1);
      // Moving task 0 (order 100) to position 1 should place it before task 1 (order 200)
      // Since we removed the moving task, it should be between start and 200
      expect(result).toBeLessThan(statusTasks[1].task_order); // < 200
      expect(result).toBeGreaterThan(0); // > 0
    });

    it('should return integer values only', () => {
      const result1 = calculateReorderPosition(statusTasks, 1, 0);
      const result2 = calculateReorderPosition(statusTasks, 0, 2); 
      const result3 = calculateReorderPosition(statusTasks, 2, 1);
      
      expect(Number.isInteger(result1)).toBe(true);
      expect(Number.isInteger(result2)).toBe(true);
      expect(Number.isInteger(result3)).toBe(true);
    });

    it('should handle bounds checking correctly', () => {
      // Test with tasks that have equal order values (edge case)
      const equalTasks = [
        createMockTask('1', 100),
        createMockTask('2', 100)
      ];
      const result = calculateReorderPosition(equalTasks, 0, 1);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThan(100);
    });
  });
});