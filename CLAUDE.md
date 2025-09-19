# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Beta Development Guidelines

**Local-only deployment** - each user runs their own instance.

### Core Principles

- **No backwards compatibility; we follow a fix‑forward approach** — remove deprecated code immediately
- **Detailed errors over graceful failures** - we want to identify and fix issues fast
- **Break things to improve them** - beta is for rapid iteration
- **Continuous improvement** - embrace change and learn from mistakes
- **KISS** - keep it simple
- **DRY** when appropriate
- **YAGNI** — don't implement features that are not needed

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

When a process should continue despite failures, it must **skip the failed item entirely** rather than storing corrupted data

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
- Fix forward
- Focus on user experience and feature completeness
- When updating code, don't reference what is changing (avoid keywords like SIMPLIFIED, ENHANCED, LEGACY, CHANGED, REMOVED), instead focus on comments that document just the functionality of the code
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

@PRPs/ai_docs/ARCHITECTURE.md

#### TanStack Query Implementation

For architecture and file references:
@PRPs/ai_docs/DATA_FETCHING_ARCHITECTURE.md

For code patterns and examples:
@PRPs/ai_docs/QUERY_PATTERNS.md

#### Service Layer Pattern

See implementation examples:
- API routes: `python/src/server/api_routes/projects_api.py`
- Service layer: `python/src/server/services/project_service.py`
- Pattern: API Route → Service → Database

#### Error Handling Patterns

See implementation examples:
- Custom exceptions: `python/src/server/exceptions.py`
- Exception handlers: `python/src/server/main.py` (search for @app.exception_handler)
- Service error handling: `python/src/server/services/` (various services)

## ETag Implementation

@PRPs/ai_docs/ETAG_IMPLEMENTATION.md

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

@PRPs/ai_docs/API_NAMING_CONVENTIONS.md

Use database values directly (no FE mapping; type‑safe end‑to‑end from BE upward):

## Environment Variables

Required in `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co  # Or http://host.docker.internal:8000 for local
SUPABASE_SERVICE_KEY=your-service-key-here      # Use legacy key format for cloud Supabase
```

Optional variables and full configuration:
See `python/.env.example` for complete list

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
3. Register tools in the feature's `__init__.py` file

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
- TanStack Query handles all data fetching; smart HTTP polling is used where appropriate (no WebSockets)
- Frontend uses Vite proxy for API calls in development
- Python backend uses `uv` for dependency management
- Docker Compose handles service orchestration
- TanStack Query for all data fetching - NO PROP DRILLING
- Vertical slice architecture in `/features` - features own their sub-features
