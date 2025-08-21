import React, { useRef, useState, useCallback } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { useToast } from '../../contexts/ToastContext';
import { DeleteConfirmModal } from '../ui/DeleteConfirmModal';
import { CheckSquare, Square, Trash2, ArrowRight } from 'lucide-react';
import { projectService } from '../../services/projectService';
import { Task } from './TaskTableView'; // Import Task interface
import { ItemTypes, getAssigneeIcon, getAssigneeGlow, getOrderColor, getOrderGlow } from '../../lib/task-utils';
import { DraggableTaskCard, DraggableTaskCardProps } from './DraggableTaskCard'; // Import the new component and its props

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
  onTaskComplete: (taskId: string) => void;
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
  onTaskComplete,
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
    drop: (item: { id: string; status: string }) => {
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
      case 'backlog':
        return 'text-gray-600 dark:text-gray-400';
      case 'in-progress':
        return 'text-blue-600 dark:text-blue-400';
      case 'review':
        return 'text-purple-600 dark:text-purple-400';
      case 'complete':
        return 'text-green-600 dark:text-green-400';
    }
  };

  // Get column header glow based on status
  const getColumnGlow = () => {
    switch (status) {
      case 'backlog':
        return 'bg-gray-500/30';
      case 'in-progress':
        return 'bg-blue-500/30 shadow-[0_0_10px_2px_rgba(59,130,246,0.2)]';
      case 'review':
        return 'bg-purple-500/30 shadow-[0_0_10px_2px_rgba(168,85,247,0.2)]';
      case 'complete':
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
            tasksInStatus={organizedTasks}
            allTasks={allTasks}
            hoveredTaskId={hoveredTaskId}
            onTaskHover={onTaskHover}
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
      // Delete all selected tasks
      await Promise.all(
        tasksToDelete.map(task => projectService.deleteTask(task.id))
      );
      
      // Clear selection
      clearSelection();
      
      showToast(`${tasksToDelete.length} tasks deleted successfully`, 'success');
    } catch (error) {
      console.error('Failed to delete tasks:', error);
      showToast('Failed to delete some tasks', 'error');
    }
  }, [selectedTasks, tasks, clearSelection, showToast]);

  // Mass status change handler
  const handleMassStatusChange = useCallback(async (newStatus: Task['status']) => {
    if (selectedTasks.size === 0) return;

    const tasksToUpdate = tasks.filter(task => selectedTasks.has(task.id));
    
    try {
      // Update all selected tasks
      await Promise.all(
        tasksToUpdate.map(task => 
          projectService.updateTask(task.id, { 
            status: mapUIStatusToDBStatus(newStatus) 
          })
        )
      );
      
      // Clear selection
      clearSelection();
      
      showToast(`${tasksToUpdate.length} tasks moved to ${newStatus}`, 'success');
    } catch (error) {
      console.error('Failed to update tasks:', error);
      showToast('Failed to update some tasks', 'error');
    }
  }, [selectedTasks, tasks, clearSelection, showToast]);

  // Helper function to map UI status to DB status (reuse from TasksTab)
  const mapUIStatusToDBStatus = (uiStatus: Task['status']) => {
    switch (uiStatus) {
      case 'backlog': return 'todo';
      case 'in-progress': return 'doing';
      case 'review': return 'review';
      case 'complete': return 'done';
      default: return 'todo';
    }
  };

  // Handle task deletion (opens confirmation modal)
  const handleDeleteTask = useCallback((task: Task) => {
    setTaskToDelete(task);
    setShowDeleteConfirm(true);
  }, [setTaskToDelete, setShowDeleteConfirm]);

  // Confirm deletion and execute
  const confirmDeleteTask = useCallback(async () => {
    if (!taskToDelete) return;

    try {
      await projectService.deleteTask(taskToDelete.id);
      // Notify parent to update tasks
      onTaskDelete(taskToDelete);
      showToast(`Task "${taskToDelete.title}" deleted successfully`, 'success');
    } catch (error) {
      console.error('Failed to delete task:', error);
      showToast(error instanceof Error ? error.message : 'Failed to delete task', 'error');
    } finally {
      setShowDeleteConfirm(false);
      setTaskToDelete(null);
    }
  }, [taskToDelete, onTaskDelete, showToast, setShowDeleteConfirm, setTaskToDelete, projectService]);

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

  return (
    <div className="flex flex-col h-full min-h-[70vh]">
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
              <option value="backlog">Backlog</option>
              <option value="in-progress">In Progress</option>
              <option value="review">Review</option>
              <option value="complete">Complete</option>
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
        {/* Backlog Column */}
        <ColumnDropZone
          status="backlog"
          title="Backlog"
          tasks={getTasksByStatus('backlog')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskComplete={onTaskComplete}
          onTaskDelete={onTaskDelete}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
        
        {/* In Progress Column */}
        <ColumnDropZone
          status="in-progress"
          title="In Process"
          tasks={getTasksByStatus('in-progress')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskComplete={onTaskComplete}
          onTaskDelete={onTaskDelete}
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
          onTaskComplete={onTaskComplete}
          onTaskDelete={onTaskDelete}
          onTaskReorder={onTaskReorder}
          allTasks={tasks}
          hoveredTaskId={hoveredTaskId}
          onTaskHover={setHoveredTaskId}
          selectedTasks={selectedTasks}
          onTaskSelect={toggleTaskSelection}
        />
        
        {/* Complete Column */}
        <ColumnDropZone
          status="complete"
          title="Complete"
          tasks={getTasksByStatus('complete')}
          onTaskMove={onTaskMove}
          onTaskView={onTaskView}
          onTaskComplete={onTaskComplete}
          onTaskDelete={onTaskDelete}
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