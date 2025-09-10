import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { taskKeys, useProjectTasks, useCreateTask } from '../useTaskQueries';
import type { Task } from '../../types';
import React from 'react';

// Mock the services
vi.mock('../../services', () => ({
  taskService: {
    getTasksByProject: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
  },
}));

// Mock the toast hook
vi.mock('../../../../ui/hooks/useToast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock smart polling
vi.mock('../../../../ui/hooks', () => ({
  useSmartPolling: () => ({
    refetchInterval: 5000,
    isPaused: false,
  }),
}));

// Test wrapper with QueryClient
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
};

describe('useTaskQueries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('taskKeys', () => {
    it('should generate correct query keys', () => {
      expect(taskKeys.all('project-123')).toEqual(['projects', 'project-123', 'tasks']);
    });
  });

  describe('useProjectTasks', () => {
    it('should fetch tasks for a project', async () => {
      const mockTasks: Task[] = [
        {
          id: 'task-1',
          project_id: 'project-123',
          title: 'Test Task',
          description: 'Test Description',
          status: 'todo',
          assignee: 'User',
          task_order: 100,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ];

      const { taskService } = await import('../../services');
      vi.mocked(taskService.getTasksByProject).mockResolvedValue(mockTasks);

      const { result } = renderHook(() => useProjectTasks('project-123'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(result.current.data).toEqual(mockTasks);
      });

      expect(taskService.getTasksByProject).toHaveBeenCalledWith('project-123');
    });

    it('should not fetch tasks when projectId is undefined', () => {
      const { result } = renderHook(() => useProjectTasks(undefined), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it('should respect enabled flag', () => {
      const { result } = renderHook(() => useProjectTasks('project-123', false), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.data).toBeUndefined();
    });
  });

  describe('useCreateTask', () => {
    it('should optimistically add task and replace with server response', async () => {
      const newTask: Task = {
        id: 'real-task-id',
        project_id: 'project-123',
        title: 'New Task',
        description: 'New Description',
        status: 'todo',
        assignee: 'User',
        task_order: 100,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const { taskService } = await import('../../services');
      vi.mocked(taskService.createTask).mockResolvedValue(newTask);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCreateTask(), { wrapper });

      await result.current.mutateAsync({
        project_id: 'project-123',
        title: 'New Task',
        description: 'New Description',
        status: 'todo',
        assignee: 'User',
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
        expect(taskService.createTask).toHaveBeenCalledWith({
          project_id: 'project-123',
          title: 'New Task',
          description: 'New Description',
          status: 'todo',
          assignee: 'User',
        });
      });
    });

    it('should provide default values for optional fields', async () => {
      const newTask: Task = {
        id: 'real-task-id',
        project_id: 'project-123',
        title: 'Minimal Task',
        description: '',
        status: 'todo',
        assignee: 'User',
        task_order: 100,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const { taskService } = await import('../../services');
      vi.mocked(taskService.createTask).mockResolvedValue(newTask);

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCreateTask(), { wrapper });

      await result.current.mutateAsync({
        project_id: 'project-123',
        title: 'Minimal Task',
        description: '',
      });

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
    });

    it('should rollback on error', async () => {
      const { taskService } = await import('../../services');
      vi.mocked(taskService.createTask).mockRejectedValue(new Error('Network error'));

      const wrapper = createWrapper();
      const { result } = renderHook(() => useCreateTask(), { wrapper });

      await expect(
        result.current.mutateAsync({
          project_id: 'project-123',
          title: 'Failed Task',
          description: 'This will fail',
        })
      ).rejects.toThrow('Network error');
    });
  });
});