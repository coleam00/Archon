import React, { useRef, useState, useCallback } from 'react';
import { useDrop } from 'react-dnd';
import { useToast } from '../../contexts/ToastContext';
import { DeleteConfirmModal } from '../common/DeleteConfirmModal';
import { Trash2 } from 'lucide-react';
import { Task } from './TaskTableView'; // Import Task interface
import { ItemTypes, getAssigneeIcon, getAssigneeGlow, getOrderColor, getOrderGlow } from '../../lib/task-utils';
import { DraggableTaskCard } from './DraggableTaskCard';

interface TaskBoardViewProps {
  tasks: Task[];
  onTaskView: (task: Task) => void;
  onTaskComplete: (taskId: string) => void;
  onTaskDelete: (task: Task) => void;
  onTaskMove: (taskId: string, newStatus: Task['status']) => void;
  onTaskReorder: (taskId: string, targetIndex: number, status: Task['status']) => void;
}

interface ColumnDropZoneProps {
  status: Task['status'];
  title: string;
  tasks: Task[];
  onTaskMove: (taskId: string, newStatus: Task['status']) => void;
  onTaskView: (task: Task) => void;
  onTaskDelete: (task: Task) => void;
  onTaskReorder: (taskId: string, targetIndex: number, status: Task['status']) => void;
  allTasks: Task[];
  hoveredTaskId: string | null;
  onTaskHover: (taskId: string | null) => void;
  selectedTasks: Set<string>;
  onTaskSelect: (taskId: string) => void;
}

const ColumnDropZone = ({
  status,
  title,
  tasks,
  onTaskMove,
  onTaskView,
  onTaskDelete,
  onTaskReorder,
  allTasks,
  hoveredTaskId,
  onTaskHover,
  selectedTasks,
  onTaskSelect
}: ColumnDropZoneProps) => {
  const ref = useRef<HTMLDivElement>(null);
  
  const [{ isOver }, drop] = useDrop({
    accept: ItemTypes.TASK,
    drop: (item: { id: string; status: Task['status'] }) => {
      if (item.status !== status) {
        // Moving to different status - use length of current column as new order
        onTaskMove(item.id, status);
      }
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver()
    })
  });

  drop(ref);

  // Get column header color based on status
  const getColumnColor = () => {
    switch (status) {
      case 'todo':
        return 'text-gray-600 dark:text-gray-400';
      case 'doing':
        return 'text-blue-600 dark:text-blue-400';
      case 'review':
        return 'text-purple-600 dark:text-purple-400';
      case 'done':
        return 'text-green-600 dark:text-green-400';
    }
  };

  // Get column header glow based on status
  const getColumnGlow = () => {
    switch (status) {
      case 'todo':
        return 'bg-gray-500/30';
      case 'doing':
        return 'bg-blue-500/30 shadow-[0_0_10px_2px_rgba(59,130,246,0.2)]';
      case 'review':
        return 'bg-purple-500/30 shadow-[0_0_10px_2px_rgba(168,85,247,0.2)]';
      case 'done':
        return 'bg-green-500/30 shadow-[0_0_10px_2px_rgba(16,185,129,0.2)]';
    }
  };

  // Just use the tasks as-is since they're already parent tasks only
  const organizedTasks = tasks;

  return (
    <div 
      ref={ref} 
      className={`flex flex-col bg-white/20 dark:bg-black/30 ${isOver ? 'bg-gray-100/50 dark:bg-gray-800/20 border-t-2 border-t-[#00ff00] shadow-[inset_0_1px_10px_rgba(0,255,0,0.1)]' : ''} transition-colors duration-200 h-full`}
    >
      <div className="text-center py-3 sticky top-0 z-10 bg-white/80 dark:bg-black/80 backdrop-blur-sm">
        <h3 className={`font-mono ${getColumnColor()} text-sm`}>{title}</h3>
        {/* Column header divider with glow */}
        <div className={`absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[1px] ${getColumnGlow()}`}></div>
      </div>
      
      <div className="px-1 flex-1 overflow-y-auto space-y-3 py-3">
        {organizedTasks.map((task, index) => (
          <DraggableTaskCard
            key={task.id}
            task={task}
            index={index}
            onView={() => onTaskView(task)}
            onComplete={() => onTaskComplete(task.id)}
            onDelete={onTaskDelete}
            onTaskReorder={onTaskReorder}
            hoveredTaskId={hoveredTaskId}
            onTaskHover={onTaskHover}
            selectedTasks={selectedTasks}
            onTaskSelect={onTaskSelect}
          />
        ))}
      </div>
    </div>
  );
};

export const TaskBoardView = ({
  tasks,
  onTaskView,
  onTaskComplete,
  onTaskDelete,
  onTaskMove,
  onTaskReorder
}: TaskBoardViewProps) => {
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());

  // State for delete confirmation modal
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);

  const { showToast } = useToast();

  // Multi-select handlers
  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTasks(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(taskId)) {
        newSelection.delete(taskId);
      } else {
        newSelection.add(taskId);
      }
      return newSelection;
    });
  }, []);

  const selectAllTasks = useCallback(() => {
    setSelectedTasks(new Set(tasks.map(task => task.id)));
  }, [tasks]);

  const clearSelection = useCallback(() => {
    setSelectedTasks(new Set());
  }, []);

  // Mass delete handler
  const handleMassDelete = useCallback(async () => {
    if (selectedTasks.size === 0) return;

    const tasksToDelete = tasks.filter(task => selectedTasks.has(task.id));
    
    try {
      const results = await Promise.allSettled(
        tasksToDelete.map(task => Promise.resolve(onTaskDelete(task)))
      );
      const rejected = results.filter(r => r.status === 'rejected');
      if (rejected.length) {
        console.error('Some deletions failed:', rejected.length);
      }
      clearSelection();
    } catch (error) {
      console.error('Failed to delete tasks:', error);
    }
  }, [selectedTasks, tasks, onTaskDelete, clearSelection]);

  // Mass status change handler
  const handleMassStatusChange = useCallback(async (newStatus: Task['status']) => {
    if (selectedTasks.size === 0) return;

    const tasksToUpdate = tasks.filter(task => selectedTasks.has(task.id));
    
    try {
      // Call onTaskMove so optimistic UI and counts refresh immediately; parent persists
      tasksToUpdate.forEach(task => onTaskMove(task.id, newStatus));
      clearSelection();
      showToast(`Moved ${tasksToUpdate.length} task${tasksToUpdate.length !== 1 ? 's' : ''} to ${newStatus}`, 'success');
    } catch (error) {
      console.error('Failed to update tasks:', error);
      showToast('Failed to move some tasks', 'error');
    }
  }, [selectedTasks, tasks, onTaskMove, clearSelection, showToast]);

  // No status mapping needed - using database values directly

  // Handle task deletion (opens confirmation modal)
  const handleDeleteTask = useCallback((task: Task) => {
    setTaskToDelete(task);
    setShowDeleteConfirm(true);
  }, [setTaskToDelete, setShowDeleteConfirm]);

  // Confirm deletion and execute
  const confirmDeleteTask = useCallback(async () => {
    if (!taskToDelete) return;

    try {
      // Delegate deletion to parent to avoid duplicate API calls
      await onTaskDelete(taskToDelete);
    } catch (error) {
      console.error('Failed to delete task:', error);
    } finally {
      setShowDeleteConfirm(false);
      setTaskToDelete(null);
    }
  }, [taskToDelete, onTaskDelete, setShowDeleteConfirm, setTaskToDelete]);

  // Cancel deletion
  const cancelDeleteTask = useCallback(() => {
    setShowDeleteConfirm(false);
    setTaskToDelete(null);
  }, [setShowDeleteConfirm, setTaskToDelete]);

  // Simple task filtering for board view
  const getTasksByStatus = (status: Task['status']) => {
    return tasks
      .filter(task => task.status === status)
      .sort((a, b) => a.task_order - b.task_order);
  };

  // Note: With optimistic updates, we no longer show loading overlays for successful moves
  // Tasks update instantly and only rollback on actual failures

  return (
    <div className="flex flex-col h-full min-h-[70vh] relative">

      {/* Multi-select toolbar */}
      {selectedTasks.size > 0 && (
        <div className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
              {selectedTasks.size} task{selectedTasks.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Status change dropdown */}
            <select
              className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              onChange={(e) => {
                if (e.target.value) {
                  handleMassStatusChange(e.target.value as Task['status']);
                  e.target.value = ''; // Reset dropdown
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>Move to...</option>
              <option value="todo">Todo</option>
              <option value="doing">Doing</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </select>
            
            {/* Mass delete button */}
            <button
              onClick={handleMassDelete}
              className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded flex items-center gap-1"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
            
            {/* Clear selection */}
            <button
              onClick={clearSelection}
              className="px-3 py-1 text-sm bg-gray-600 hover:bg-gray-700 text-white rounded"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Board Columns */}
      <div className="grid grid-cols-4 gap-0 flex-1">
        {/* Todo Column */}
        <ColumnDropZone
          status="todo"
          title="Todo"
          tasks={getTasksByStatus('todo')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskDelete={handleDeleteTask}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
        
        {/* Doing Column */}
        <ColumnDropZone
          status="doing"
          title="Doing"
          tasks={getTasksByStatus('doing')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskDelete={handleDeleteTask}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
        
        {/* Review Column */}
        <ColumnDropZone
          status="review"
          title="Review"
          tasks={getTasksByStatus('review')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskDelete={handleDeleteTask}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
        
        {/* Done Column */}
        <ColumnDropZone
          status="done"
          title="Done"
          tasks={getTasksByStatus('done')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskDelete={handleDeleteTask}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
      </div>

      {/* Delete Confirmation Modal for Tasks */}
      {showDeleteConfirm && taskToDelete && (
        <DeleteConfirmModal
          itemName={taskToDelete.title}
          onConfirm={confirmDeleteTask}
          onCancel={cancelDeleteTask}
          type="task"
        />
      )}
    </div>
  );
};