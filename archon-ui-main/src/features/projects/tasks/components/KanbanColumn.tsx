import { useRef } from "react";
import { useDrop } from "react-dnd";
import { cn } from "../../../ui/primitives/styles";
import type { Task } from "../types";
import { getColumnColor, getColumnGlow, ItemTypes } from "../utils/task-styles";
import { TaskCard } from "./TaskCard";

interface KanbanColumnProps {
  status: Task["status"];
  title: string;
  tasks: Task[];
  projectId: string;
  onTaskMove: (taskId: string, newStatus: Task["status"]) => void;
  onTaskReorder: (taskId: string, targetIndex: number, status: Task["status"]) => void;
  onTaskEdit?: (task: Task) => void;
  onTaskDelete?: (task: Task) => void;
  hoveredTaskId: string | null;
  onTaskHover: (taskId: string | null) => void;
}

export const KanbanColumn = ({
  status,
  title,
  tasks,
  projectId,
  onTaskMove,
  onTaskReorder,
  onTaskEdit,
  onTaskDelete,
  hoveredTaskId,
  onTaskHover,
}: KanbanColumnProps) => {
  const ref = useRef<HTMLDivElement>(null);

  const [{ isOver }, drop] = useDrop({
    accept: ItemTypes.TASK,
    drop: (item: { id: string; status: Task["status"] }) => {
      if (item.status !== status) {
        onTaskMove(item.id, status);
      }
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver(),
    }),
  });

  drop(ref);

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col h-full",
        "bg-gradient-to-b from-white/20 to-transparent dark:from-black/30 dark:to-transparent",
        "backdrop-blur-sm",
        "transition-all duration-200",
        isOver && "bg-gradient-to-b from-cyan-500/5 to-purple-500/5 dark:from-cyan-400/10 dark:to-purple-400/10",
        isOver && "border-t-2 border-t-cyan-400/50 dark:border-t-cyan-400/70",
        isOver &&
          "shadow-[inset_0_2px_20px_rgba(34,211,238,0.15)] dark:shadow-[inset_0_2px_30px_rgba(34,211,238,0.25)]",
        isOver && "backdrop-blur-md",
      )}
    >
      {/* Column Header with Glassmorphism */}
      <div
        className={cn(
          "text-center py-3 sticky top-0 z-10",
          "bg-gradient-to-b from-white/80 to-white/60 dark:from-black/80 dark:to-black/60",
          "backdrop-blur-md",
          "border-b border-gray-200/50 dark:border-gray-700/50",
          "relative",
        )}
      >
        <h3 className={cn("font-mono text-sm font-medium", getColumnColor(status))}>{title}</h3>
        {/* Column header glow effect */}
        <div
          className={cn("absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[1px]", getColumnGlow(status))}
        />
      </div>

      {/* Tasks Container */}
      <div className="px-2 flex-1 overflow-y-auto space-y-2 py-3 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
        {tasks.length === 0 ? (
          <div className={cn("text-center py-8 text-gray-400 dark:text-gray-600 text-sm", "opacity-60")}>No tasks</div>
        ) : (
          tasks.map((task, index) => (
            <TaskCard
              key={task.id}
              task={task}
              index={index}
              projectId={projectId}
              onTaskReorder={onTaskReorder}
              onEdit={onTaskEdit}
              onDelete={onTaskDelete}
              hoveredTaskId={hoveredTaskId}
              onTaskHover={onTaskHover}
            />
          ))
        )}
      </div>
    </div>
  );
};
