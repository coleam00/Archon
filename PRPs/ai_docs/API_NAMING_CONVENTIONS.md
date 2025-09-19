# API Naming Conventions

## Overview

This document describes the actual naming conventions used throughout Archon's codebase based on current implementation patterns. All examples reference real files where these patterns are implemented.

## Backend API Endpoints

### RESTful Route Patterns
**Reference**: `python/src/server/api_routes/projects_api.py`

Standard REST patterns used:
- `GET /api/{resource}` - List all resources
- `POST /api/{resource}` - Create new resource
- `GET /api/{resource}/{id}` - Get single resource
- `PUT /api/{resource}/{id}` - Update resource
- `DELETE /api/{resource}/{id}` - Delete resource

Nested resource patterns:
- `GET /api/projects/{project_id}/tasks` - Tasks scoped to project
- `GET /api/projects/{project_id}/docs` - Documents scoped to project
- `POST /api/projects/{project_id}/versions` - Create version for project

### Actual Endpoint Examples
From `python/src/server/api_routes/`:

**Projects** (`projects_api.py`):
- `/api/projects` - Project CRUD
- `/api/projects/{project_id}/features` - Get project features
- `/api/projects/{project_id}/tasks` - Project-scoped tasks
- `/api/projects/{project_id}/docs` - Project documents
- `/api/projects/{project_id}/versions` - Version history

**Knowledge** (`knowledge_api.py`):
- `/api/knowledge/sources` - Knowledge sources
- `/api/knowledge/crawl` - Start web crawl
- `/api/knowledge/upload` - Upload document
- `/api/knowledge/search` - RAG search
- `/api/knowledge/code-search` - Code-specific search

**Progress** (`progress_api.py`):
- `/api/progress/active` - Active operations
- `/api/progress/{operation_id}` - Specific operation status

**MCP** (`mcp_api.py`):
- `/api/mcp/status` - MCP server status
- `/api/mcp/execute` - Execute MCP tool

## Frontend Service Methods

### Service Object Pattern
**Reference**: `archon-ui-main/src/features/projects/services/projectService.ts`

Services are exported as objects with async methods:
```typescript
export const serviceNameService = {
  async methodName(): Promise<ReturnType> { ... }
}
```

### Standard Service Method Names
Actual patterns from service files:

**List Operations**:
- `listProjects()` - Get all projects
- `getTasksByProject(projectId)` - Get filtered list
- `getTasksByStatus(status)` - Get by specific criteria

**Single Item Operations**:
- `getProject(projectId)` - Get single item
- `getTask(taskId)` - Direct ID access

**Create Operations**:
- `createProject(data)` - Returns created entity
- `createTask(data)` - Includes server-generated fields

**Update Operations**:
- `updateProject(id, updates)` - Partial updates
- `updateTaskStatus(id, status)` - Specific field update
- `updateTaskOrder(id, order, status?)` - Complex updates

**Delete Operations**:
- `deleteProject(id)` - Returns void
- `deleteTask(id)` - Soft delete pattern

### Service File Locations
- **Projects**: `archon-ui-main/src/features/projects/services/projectService.ts`
- **Tasks**: `archon-ui-main/src/features/projects/tasks/services/taskService.ts`
- **Knowledge**: `archon-ui-main/src/features/knowledge/services/knowledgeService.ts`
- **Progress**: `archon-ui-main/src/features/progress/services/progressService.ts`

## React Hook Naming

### Query Hooks
**Reference**: `archon-ui-main/src/features/projects/tasks/hooks/useTaskQueries.ts`

Standard patterns:
- `use[Resource]()` - List query (e.g., `useProjects`)
- `use[Resource]Detail(id)` - Single item query
- `use[Parent][Resource](parentId)` - Scoped query (e.g., `useProjectTasks`)

### Mutation Hooks
- `useCreate[Resource]()` - Creation mutation
- `useUpdate[Resource]()` - Update mutation
- `useDelete[Resource]()` - Deletion mutation

### Utility Hooks
**Reference**: `archon-ui-main/src/features/ui/hooks/`
- `useSmartPolling()` - Visibility-aware polling
- `useToast()` - Toast notifications
- `useDebounce()` - Debounced values

## Type Naming Conventions

### Type Definition Patterns
**Reference**: `archon-ui-main/src/features/projects/types/`

**Entity Types**:
- `Project` - Core entity type
- `Task` - Business object
- `Document` - Data model

**Request/Response Types**:
- `Create[Entity]Request` - Creation payload
- `Update[Entity]Request` - Update payload
- `[Entity]Response` - API response wrapper

**Database Types**:
- `DatabaseTaskStatus` - Exact database values
**Location**: `archon-ui-main/src/features/projects/tasks/types/task.ts`
Values: `"todo" | "doing" | "review" | "done"`

### Type File Organization
Following vertical slice architecture:
- Core types in `{feature}/types/`
- Sub-feature types in `{feature}/{subfeature}/types/`
- Shared types in `shared/types/`

## Query Key Factories

**Reference**: Each feature's `hooks/use{Feature}Queries.ts` file

Standard factory pattern:
- `{resource}Keys.all` - Base key for invalidation
- `{resource}Keys.lists()` - List queries
- `{resource}Keys.detail(id)` - Single item queries
- `{resource}Keys.byProject(projectId)` - Scoped queries

Examples:
- `projectKeys` - Projects domain
- `taskKeys` - Tasks (dual nature: global and project-scoped)
- `knowledgeKeys` - Knowledge base
- `progressKeys` - Progress tracking
- `documentKeys` - Document management

## Component Naming

### Page Components
**Location**: `archon-ui-main/src/pages/`
- `[Feature]Page.tsx` - Top-level pages
- `[Feature]View.tsx` - Main view components

### Feature Components
**Location**: `archon-ui-main/src/features/{feature}/components/`
- `[Entity]Card.tsx` - Card displays
- `[Entity]List.tsx` - List containers
- `[Entity]Form.tsx` - Form components
- `New[Entity]Modal.tsx` - Creation modals
- `Edit[Entity]Modal.tsx` - Edit modals

### Shared Components
**Location**: `archon-ui-main/src/features/ui/primitives/`
- Radix UI-based primitives
- Generic, reusable components

## State Variable Naming

### Loading States
**Examples from**: `archon-ui-main/src/features/projects/views/ProjectsView.tsx`
- `isLoading` - Generic loading
- `is[Action]ing` - Specific operations (e.g., `isSwitchingProject`)
- `[action]ingIds` - Sets of items being processed

### Error States
- `error` - Query errors
- `[operation]Error` - Specific operation errors

### Selection States
- `selected[Entity]` - Currently selected item
- `active[Entity]Id` - Active item ID

## Constants and Enums

### Status Values
**Location**: `archon-ui-main/src/features/projects/tasks/types/task.ts`
Database values used directly - no mapping layers:
- Task statuses: `"todo"`, `"doing"`, `"review"`, `"done"`
- Operation statuses: `"pending"`, `"processing"`, `"completed"`, `"failed"`

### Time Constants
**Location**: `archon-ui-main/src/features/shared/queryPatterns.ts`
- `STALE_TIMES.instant` - 0ms
- `STALE_TIMES.realtime` - 3 seconds
- `STALE_TIMES.frequent` - 5 seconds
- `STALE_TIMES.normal` - 30 seconds
- `STALE_TIMES.rare` - 5 minutes
- `STALE_TIMES.static` - Infinity

## File Naming Patterns

### Service Layer
- `{feature}Service.ts` - Service modules
- Use lower camelCase with "Service" suffix (e.g., `projectService.ts`)

### Hook Files
- `use{Feature}Queries.ts` - Query hooks and keys
- `use{Feature}.ts` - Feature-specific hooks

### Type Files
- `index.ts` - Barrel exports
- `{entity}.ts` - Specific entity types

### Test Files
- `{filename}.test.ts` - Unit tests
- Located in `tests/` subdirectories

## Best Practices

### Do Follow
- Use exact database values (no translation layers)
- Keep consistent patterns within features
- Use query key factories for all cache operations
- Follow vertical slice architecture
- Reference shared constants

### Don't Do
- Don't create mapping layers for database values
- Don't hardcode time values
- Don't mix query keys between features
- Don't use inconsistent naming within a feature
- Don't embed business logic in components

## Common Patterns Reference

For implementation examples, see:
- Query patterns: Any `use{Feature}Queries.ts` file
- Service patterns: Any `{feature}Service.ts` file
- Type patterns: Any `{feature}/types/` directory
- Component patterns: Any `{feature}/components/` directory