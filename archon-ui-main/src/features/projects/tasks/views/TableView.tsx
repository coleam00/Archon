import { Check, Edit, Tag, Trash2 } from "lucide-react";
import React, { useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import { EditableTableCell } from "../components/EditableTableCell";
import { TaskAssignee } from "../components/TaskAssignee";
import { useDeleteTask, useUpdateTask } from "../hooks";
import type { Assignee, Task } from "../types";
import { getOrderColor, getOrderGlow, ItemTypes } from "../utils/task-styles";

interface TableViewProps {
  tasks: Task[];
  projectId: string;
  onTaskView?: (task: Task) => void;
  onTaskComplete?: (taskId: string) => void;
  onTaskDelete?: (task: Task) => void;
  onTaskReorder: (taskId: string, newOrder: number, status: Task["status"]) => void;
  onTaskUpdate?: (taskId: string, updates: Partial<Task>) => Promise<void>;
}

interface DraggableRowProps {
  task: Task;
  index: number;
  projectId: string;
  onTaskView?: (task: Task) => void;
  onTaskComplete?: (taskId: string) => void;
  onTaskDelete?: (task: Task) => void;
  onTaskReorder: (taskId: string, newOrder: number, status: Task["status"]) => void;
}

const DraggableRow = ({
  task,
  index,
  projectId,
  onTaskView,
  onTaskComplete,
  onTaskDelete,
  onTaskReorder,
}: DraggableRowProps) => {
  const updateTaskMutation = useUpdateTask(projectId);
  const deleteTaskMutation = useDeleteTask(projectId);
  const [localAssignee, setLocalAssignee] = useState<Assignee>(task.assignee);

  // Drag and drop handlers
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TASK,
    item: { id: task.id, index, status: task.status },
    collect: (monitor) => ({
      isDragging: !!monitor.isDragging(),
    }),
  });

  const [{ isOver }, drop] = useDrop({
    accept: ItemTypes.TASK,
    hover: (draggedItem: { id: string; index: number; status: Task["status"] }, monitor) => {
      if (!monitor.isOver({ shallow: true })) return;
      if (draggedItem.id === task.id) return;
      if (draggedItem.status !== task.status) return;

      const draggedIndex = draggedItem.index;
      const hoveredIndex = index;

      if (draggedIndex === hoveredIndex) return;

      // Move the task for visual feedback
      onTaskReorder(draggedItem.id, hoveredIndex, task.status);

      // Update the dragged item's index
      draggedItem.index = hoveredIndex;
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver(),
    }),
  });

  // Handle field updates using mutations
  const handleUpdateField = async (field: keyof Task, value: string) => {
    const updates: Partial<Task> = { [field]: value };

    await updateTaskMutation.mutateAsync({
      taskId: task.id,
      updates,
    });
  };

  const handleAssigneeChange = (newAssignee: Assignee) => {
    setLocalAssignee(newAssignee);
    updateTaskMutation.mutate({
      taskId: task.id,
      updates: { assignee: newAssignee },
    });
  };

  const handleDelete = () => {
    if (onTaskDelete) {
      onTaskDelete(task);
    }
  };

  const handleComplete = () => {
    if (onTaskComplete) {
      onTaskComplete(task.id);
    }
  };

  const handleEdit = () => {
    if (onTaskView) {
      onTaskView(task);
    }
  };

  return (
    <tr
      ref={(node) => drag(drop(node))}
      className={cn(
        "group transition-all duration-200 cursor-move",
        index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
        "hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70",
        "dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20",
        "border-b border-gray-200 dark:border-gray-800",
        isDragging && "opacity-50 scale-105 shadow-lg",
        isOver && "bg-cyan-100/50 dark:bg-cyan-900/20 border-cyan-400",
      )}
    >
      {/* Priority/Order Indicator */}
      <td className="w-1 p-0">
        <div className={cn("w-1 h-full", getOrderColor(task.task_order), getOrderGlow(task.task_order))} />
      </td>

      {/* Title */}
      <td className="px-4 py-2">
        <EditableTableCell
          value={task.title}
          onSave={(value) => handleUpdateField("title", value)}
          placeholder="Enter task title"
          className="font-medium"
          isUpdating={updateTaskMutation.isPending}
        />
      </td>

      {/* Status */}
      <td className="px-4 py-2 w-32">
        <EditableTableCell
          value={task.status}
          onSave={(value) => handleUpdateField("status", value)}
          type="status"
          isUpdating={updateTaskMutation.isPending}
        />
      </td>

      {/* Feature */}
      <td className="px-4 py-2 w-40">
        <div className="flex items-center gap-1">
          {task.feature && <Tag className="w-3 h-3 text-gray-500 dark:text-gray-400" />}
          <EditableTableCell
            value={task.feature || ""}
            onSave={(value) => handleUpdateField("feature", value)}
            placeholder="Add feature"
            className="text-sm"
            isUpdating={updateTaskMutation.isPending}
          />
        </div>
      </td>

      {/* Assignee */}
      <td className="px-4 py-2 w-36">
        <TaskAssignee
          assignee={localAssignee}
          onAssigneeChange={handleAssigneeChange}
          isLoading={updateTaskMutation.isPending}
        />
      </td>

      {/* Actions */}
      <td className="px-4 py-2 w-28">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="xs" onClick={handleEdit} className="h-7 w-7 p-0">
                  <Edit className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit task</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleComplete}
                  className="h-7 w-7 p-0 text-green-600 hover:text-green-700"
                >
                  <Check className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark as complete</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handleDelete}
                  className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                  disabled={deleteTaskMutation.isPending}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete task</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </td>
    </tr>
  );
};

export const TableView = ({
  tasks,
  projectId,
  onTaskView,
  onTaskComplete,
  onTaskDelete,
  onTaskReorder,
}: TableViewProps) => {
  // Group tasks by status for better organization
  const groupedTasks = React.useMemo(() => {
    const groups: Record<Task["status"], Task[]> = {
      todo: [],
      doing: [],
      review: [],
      done: [],
    };

    tasks.forEach((task) => {
      groups[task.status].push(task);
    });

    // Sort each group by task_order
    Object.keys(groups).forEach((status) => {
      groups[status as Task["status"]].sort((a, b) => a.task_order - b.task_order);
    });

    return groups;
  }, [tasks]);

  const statusOrder: Task["status"][] = ["todo", "doing", "review", "done"];

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
            <th className="w-1"></th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Title</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Status</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-40">Feature</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-36">Assignee</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-28">Actions</th>
          </tr>
        </thead>
        <tbody>
          {statusOrder.map((status) => {
            const statusTasks = groupedTasks[status];
            if (statusTasks.length === 0) return null;

            return (
              <React.Fragment key={status}>
                {/* Status group header */}
                <tr className="bg-gray-100/50 dark:bg-gray-800/50">
                  <td colSpan={6} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-xs font-semibold uppercase tracking-wider",
                          status === "todo" && "text-gray-600",
                          status === "doing" && "text-blue-600",
                          status === "review" && "text-purple-600",
                          status === "done" && "text-green-600",
                        )}
                      >
                        {status} ({statusTasks.length})
                      </span>
                    </div>
                  </td>
                </tr>
                {/* Tasks in this status */}
                {statusTasks.map((task, index) => (
                  <DraggableRow
                    key={task.id}
                    task={task}
                    index={index}
                    projectId={projectId}
                    onTaskView={onTaskView}
                    onTaskComplete={onTaskComplete}
                    onTaskDelete={onTaskDelete}
                    onTaskReorder={onTaskReorder}
                  />
                ))}
              </React.Fragment>
            );
          })}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={6} className="text-center py-8 text-gray-400">
                No tasks yet. Create your first task to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
