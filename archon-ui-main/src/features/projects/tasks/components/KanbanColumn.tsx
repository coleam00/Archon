import { Activity, CheckCircle2, Eye, ListTodo } from "lucide-react";
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

  const [, drop] = useDrop({
    accept: ItemTypes.TASK,
    drop: (item: { id: string; status: Task["status"] }) => {
      if (item.status !== status) {
        onTaskMove(item.id, status);
      }
    },
  });

  drop(ref);

  // Get icon and label based on status
  const getStatusInfo = () => {
    switch (status) {
      case "todo":
        return {
          icon: <ListTodo className="w-3 h-3" />,
          label: "Todo",
          color: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30",
        };
      case "doing":
        return {
          icon: <Activity className="w-3 h-3" />,
          label: "Doing",
          color: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
        };
      case "review":
        return {
          icon: <Eye className="w-3 h-3" />,
          label: "Review",
          color: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30",
        };
      case "done":
        return {
          icon: <CheckCircle2 className="w-3 h-3" />,
          label: "Done",
          color: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30",
        };
      default:
        return {
          icon: <ListTodo className="w-3 h-3" />,
          label: "Todo",
          color: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30",
        };
    }
  };

  const statusInfo = getStatusInfo();

  return (
    <div ref={ref} className="flex flex-col h-full">
      {/* Column Header - pill badge only */}
      <div className="text-center py-3 relative">
        <div className="flex items-center justify-center">
          <div
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border backdrop-blur-md",
              statusInfo.color
            )}
          >
            {statusInfo.icon}
            <span className="font-medium">{statusInfo.label}</span>
            <span className="font-bold">{tasks.length}</span>
          </div>
        </div>
        {/* Colored underline */}
        <div
          className={cn(
            "absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[1px]",
            getColumnGlow(status),
            "shadow-md",
          )}
        />
      </div>

      {/* Tasks Container */}
      <div className="px-2 flex-1 overflow-y-auto space-y-2 py-3 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
        {tasks.map((task, index) => (
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
        ))}
      </div>
    </div>
  );
};
