# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Alpha Development Guidelines

**Local-only deployment** - each user runs their own instance.

### Core Principles

- **No backwards compatibility** - remove deprecated code immediately
- **Detailed errors over graceful failures** - we want to identify and fix issues fast
- **Break things to improve them** - alpha is for rapid iteration

### Error Handling

**Core Principle**: In alpha, we want detailed errors that help us fix issues fast, not graceful failures that hide problems.

#### When to Fail Fast and Loud (Let it Crash!)
These errors should stop execution and bubble up immediately:
- **Service startup failures** - If credentials, database, or any service can't initialize, the system should crash with a clear error
- **Missing configuration** - Missing environment variables or invalid settings should stop the system
- **Database connection failures** - Don't hide connection issues, expose them
- **Authentication/authorization failures** - Security errors must be visible and halt the operation
- **Data corruption or validation errors** - Never silently accept bad data, Pydantic should raise
- **Critical dependencies unavailable** - If a required service is down, fail immediately

#### When to Complete but Log Detailed Errors
These operations should continue but log every failure clearly:
- **Batch processing** - When crawling websites or processing documents, complete what you can and report detailed failures for each item
- **Background tasks** - Embedding generation, async jobs should finish the queue but log failures
- **WebSocket events** - Don't crash on a single event failure, log it and continue serving other clients
- **Optional features** - If projects/tasks are disabled, log and skip rather than crash
- **External API calls** - Retry with exponential backoff, then fail with a clear message about what service failed and why

#### Error Message Guidelines
- Include context about what was being attempted when the error occurred
- Preserve full stack traces with `exc_info=True` in Python logging
- Use specific exception types, not generic Exception catching
- Include relevant IDs, URLs, or data that helps debug the issue
- Never return None/null to indicate failure - raise an exception with details

### Code Quality

- Remove dead code immediately rather than maintaining it
- Prioritize functionality over production-ready patterns
- Focus on user experience and feature completeness

## Architecture Overview

Archon V2 Alpha is a microservices-based knowledge management system with MCP (Model Context Protocol) integration:

- **Frontend (port 3737)**: React + TypeScript + Vite + TailwindCSS
- **Main Server (port 8181)**: FastAPI + Socket.IO for real-time updates
- **MCP Server (port 8051)**: Lightweight HTTP-based MCP protocol server
- **Agents Service (port 8052)**: PydanticAI agents for AI/ML operations
- **Database**: Supabase (PostgreSQL + pgvector for embeddings)

## Development Commands

### Frontend (archon-ui-main/)

```bash
npm run dev              # Start development server on port 3737
npm run build            # Build for production
npm run lint             # Run ESLint
npm run test             # Run Vitest tests
npm run test:coverage    # Run tests with coverage report
```

### Backend (python/)

```bash
# Using uv package manager
uv sync                  # Install/update dependencies
uv run pytest            # Run tests
uv run python -m src.server.main  # Run server locally

# With Docker
docker-compose up --build -d       # Start all services
docker-compose logs -f             # View logs
docker-compose restart              # Restart services
```

### Testing

```bash
# Frontend tests (from archon-ui-main/)
npm run test:coverage:stream       # Run with streaming output
npm run test:ui                    # Run with Vitest UI

# Backend tests (from python/)
uv run pytest tests/test_api_essentials.py -v
uv run pytest tests/test_service_integration.py -v
```

## Key API Endpoints

### Knowledge Base

- `POST /api/knowledge/crawl` - Crawl a website
- `POST /api/knowledge/upload` - Upload documents (PDF, DOCX, MD)
- `GET /api/knowledge/items` - List knowledge items
- `POST /api/knowledge/search` - RAG search

### MCP Integration

- `GET /api/mcp/health` - MCP server status
- `POST /api/mcp/tools/{tool_name}` - Execute MCP tool
- `GET /api/mcp/tools` - List available tools

### Projects & Tasks (when enabled)

- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/{id}/tasks` - Get project tasks
- `POST /api/projects/{id}/tasks` - Create task

## Socket.IO Events

Real-time updates via Socket.IO on port 8181:

- `crawl_progress` - Website crawling progress
- `project_creation_progress` - Project setup progress
- `task_update` - Task status changes
- `knowledge_update` - Knowledge base changes

## Environment Variables

Required in `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key-here
```

Optional:

```bash
OPENAI_API_KEY=your-openai-key        # Can be set via UI
LOGFIRE_TOKEN=your-logfire-token      # For observability
LOG_LEVEL=INFO                         # DEBUG, INFO, WARNING, ERROR
```

## File Organization

### Frontend Structure

- `src/components/` - Reusable UI components
- `src/pages/` - Main application pages
- `src/services/` - API communication and business logic
- `src/hooks/` - Custom React hooks
- `src/contexts/` - React context providers

### Backend Structure

- `src/server/` - Main FastAPI application
- `src/server/fastapi/` - API route handlers
- `src/server/services/` - Business logic services
- `src/mcp/` - MCP server implementation
- `src/agents/` - PydanticAI agent implementations

## Database Schema

Key tables in Supabase:

- `sources` - Crawled websites and uploaded documents
- `documents` - Processed document chunks with embeddings
- `projects` - Project management (optional feature)
- `tasks` - Task tracking linked to projects
- `code_examples` - Extracted code snippets

## Common Development Tasks

### Add a new API endpoint

1. Create route handler in `python/src/server/fastapi/`
2. Add service logic in `python/src/server/services/`
3. Include router in `python/src/server/main.py`
4. Update frontend service in `archon-ui-main/src/services/`

### Add a new UI component

1. Create component in `archon-ui-main/src/components/`
2. Add to page in `archon-ui-main/src/pages/`
3. Include any new API calls in services
4. Add tests in `archon-ui-main/test/`

### Debug MCP connection issues

1. Check MCP health: `curl http://localhost:8051/health`
2. View MCP logs: `docker-compose logs archon-mcp`
3. Test tool execution via UI MCP page
4. Verify Supabase connection and credentials

## MCP Tools Available

When connected to Cursor/Windsurf:

- `archon:perform_rag_query` - Search knowledge base
- `archon:search_code_examples` - Find code snippets
- `archon:manage_project` - Project operations
- `archon:manage_task` - Task management
- `archon:get_available_sources` - List knowledge sources

## Important Notes

- Projects feature is optional - toggle in Settings UI
- All services communicate via HTTP, not gRPC
- Socket.IO handles all real-time updates
- Frontend uses Vite proxy for API calls in development
- Python backend uses `uv` for dependency management
- Docker Compose handles service orchestration

ADDITIONAL CONTEXT FOR SPECIFICALLY HOW TO USE ARCHON ITSLEF:
@CLAUDE-ARCHON.md
