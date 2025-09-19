import { Tag } from "lucide-react";
import type React from "react";
import { useCallback } from "react";
import { useDrag, useDrop } from "react-dnd";
import { isOptimistic } from "../../../shared/optimistic";
import { OptimisticIndicator } from "../../../ui/primitives/OptimisticIndicator";
import { useTaskActions } from "../hooks";
import type { Assignee, Task, TaskPriority } from "../types";
import { getOrderColor, getOrderGlow, ItemTypes } from "../utils/task-styles";
import { TaskPriorityComponent } from ".";
import { TaskAssignee } from "./TaskAssignee";
import { TaskCardActions } from "./TaskCardActions";

export interface TaskCardProps {
  task: Task;
  index: number;
  projectId: string; // Need this for mutations
  onTaskReorder: (taskId: string, targetIndex: number, status: Task["status"]) => void;
  onEdit?: (task: Task) => void; // Optional edit handler
  onDelete?: (task: Task) => void; // Optional delete handler
  hoveredTaskId?: string | null;
  onTaskHover?: (taskId: string | null) => void;
  selectedTasks?: Set<string>;
  onTaskSelect?: (taskId: string) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  index,
  projectId,
  onTaskReorder,
  onEdit,
  onDelete,
  hoveredTaskId,
  onTaskHover,
  selectedTasks,
  onTaskSelect,
}) => {
  // Check if task is optimistic
  const optimistic = isOptimistic(task);

  // Use business logic hook with changePriority
  const { changeAssignee, changePriority, isUpdating } = useTaskActions(projectId);

  // Handlers - now just call hook methods
  const handleEdit = useCallback(() => {
    // Call the onEdit prop if provided, otherwise log
    if (onEdit) {
      onEdit(task);
    } else {
      // Edit task - no handler provided
    }
  }, [onEdit, task]);

  const handleDelete = useCallback(() => {
    if (onDelete) {
      onDelete(task);
    } else {
      // Delete task - no handler provided
    }
  }, [onDelete, task]);

  const handlePriorityChange = useCallback(
    (priority: TaskPriority) => {
      changePriority(task.id, priority);
    },
    [changePriority, task.id],
  );

  const handleAssigneeChange = useCallback(
    (newAssignee: Assignee) => {
      changeAssignee(task.id, newAssignee);
    },
    [changeAssignee, task.id],
  );

  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TASK,
    item: { id: task.id, status: task.status, index },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging(),
    }),
  });

  const [, drop] = useDrop({
    accept: ItemTypes.TASK,
    hover: (draggedItem: { id: string; status: Task["status"]; index: number }, monitor) => {
      if (!monitor.isOver({ shallow: true })) return;
      if (draggedItem.id === task.id) return;
      if (draggedItem.status !== task.status) return;

      const draggedIndex = draggedItem.index;
      const hoveredIndex = index;

      if (draggedIndex === hoveredIndex) return;

      // Move the task immediately for visual feedback
      onTaskReorder(draggedItem.id, hoveredIndex, task.status);

      // Update the dragged item's index to prevent re-triggering
      draggedItem.index = hoveredIndex;
    },
  });

  const isHighlighted = hoveredTaskId === task.id;
  const isSelected = selectedTasks?.has(task.id) || false;

  const handleMouseEnter = () => {
    onTaskHover?.(task.id);
  };

  const handleMouseLeave = () => {
    onTaskHover?.(null);
  };

  const handleTaskClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      onTaskSelect?.(task.id);
    }
  };

  // Glassmorphism styling constants
  const cardBaseStyles =
    "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30 border border-gray-200 dark:border-gray-700 rounded-lg backdrop-blur-md";
  const transitionStyles = "transition-all duration-200 ease-in-out";

  // Subtle highlight effect for related tasks
  const highlightGlow = isHighlighted ? "border-cyan-400/50 shadow-[0_0_8px_rgba(34,211,238,0.2)]" : "";

  // Selection styling with glassmorphism
  const selectionGlow = isSelected
    ? "border-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.4)] bg-blue-50/30 dark:bg-blue-900/20"
    : "";

  // Beautiful hover effect with glowing borders
  const hoverEffectClasses =
    "group-hover:border-cyan-400/70 dark:group-hover:border-cyan-500/50 group-hover:shadow-[0_0_15px_rgba(34,211,238,0.4)] dark:group-hover:shadow-[0_0_15px_rgba(34,211,238,0.6)]";

  return (
    // biome-ignore lint/a11y/useSemanticElements: Drag-and-drop card with react-dnd - requires div for drag handle
    <div
      ref={(node) => drag(drop(node))}
      role="button"
      tabIndex={0}
      className={`w-full min-h-[140px] cursor-move relative ${isDragging ? "opacity-50 scale-90" : "scale-100 opacity-100"} ${transitionStyles} group`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTaskClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (onEdit) {
            onEdit(task);
          }
        }
      }}
    >
      <div
        className={`${cardBaseStyles} ${transitionStyles} ${hoverEffectClasses} ${highlightGlow} ${selectionGlow} ${optimistic ? "opacity-80 ring-1 ring-cyan-400/30" : ""} w-full min-h-[140px] h-full`}
      >
        {/* Priority indicator with beautiful glow */}
        <div
          className={`absolute left-0 top-0 bottom-0 w-[3px] ${getOrderColor(task.task_order)} ${getOrderGlow(task.task_order)} rounded-l-lg opacity-80 group-hover:w-[4px] group-hover:opacity-100 transition-all duration-300`}
        />

        {/* Content container with fixed padding */}
        <div className="flex flex-col h-full p-3">
          {/* Header with feature and actions */}
          <div className="flex items-center gap-2 mb-2 pl-1.5">
            {task.feature && (
              <div
                className="px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 backdrop-blur-md"
                style={{
                  backgroundColor: `${task.featureColor}20`,
                  color: task.featureColor,
                  boxShadow: `0 0 10px ${task.featureColor}20`,
                }}
              >
                <Tag className="w-3 h-3" />
                {task.feature}
              </div>
            )}

            {/* Optimistic indicator */}
            <OptimisticIndicator isOptimistic={optimistic} className="ml-auto" />

            {/* Action buttons group */}
            <div className={`${optimistic ? "" : "ml-auto"} flex items-center gap-1.5`}>
              <TaskCardActions
                taskId={task.id}
                taskTitle={task.title}
                onEdit={handleEdit}
                onDelete={handleDelete}
                isDeleting={false}
              />
            </div>
          </div>

          {/* Title */}
          <h4
            className="text-xs font-medium text-gray-900 dark:text-white mb-2 pl-1.5 line-clamp-2 overflow-hidden"
            title={task.title}
          >
            {task.title}
          </h4>

          {/* Description - visible when task has description */}
          {task.description && (
            <div className="pl-1.5 pr-3 mb-2 flex-1">
              <p
                className="text-xs text-gray-600 dark:text-gray-400 line-clamp-3 break-words whitespace-pre-wrap opacity-75"
                style={{ fontSize: "11px" }}
              >
                {task.description}
              </p>
            </div>
          )}

          {/* Spacer when no description */}
          {!task.description && <div className="flex-1"></div>}

          {/* Footer with assignee - glassmorphism styling */}
          <div className="flex items-center justify-between mt-auto pt-2 pl-1.5 pr-3">
            <TaskAssignee assignee={task.assignee} onAssigneeChange={handleAssigneeChange} isLoading={isUpdating} />

            {/* Priority display connected to database */}
            <TaskPriorityComponent
              priority={task.priority}
              onPriorityChange={handlePriorityChange}
              isLoading={isUpdating}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
