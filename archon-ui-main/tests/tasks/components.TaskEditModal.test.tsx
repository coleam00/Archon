import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock lucide-react icons used by primitives (ComboBox)
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ChevronsUpDown: (props: any) => React.createElement('svg', props),
    Check: (props: any) => React.createElement('svg', props),
  };
});

// SUT
import { TaskEditModal } from '../../src/features/projects/tasks/components/TaskEditModal';

// Types
import type { Task } from '../../src/features/projects/tasks/types';

// Mocks
vi.mock('../../src/features/projects/tasks/hooks', () => ({
  useTaskEditor: () => ({
    projectFeatures: [],
    saveTask: vi.fn(),
    isLoadingFeatures: false,
    isSaving: false,
  }),
}));

const refetchMock = vi.fn();

vi.mock('../../src/features/projects/tasks/hooks/useTaskQueries', () => ({
  useTaskDetails: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: refetchMock,
  })),
}));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't-1',
  project_id: 'p-1',
  title: 'My Task',
  description: 'Lightweight desc',
  status: 'todo',
  assignee: 'User',
  task_order: 1,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('TaskEditModal lazy-loading behavior', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading placeholder while details are fetching', async () => {
    const { useTaskDetails } = await import(
      '../../src/features/projects/tasks/hooks/useTaskQueries'
    );
    vi.mocked(useTaskDetails as any).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: refetchMock,
    });

    render(
      <TaskEditModal
        isModalOpen
        editingTask={makeTask()}
        projectId="p-1"
        onClose={onClose}
      />,
    );

    expect(await screen.findByText(/Loading task details/i)).toBeInTheDocument();
    const saveBtn = await screen.findByRole('button', { name: /update task/i });
    expect(saveBtn).toBeDisabled();
  });

  it('shows error state with retry and prevents save when details failed', async () => {
    const { useTaskDetails } = await import(
      '../../src/features/projects/tasks/hooks/useTaskQueries'
    );
    vi.mocked(useTaskDetails as any).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchMock,
    });

    render(
      <TaskEditModal
        isModalOpen
        editingTask={makeTask()}
        projectId="p-1"
        onClose={onClose}
      />,
    );

    expect(await screen.findByText(/Failed to load task details/i)).toBeInTheDocument();

    // Retry button calls refetch
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetchMock).toHaveBeenCalled();

    // Save is disabled
    const saveBtn = await screen.findByRole('button', { name: /update task/i });
    expect(saveBtn).toBeDisabled();
  });

  it('allows normal create-new flow without lazy details', async () => {
    const { useTaskDetails } = await import(
      '../../src/features/projects/tasks/hooks/useTaskQueries'
    );
    // Not editing existing: hook should not block UI even if mocked
    vi.mocked(useTaskDetails as any).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetchMock,
    });

    render(
      <TaskEditModal
        isModalOpen
        editingTask={null}
        projectId="p-1"
        onClose={onClose}
      />,
    );

    // Create button should be enabled only after title entered; initially disabled due to empty title
    const createBtn = await screen.findByRole('button', { name: /create task/i });
    expect(createBtn).toBeDisabled();
  });
});

