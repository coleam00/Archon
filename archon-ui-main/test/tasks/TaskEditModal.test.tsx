import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { renderWithProviders } from '../../src/features/testing/test-utils';
import { TaskEditModal } from '../../src/features/projects/tasks/components/TaskEditModal';

// Mock business logic hooks used by the component
vi.mock('../../src/features/projects/tasks/hooks', () => ({
  useTaskEditor: () => ({
    projectFeatures: [],
    saveTask: vi.fn(),
    isLoadingFeatures: false,
    isSaving: false,
  }),
}));

vi.mock('../../src/features/projects/tasks/hooks/useTaskQueries', () => ({
  useTaskDetails: (_id?: string, _opts?: any) => ({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  }),
}));

describe('TaskEditModal safety states', () => {
  it('disables save when editing existing task and details are not loaded yet', () => {
    renderWithProviders(
      <TaskEditModal
        isModalOpen={true}
        editingTask={{ id: 't-1', project_id: 'p1', title: 'T', description: '', status: 'todo', assignee: 'User', task_order: 1, created_at: '', updated_at: '' } as any}
        projectId="p1"
        onClose={() => {}}
      />
    );

    // Button shows "Update Task" for existing tasks
    const saveBtn = screen.getByRole('button', { name: /update task/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables save for new task when title is provided', () => {
    renderWithProviders(
      <TaskEditModal
        isModalOpen={true}
        editingTask={null}
        projectId="p1"
        onClose={() => {}}
      />
    );

    // Initially disabled because title empty
    const createBtn = screen.getByRole('button', { name: /create task/i });
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);

    // Fill in title
    const titleInput = screen.getByPlaceholderText(/enter task title/i) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'New Task' } });

    // Now enabled
    expect((createBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

