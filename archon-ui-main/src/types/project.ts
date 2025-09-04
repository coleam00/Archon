// TypeScript types for Project Management system
// Based on database schema in migration/archon_tasks.sql

// Database status enum mapping
export type DatabaseTaskStatus = 'todo' | 'doing' | 'review' | 'done';

// Using database status values directly - no UI mapping needed

// Priority levels
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';


// Assignee type - simplified to predefined options
export type Assignee = 'User' | 'Archon' | 'AI IDE Agent';

// Base Project interface (matches database schema)
export interface Project {
  id: string;
  title: string;
  prd?: Record<string, any>; // JSONB field
  docs?: any[]; // JSONB field
  features?: any[]; // JSONB field  
  data?: any[]; // JSONB field
  github_repo?: string;
  created_at: string;
  updated_at: string;
  technical_sources?: string[]; // Array of source IDs from archon_project_sources table
  business_sources?: string[]; // Array of source IDs from archon_project_sources table
  
  // Extended UI properties (stored in JSONB fields)
  description?: string;
  progress?: number;
  updated?: string; // Human-readable format
  pinned: boolean; // Database column - indicates if project is pinned for priority
  
  // Creation progress tracking for inline display
  creationProgress?: {
    progressId: string;
    status: 'starting' | 'initializing_agents' | 'generating_docs' | 'processing_requirements' | 'ai_generation' | 'finalizing_docs' | 'saving_to_database' | 'completed' | 'error';
    percentage: number;
    logs: string[];
    error?: string;
    step?: string;
    currentStep?: string;
    eta?: string;
    duration?: string;
    project?: Project; // The created project when completed
  };
}

// Base Task interface (matches database schema)
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: DatabaseTaskStatus;
  assignee: Assignee; // Now a database column with enum constraint
  task_order: number; // New database column for priority ordering
  feature?: string; // New database column for feature name
  sources?: any[]; // JSONB field
  code_examples?: any[]; // JSONB field
  created_at: string;
  updated_at: string;
  
  // Soft delete fields
  archived?: boolean; // Soft delete flag
  archived_at?: string; // Timestamp when archived
  archived_by?: string; // User/system that archived the task
  
  // Extended UI properties (can be stored in sources JSONB)
  featureColor?: string;
  priority?: TaskPriority;
  
  // No UI-specific status mapping needed
}

// Create project request
export interface CreateProjectRequest {
  title: string;
  description?: string;
  github_repo?: string;
  pinned?: boolean;
  // Note: PRD data should be stored as a document in the docs array with document_type="prd"
  // not as a direct 'prd' field since this column doesn't exist in the database
  docs?: any[];
  features?: any[];
  data?: any[];
  technical_sources?: string[];
  business_sources?: string[];
}

// Update project request
export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  github_repo?: string;
  prd?: Record<string, any>;
  docs?: any[];
  features?: any[];
  data?: any[];
  technical_sources?: string[];
  business_sources?: string[];
  pinned?: boolean;
}

// Create task request
// Task counts for a project
export interface TaskCounts {
  todo: number;
  doing: number;
  done: number;
}

export interface CreateTaskRequest {
  project_id: string;
  title: string;
  description: string;
  status?: DatabaseTaskStatus;
  assignee?: Assignee;
  task_order?: number;
  feature?: string;
  featureColor?: string;
  priority?: TaskPriority;
  sources?: any[];
  code_examples?: any[];
}

// Update task request
export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  status?: DatabaseTaskStatus;
  assignee?: Assignee;
  task_order?: number;
  feature?: string;
  featureColor?: string;
  priority?: TaskPriority;
  sources?: any[];
  code_examples?: any[];
}

// MCP tool response types
export interface MCPToolResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Utility type for paginated responses
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

// No status mapping needed - using database values directly 