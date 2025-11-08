import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../../testing/test-utils";
import type { Task } from "../../types";
import { TaskCard } from "../TaskCard";

// Mock hooks
vi.mock("../../hooks", () => ({
  useTaskActions: vi.fn(() => ({
    changeAssignee: vi.fn(),
    changePriority: vi.fn(),
    isUpdating: false,
  })),
}));

describe("TaskCard", () => {
  const mockTask: Task = {
    id: "test-task-id",
    project_id: "test-project-id",
    title: "Test Task",
    description: "Test task description",
    status: "todo",
    assignee: "User",
    priority: "medium",
    task_order: 1,
    feature: "Test Feature",
    featureColor: "#8B5CF6",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const renderTaskCard = (props: any) => {
    return renderWithProviders(
      <DndProvider backend={HTML5Backend}>
        <TaskCard {...props} />
      </DndProvider>,
    );
  };

  it("renders task card correctly", () => {
    const { container } = renderTaskCard({
      task: mockTask,
      index: 0,
      projectId: "test-project-id",
      onTaskReorder: vi.fn(),
    });
    expect(container).toBeTruthy();
  });

  it("displays task title", () => {
    const { getByText } = renderTaskCard({
      task: mockTask,
      index: 0,
      projectId: "test-project-id",
      onTaskReorder: vi.fn(),
    });
    expect(getByText("Test Task")).toBeInTheDocument();
  });

  it("displays task description", () => {
    const { getByText } = renderTaskCard({
      task: mockTask,
      index: 0,
      projectId: "test-project-id",
      onTaskReorder: vi.fn(),
    });
    expect(getByText("Test task description")).toBeInTheDocument();
  });

  it("displays feature tag", () => {
    const { getByText } = renderTaskCard({
      task: mockTask,
      index: 0,
      projectId: "test-project-id",
      onTaskReorder: vi.fn(),
    });
    expect(getByText("Test Feature")).toBeInTheDocument();
  });

  it("matches snapshot", () => {
    const { container } = renderTaskCard({
      task: mockTask,
      index: 0,
      projectId: "test-project-id",
      onTaskReorder: vi.fn(),
    });
    expect(container).toMatchSnapshot();
  });
});
