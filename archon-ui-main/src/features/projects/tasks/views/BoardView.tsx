import { useState } from "react";
import { KanbanColumn } from "../components/KanbanColumn";
import type { Task } from "../types";

interface BoardViewProps {
  tasks: Task[];
  projectId: string;
  onTaskMove: (taskId: string, newStatus: Task["status"]) => void;
  onTaskReorder: (taskId: string, targetIndex: number, status: Task["status"]) => void;
  onTaskEdit?: (task: Task) => void;
  onTaskDelete?: (task: Task) => void;
}

export const BoardView = ({
  tasks,
  projectId,
  onTaskMove,
  onTaskReorder,
  onTaskEdit,
  onTaskDelete,
}: BoardViewProps) => {
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  // Simple task filtering for board view
  const getTasksByStatus = (status: Task["status"]) => {
    return tasks.filter((task) => task.status === status).sort((a, b) => a.task_order - b.task_order);
  };

  // Column configuration
  const columns: Array<{ status: Task["status"]; title: string }> = [
    { status: "todo", title: "Todo" },
    { status: "doing", title: "Doing" },
    { status: "review", title: "Review" },
    { status: "done", title: "Done" },
  ];

  return (
    <div className="flex flex-col h-full min-h-[70vh] relative">
      {/* Board Columns Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 flex-1 p-2 min-h-[500px]">
        {columns.map(({ status, title }) => (
          <KanbanColumn
            key={status}
            status={status}
            title={title}
            tasks={getTasksByStatus(status)}
            projectId={projectId}
            onTaskMove={onTaskMove}
            onTaskReorder={onTaskReorder}
            onTaskEdit={onTaskEdit}
            onTaskDelete={onTaskDelete}
            hoveredTaskId={hoveredTaskId}
            onTaskHover={setHoveredTaskId}
          />
        ))}
      </div>
    </div>
  );
};
