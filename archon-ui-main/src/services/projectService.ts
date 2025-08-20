// Project Management Service Layer
// Integrates with MCP backend tools via API wrapper

import type { 
  Project, 
  Task, 
  CreateProjectRequest, 
  UpdateProjectRequest,
  CreateTaskRequest, 
  UpdateTaskRequest,
  DatabaseTaskStatus,
  UITaskStatus,
  ProjectManagementEvent
} from '../types/project';

import { 
  validateCreateProject, 
  validateUpdateProject, 
  validateCreateTask, 
  validateUpdateTask,
  validateUpdateTaskStatus,
  formatValidationErrors
} from '../lib/projectSchemas';

import { dbTaskToUITask, uiStatusToDBStatus } from '../types/project';

// Document interface for type safety
export interface Document {
  id: string;
  project_id: string;
  title: string;
  content: any;
  document_type: string;
  metadata?: Record<string, any>;
  tags?: string[];
  author?: string;
  created_at: string;
  updated_at: string;
}

// API configuration - use relative URL to go through Vite proxy
const API_BASE_URL = '/api';

// WebSocket connection for real-time updates
let websocketConnection: WebSocket | null = null;
const projectUpdateSubscriptions: Map<string, (event: ProjectManagementEvent) => void> = new Map();

// Error classes
export class ProjectServiceError extends Error {
  constructor(message: string, public code?: string, public statusCode?: number) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}

export class ValidationError extends ProjectServiceError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class MCPToolError extends ProjectServiceError {
  constructor(message: string, public toolName: string) {
    super(message, 'MCP_TOOL_ERROR', 500);
    this.name = 'MCPToolError';
  }
}

// Helper function to call FastAPI endpoints directly
async function callAPI<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Remove /api prefix if it exists since API_BASE_URL already includes it
    const cleanEndpoint = endpoint.startsWith('/api') ? endpoint.substring(4) : endpoint;
    const response = await fetch(`${API_BASE_URL}${cleanEndpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options
    });

    if (!response.ok) {
      // Try to get error details from response body
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.error || errorMessage;
        }
      } catch (e) {
        // Ignore parse errors, use default message
      }
      
      throw new ProjectServiceError(
        errorMessage, 
        'HTTP_ERROR', 
        response.status
      );
    }

    const result = await response.json();
    
    // Check if response has error field (from FastAPI error format)
    if (result.error) {
      throw new ProjectServiceError(
        result.error, 
        'API_ERROR',
        response.status
      );
    }

    return result as T;
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      throw error;
    }
    
    throw new ProjectServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      500
    );
  }
}

// WebSocket management for real-time updates
function initializeWebSocket() {
  if (websocketConnection?.readyState === WebSocket.OPEN) {
    return websocketConnection;
  }

  // Construct WebSocket URL based on current location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws/project-updates`;
  websocketConnection = new WebSocket(wsUrl);

  websocketConnection.onopen = () => {
    console.log('📡 Project management WebSocket connected');
  };

  websocketConnection.onmessage = (event) => {
    try {
      const update: ProjectManagementEvent = JSON.parse(event.data);
      
      // Notify all subscribers
      projectUpdateSubscriptions.forEach((callback, projectId) => {
        if (update.type.includes('PROJECT') && update.projectId === projectId) {
          callback(update);
        } else if (update.type.includes('TASK') && update.projectId === projectId) {
          callback(update);
        }
      });
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  };

  websocketConnection.onclose = () => {
    console.log('📡 Project management WebSocket disconnected');
    // Attempt to reconnect after 3 seconds
    setTimeout(initializeWebSocket, 3000);
  };

  websocketConnection.onerror = (error) => {
    console.error('📡 Project management WebSocket error:', error);
  };

  return websocketConnection;
}

// Project Management Service
export const projectService = {
  // ==================== PROJECT OPERATIONS ====================

  /**
   * Get all projects
   */
  async listProjects(): Promise<Project[]> {
    try {
      console.log('[PROJECT SERVICE] Fetching projects from API');
      const projects = await callAPI<Project[]>('/api/projects');
      console.log('[PROJECT SERVICE] Raw API response:', projects);
      console.log('[PROJECT SERVICE] Raw API response length:', projects.length);
      
      // Debug raw pinned values
      projects.forEach((p: any) => {
        console.log(`[PROJECT SERVICE] Raw project: ${p.title}, pinned=${p.pinned} (type: ${typeof p.pinned})`);
      });
      
      // Add computed UI properties
      const processedProjects = projects.map((project: Project) => {
        // Debug the raw pinned value
        console.log(`[PROJECT SERVICE] Processing ${project.title}: raw pinned=${project.pinned} (type: ${typeof project.pinned})`);
        
        const processed = {
          ...project,
          // Ensure pinned is properly handled as boolean
          pinned: project.pinned === true || project.pinned === 'true',
          progress: project.progress || 0,
          updated: project.updated || this.formatRelativeTime(project.updated_at)
        };
        console.log(`[PROJECT SERVICE] Processed project ${project.id} (${project.title}), pinned=${processed.pinned} (type: ${typeof processed.pinned})`);
        return processed;
      });
      
      console.log('[PROJECT SERVICE] All processed projects:', processedProjects.map(p => ({id: p.id, title: p.title, pinned: p.pinned})));
      return processedProjects;
    } catch (error) {
      console.error('Failed to list projects:', error);
      throw error;
    }
  },

  /**
   * Get a specific project by ID
   */
  async getProject(projectId: string): Promise<Project> {
    try {
      const project = await callAPI<Project>(`/api/projects/${projectId}`);
      
      return {
        ...project,
        progress: project.progress || 0,
        updated: project.updated || this.formatRelativeTime(project.updated_at)
      };
    } catch (error) {
      console.error(`Failed to get project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new project
   */
  async createProject(projectData: CreateProjectRequest): Promise<Project> {
    // Validate input
    const validation = validateCreateProject(projectData);
    if (!validation.success) {
      throw new ValidationError(formatValidationErrors(validation.error));
    }

    try {
      const project = await callAPI<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validation.data)
      });
      
      // Broadcast creation event
      this.broadcastProjectUpdate('PROJECT_CREATED', project.id, project);
      
      return {
        ...project,
        progress: 0,
        updated: this.formatRelativeTime(project.created_at)
      };
    } catch (error) {
      console.error('Failed to create project:', error);
      throw error;
    }
  },

  /**
   * Create a new project with streaming progress
   */
  async createProjectWithStreaming(projectData: CreateProjectRequest): Promise<{ progress_id: string; status: string; message: string }> {
    // Validate input
    console.log('[PROJECT SERVICE] Validating project data:', projectData);
    const validation = validateCreateProject(projectData);
    if (!validation.success) {
      console.error('[PROJECT SERVICE] Validation failed:', validation.error);
      throw new ValidationError(formatValidationErrors(validation.error));
    }
    console.log('[PROJECT SERVICE] Validation passed:', validation.data);

    try {
      console.log('[PROJECT SERVICE] Sending project creation request:', validation.data);
      const response = await callAPI<{ progress_id: string; status: string; message: string }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validation.data)
      });
      
      console.log('[PROJECT SERVICE] Project creation response:', response);
      return response;
    } catch (error) {
      console.error('[PROJECT SERVICE] Failed to initiate project creation:', error);
      if (error instanceof ProjectServiceError) {
        console.error('[PROJECT SERVICE] Error details:', {
          message: error.message,
          code: error.code,
          statusCode: error.statusCode
        });
      }
      throw error;
    }
  },

  /**
   * Update an existing project
   */
  async updateProject(projectId: string, updates: UpdateProjectRequest): Promise<Project> {
    // Validate input
    console.log(`[PROJECT SERVICE] Updating project ${projectId} with data:`, updates);
    const validation = validateUpdateProject(updates);
    if (!validation.success) {
      console.error(`[PROJECT SERVICE] Validation failed:`, validation.error);
      throw new ValidationError(formatValidationErrors(validation.error));
    }

    try {
      console.log(`[PROJECT SERVICE] Sending API request to update project ${projectId}`, validation.data);
      const project = await callAPI<Project>(`/api/projects/${projectId}`, {
        method: 'PUT',
        body: JSON.stringify(validation.data)
      });
      
      console.log(`[PROJECT SERVICE] API update response:`, project);
      
      // Broadcast update event
      this.broadcastProjectUpdate('PROJECT_UPDATED', project.id, updates);
      
      // Ensure pinned property is properly handled as boolean
      const processedProject = {
        ...project,
        pinned: project.pinned === true,
        progress: project.progress || 0,
        updated: this.formatRelativeTime(project.updated_at)
      };
      
      console.log(`[PROJECT SERVICE] Final processed project:`, {
        id: processedProject.id,
        title: processedProject.title,
        pinned: processedProject.pinned
      });
      
      return processedProject;
    } catch (error) {
      console.error(`Failed to update project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a project
   */
  async deleteProject(projectId: string): Promise<void> {
    try {
      await callAPI(`/api/projects/${projectId}`, {
        method: 'DELETE'
      });
      
      // Broadcast deletion event
      this.broadcastProjectUpdate('PROJECT_DELETED', projectId, {});
    } catch (error) {
      console.error(`Failed to delete project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get features from a project's features JSONB field
   */
  async getProjectFeatures(projectId: string): Promise<{ features: any[]; count: number }> {
    try {
      const response = await callAPI<{ features: any[]; count: number }>(`/api/projects/${projectId}/features`);
      return response;
    } catch (error) {
      console.error(`Failed to get features for project ${projectId}:`, error);
      throw error;
    }
  },

  // ==================== TASK OPERATIONS ====================

  /**
   * Get all tasks for a project
   */
  async getTasksByProject(projectId: string): Promise<Task[]> {
    try {
      const tasks = await callAPI<Task[]>(`/api/projects/${projectId}/tasks`);
      
      // Convert database tasks to UI tasks with status mapping
      return tasks.map((task: Task) => dbTaskToUITask(task));
    } catch (error) {
      console.error(`Failed to get tasks for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get a specific task by ID
   */
  async getTask(taskId: string): Promise<Task> {
    try {
      const task = await callAPI<Task>(`/api/tasks/${taskId}`);
      return dbTaskToUITask(task);
    } catch (error) {
      console.error(`Failed to get task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new task
   */
  async createTask(taskData: CreateTaskRequest): Promise<Task> {
    // Validate input
    const validation = validateCreateTask(taskData);
    if (!validation.success) {
      throw new ValidationError(formatValidationErrors(validation.error));
    }

    try {
      // The validation.data already has defaults from schema
      const requestData = validation.data;

      const task = await callAPI<Task>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(requestData)
      });
      
      // Broadcast creation event
      this.broadcastTaskUpdate('TASK_CREATED', task.id, task.project_id, task);
      
      return dbTaskToUITask(task);
    } catch (error) {
      console.error('Failed to create task:', error);
      throw error;
    }
  },

  /**
   * Update an existing task
   */
  async updateTask(taskId: string, updates: UpdateTaskRequest): Promise<Task> {
    // Validate input
    const validation = validateUpdateTask(updates);
    if (!validation.success) {
      throw new ValidationError(formatValidationErrors(validation.error));
    }

    try {
      const task = await callAPI<Task>(`/api/tasks/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(validation.data)
      });
      
      // Broadcast update event
      this.broadcastTaskUpdate('TASK_UPDATED', task.id, task.project_id, updates);
      
      return dbTaskToUITask(task);
    } catch (error) {
      console.error(`Failed to update task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Update task status (for drag & drop operations)
   */
  async updateTaskStatus(taskId: string, uiStatus: UITaskStatus): Promise<Task> {
    // Convert UI status to database status
    const dbStatus = uiStatusToDBStatus(uiStatus);
    
    // Validate input
    const validation = validateUpdateTaskStatus({ task_id: taskId, status: dbStatus });
    if (!validation.success) {
      throw new ValidationError(formatValidationErrors(validation.error));
    }

    try {
      // Use the standard update task endpoint with status parameter
      const task = await callAPI<Task>(`/api/tasks/${taskId}?status=${dbStatus}`, {
        method: 'PUT'
      });
      
      // Broadcast move event
      this.broadcastTaskUpdate('TASK_MOVED', task.id, task.project_id, { status: dbStatus });
      
      return dbTaskToUITask(task);
    } catch (error) {
      console.error(`Failed to update task status ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    try {
      // Get task info before deletion for broadcasting
      const task = await this.getTask(taskId);
      
      await callAPI(`/api/tasks/${taskId}`, {
        method: 'DELETE'
      });
      
      // Broadcast archive event  
      this.broadcastTaskUpdate('TASK_ARCHIVED', taskId, task.project_id, {});
    } catch (error) {
      console.error(`Failed to delete task ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Update task order for better drag-and-drop support
   */
  async updateTaskOrder(taskId: string, newOrder: number, newStatus?: DatabaseTaskStatus): Promise<Task> {
    try {
      const updates: UpdateTaskRequest = {
        task_order: newOrder
      };
      
      if (newStatus) {
        updates.status = newStatus;
      }
      
      const task = await this.updateTask(taskId, updates);
      
      // Broadcast order change event
      this.broadcastTaskUpdate('TASK_MOVED', task.id, task.project_id, { task_order: newOrder, status: newStatus });
      
      return task;
    } catch (error) {
      console.error(`Failed to update task order for ${taskId}:`, error);
      throw error;
    }
  },

  /**
   * Get tasks by status across all projects
   */
  async getTasksByStatus(status: DatabaseTaskStatus): Promise<Task[]> {
    try {
      // Note: This endpoint might need to be implemented in the backend
      // For now, we'll get all projects and filter tasks locally
      const projects = await this.listProjects();
      const allTasks: Task[] = [];
      
      for (const project of projects) {
        const projectTasks = await this.getTasksByProject(project.id);
        // Filter tasks by database status - task.status should be DatabaseTaskStatus from database
        allTasks.push(...projectTasks.filter(task => {
          return task.status === status;
        }));
      }
      
      return allTasks;
    } catch (error) {
      console.error(`Failed to get tasks by status ${status}:`, error);
      throw error;
    }
  },


  // ==================== DOCUMENT OPERATIONS ====================

  /**
   * List all documents for a project
   */
  async listProjectDocuments(projectId: string): Promise<Document[]> {
    try {
      const response = await callAPI<{documents: Document[]}>(`/api/projects/${projectId}/docs`);
      return response.documents || [];
    } catch (error) {
      console.error(`Failed to list documents for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get a specific document with full content
   */
  async getDocument(projectId: string, docId: string): Promise<Document> {
    try {
      const response = await callAPI<{document: Document}>(`/api/projects/${projectId}/docs/${docId}`);
      return response.document;
    } catch (error) {
      console.error(`Failed to get document ${docId} from project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Create a new document for a project
   */
  async createDocument(projectId: string, documentData: Partial<Document>): Promise<Document> {
    try {
      const response = await callAPI<{document: Document}>(`/api/projects/${projectId}/docs`, {
        method: 'POST',
        body: JSON.stringify(documentData)
      });
      return response.document;
    } catch (error) {
      console.error(`Failed to create document for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Update an existing document
   */
  async updateDocument(projectId: string, docId: string, updates: Partial<Document>): Promise<Document> {
    try {
      const response = await callAPI<{document: Document}>(`/api/projects/${projectId}/docs/${docId}`, {
        method: 'PUT',
        body: JSON.stringify(updates)
      });
      return response.document;
    } catch (error) {
      console.error(`Failed to update document ${docId} in project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Delete a document
   */
  async deleteDocument(projectId: string, docId: string): Promise<void> {
    try {
      await callAPI<void>(`/api/projects/${projectId}/docs/${docId}`, { method: 'DELETE' });
    } catch (error) {
      console.error(`Failed to delete document ${docId} from project ${projectId}:`, error);
      throw error;
    }
  },

  // ==================== VERSIONING OPERATIONS ====================

  /**
   * Get version history for project documents
   */
  async getDocumentVersionHistory(projectId: string, fieldName: string = 'docs'): Promise<any[]> {
    try {
      const response = await callAPI<{versions: any[]}>(`/api/projects/${projectId}/versions?field_name=${fieldName}`);
      return response.versions || [];
    } catch (error) {
      console.error(`Failed to get document version history for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Get content of a specific document version for preview
   */
  async getVersionContent(projectId: string, versionNumber: number, fieldName: string = 'docs'): Promise<any> {
    try {
      const response = await callAPI<{content: any, version: any}>(`/api/projects/${projectId}/versions/${fieldName}/${versionNumber}`);
      return response;
    } catch (error) {
      console.error(`Failed to get version ${versionNumber} content for project ${projectId}:`, error);
      throw error;
    }
  },

  /**
   * Restore a project document field to a specific version
   */
  async restoreDocumentVersion(projectId: string, versionNumber: number, fieldName: string = 'docs'): Promise<any> {
    try {
      const response = await callAPI<any>(`/api/projects/${projectId}/versions/${fieldName}/${versionNumber}/restore`, {
        method: 'POST'
      });
      
      // Broadcast restore event
      this.broadcastProjectUpdate('PROJECT_UPDATED', projectId, { restored_version: versionNumber, field_name: fieldName });
      
      return response;
    } catch (error) {
      console.error(`Failed to restore version ${versionNumber} for project ${projectId}:`, error);
      throw error;
    }
  },

  // ==================== REAL-TIME SUBSCRIPTIONS ====================

  /**
   * Subscribe to real-time project updates
   */
  subscribeToProjectUpdates(projectId: string, callback: (event: ProjectManagementEvent) => void): () => void {
    // Initialize WebSocket connection if needed
    initializeWebSocket();
    
    // Add subscription
    projectUpdateSubscriptions.set(projectId, callback);
    
    // Return unsubscribe function
    return () => {
      projectUpdateSubscriptions.delete(projectId);
    };
  },

  /**
   * Unsubscribe from all project updates
   */
  unsubscribeFromUpdates(): void {
    projectUpdateSubscriptions.clear();
    
    if (websocketConnection?.readyState === WebSocket.OPEN) {
      websocketConnection.close();
    }
  },

  // ==================== UTILITY METHODS ====================

  /**
   * Format relative time for display
   */
  formatRelativeTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;
    
    return `${Math.floor(diffInSeconds / 604800)} weeks ago`;
  },

  /**
   * Broadcast project update event
   */
  broadcastProjectUpdate(type: 'PROJECT_CREATED' | 'PROJECT_UPDATED' | 'PROJECT_DELETED', projectId: string, data: any): void {
    const event: ProjectManagementEvent = {
      type,
      projectId,
      userId: 'current-user', // TODO: Get from auth context
      timestamp: new Date().toISOString(),
      data
    };

    // Send via WebSocket if connected
    if (websocketConnection?.readyState === WebSocket.OPEN) {
      websocketConnection.send(JSON.stringify(event));
    }
  },

  /**
   * Broadcast task update event
   */
  broadcastTaskUpdate(type: 'TASK_CREATED' | 'TASK_UPDATED' | 'TASK_MOVED' | 'TASK_DELETED' | 'TASK_ARCHIVED', taskId: string, projectId: string, data: any): void {
    const event: ProjectManagementEvent = {
      type,
      taskId,
      projectId,
      userId: 'current-user', // TODO: Get from auth context
      timestamp: new Date().toISOString(),
      data
    };

    // Send via WebSocket if connected
    if (websocketConnection?.readyState === WebSocket.OPEN) {
      websocketConnection.send(JSON.stringify(event));
    }
  }
};

// Default export
export default projectService; 