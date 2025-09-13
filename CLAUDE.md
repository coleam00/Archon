# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Beta Development Guidelines

**Local-only deployment** - each user runs their own instance.

### Core Principles

- **No backwards compatibility** - remove deprecated code immediately
- **Detailed errors over graceful failures** - we want to identify and fix issues fast
- **Break things to improve them** - beta is for rapid iteration

### Error Handling

**Core Principle**: In beta, we need to intelligently decide when to fail hard and fast to quickly address issues, and when to allow processes to complete in critical services despite failures. Read below carefully and make intelligent decisions on a case-by-case basis.

#### When to Fail Fast and Loud (Let it Crash!)

These errors should stop execution and bubble up immediately: (except for crawling flows)

- **Service startup failures** - If credentials, database, or any service can't initialize, the system should crash with a clear error
- **Missing configuration** - Missing environment variables or invalid settings should stop the system
- **Database connection failures** - Don't hide connection issues, expose them
- **Authentication/authorization failures** - Security errors must be visible and halt the operation
- **Data corruption or validation errors** - Never silently accept bad data, Pydantic should raise
- **Critical dependencies unavailable** - If a required service is down, fail immediately
- **Invalid data that would corrupt state** - Never store zero embeddings, null foreign keys, or malformed JSON

#### When to Complete but Log Detailed Errors

These operations should continue but track and report failures clearly:

- **Batch processing** - When crawling websites or processing documents, complete what you can and report detailed failures for each item
- **Background tasks** - Embedding generation, async jobs should finish the queue but log failures
- **WebSocket events** - Don't crash on a single event failure, log it and continue serving other clients
- **Optional features** - If projects/tasks are disabled, log and skip rather than crash
- **External API calls** - Retry with exponential backoff, then fail with a clear message about what service failed and why

#### Critical Nuance: Never Accept Corrupted Data

When a process should continue despite failures, it must **skip the failed item entirely** rather than storing corrupted data:

**❌ WRONG - Silent Corruption:**

```python
try:
    embedding = create_embedding(text)
except Exception as e:
    embedding = [0.0] * 1536  # NEVER DO THIS - corrupts database
    store_document(doc, embedding)
```

**✅ CORRECT - Skip Failed Items:**

```python
try:
    embedding = create_embedding(text)
    store_document(doc, embedding)  # Only store on success
except Exception as e:
    failed_items.append({'doc': doc, 'error': str(e)})
    logger.error(f"Skipping document {doc.id}: {e}")
    # Continue with next document, don't store anything
```

**✅ CORRECT - Batch Processing with Failure Tracking:**

```python
def process_batch(items):
    results = {'succeeded': [], 'failed': []}

    for item in items:
        try:
            result = process_item(item)
            results['succeeded'].append(result)
        except Exception as e:
            results['failed'].append({
                'item': item,
                'error': str(e),
                'traceback': traceback.format_exc()
            })
            logger.error(f"Failed to process {item.id}: {e}")

    # Always return both successes and failures
    return results
```

#### Error Message Guidelines

- Include context about what was being attempted when the error occurred
- Preserve full stack traces with `exc_info=True` in Python logging
- Use specific exception types, not generic Exception catching
- Include relevant IDs, URLs, or data that helps debug the issue
- Never return None/null to indicate failure - raise an exception with details
- For batch operations, always report both success count and detailed failure list

### Code Quality

- Remove dead code immediately rather than maintaining it - no backward compatibility or legacy functions
- Avoid backward compatibility mappings or legacy function wrappers
- Prioritize functionality over production-ready patterns
- Focus on user experience and feature completeness
- When updating code, don't reference what is changing (avoid keywords like LEGACY, CHANGED, REMOVED), instead focus on comments that document just the functionality of the code
- When commenting on code in the codebase, only comment on the functionality and reasoning behind the code. Refrain from speaking to Archon being in "beta" or referencing anything else that comes from these global rules.

## Development Commands

### Frontend (archon-ui-main/)

```bash
npm run dev              # Start development server on port 3737
npm run build            # Build for production
npm run lint             # Run ESLint on legacy code (excludes /features)
npm run lint:files path/to/file.tsx  # Lint specific files

# Biome for /src/features directory only
npm run biome            # Check features directory
npm run biome:fix        # Auto-fix issues
npm run biome:format     # Format code (120 char lines)
npm run biome:ai         # Machine-readable JSON output for AI
npm run biome:ai-fix     # Auto-fix with JSON output

# Testing
npm run test             # Run all tests in watch mode
npm run test:ui          # Run with Vitest UI interface
npm run test:coverage:stream  # Run once with streaming output
vitest run src/features/projects  # Test specific directory

# TypeScript
npx tsc --noEmit         # Check all TypeScript errors
npx tsc --noEmit 2>&1 | grep "src/features"  # Check features only
```

### Backend (python/)

```bash
# Using uv package manager (preferred)
uv sync --group all      # Install all dependencies
uv run python -m src.server.main  # Run server locally on 8181
uv run pytest            # Run all tests
uv run pytest tests/test_api_essentials.py -v  # Run specific test
uv run ruff check        # Run linter
uv run ruff check --fix  # Auto-fix linting issues
uv run mypy src/         # Type check

# Docker operations
docker compose up --build -d       # Start all services
docker compose --profile backend up -d  # Backend only (for hybrid dev)
docker compose logs -f archon-server   # View server logs
docker compose logs -f archon-mcp      # View MCP server logs
docker compose restart archon-server   # Restart after code changes
docker compose down      # Stop all services
docker compose down -v   # Stop and remove volumes
```

### Quick Workflows

```bash
# Hybrid development (recommended) - backend in Docker, frontend local
make dev                 # Or manually: docker compose --profile backend up -d && cd archon-ui-main && npm run dev

# Full Docker mode
make dev-docker          # Or: docker compose up --build -d

# Run linters before committing
make lint                # Runs both frontend and backend linters
make lint-fe             # Frontend only (ESLint + Biome)
make lint-be             # Backend only (Ruff + MyPy)

# Testing
make test                # Run all tests
make test-fe             # Frontend tests only
make test-be             # Backend tests only
```

## Architecture Overview

Archon Beta is a microservices-based knowledge management system with MCP (Model Context Protocol) integration:

### Service Architecture

- **Frontend (port 3737)**: React + TypeScript + Vite + TailwindCSS
  - **Dual UI Strategy**:
    - `/features` - Modern vertical slice with Radix UI primitives + TanStack Query
    - `/components` - Legacy custom components (being migrated)
  - **State Management**: TanStack Query for all data fetching (no prop drilling)
  - **Styling**: Tron-inspired glassmorphism with Tailwind CSS
  - **Linting**: Biome for `/features`, ESLint for legacy code

- **Main Server (port 8181)**: FastAPI with HTTP polling for updates
  - Handles all business logic, database operations, and external API calls
  - WebSocket support removed in favor of HTTP polling with ETag caching

- **MCP Server (port 8051)**: Lightweight HTTP-based MCP protocol server
  - Provides tools for AI assistants (Claude, Cursor, Windsurf)
  - Exposes knowledge search, task management, and project operations

- **Agents Service (port 8052)**: PydanticAI agents for AI/ML operations
  - Handles complex AI workflows and document processing

- **Database**: Supabase (PostgreSQL + pgvector for embeddings)
  - Cloud or local Supabase both supported
  - pgvector for semantic search capabilities

### Frontend Architecture Details

#### Vertical Slice Architecture (/features)

Features are organized by domain hierarchy with self-contained modules:

```
src/features/
├── ui/
│   ├── primitives/    # Radix UI base components
│   ├── hooks/         # Shared UI hooks (useSmartPolling, etc)
│   └── types/         # UI type definitions
├── projects/
│   ├── components/    # Project UI components
│   ├── hooks/         # Project hooks (useProjectQueries, etc)
│   ├── services/      # Project API services
│   ├── types/         # Project type definitions
│   ├── tasks/         # Tasks sub-feature (nested under projects)
│   │   ├── components/
│   │   ├── hooks/     # Task-specific hooks
│   │   ├── services/  # Task API services
│   │   └── types/
│   └── documents/     # Documents sub-feature
│       ├── components/
│       ├── services/
│       └── types/
```

#### TanStack Query Patterns

All data fetching uses TanStack Query with consistent patterns:

```typescript
// Query keys factory pattern
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => [...projectKeys.all, "detail", id] as const,
};

// Smart polling with visibility awareness
const { refetchInterval } = useSmartPolling(10000); // Pauses when tab inactive

// Optimistic updates with rollback
useMutation({
  onMutate: async (data) => {
    await queryClient.cancelQueries(key);
    const previous = queryClient.getQueryData(key);
    queryClient.setQueryData(key, optimisticData);
    return { previous };
  },
  onError: (err, vars, context) => {
    if (context?.previous) {
      queryClient.setQueryData(key, context.previous);
    }
  },
});
```

### Backend Architecture Details

#### Service Layer Pattern

```python
# API Route -> Service -> Database
# src/server/api_routes/projects.py
@router.get("/{project_id}")
async def get_project(project_id: str):
    return await project_service.get_project(project_id)

# src/server/services/project_service.py
async def get_project(project_id: str):
    # Business logic here
    return await db.fetch_project(project_id)
```

#### Error Handling Patterns

```python
# Use specific exceptions
class ProjectNotFoundError(Exception): pass
class ValidationError(Exception): pass

# Rich error responses
@app.exception_handler(ProjectNotFoundError)
async def handle_not_found(request, exc):
    return JSONResponse(
        status_code=404,
        content={"detail": str(exc), "type": "not_found"}
    )
```

## Polling Architecture

### HTTP Polling (replaced Socket.IO)

- **Polling intervals**: 1-2s for active operations, 5-10s for background data
- **ETag caching**: Reduces bandwidth by ~70% via 304 Not Modified responses
- **Smart pausing**: Stops polling when browser tab is inactive
- **Progress endpoints**: `/api/progress/{id}` for operation tracking

### Key Polling Hooks

- `useSmartPolling` - Adjusts interval based on page visibility/focus
- `useCrawlProgressPolling` - Specialized for crawl progress with auto-cleanup
- `useProjectTasks` - Smart polling for task lists

## Database Schema

Key tables in Supabase:

- `sources` - Crawled websites and uploaded documents
  - Stores metadata, crawl status, and configuration
- `documents` - Processed document chunks with embeddings
  - Text chunks with vector embeddings for semantic search
- `projects` - Project management (optional feature)
  - Contains features array, documents, and metadata
- `tasks` - Task tracking linked to projects
  - Status: todo, doing, review, done
  - Assignee: User, Archon, AI IDE Agent
- `code_examples` - Extracted code snippets
  - Language, summary, and relevance metadata

## API Naming Conventions

### Task Status Values

Use database values directly (no UI mapping):

- `todo`, `doing`, `review`, `done`

### Service Method Patterns

- `get[Resource]sByProject(projectId)` - Scoped queries
- `get[Resource](id)` - Single resource
- `create[Resource](data)` - Create operations
- `update[Resource](id, updates)` - Updates
- `delete[Resource](id)` - Soft deletes

### State Naming

- `is[Action]ing` - Loading states (e.g., `isSwitchingProject`)
- `[resource]Error` - Error messages
- `selected[Resource]` - Current selection

## Environment Variables

Required in `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co  # Or http://host.docker.internal:8000 for local
SUPABASE_SERVICE_KEY=your-service-key-here      # Use legacy key format for cloud Supabase
```

Optional:

```bash
LOGFIRE_TOKEN=your-logfire-token      # For observability
LOG_LEVEL=INFO                         # DEBUG, INFO, WARNING, ERROR
ARCHON_SERVER_PORT=8181               # Server port
ARCHON_MCP_PORT=8051                 # MCP server port
ARCHON_UI_PORT=3737                  # Frontend port
```

## Common Development Tasks

### Add a new API endpoint

1. Create route handler in `python/src/server/api_routes/`
2. Add service logic in `python/src/server/services/`
3. Include router in `python/src/server/main.py`
4. Update frontend service in `archon-ui-main/src/features/[feature]/services/`

### Add a new UI component in features directory

1. Use Radix UI primitives from `src/features/ui/primitives/`
2. Create component in relevant feature folder under `src/features/[feature]/components/`
3. Define types in `src/features/[feature]/types/`
4. Use TanStack Query hook from `src/features/[feature]/hooks/`
5. Apply Tron-inspired glassmorphism styling with Tailwind

### Add or modify MCP tools

1. MCP tools are in `python/src/mcp_server/features/[feature]/[feature]_tools.py`
2. Follow the pattern:
   - `find_[resource]` - Handles list, search, and get single item operations
   - `manage_[resource]` - Handles create, update, delete with an "action" parameter
3. Optimize responses by truncating/filtering fields in list operations
4. Register tools in the feature's `__init__.py` file

### Debug MCP connection issues

1. Check MCP health: `curl http://localhost:8051/health`
2. View MCP logs: `docker compose logs archon-mcp`
3. Test tool execution via UI MCP page
4. Verify Supabase connection and credentials

### Fix TypeScript/Linting Issues

```bash
# TypeScript errors in features
npx tsc --noEmit 2>&1 | grep "src/features"

# Biome auto-fix for features
npm run biome:fix

# ESLint for legacy code
npm run lint:files src/components/SomeComponent.tsx
```

## Code Quality Standards

### Frontend

- **TypeScript**: Strict mode enabled, no implicit any
- **Biome** for `/src/features/`: 120 char lines, double quotes, trailing commas
- **ESLint** for legacy code: Standard React rules
- **Testing**: Vitest with React Testing Library

### Backend

- **Python 3.12** with 120 character line length
- **Ruff** for linting - checks for errors, warnings, unused imports
- **Mypy** for type checking - ensures type safety
- **Pytest** for testing with async support

## MCP Tools Available

When connected to Claude/Cursor/Windsurf, the following tools are available:

### Knowledge Base Tools
- `archon:rag_search_knowledge_base` - Search knowledge base for relevant content
- `archon:rag_search_code_examples` - Find code snippets in the knowledge base
- `archon:rag_get_available_sources` - List available knowledge sources

### Project Management
- `archon:find_projects` - Find all projects, search, or get specific project (by project_id)
- `archon:manage_project` - Manage projects with actions: "create", "update", "delete"

### Task Management
- `archon:find_tasks` - Find tasks with search, filters, or get specific task (by task_id)
- `archon:manage_task` - Manage tasks with actions: "create", "update", "delete"

### Document Management
- `archon:find_documents` - Find documents, search, or get specific document (by document_id)
- `archon:manage_document` - Manage documents with actions: "create", "update", "delete"

### Version Control
- `archon:find_versions` - Find version history or get specific version
- `archon:manage_version` - Manage versions with actions: "create", "restore"

## Important Notes

- Projects feature is optional - toggle in Settings UI
- All services communicate via HTTP, not gRPC
- HTTP polling handles all updates
- Frontend uses Vite proxy for API calls in development
- Python backend uses `uv` for dependency management
- Docker Compose handles service orchestration
- TanStack Query for all data fetching - NO PROP DRILLING
- Vertical slice architecture in `/features` - features own their sub-features
