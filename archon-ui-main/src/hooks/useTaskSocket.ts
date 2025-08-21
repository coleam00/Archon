/**
 * Task Socket Hook - Simplified real-time task synchronization
 * 
 * This hook provides a clean interface to the task socket service,
 * replacing the complex useOptimisticUpdates pattern with a simpler
 * approach that avoids conflicts and connection issues.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { taskSocketService, TaskSocketEvents } from '../services/taskSocketService';
import { WebSocketState } from '../services/socketIOService';

export interface UseTaskSocketOptions {
  projectId: string;
  onTaskCreated?: (task: any) => void;
  onTaskUpdated?: (task: any) => void;
  onTaskDeleted?: (task: any) => void;
  onTaskArchived?: (task: any) => void;
  onTasksReordered?: (data: any) => void;
  onInitialTasks?: (tasks: any[]) => void;
  onConnectionStateChange?: (state: WebSocketState) => void;
}

export function useTaskSocket(options: UseTaskSocketOptions) {
  const {
    projectId,
    onTaskCreated,
    onTaskUpdated,
    onTaskDeleted,
    onTaskArchived,
    onTasksReordered,
    onInitialTasks,
    onConnectionStateChange
  } = options;

  const componentIdRef = useRef<string>(`task-socket-${Math.random().toString(36).substring(7)}`);
  const currentProjectIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef<boolean>(false);
  
  // Add reactive state for connection status
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [connectionState, setConnectionState] = useState<WebSocketState>(WebSocketState.DISCONNECTED);

  // Memoized handlers to prevent unnecessary re-registrations
  const memoizedHandlers = useCallback((): Partial<TaskSocketEvents> => {
    return {
      onTaskCreated,
      onTaskUpdated,
      onTaskDeleted,
      onTaskArchived,
      onTasksReordered,
      onInitialTasks,
      onConnectionStateChange
    };
  }, [
    onTaskCreated,
    onTaskUpdated,
    onTaskDeleted,
    onTaskArchived,
    onTasksReordered,
    onInitialTasks,
    onConnectionStateChange
  ]);

  // Subscribe to connection state changes
  useEffect(() => {
    const checkConnection = () => {
      const connected = taskSocketService.isConnected();
      const state = taskSocketService.getConnectionState();
      setIsConnected(connected);
      setConnectionState(state);
    };

    // Check initial state
    checkConnection();

    // Poll for connection state changes (since the service doesn't expose event emitters)
    const interval = setInterval(checkConnection, 500);

    // Also trigger when connection state handler is called
    const wrappedOnConnectionStateChange = onConnectionStateChange ? (state: WebSocketState) => {
      setConnectionState(state);
      setIsConnected(state === WebSocketState.CONNECTED);
      onConnectionStateChange(state);
    } : (state: WebSocketState) => {
      setConnectionState(state);
      setIsConnected(state === WebSocketState.CONNECTED);
    };

    // Update the handler
    if (componentIdRef.current && taskSocketService) {
      taskSocketService.registerHandlers(componentIdRef.current, {
        ...memoizedHandlers(),
        onConnectionStateChange: wrappedOnConnectionStateChange
      });
    }

    return () => {
      clearInterval(interval);
    };
  }, []); // No dependencies - only run once on mount

  // Initialize connection once and register handlers
  useEffect(() => {
    if (!projectId || isInitializedRef.current) return;

    const initializeConnection = async () => {
      try {
        console.log(`[USE_TASK_SOCKET] Initializing connection for project: ${projectId}`);
        setConnectionState(WebSocketState.CONNECTING);
        
        // Register handlers first
        taskSocketService.registerHandlers(componentIdRef.current, memoizedHandlers());
        
        // Connect to project (singleton service will handle deduplication)
        await taskSocketService.connectToProject(projectId);
        
        currentProjectIdRef.current = projectId;
        isInitializedRef.current = true;
        console.log(`[USE_TASK_SOCKET] Successfully initialized for project: ${projectId}`);
        
        // Update connection state after successful connection
        setIsConnected(taskSocketService.isConnected());
        setConnectionState(taskSocketService.getConnectionState());
        
      } catch (error) {
        console.error(`[USE_TASK_SOCKET] Failed to initialize for project ${projectId}:`, error);
        setConnectionState(WebSocketState.DISCONNECTED);
        setIsConnected(false);
      }
    };

    initializeConnection();

  }, [projectId]); // Only depend on projectId

  // Handle project change (different project)
  useEffect(() => {
    if (!projectId) return;

    // If project changed, reconnect
    if (isInitializedRef.current && currentProjectIdRef.current !== projectId) {
      console.log(`[USE_TASK_SOCKET] Project changed from ${currentProjectIdRef.current} to ${projectId}`);
      
      const switchProject = async () => {
        try {
          setConnectionState(WebSocketState.CONNECTING);
          
          // Update handlers for new project
          taskSocketService.registerHandlers(componentIdRef.current, memoizedHandlers());
          
          // Connect to new project (service handles disconnecting from old)
          await taskSocketService.connectToProject(projectId);
          
          currentProjectIdRef.current = projectId;
          console.log(`[USE_TASK_SOCKET] Successfully switched to project: ${projectId}`);
          
          // Update connection state
          setIsConnected(taskSocketService.isConnected());
          setConnectionState(taskSocketService.getConnectionState());
          
        } catch (error) {
          console.error(`[USE_TASK_SOCKET] Failed to switch to project ${projectId}:`, error);
          setConnectionState(WebSocketState.DISCONNECTED);
          setIsConnected(false);
        }
      };

      switchProject();
    }
  }, [projectId]); // Only depend on projectId

  // Cleanup on unmount
  useEffect(() => {
    const componentId = componentIdRef.current;
    
    return () => {
      console.log(`[USE_TASK_SOCKET] Cleaning up component: ${componentId}`);
      taskSocketService.unregisterHandlers(componentId);
      isInitializedRef.current = false;
    };
  }, []);

  // Return reactive state and utility functions
  return {
    isConnected,  // Now reactive!
    connectionState,  // Now reactive!
    reconnect: taskSocketService.reconnect.bind(taskSocketService),
    getCurrentProjectId: taskSocketService.getCurrentProjectId.bind(taskSocketService)
  };
}