# API Naming Conventions

## Overview
This document defines the naming conventions used throughout the Archon V2 codebase for consistency and clarity.

## Task Status Values
**Database values only - no UI mapping:**
- `todo` - Task is in backlog/todo state
- `doing` - Task is actively being worked on
- `review` - Task is pending review
- `done` - Task is completed

## Service Method Naming

### Project Service (`projectService.ts`)

#### Projects
- `listProjects()` - Get all projects
- `getProject(projectId)` - Get single project by ID
- `createProject(projectData)` - Create new project
- `updateProject(projectId, updates)` - Update project
- `deleteProject(projectId)` - Delete project

#### Tasks
- `getTasksByProject(projectId)` - Get all tasks for a specific project
- `getTask(taskId)` - Get single task by ID
- `createTask(taskData)` - Create new task
- `updateTask(taskId, updates)` - Update task with partial data
- `updateTaskStatus(taskId, status)` - Update only task status
- `updateTaskOrder(taskId, newOrder, newStatus?)` - Update task position/order
- `deleteTask(taskId)` - Delete task (soft delete/archive)
- `getTasksByStatus(status)` - Get all tasks with specific status

#### Documents
- `getDocuments(projectId)` - Get all documents for project
- `getDocument(projectId, docId)` - Get single document
- `createDocument(projectId, documentData)` - Create document
- `updateDocument(projectId, docId, updates)` - Update document
- `deleteDocument(projectId, docId)` - Delete document

#### Versions
- `createVersion(projectId, field, content)` - Create version snapshot
- `listVersions(projectId, fieldName?)` - List version history
- `getVersion(projectId, fieldName, versionNumber)` - Get specific version
- `restoreVersion(projectId, fieldName, versionNumber)` - Restore version

## API Endpoint Patterns

### RESTful Endpoints
```
GET    /api/projects                      - List all projects
POST   /api/projects                      - Create project
GET    /api/projects/{project_id}         - Get project
PUT    /api/projects/{project_id}         - Update project
DELETE /api/projects/{project_id}         - Delete project

GET    /api/projects/{project_id}/tasks   - Get project tasks
POST   /api/tasks                         - Create task (project_id in body)
GET    /api/tasks/{task_id}               - Get task
PUT    /api/tasks/{task_id}               - Update task
DELETE /api/tasks/{task_id}               - Delete task

GET    /api/projects/{project_id}/docs         - Get project documents
POST   /api/projects/{project_id}/docs         - Create document
GET    /api/projects/{project_id}/docs/{doc_id} - Get document
PUT    /api/projects/{project_id}/docs/{doc_id} - Update document
DELETE /api/projects/{project_id}/docs/{doc_id} - Delete document
```

### Progress/Polling Endpoints
```
GET /api/progress/{operation_id}          - Generic operation progress
GET /api/knowledge/crawl-progress/{id}    - Crawling progress
GET /api/agent-chat/sessions/{id}/messages - Chat messages
```

## Component Naming

### Hooks
- `use[Feature]` - Custom hooks (e.g., `usePolling`, `useProjectMutation`)
- Returns object with: `{ data, isLoading, error, refetch }`

### Services
- `[feature]Service` - Service modules (e.g., `projectService`, `crawlProgressService`)
- Methods return Promises with typed responses

### Components
- `[Feature][Type]` - UI components (e.g., `TaskBoardView`, `EditTaskModal`)
- Props interfaces: `[Component]Props`

## State Variable Naming

### Loading States
- `isLoading[Feature]` - Boolean loading indicators
- `isSwitchingProject` - Specific operation states
- `movingTaskIds` - Set/Array of items being processed

### Error States
- `[feature]Error` - Error message strings
- `taskOperationError` - Specific operation errors

### Data States
- `[feature]s` - Plural for collections (e.g., `tasks`, `projects`)
- `selected[Feature]` - Currently selected item
- `[feature]Data` - Raw data from API

## Type Definitions

### Database Types (from backend)
```typescript
type DatabaseTaskStatus = 'todo' | 'doing' | 'review' | 'done';
type Assignee = string; // Flexible string to support any agent name
// Common values: 'User', 'Archon', 'Coding Agent'
```

### Request/Response Types
```typescript
Create[Feature]Request  // e.g., CreateTaskRequest
Update[Feature]Request  // e.g., UpdateTaskRequest
[Feature]Response       // e.g., TaskResponse
```

## Function Naming Patterns

### Event Handlers
- `handle[Event]` - Generic handlers (e.g., `handleProjectSelect`)
- `on[Event]` - Props callbacks (e.g., `onTaskMove`, `onRefresh`)

### Operations
- `load[Feature]` - Fetch data (e.g., `loadTasksForProject`)
- `save[Feature]` - Persist changes (e.g., `saveTask`)
- `delete[Feature]` - Remove items (e.g., `deleteTask`)
- `refresh[Feature]` - Reload data (e.g., `refreshTasks`)

### Formatting/Transformation
- `format[Feature]` - Format for display (e.g., `formatTask`)
- `validate[Feature]` - Validate data (e.g., `validateUpdateTask`)

## Best Practices

### ✅ Do Use
- `getTasksByProject(projectId)` - Clear scope with context
- `status` - Single source of truth from database
- Direct database values everywhere (no mapping)
- Polling with `usePolling` hook for data fetching
- Async/await with proper error handling
- ETag headers for efficient polling
- Loading indicators during operations

## Current Architecture Patterns

### Polling & Data Fetching
- HTTP polling with `usePolling` and `useCrawlProgressPolling` hooks
- ETag-based caching for bandwidth efficiency
- Loading state indicators (`isLoading`, `isSwitchingProject`)
- Error toast notifications for user feedback
- Manual refresh triggers via `refetch()`
- Immediate UI updates followed by API calls

### Service Architecture
- Specialized services for different domains (`projectService`, `crawlProgressService`)
- Direct database value usage (no UI/DB mapping)
- Promise-based async operations
- Typed request/response interfaces