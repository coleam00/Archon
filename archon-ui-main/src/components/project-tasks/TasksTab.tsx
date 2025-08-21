import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Table, LayoutGrid, Plus, Wifi, WifiOff, List, Trash2 } from 'lucide-react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Toggle } from '../ui/Toggle';
import { projectService } from '../../services/projectService';
import { getGlobalOperationTracker } from '../../utils/operationTracker';
import { Card } from '../ui/card';

import { useTaskSocket } from '../../hooks/useTaskSocket';
import { useOptimisticUpdates } from '../../hooks/useOptimisticUpdates';
import type { CreateTaskRequest, UpdateTaskRequest, DatabaseTaskStatus } from '../../types/project';
import { WebSocketState } from '../../services/socketIOService';
import { TaskTableView, Task } from './TaskTableView';
import { TaskBoardView } from './TaskBoardView';
import { EditTaskModal } from './EditTaskModal';
import { DeleteConfirmModal } from '../ui/DeleteConfirmModal';

// Assignee utilities - expanded to include all agent types
const ASSIGNEE_OPTIONS = [
  'User', 
  'Archon', 
  'AI IDE Agent',
  'IDE Agent',
  'prp-executor',
  'prp-validator'
] as const;

// Delete confirmation modal component

// Mapping functions for status conversion
const mapUIStatusToDBStatus = (uiStatus: Task['status']): DatabaseTaskStatus => {
  switch (uiStatus) {
    case 'backlog': return 'todo';
    case 'in-progress': return 'doing';
    case 'review': return 'review'; // Map UI 'review' to database 'review'
    case 'complete': return 'done';
    default: return 'todo';
  }
};

const mapDBStatusToUIStatus = (dbStatus: DatabaseTaskStatus): Task['status'] => {
  switch (dbStatus) {
    case 'todo': return 'backlog';
    case 'doing': return 'in-progress';
    case 'review': return 'review'; // Map database 'review' to UI 'review'
    case 'done': return 'complete';
    default: return 'backlog';
  }
};

// Helper function to map database task format to UI task format
const mapDatabaseTaskToUITask = (dbTask: any): Task => {
  return {
    id: dbTask.id,
    title: dbTask.title || '',
    description: dbTask.description || '',
    status: mapDBStatusToUIStatus(dbTask.status || 'todo'),
    assignee: {
      name: dbTask.assignee || 'User',
      avatar: ''
    },
    feature: dbTask.feature || 'General',
    featureColor: dbTask.featureColor || '#3b82f6', // Default blue color
    task_order: dbTask.task_order || 0,
  };
};

export const TasksTab = ({
  initialTasks,
  onTasksChange,
  projectId
}: {
  initialTasks: Task[];
  onTasksChange: (tasks: Task[]) => void;
  projectId: string;
}) => {
  const [viewMode, setViewMode] = useState<'table' | 'board'>('board');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [projectFeatures, setProjectFeatures] = useState<import('../types/jsonb').ProjectFeature[]>([]);
  const [isLoadingFeatures, setIsLoadingFeatures] = useState(false);
  const [isSavingTask, setIsSavingTask] = useState<boolean>(false);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  
  // Use optimistic updates hook for proper echo suppression
  const { addPendingUpdate, isPendingUpdate, removePendingUpdate } = useOptimisticUpdates<Task>();
  
  // Track recently deleted tasks to prevent race conditions
  const recentlyDeletedIdsRef = useRef<Set<string>>(new Set());
  
  // Track recently created tasks to prevent WebSocket echo
  const recentlyCreatedIdsRef = useRef<Set<string>>(new Set());
  
  // Track the project ID to detect when we switch projects
  const lastProjectId = useRef(projectId);
  
  // Initialize tasks when component mounts or project changes
  useEffect(() => {
    // If project changed, always reinitialize
    if (lastProjectId.current !== projectId) {
      setTasks(initialTasks);
      lastProjectId.current = projectId;
    } else if (tasks.length === 0 && initialTasks.length > 0) {
      // Only initialize if we have no tasks but received initial tasks
      setTasks(initialTasks);
    }
  }, [initialTasks, projectId]);

  // Load project features on component mount
  useEffect(() => {
    loadProjectFeatures();
  }, [projectId]);

  // Optimized socket handlers with conflict resolution
  const handleTaskUpdated = useCallback((message: any) => {
    const updatedTask = message.data || message;
    const mappedTask = mapDatabaseTaskToUITask(updatedTask);
    
    // Skip updates for recently deleted tasks (race condition prevention)
    if (recentlyDeletedIdsRef.current.has(updatedTask.id)) {
      console.log('[Socket] Ignoring update for recently deleted task:', updatedTask.id);
      return;
    }
    
    // Check if this is an echo of a local update
    if (isPendingUpdate(updatedTask.id, mappedTask)) {
      console.log('[Socket] Skipping echo update for locally updated task:', updatedTask.id);
      return;
    }
    
    // Skip updates while modal is open for the same task to prevent conflicts
    if (isModalOpen && editingTask?.id === updatedTask.id) {
      console.log('[Socket] Skipping update for task being edited:', updatedTask.id);
      return;
    }
    
    setTasks(prev => {
      // Use server timestamp for conflict resolution
      const existingTask = prev.find(task => task.id === updatedTask.id);
      
      if (!existingTask) {
        // Task not found locally, skip the update
        return prev;
      }
      
      const updated = prev.map(task => 
        task.id === updatedTask.id 
          ? { ...mappedTask }
          : task
      );
      
      // Notify parent after state settles
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
  }, [onTasksChange, isModalOpen, editingTask?.id, isPendingUpdate]);

  const handleTaskCreated = useCallback((message: any) => {
    const newTask = message.data || message;
    console.log('🆕 Real-time task created:', newTask);
    
    // Skip if this is our own recently created task
    if (recentlyCreatedIdsRef.current.has(newTask.id)) {
      console.log('[Socket] Skipping echo of our own task creation:', newTask.id);
      return;
    }
    
    const mappedTask = mapDatabaseTaskToUITask(newTask);
    
    setTasks(prev => {
      // Check if task already exists to prevent duplicates
      if (prev.some(task => task.id === newTask.id)) {
        console.log('Task already exists, skipping create');
        return prev;
      }
      
      // Remove any temp tasks with same title (in case of race condition)
      const filteredPrev = prev.filter(task => {
        // Keep non-temp tasks
        if (!task.id?.startsWith('temp-')) return true;
        // Remove temp tasks with matching title
        return task.title !== newTask.title;
      });
      
      const updated = [...filteredPrev, mappedTask];
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
  }, [onTasksChange]);

  const handleTaskDeleted = useCallback((message: any) => {
    const deletedTask = message.data || message;
    console.log('🗑️ Real-time task deleted:', deletedTask);
    
    // Remove from recently deleted cache when deletion is confirmed
    recentlyDeletedIdsRef.current.delete(deletedTask.id);
    
    setTasks(prev => {
      const updated = prev.filter(task => task.id !== deletedTask.id);
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
  }, [onTasksChange]);

  const handleTaskArchived = useCallback((message: any) => {
    const archivedTask = message.data || message;
    console.log('📦 Real-time task archived:', archivedTask);
    setTasks(prev => {
      const updated = prev.filter(task => task.id !== archivedTask.id);
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
  }, [onTasksChange]);

  const handleTasksReordered = useCallback((message: any) => {
    const reorderData = message.data || message;
    console.log('🔄 Real-time tasks reordered:', reorderData);
    
    // Handle bulk task reordering from server
    if (reorderData.tasks && Array.isArray(reorderData.tasks)) {
      const uiTasks: Task[] = reorderData.tasks.map(mapDatabaseTaskToUITask);
      setTasks(uiTasks);
      setTimeout(() => onTasksChange(uiTasks), 0);
    }
  }, [onTasksChange]);

  const handleInitialTasks = useCallback((message: any) => {
    const initialWebSocketTasks = message.data || message;
    const uiTasks: Task[] = initialWebSocketTasks.map(mapDatabaseTaskToUITask);
    setTasks(uiTasks);
    setTimeout(() => onTasksChange(uiTasks), 0);
  }, [onTasksChange]);

  // Simplified socket connection with better lifecycle management
  const { isConnected, connectionState } = useTaskSocket({
    projectId,
    onTaskCreated: handleTaskCreated,
    onTaskUpdated: handleTaskUpdated,
    onTaskDeleted: handleTaskDeleted,
    onTaskArchived: handleTaskArchived,
    onTasksReordered: handleTasksReordered,
    onInitialTasks: handleInitialTasks,
    onConnectionStateChange: (state) => {
      setIsWebSocketConnected(state === WebSocketState.CONNECTED);
    }
  });

  // Update connection state when hook state changes
  useEffect(() => {
    setIsWebSocketConnected(isConnected);
  }, [isConnected]);

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
    
    // Store original task for rollback
    const originalTask = task.id ? tasks.find(t => t.id === task.id) : null;
    
    // OPTIMISTIC UPDATE: Update UI immediately for existing tasks
    if (task.id) {
      setTasks(prev => {
        const updated = prev.map(t => 
          t.id === task.id ? task : t
        );
        // Notify parent of the change
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      
      // Mark as pending update to prevent echo
      addPendingUpdate({
        id: task.id,
        timestamp: Date.now(),
        data: task,
        operation: 'update'
      });
    }
    
    try {
      let parentTaskId = task.id;
      
      if (task.id) {
        // Update existing task
        const updateData: UpdateTaskRequest = {
          title: task.title,
          description: task.description,
          status: mapUIStatusToDBStatus(task.status),
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
          status: mapUIStatusToDBStatus(task.status),
          assignee: task.assignee?.name || 'User',
          task_order: task.task_order,
          ...(task.feature && { feature: task.feature }),
          ...(task.featureColor && { featureColor: task.featureColor })
        };
        
        const createdTask = await projectService.createTask(createData);
        parentTaskId = createdTask.id;
      }
      
      // Don't reload tasks - let socket updates handle synchronization
      closeModal();
    } catch (error) {
      console.error('Failed to save task:', error);
      
      // Rollback optimistic update on error
      if (task.id && originalTask) {
        setTasks(prev => {
          const updated = prev.map(t => 
            t.id === task.id ? originalTask : t
          );
          // Notify parent of the rollback
          setTimeout(() => onTasksChange(updated), 0);
          return updated;
        });
        
        // Clear pending update tracking
        removePendingUpdate(task.id);
      }
      
      alert(`Failed to save task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSavingTask(false);
    }
  };

  // Update tasks helper
  const updateTasks = (newTasks: Task[]) => {
    setTasks(newTasks);
    setTimeout(() => onTasksChange(newTasks), 0);
  };

  // Helper function to reorder tasks by status to ensure no gaps (1,2,3...)
  const reorderTasksByStatus = async (status: Task['status']) => {
    const tasksInStatus = tasks
      .filter(task => task.status === status)
      .sort((a, b) => a.task_order - b.task_order);
    
    const updatePromises = tasksInStatus.map((task, index) => 
      projectService.updateTask(task.id, { task_order: index + 1 })
    );
    
    await Promise.all(updatePromises);
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

  // Simple debounce function
  const debounce = (func: Function, delay: number) => {
    let timeoutId: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func(...args), delay);
    };
  };

  // Batch reorder persistence for efficient updates
  const debouncedPersistBatchReorder = useMemo(
    () => debounce(async (tasksToUpdate: Task[]) => {
      try {
        console.log(`REORDER: Persisting batch update for ${tasksToUpdate.length} tasks`);
        
        // Send batch update request to backend
        // For now, update tasks individually (backend can be optimized later for batch endpoint)
        const updatePromises = tasksToUpdate.map(task =>
          projectService.updateTask(task.id, { 
            task_order: task.task_order
          })
        );
        
        await Promise.all(updatePromises);
        console.log('REORDER: Batch reorder persisted successfully');
        
      } catch (error) {
        console.error('REORDER: Failed to persist batch reorder:', error);
        // Socket will handle state recovery
        console.log('REORDER: Socket will handle state recovery');
      }
    }, 500), // Shorter delay for batch updates
    [projectId]
  );
  
  // Single task persistence (still used for other operations)
  const debouncedPersistSingleTask = useMemo(
    () => debounce(async (task: Task) => {
      try {
        console.log('REORDER: Persisting position change for task:', task.title, 'new position:', task.task_order);
        
        // Update only the moved task
        await projectService.updateTask(task.id, { 
          task_order: task.task_order
        });
        console.log('REORDER: Single task position persisted successfully');
        
      } catch (error) {
        console.error('REORDER: Failed to persist task position:', error);
        console.log('REORDER: Socket will handle state recovery');
      }
    }, 800),
    [projectId]
  );

  // Standard drag-and-drop reordering with sequential integers (like Jira/Trello/Linear)
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
    
    console.log('REORDER: Moving task from position', movingTaskIndex, 'to', targetIndex);
    
    // Remove the task from its current position and insert at target position
    const reorderedTasks = [...statusTasks];
    const [movedTask] = reorderedTasks.splice(movingTaskIndex, 1);
    reorderedTasks.splice(targetIndex, 0, movedTask);
    
    // Assign sequential order numbers (1, 2, 3, etc.) to all tasks in this status
    const updatedStatusTasks = reorderedTasks.map((task, index) => ({
      ...task,
      task_order: index + 1,
      lastUpdate: Date.now()
    }));
    
    console.log('REORDER: New order:', updatedStatusTasks.map(t => `${t.title}:${t.task_order}`));
    
    // Update UI immediately with all reordered tasks
    const allUpdatedTasks = [...otherTasks, ...updatedStatusTasks];
    updateTasks(allUpdatedTasks);
    
    // Batch update to backend - only update tasks that changed position
    const tasksToUpdate = updatedStatusTasks.filter((task, index) => {
      const originalTask = statusTasks.find(t => t.id === task.id);
      return originalTask && originalTask.task_order !== task.task_order;
    });
    
    console.log(`REORDER: Updating ${tasksToUpdate.length} tasks in backend`);
    
    // Send batch update to backend (debounced)
    debouncedPersistBatchReorder(tasksToUpdate);
  }, [tasks, updateTasks, debouncedPersistBatchReorder]);

  // Task move function (for board view) with optimistic UI update
  const moveTask = async (taskId: string, newStatus: Task['status']) => {
    console.log(`[TasksTab] Attempting to move task ${taskId} to new status: ${newStatus}`);
    
    const movingTask = tasks.find(task => task.id === taskId);
    if (!movingTask) {
      console.warn(`[TasksTab] Task ${taskId} not found for move operation.`);
      return;
    }
    
    const oldStatus = movingTask.status;
    const newOrder = getNextOrderForStatus(newStatus);
    const updatedTask = { ...movingTask, status: newStatus, task_order: newOrder };

    console.log(`[TasksTab] Moving task ${movingTask.title} from ${oldStatus} to ${newStatus} with order ${newOrder}`);

    // OPTIMISTIC UPDATE: Update UI immediately
    console.log(`[TasksTab] Applying optimistic move for task ${taskId} to ${newStatus}`);
    setTasks(prev => {
      const updated = prev.map(task => task.id === taskId ? updatedTask : task);
      console.log(`[TasksTab] Tasks after optimistic move:`, updated);
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
    console.log(`[TasksTab] Optimistically updated UI for task ${taskId}`);
    
    // Mark as pending update to prevent echo when socket update arrives
    const taskToUpdate = tasks.find(t => t.id === taskId);
    if (taskToUpdate) {
      const updatedTask = { ...taskToUpdate, status: newStatus, task_order: newOrder };
      addPendingUpdate({
        id: taskId,
        timestamp: Date.now(),
        data: updatedTask,
        operation: 'update'
      });
    }

    try {
      // Then update the backend
      await projectService.updateTask(taskId, {
        status: mapUIStatusToDBStatus(newStatus),
        task_order: newOrder
      });
      console.log(`[TasksTab] Successfully updated task ${taskId} status in backend.`);
      
      // Socket will confirm the update, but UI is already updated
      
    } catch (error) {
      console.error(`[TasksTab] Failed to move task ${taskId}, rolling back:`, error);
      
      // ROLLBACK on error - restore original task
      setTasks(prev => {
        const updated = prev.map(task => task.id === taskId ? movingTask : task);
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      
      // Clear the pending update marker
      removePendingUpdate(taskId);
      
      alert(`Failed to move task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const completeTask = (taskId: string) => {
    console.log(`[TasksTab] Calling completeTask for ${taskId}`);
    moveTask(taskId, 'complete');
  };

  const deleteTask = async (task: Task) => {
    // Set the task to delete and show confirmation modal
    setTaskToDelete(task);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTask = async () => {
    if (!taskToDelete) return;
    
    try {
      // Add to recently deleted cache to prevent race conditions
      recentlyDeletedIdsRef.current.add(taskToDelete.id);
      
      // OPTIMISTIC UPDATE: Remove task from UI immediately
      setTasks(prev => {
        const updated = prev.filter(t => t.id !== taskToDelete.id);
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      console.log(`[TasksTab] Optimistically removed task ${taskToDelete.id} from UI`);
      
      // Then delete from backend
      await projectService.deleteTask(taskToDelete.id);
      console.log(`[TasksTab] Task ${taskToDelete.id} deletion confirmed by backend`);
      
      // Clear from recently deleted cache after a delay (to catch any lingering socket events)
      setTimeout(() => {
        recentlyDeletedIdsRef.current.delete(taskToDelete.id);
      }, 3000); // 3 second window to ignore stale socket events
      
    } catch (error) {
      console.error('Failed to delete task:', error);
      
      // Remove from recently deleted cache on error
      recentlyDeletedIdsRef.current.delete(taskToDelete.id);
      
      // ROLLBACK on error - restore the task
      setTasks(prev => {
        const updated = [...prev, taskToDelete].sort((a, b) => a.task_order - b.task_order);
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      console.log(`[TasksTab] Rolled back task deletion for ${taskToDelete.id}`);
      
      // Re-throw to let the calling component handle the error display
      throw error;
    } finally {
      setTaskToDelete(null);
      setShowDeleteConfirm(false);
    }
  };

  // Inline task creation function with optimistic update
  const createTaskInline = async (newTask: Omit<Task, 'id'>) => {
    // Create temporary task with a temp ID for optimistic update
    const tempId = `temp-${Date.now()}`;
    
    try {
      // Auto-assign next order number if not provided
      const nextOrder = newTask.task_order || getNextOrderForStatus(newTask.status);
      
      const tempTask: Task = {
        ...newTask,
        id: tempId,
        task_order: nextOrder
      };
      
      // OPTIMISTIC UPDATE: Add to UI immediately
      setTasks(prev => {
        const updated = [...prev, tempTask];
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      
      const createData: CreateTaskRequest = {
        project_id: projectId,
        title: newTask.title,
        description: newTask.description,
        status: mapUIStatusToDBStatus(newTask.status),
        assignee: newTask.assignee?.name || 'User',
        task_order: nextOrder,
        ...(newTask.feature && { feature: newTask.feature }),
        ...(newTask.featureColor && { featureColor: newTask.featureColor })
      };
      
      const createdTask = await projectService.createTask(createData);
      const mappedCreatedTask = mapDatabaseTaskToUITask(createdTask);
      
      // Add to recently created to prevent WebSocket echo from duplicating
      recentlyCreatedIdsRef.current.add(createdTask.id);
      setTimeout(() => {
        recentlyCreatedIdsRef.current.delete(createdTask.id);
      }, 5000);
      
      // Replace temp task with real one
      setTasks(prev => {
        // Find and replace the temp task
        const updated = prev.map(t => 
          t.id === tempId ? mappedCreatedTask : t
        );
        setTimeout(() => onTasksChange(updated), 0);
        return updated;
      });
      
      
    } catch (error) {
      console.error('Failed to create task:', error);
      
      // Rollback: Remove temp task on error
      setTasks(prev => prev.filter(t => t.id !== tempId));
      
      throw error;
    }
  };

  // Inline task update function
  const updateTaskInline = async (taskId: string, updates: Partial<Task>) => {
    console.log(`[TasksTab] Inline update for task ${taskId} with updates:`, updates);
    
    // Store the original task for potential rollback
    const originalTask = tasks.find(t => t.id === taskId);
    
    // Optimistically update the UI immediately
    console.log(`[TasksTab] Applying optimistic update for task ${taskId}`, updates);
    setTasks(prevTasks => {
      const updated = prevTasks.map(task => 
        task.id === taskId 
          ? { ...task, ...updates }
          : task
      );
      console.log(`[TasksTab] Tasks after optimistic update:`, updated);
      // Notify parent of the optimistic update
      setTimeout(() => onTasksChange(updated), 0);
      return updated;
    });
    
    // Mark as pending update to prevent echo when socket update arrives
    const taskToUpdate = tasks.find(t => t.id === taskId);
    if (taskToUpdate) {
      const updatedTask = { ...taskToUpdate, ...updates };
      addPendingUpdate({
        id: taskId,
        timestamp: Date.now(),
        data: updatedTask,
        operation: 'update'
      });
    }
    
    try {
      const updateData: Partial<UpdateTaskRequest> = {};
      
      if (updates.title !== undefined) updateData.title = updates.title;
      if (updates.description !== undefined) updateData.description = updates.description;
      if (updates.status !== undefined) {
        console.log(`[TasksTab] Mapping UI status ${updates.status} to DB status.`);
        updateData.status = mapUIStatusToDBStatus(updates.status);
        console.log(`[TasksTab] Mapped status for ${taskId}: ${updates.status} -> ${updateData.status}`);
      }
      if (updates.assignee !== undefined) updateData.assignee = updates.assignee.name;
      if (updates.task_order !== undefined) updateData.task_order = updates.task_order;
      if (updates.feature !== undefined) updateData.feature = updates.feature;
      if (updates.featureColor !== undefined) updateData.featureColor = updates.featureColor;
      
      console.log(`[TasksTab] Sending update request for task ${taskId} to projectService:`, updateData);
      await projectService.updateTask(taskId, updateData);
      console.log(`[TasksTab] projectService.updateTask successful for ${taskId}.`);
      
    } catch (error) {
      console.error(`[TasksTab] Failed to update task ${taskId} inline:`, error);
      
      // Revert the optimistic update on error
      if (originalTask) {
        setTasks(prevTasks => 
          prevTasks.map(task => 
            task.id === taskId ? originalTask : task
          )
        );
      }
      
      // Clear the pending update marker
      removePendingUpdate(taskId);
      
      alert(`Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
              tasks={tasks.filter(t => t && t.id && t.title !== undefined)}
              onTaskView={openEditModal}
              onTaskComplete={completeTask}
              onTaskDelete={deleteTask}
              onTaskReorder={handleTaskReorder}
              onTaskCreate={createTaskInline}
              onTaskUpdate={updateTaskInline}
            />
          ) : (
            <TaskBoardView
              tasks={tasks.filter(t => t && t.id && t.title !== undefined)}
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
            {/* WebSocket Status Indicator */}
            <div className="flex items-center gap-2 px-3 py-2 bg-white/80 dark:bg-black/90 border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_0_20px_rgba(0,0,0,0.1)] dark:shadow-[0_0_20px_rgba(0,0,0,0.5)] backdrop-blur-md pointer-events-auto">
              {isWebSocketConnected ? (
                <>
                  <Wifi className="w-4 h-4 text-green-500" />
                  <span className="text-xs text-green-600 dark:text-green-400">Live</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4 text-red-500" />
                  <span className="text-xs text-red-600 dark:text-red-400">Offline</span>
                </>
              )}
            </div>
            
            {/* Add Task Button with Luminous Style */}
            <button 
              onClick={() => {
                const defaultOrder = getTasksForPrioritySelection('backlog')[0]?.value || 1;
                setEditingTask({
                  id: '',
                  title: '',
                  description: '',
                  status: 'backlog',
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

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && taskToDelete && (
          <DeleteConfirmModal
            itemName={taskToDelete.title}
            onConfirm={confirmDeleteTask}
            onCancel={() => {
              setTaskToDelete(null);
              setShowDeleteConfirm(false);
            }}
            type="task"
          />
        )}
      </div>
    </DndProvider>
  );
};