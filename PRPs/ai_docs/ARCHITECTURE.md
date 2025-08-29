# Archon Architecture

## Overview

Archon follows a **Vertical Slice Architecture** pattern where features are organized by business capability rather than technical layers. Each module is self-contained with its own API, business logic, and data access, making the system modular, maintainable, and ready for future microservice extraction if needed.

## Core Principles

1. **Feature Cohesion**: All code for a feature lives together
2. **Module Independence**: Modules communicate through well-defined interfaces
3. **Vertical Slices**: Each feature contains its complete stack (API → Service → Repository)
4. **Shared Minimal**: Only truly cross-cutting concerns go in shared
5. **Migration Ready**: Structure supports easy extraction to microservices

## Directory Structure

```
archon/
├── python/
│   ├── src/
│   │   ├── knowledge/                    # Knowledge Management Module
│   │   │   ├── __init__.py
│   │   │   ├── main.py                  # Knowledge module entry point
│   │   │   ├── shared/                  # Shared within knowledge context
│   │   │   │   ├── models.py
│   │   │   │   ├── exceptions.py
│   │   │   │   └── utils.py
│   │   │   └── features/                # Knowledge feature slices
│   │   │       ├── crawling/            # Web crawling feature
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Crawl endpoints
│   │   │       │   ├── service.py      # Crawling orchestration
│   │   │       │   ├── models.py       # Crawl-specific models
│   │   │       │   ├── repository.py   # Crawl data storage
│   │   │       │   └── tests/
│   │   │       ├── document_processing/ # Document upload & processing
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Upload endpoints
│   │   │       │   ├── service.py      # PDF/DOCX processing
│   │   │       │   ├── extractors.py   # Text extraction
│   │   │       │   └── tests/
│   │   │       ├── embeddings/          # Vector embeddings
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Embedding endpoints
│   │   │       │   ├── service.py      # OpenAI/local embeddings
│   │   │       │   ├── models.py
│   │   │       │   └── repository.py   # Vector storage
│   │   │       ├── search/              # RAG search
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Search endpoints
│   │   │       │   ├── service.py      # Search algorithms
│   │   │       │   ├── reranker.py     # Result reranking
│   │   │       │   └── tests/
│   │   │       ├── code_extraction/     # Code snippet extraction
│   │   │       │   ├── __init__.py
│   │   │       │   ├── service.py      # Code parsing
│   │   │       │   ├── analyzers.py    # Language detection
│   │   │       │   └── repository.py
│   │   │       └── source_management/   # Knowledge source CRUD
│   │   │           ├── __init__.py
│   │   │           ├── api.py
│   │   │           ├── service.py
│   │   │           └── repository.py
│   │   │
│   │   ├── projects/                     # Project Management Module
│   │   │   ├── __init__.py
│   │   │   ├── main.py                  # Projects module entry point
│   │   │   ├── shared/                  # Shared within projects context
│   │   │   │   ├── database.py         # Project DB utilities
│   │   │   │   ├── models.py           # Shared project models
│   │   │   │   └── exceptions.py       # Project-specific exceptions
│   │   │   └── features/                # Project feature slices
│   │   │       ├── project_management/  # Project CRUD
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Project endpoints
│   │   │       │   ├── service.py      # Project business logic
│   │   │       │   ├── models.py       # Project models
│   │   │       │   ├── repository.py   # Project DB operations
│   │   │       │   └── tests/
│   │   │       ├── task_management/     # Task CRUD
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Task endpoints
│   │   │       │   ├── service.py      # Task business logic
│   │   │       │   ├── models.py       # Task models
│   │   │       │   ├── repository.py   # Task DB operations
│   │   │       │   └── tests/
│   │   │       ├── task_ordering/       # Drag-and-drop reordering
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Reorder endpoints
│   │   │       │   ├── service.py      # Reordering algorithm
│   │   │       │   └── tests/
│   │   │       ├── document_management/ # Project documents
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Document endpoints
│   │   │       │   ├── service.py      # Document logic
│   │   │       │   ├── models.py
│   │   │       │   └── repository.py
│   │   │       ├── document_versioning/ # Version control
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Version endpoints
│   │   │       │   ├── service.py      # Versioning logic
│   │   │       │   ├── models.py       # Version models
│   │   │       │   └── repository.py   # Version storage
│   │   │       ├── ai_generation/       # AI project creation
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Generate endpoints
│   │   │       │   ├── service.py      # AI orchestration
│   │   │       │   ├── agents.py       # Agent interactions
│   │   │       │   ├── progress.py     # Progress tracking
│   │   │       │   └── prompts.py      # Generation prompts
│   │   │       ├── source_linking/      # Link to knowledge base
│   │   │       │   ├── __init__.py
│   │   │       │   ├── api.py          # Link endpoints
│   │   │       │   ├── service.py      # Linking logic
│   │   │       │   └── repository.py   # Junction table ops
│   │   │       └── bulk_operations/     # Batch updates
│   │   │           ├── __init__.py
│   │   │           ├── api.py          # Bulk endpoints
│   │   │           ├── service.py      # Batch processing
│   │   │           └── tests/
│   │   │
│   │   ├── mcp_server/                   # MCP Protocol Server (IDE Integration)
│   │   │   ├── __init__.py
│   │   │   ├── main.py                  # MCP server entry point
│   │   │   ├── server.py                # FastMCP server setup
│   │   │   ├── features/                # MCP tool implementations
│   │   │   │   ├── projects/           # Project tools for IDEs
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── project_tools.py
│   │   │   │   │   └── tests/
│   │   │   │   ├── tasks/              # Task tools for IDEs
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── task_tools.py
│   │   │   │   │   └── tests/
│   │   │   │   ├── documents/          # Document tools for IDEs
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── document_tools.py
│   │   │   │   │   ├── version_tools.py
│   │   │   │   │   └── tests/
│   │   │   │   └── feature_tools.py    # Feature management
│   │   │   ├── modules/                 # MCP modules
│   │   │   │   └── archon.py          # Main Archon MCP module
│   │   │   └── utils/                  # MCP utilities
│   │   │       └── tool_utils.py
│   │   │
│   │   ├── agents/                       # AI Agents Module
│   │   │   ├── __init__.py
│   │   │   ├── main.py                  # Agents module entry point
│   │   │   ├── config.py                # Agent configurations
│   │   │   ├── features/                # Agent capabilities
│   │   │   │   ├── document_agent/     # Document processing agent
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── agent.py        # PydanticAI agent
│   │   │   │   │   ├── prompts.py      # Agent prompts
│   │   │   │   │   └── tools.py        # Agent tools
│   │   │   │   ├── code_agent/         # Code analysis agent
│   │   │   │   │   ├── __init__.py
│   │   │   │   │   ├── agent.py
│   │   │   │   │   └── analyzers.py
│   │   │   │   └── project_agent/      # Project creation agent
│   │   │   │       ├── __init__.py
│   │   │   │       ├── agent.py
│   │   │   │       ├── prp_generator.py
│   │   │   │       └── task_generator.py
│   │   │   └── shared/                 # Shared agent utilities
│   │   │       ├── base_agent.py
│   │   │       ├── llm_client.py
│   │   │       └── response_models.py
│   │   │
│   │   ├── shared/                       # Shared Across All Modules
│   │   │   ├── database/                # Database utilities
│   │   │   │   ├── __init__.py
│   │   │   │   ├── supabase.py        # Supabase client
│   │   │   │   ├── migrations.py      # DB migrations
│   │   │   │   └── connection_pool.py
│   │   │   ├── auth/                    # Authentication
│   │   │   │   ├── __init__.py
│   │   │   │   ├── api_keys.py
│   │   │   │   └── permissions.py
│   │   │   ├── config/                  # Configuration
│   │   │   │   ├── __init__.py
│   │   │   │   ├── settings.py        # Environment settings
│   │   │   │   └── logfire_config.py  # Logging config
│   │   │   ├── middleware/              # HTTP middleware
│   │   │   │   ├── __init__.py
│   │   │   │   ├── cors.py
│   │   │   │   └── error_handler.py
│   │   │   └── utils/                   # General utilities
│   │   │       ├── __init__.py
│   │   │       ├── datetime_utils.py
│   │   │       └── json_utils.py
│   │   │
│   │   └── main.py                       # Application orchestrator
│   │
│   └── tests/                            # Integration tests
│       ├── test_api_essentials.py
│       ├── test_service_integration.py
│       └── fixtures/
│
├── archon-ui-main/                       # Frontend Application
│   ├── src/
│   │   ├── pages/                      # Page components
│   │   │   ├── KnowledgeBasePage.tsx
│   │   │   ├── ProjectPage.tsx
│   │   │   ├── SettingsPage.tsx
│   │   │   └── MCPPage.tsx
│   │   ├── components/                  # Reusable components
│   │   │   ├── knowledge-base/         # Knowledge features
│   │   │   ├── project-tasks/          # Project features
│   │   │   └── ui/                     # Shared UI components
│   │   ├── services/                    # API services
│   │   │   ├── api.ts                  # Base API client
│   │   │   ├── knowledgeBaseService.ts
│   │   │   ├── projectService.ts
│   │   │   └── pollingService.ts       # New polling utilities
│   │   ├── hooks/                       # React hooks
│   │   │   ├── usePolling.ts           # Polling hook
│   │   │   ├── useDatabaseMutation.ts  # DB-first mutations
│   │   │   └── useAsyncAction.ts
│   │   └── contexts/                    # React contexts
│   │       ├── ToastContext.tsx
│   │       └── ThemeContext.tsx
│   │
│   └── tests/                           # Frontend tests
│
├── PRPs/                                 # Product Requirement Prompts
│   ├── templates/                       # PRP templates
│   ├── ai_docs/                        # AI context documentation
│   └── *.md                            # Feature PRPs
│
├── docs/                                 # Documentation
│   └── architecture/                    # Architecture decisions
│
└── docker/                               # Docker configurations
    ├── Dockerfile
    └── docker-compose.yml
```

## Module Descriptions

### Knowledge Module (`src/knowledge/`)

Core knowledge management functionality including web crawling, document processing, embeddings, and RAG search. This is the heart of Archon's knowledge engine.

**Key Features:**

- Web crawling with JavaScript rendering
- Document upload and text extraction
- Vector embeddings and similarity search
- Code snippet extraction and indexing
- Source management and organization

### Projects Module (`src/projects/`)

Project and task management system with AI-powered project generation. Currently optional via feature flag.

**Key Features:**

- Project CRUD operations
- Task management with drag-and-drop ordering
- Document management with versioning
- AI-powered project generation
- Integration with knowledge base sources

### MCP Server Module (`src/mcp_server/`)

Model Context Protocol server that exposes Archon functionality to IDEs like Cursor and Windsurf.

**Key Features:**

- Tool-based API for IDE integration
- Project and task management tools
- Document operations
- Async operation support

### Agents Module (`src/agents/`)

AI agents powered by PydanticAI for intelligent document processing and project generation.

**Key Features:**

- Document analysis and summarization
- Code understanding and extraction
- Project requirement generation
- Task breakdown and planning

### Shared Module (`src/shared/`)

Cross-cutting concerns shared across all modules. Kept minimal to maintain module independence.

**Key Components:**

- Database connections and utilities
- Authentication and authorization
- Configuration management
- Logging and observability
- Common middleware

## Communication Patterns

### Inter-Module Communication

Modules communicate through:

1. **Direct HTTP API Calls** (current)
   - Projects module calls Knowledge module APIs
   - Simple and straightforward
   - Works well for current scale

2. **Event Bus** (future consideration)

   ```python
   # Example event-driven communication
   await event_bus.publish("project.created", {
       "project_id": "123",
       "created_by": "user"
   })
   ```

3. **Shared Database** (current reality)
   - All modules use same Supabase instance
   - Direct foreign keys between contexts
   - Will need refactoring for true microservices

## Feature Flags

Features can be toggled via environment variables:

```python
# settings.py
PROJECTS_ENABLED = env.bool("PROJECTS_ENABLED", default=False)
TASK_ORDERING_ENABLED = env.bool("TASK_ORDERING_ENABLED", default=True)
AI_GENERATION_ENABLED = env.bool("AI_GENERATION_ENABLED", default=True)
```

## Database Architecture

Currently using a shared Supabase (PostgreSQL) database:

```sql
-- Knowledge context tables
sources
documents
code_examples

-- Projects context tables
archon_projects
archon_tasks
archon_document_versions

-- Cross-context junction tables
archon_project_sources  -- Links projects to knowledge
```

## API Structure

Each feature exposes its own API routes:

```
/api/knowledge/
  /crawl           # Web crawling
  /upload          # Document upload
  /search          # RAG search
  /sources         # Source management

/api/projects/
  /projects        # Project CRUD
  /tasks           # Task management
  /tasks/reorder   # Task ordering
  /documents       # Document management
  /generate        # AI generation
```

## Deployment Architecture

### Current mixed

### Future (service modules)

Each module can become its own service:

```yaml
# docker-compose.yml (future)
services:
  knowledge:
    image: archon-knowledge
    ports: ["8001:8000"]

  projects:
    image: archon-projects
    ports: ["8002:8000"]

  mcp-server:
    image: archon-mcp
    ports: ["8051:8051"]

  agents:
    image: archon-agents
    ports: ["8052:8052"]
```

## Migration Path

### Phase 1: Current State (Modules/service)

- All code in one repository
- Shared database
- Single deployment

### Phase 2: Vertical Slices

- Reorganize by feature
- Clear module boundaries
- Feature flags for control

## Development Guidelines

### Adding a New Feature

1. **Identify the Module**: Which bounded context does it belong to?
2. **Create Feature Slice**: New folder under `module/features/`
3. **Implement Vertical Slice**:
   - `api.py` - HTTP endpoints
   - `service.py` - Business logic
   - `models.py` - Data models
   - `repository.py` - Data access
   - `tests/` - Feature tests

### Testing Strategy

- **Unit Tests**: Each feature has its own tests
- **Integration Tests**: Test module boundaries
- **E2E Tests**: Test complete user flows

### Code Organization Rules

1. **Features are Self-Contained**: All code for a feature lives together
2. **No Cross-Feature Imports**: Use module's shared or API calls
3. **Shared is Minimal**: Only truly cross-cutting concerns
4. **Dependencies Point Inward**: Features → Module Shared → Global Shared

## Technology Stack

### Backend

- **FastAPI**: Web framework
- **Supabase**: Database and auth
- **PydanticAI**: AI agents
- **OpenAI**: Embeddings and LLM
- **Crawl4AI**: Web crawling

### Frontend

- **React**: UI framework
- **TypeScript**: Type safety
- **TailwindCSS**: Styling
- **React Query**: Data fetching
- **Vite**: Build tool

### Infrastructure

- **Docker**: Containerization
- **PostgreSQL**: Database (via Supabase, desire to support any PostgreSQL)
- **pgvector**: Vector storage, Desire to support ChromaDB, Pinecone, Weaviate, etc.

## Future Considerations

### Planned Improvements

1. **Remove Socket.IO**: Replace with polling (in progress)
2. **API Gateway**: Central entry point for all services
3. **Separate Databases**: One per bounded context

### Scalability Path

1. **Vertical Scaling**: Current approach, works for single-user
2. **Horizontal Scaling**: Add load balancer and multiple instances

---

This architecture provides a clear path from the current monolithic application to a more modular approach with vertical slicing, for easy potential to service separation if needed.
