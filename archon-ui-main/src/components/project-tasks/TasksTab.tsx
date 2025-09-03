import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Table, LayoutGrid, Plus } from 'lucide-react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Toggle } from '../ui/Toggle';
import { projectService } from '../../services/projectService';
import { useToast } from '../../contexts/ToastContext';
import { debounce } from '../../utils/debounce';
import { calculateReorderPosition, getDefaultTaskOrder } from '../../utils/taskOrdering';

import type { CreateTaskRequest, UpdateTaskRequest } from '../../types/project';
import { TaskTableView, Task } from './TaskTableView';
import { TaskBoardView } from './TaskBoardView';
import { EditTaskModal } from './EditTaskModal';

// Type for optimistic task updates with operation tracking
type OptimisticTask = Task & { _optimisticOperationId: string };



export const TasksTab = ({
  initialTasks,
  onTasksChange,
  projectId
}: {
  initialTasks: Task[];
  onTasksChange: (tasks: Task[]) => void;
  projectId: string;
}) => {
  const { showToast } = useToast();
  const [viewMode, setViewMode] = useState<'table' | 'board'>('board');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectFeatures, setProjectFeatures] = useState<any[]>([]);
  const [isLoadingFeatures, setIsLoadingFeatures] = useState(false);
  const [isSavingTask, setIsSavingTask] = useState<boolean>(false);
  const [optimisticTaskUpdates, setOptimisticTaskUpdates] = useState<Map<string, OptimisticTask>>(new Map());
  
  // Initialize tasks, but preserve optimistic updates
  useEffect(() => {
    if (optimisticTaskUpdates.size === 0) {
      // No optimistic updates, use incoming data as-is
      setTasks(initialTasks);
    } else {
      // Merge incoming data with optimistic updates
      const mergedTasks = initialTasks.map(task => {
        const optimisticUpdate = optimisticTaskUpdates.get(task.id);
        if (optimisticUpdate) {
          console.log(`[TasksTab] Preserving optimistic update for task ${task.id}:`, optimisticUpdate.status);
          // Clean up internal tracking field before returning
          const { _optimisticOperationId, ...cleanTask } = optimisticUpdate;
          return cleanTask as Task; // Keep optimistic version without internal fields
        }
        return task; // Use polling data for non-optimistic tasks
      });
      setTasks(mergedTasks);
    }
  }, [initialTasks, optimisticTaskUpdates]);

  // Load project features on component mount
  useEffect(() => {
    loadProjectFeatures();
  }, [projectId]);


  const loadProjectFeatures = async () => {
    if (!projectId) return;
    
    setIsLoadingFeatures(true);
    try {
      const response = await projectService.getProjectFeatures(projectId);
      setProjectFeatures(response.features || []);
    } catch (error) {
      console.error('Failed to load project features:', error);
      setProjectFeatures([]);
    } finally {
      setIsLoadingFeatures(false);
    }
  };

  // Modal management functions
  const openEditModal = async (task: Task) => {
    setEditingTask(task);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingTask(null);
  };

  const saveTask = async (task: Task) => {
    setEditingTask(task);
    
    setIsSavingTask(true);
    try {
      
      if (task.id) {
        // Update existing task
        const updateData: UpdateTaskRequest = {
          title: task.title,
          description: task.description,
          status: task.status,
          assignee: task.assignee?.name || 'User',
          task_order: task.task_order,
          ...(task.feature && { feature: task.feature }),
          ...(task.featureColor && { featureColor: task.featureColor })
        };
        
        await projectService.updateTask(task.id, updateData);
      } else {
        // Create new task first to get UUID
        const createData: CreateTaskRequest = {
          project_id: projectId,
          title: task.title,
          description: task.description,
          status: task.status,
          assignee: task.assignee?.name || 'User',
          task_order: task.task_order,
          ...(task.feature && { feature: task.feature }),
          ...(task.featureColor && { featureColor: task.featureColor })
        };
        
        await projectService.createTask(createData);
      }
      
      // Task saved - polling will pick up changes automatically
      closeModal();
    } catch (error) {
      console.error('Failed to save task:', error);
      showToast(`Failed to save task: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsSavingTask(false);
    }
  };

  // Update tasks helper
  const updateTasks = (newTasks: Task[]) => {
    setTasks(newTasks);
    onTasksChange(newTasks);
  };


  // Helper function to get next available order number for a status
  const getNextOrderForStatus = (status: Task['status']): number => {
    const tasksInStatus = tasks.filter(task => 
      task.status === status
    );
    
    if (tasksInStatus.length === 0) return 1;
    
    const maxOrder = Math.max(...tasksInStatus.map(task => task.task_order));
    return maxOrder + 1;
  };

  // Use shared debounce helper

  // Improved debounced persistence with better coordination
  const debouncedPersistSingleTask = useMemo(
    () => debounce(async (task: Task) => {
      try {
        console.log('REORDER: Persisting position change for task:', task.title, 'new position:', task.task_order);
        
        // Update only the moved task with server timestamp for conflict resolution
        await projectService.updateTask(task.id, { 
          task_order: task.task_order,
          client_timestamp: Date.now()
        });
        console.log('REORDER: Single task position persisted successfully');
        
      } catch (error) {
        console.error('REORDER: Failed to persist task position:', error);
        // Polling will eventually sync the correct state
      }
    }, 800), // Slightly reduced delay for better responsiveness
    []
  );

  // Optimized task reordering without optimistic update conflicts
  const handleTaskReorder = useCallback((taskId: string, targetIndex: number, status: Task['status']) => {
    console.log('REORDER: Moving task', taskId, 'to index', targetIndex, 'in status', status);
    
    // Get all tasks in the target status, sorted by current order
    const statusTasks = tasks
      .filter(task => task.status === status)
      .sort((a, b) => a.task_order - b.task_order);
    
    const otherTasks = tasks.filter(task => task.status !== status);
    
    // Find the moving task
    const movingTaskIndex = statusTasks.findIndex(task => task.id === taskId);
    if (movingTaskIndex === -1) {
      console.log('REORDER: Task not found in status');
      return;
    }
    
    // Prevent invalid moves
    if (targetIndex < 0 || targetIndex >= statusTasks.length) {
      console.log('REORDER: Invalid target index', targetIndex);
      return;
    }
    
    // Skip if moving to same position
    if (movingTaskIndex === targetIndex) {
      console.log('REORDER: Task already in target position');
      return;
    }
    
    const movingTask = statusTasks[movingTaskIndex];
    console.log('REORDER: Moving', movingTask.title, 'from', movingTaskIndex, 'to', targetIndex);
    
    // Calculate new position using shared ordering utility
    const newPosition = calculateReorderPosition(statusTasks, movingTaskIndex, targetIndex);
    
    console.log('REORDER: New position calculated:', newPosition);
    
    // Create updated task with new position
    const updatedTask = {
      ...movingTask,
      task_order: newPosition
    };
    
    // Immediate UI update without optimistic tracking interference
    const allUpdatedTasks = otherTasks.concat(
      statusTasks.map(task => task.id === taskId ? updatedTask : task)
    );
    updateTasks(allUpdatedTasks);
    
    // Persist to backend (single API call)
    debouncedPersistSingleTask(updatedTask);
  }, [tasks, updateTasks, debouncedPersistSingleTask]);

  // Task move function (for board view) - Optimistic Updates with Concurrent Operation Protection
  const moveTask = async (taskId: string, newStatus: Task['status']) => {
    // Generate unique operation ID to handle concurrent operations
    const operationId = `${taskId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[TasksTab] Optimistically moving task ${taskId} to ${newStatus} (op: ${operationId})`);
    
    // Clear any previous errors (removed local error state)
    
    // Find the task and validate
    const movingTask = tasks.find(task => task.id === taskId);
    if (!movingTask) {
      showToast('Task not found', 'error');
      return;
    }

    // (pendingOperations removed)

    // 1. Save current state for rollback
    const previousTasks = [...tasks]; // Shallow clone sufficient
    const newOrder = getNextOrderForStatus(newStatus);

    // 2. Update UI immediately (optimistic update - no loader!)
    const optimisticTask: OptimisticTask = { 
      ...movingTask, 
      status: newStatus, 
      task_order: newOrder,
      _optimisticOperationId: operationId // Track which operation created this
    };
    const optimisticTasks = tasks.map(task => 
      task.id === taskId ? optimisticTask : task
    );
    
    // Track this as an optimistic update with operation ID
    setOptimisticTaskUpdates(prev => new Map(prev).set(taskId, optimisticTask));
    updateTasks(optimisticTasks);

    // 3. Call API in background
    try {
      await projectService.updateTask(taskId, {
        status: newStatus,
        task_order: newOrder,
        client_timestamp: Date.now()
      });
      
      console.log(`[TasksTab] Successfully moved task ${taskId} (op: ${operationId})`);
      
      // Only clear if this is still the current operation (no newer operation started)
      setOptimisticTaskUpdates(prev => {
        const currentOptimistic = prev.get(taskId);
        if (currentOptimistic?._optimisticOperationId === operationId) {
          const newMap = new Map(prev);
          newMap.delete(taskId);
          return newMap;
        }
        return prev; // Don't clear, newer operation is active
      });
      
    } catch (error) {
      console.error(`[TasksTab] Failed to move task ${taskId} (op: ${operationId}):`, error);
      
      // Only rollback if this is still the current operation
      setOptimisticTaskUpdates(prev => {
        const currentOptimistic = prev.get(taskId);
        if (currentOptimistic?._optimisticOperationId === operationId) {
          // 4. Rollback on failure - revert to exact previous state
          updateTasks(previousTasks);
          
          const newMap = new Map(prev);
          newMap.delete(taskId);
          
          const errorMessage = error instanceof Error ? error.message : 'Failed to move task';
          showToast(`Failed to move task: ${errorMessage}`, 'error');
          
          return newMap;
        }
        return prev; // Don't rollback, newer operation is active
      });
      
    } finally {
      // (pendingOperations cleanup removed)
    }
  };

  const completeTask = (taskId: string) => {
    console.log(`[TasksTab] Calling completeTask for ${taskId}`);
    moveTask(taskId, 'done');
  };

  const deleteTask = async (task: Task) => {
    try {
      await projectService.deleteTask(task.id);
      updateTasks(tasks.filter(t => t.id !== task.id));
      showToast(`Task "${task.title}" deleted`, 'success');
    } catch (error) {
      console.error('Failed to delete task:', error);
      showToast('Failed to delete task', 'error');
    }
  };

  // Inline task creation function
  const createTaskInline = async (newTask: Omit<Task, 'id'>) => {
    try {
      // Auto-assign next order number if not provided
      const nextOrder = newTask.task_order || getNextOrderForStatus(newTask.status);
      
      const createData: CreateTaskRequest = {
        project_id: projectId,
        title: newTask.title,
        description: newTask.description,
        status: newTask.status,
        assignee: newTask.assignee?.name || 'User',
        task_order: nextOrder,
        ...(newTask.feature && { feature: newTask.feature }),
        ...(newTask.featureColor && { featureColor: newTask.featureColor })
      };
      
      await projectService.createTask(createData);
      
      // Task created - polling will pick up changes automatically
      console.log('[TasksTab] Task created successfully');
      
    } catch (error) {
      console.error('Failed to create task:', error);
      throw error;
    }
  };

  // Inline task update function
  const updateTaskInline = async (taskId: string, updates: Partial<Task>) => {
    console.log(`[TasksTab] Inline update for task ${taskId} with updates:`, updates);
    try {
      const updateData: Partial<UpdateTaskRequest> = {
        client_timestamp: Date.now()
      };
      
      if (updates.title !== undefined) updateData.title = updates.title;
      if (updates.description !== undefined) updateData.description = updates.description;
      if (updates.status !== undefined) {
        console.log(`[TasksTab] Setting status for ${taskId}: ${updates.status}`);
        updateData.status = updates.status;
      }
      if (updates.assignee !== undefined) updateData.assignee = updates.assignee.name;
      if (updates.task_order !== undefined) updateData.task_order = updates.task_order;
      if (updates.feature !== undefined) updateData.feature = updates.feature;
      if (updates.featureColor !== undefined) updateData.featureColor = updates.featureColor;
      
      console.log(`[TasksTab] Sending update request for task ${taskId} to projectService:`, updateData);
      await projectService.updateTask(taskId, updateData);
      console.log(`[TasksTab] projectService.updateTask successful for ${taskId}.`);
      
      // Task updated - polling will pick up changes automatically
      console.log(`[TasksTab] Task ${taskId} updated successfully`);
      
    } catch (error) {
      console.error(`[TasksTab] Failed to update task ${taskId} inline:`, error);
      showToast(`Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
      throw error;
    }
  };

  // Get tasks for priority selection with descriptive labels
  const getTasksForPrioritySelection = (status: Task['status']): Array<{value: number, label: string}> => {
    const tasksInStatus = tasks
      .filter(task => task.status === status && task.id !== editingTask?.id) // Exclude current task if editing
      .sort((a, b) => a.task_order - b.task_order);
    
    const options: Array<{value: number, label: string}> = [];
    
    if (tasksInStatus.length === 0) {
      // No tasks in this status
      options.push({ value: 1, label: "1 - First task in this status" });
    } else {
      // Add option to be first
      options.push({ 
        value: 1, 
        label: `1 - Before "${tasksInStatus[0].title.substring(0, 30)}${tasksInStatus[0].title.length > 30 ? '...' : ''}"` 
      });
      
      // Add options between existing tasks
      for (let i = 0; i < tasksInStatus.length - 1; i++) {
        const currentTask = tasksInStatus[i];
        const nextTask = tasksInStatus[i + 1];
        options.push({ 
          value: i + 2, 
          label: `${i + 2} - After "${currentTask.title.substring(0, 20)}${currentTask.title.length > 20 ? '...' : ''}", Before "${nextTask.title.substring(0, 20)}${nextTask.title.length > 20 ? '...' : ''}"` 
        });
      }
      
      // Add option to be last
      const lastTask = tasksInStatus[tasksInStatus.length - 1];
      options.push({ 
        value: tasksInStatus.length + 1, 
        label: `${tasksInStatus.length + 1} - After "${lastTask.title.substring(0, 30)}${lastTask.title.length > 30 ? '...' : ''}"` 
      });
    }
    
    return options;
  };

  // Memoized version of getTasksForPrioritySelection to prevent recalculation on every render
  const memoizedGetTasksForPrioritySelection = useMemo(
    () => getTasksForPrioritySelection,
    [tasks, editingTask?.id]
  );

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="min-h-[70vh] relative">
        {/* Main content - Table or Board view */}
        <div className="relative h-[calc(100vh-220px)] overflow-auto">
          {viewMode === 'table' ? (
            <TaskTableView
              tasks={tasks}
              onTaskView={openEditModal}
              onTaskComplete={completeTask}
              onTaskDelete={deleteTask}
              onTaskReorder={handleTaskReorder}
              onTaskCreate={createTaskInline}
              onTaskUpdate={updateTaskInline}
            />
          ) : (
            <TaskBoardView
              tasks={tasks}
              onTaskView={openEditModal}
              onTaskComplete={completeTask}
              onTaskDelete={deleteTask}
              onTaskMove={moveTask}
              onTaskReorder={handleTaskReorder}
            />
          )}
        </div>

        {/* Fixed View Controls */}
        <div className="fixed bottom-6 left-0 right-0 flex justify-center z-50 pointer-events-none">
          <div className="flex items-center gap-4">
            
            {/* Add Task Button with Luminous Style */}
            <button 
              onClick={() => {
                const defaultOrder = getDefaultTaskOrder(tasks.filter(t => t.status === 'todo'));
                setEditingTask({
                  id: '',
                  title: '',
                  description: '',
                  status: 'todo',
                  assignee: { name: 'AI IDE Agent', avatar: '' },
                  feature: '',
                  featureColor: '#3b82f6',
                  task_order: defaultOrder
                });
                setIsModalOpen(true);
              }}
              className="relative px-5 py-2.5 flex items-center gap-2 bg-white/80 dark:bg-black/90 border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_0_20px_rgba(0,0,0,0.1)] dark:shadow-[0_0_20px_rgba(0,0,0,0.5)] backdrop-blur-md pointer-events-auto text-cyan-600 dark:text-cyan-400 hover:text-cyan-700 dark:hover:text-cyan-300 transition-all duration-300"
            >
              <Plus className="w-4 h-4 mr-1" />
              <span>Add Task</span>
              <span className="absolute bottom-0 left-[0%] right-[0%] w-[95%] mx-auto h-[2px] bg-cyan-500 shadow-[0_0_10px_2px_rgba(34,211,238,0.4)] dark:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]"></span>
            </button>
          
            {/* View Toggle Controls */}
            <div className="flex items-center bg-white/80 dark:bg-black/90 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden shadow-[0_0_20px_rgba(0,0,0,0.1)] dark:shadow-[0_0_20px_rgba(0,0,0,0.5)] backdrop-blur-md pointer-events-auto">
              <button 
                onClick={() => setViewMode('table')} 
                className={`px-5 py-2.5 flex items-center gap-2 relative transition-all duration-300 ${viewMode === 'table' ? 'text-cyan-600 dark:text-cyan-400' : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-300'}`}
              >
                <Table className="w-4 h-4" />
                <span>Table</span>
                {viewMode === 'table' && <span className="absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[2px] bg-cyan-500 shadow-[0_0_10px_2px_rgba(34,211,238,0.4)] dark:shadow-[0_0_20px_5px_rgba(34,211,238,0.7)]"></span>}
              </button>
              <button 
                onClick={() => setViewMode('board')} 
                className={`px-5 py-2.5 flex items-center gap-2 relative transition-all duration-300 ${viewMode === 'board' ? 'text-purple-600 dark:text-purple-400' : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-300'}`}
              >
                <LayoutGrid className="w-4 h-4" />
                <span>Board</span>
                {viewMode === 'board' && <span className="absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[2px] bg-purple-500 shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]"></span>}
              </button>
            </div>
          </div>
        </div>

        {/* Edit Task Modal */}
        <EditTaskModal
          isModalOpen={isModalOpen}
          editingTask={editingTask}
          projectFeatures={projectFeatures}
          isLoadingFeatures={isLoadingFeatures}
          isSavingTask={isSavingTask}
          onClose={closeModal}
          onSave={saveTask}
          getTasksForPrioritySelection={memoizedGetTasksForPrioritySelection}
        />
      </div>
    </DndProvider>
  );
};