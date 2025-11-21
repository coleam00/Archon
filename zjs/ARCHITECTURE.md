# Archon System Architecture

## Table of Contents
- [System Overview](#system-overview)
- [Technology Stack](#technology-stack)
- [Architecture Layers](#architecture-layers)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Database Schema](#database-schema)
- [API Architecture](#api-architecture)
- [Frontend Architecture](#frontend-architecture)
- [Integration Points](#integration-points)
- [Security Architecture](#security-architecture)
- [Performance Architecture](#performance-architecture)
- [Deployment Architecture](#deployment-architecture)
- [File Structure Reference](#file-structure-reference)

## System Overview

### What is Archon?

Archon is a sophisticated AI-powered knowledge management and coding assistant platform that combines:
- **Knowledge Base Management**: Web crawling, document processing, and semantic search
- **Project Management**: Projects, tasks, documents with version control
- **AI Integration**: Multiple AI agents for document generation, code analysis, and workflow execution
- **MCP Server**: IDE integration for Cursor, Windsurf, and other AI-enabled IDEs
- **Workflow Orchestration**: Agent work orders system for complex multi-step tasks

### Core Capabilities

1. **Knowledge Ingestion**
   - Web crawling with Crawl4ai
   - Document upload (PDF, DOCX, Markdown, text)
   - Code extraction and indexing
   - Page metadata extraction

2. **Semantic Search**
   - Vector embeddings (OpenAI)
   - Hybrid search (full-text + vector)
   - Code-specific search
   - Contextual embeddings

3. **Project Management**
   - Projects with custom features
   - Kanban board for tasks (todo, doing, review, done)
   - Document versioning
   - Source linking

4. **AI Agents**
   - Document generation agent
   - RAG-powered query agent
   - Code analysis capabilities
   - Streaming responses for long-running tasks

5. **Workflow Execution**
   - Agent work orders service
   - GitHub integration
   - Git sandbox management
   - Claude Code CLI integration

### System Scale

- **Frontend**: 310+ TypeScript/TSX files
- **Backend**: 85,000+ lines of Python code
- **API Routes**: 6,100+ lines across 10+ route modules
- **Database**: 15+ tables with vector search capabilities
- **Microservices**: 4 independent services + frontend

---

## Technology Stack

### Frontend Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **React** | 18 | UI framework |
| **TypeScript** | 5 | Type safety |
| **TanStack Query** | v5 | Server state management |
| **Tailwind CSS** | Latest | Styling system |
| **Radix UI** | Latest | Accessible UI primitives |
| **Vite** | Latest | Build tool and dev server |
| **Vitest** | Latest | Testing framework |
| **React Testing Library** | Latest | Component testing |
| **Biome** | Latest | Linting/formatting (features dir) |
| **ESLint** | Latest | Linting (legacy code) |

### Backend Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Python** | 3.12 | Primary language |
| **FastAPI** | Latest | Web framework |
| **Supabase Client** | 2.15.1 | Database client |
| **PostgreSQL** | Latest | Primary database |
| **pgvector** | Latest | Vector search |
| **PydanticAI** | Latest | AI agent framework |
| **Crawl4ai** | Latest | Web crawling |
| **Logfire** | Latest | Structured logging |
| **Pytest** | Latest | Testing framework |
| **Ruff** | Latest | Linting |
| **MyPy** | Latest | Type checking |

### Infrastructure Stack

| Technology | Purpose |
|-----------|---------|
| **Docker** | Containerization |
| **Docker Compose** | Service orchestration |
| **uv** | Python package manager |
| **npm** | Node package manager |
| **Make** | Build automation |

### AI/ML Stack

| Service | Purpose |
|---------|---------|
| **OpenAI** | Embeddings, GPT models |
| **Anthropic** | Claude models for agents |
| **Ollama** | Local model management (optional) |

---

## Architecture Layers

Archon follows a clean layered architecture with microservice decomposition:

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                          │
│  (Browser, IDE, CLI Tools)                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   React UI   │  │  MCP Server  │  │ Agent Server │      │
│  │  (Port 3737) │  │  (Port 8051) │  │ (Port 8052)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      API GATEWAY LAYER                       │
│  ┌────────────────────────────────────────────────────┐     │
│  │           FastAPI Main Server (Port 8181)          │     │
│  │  - 10+ Route Modules                               │     │
│  │  - ETag Middleware                                 │     │
│  │  - CORS & Logging                                  │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BUSINESS LOGIC LAYER                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Services   │  │    Agents    │  │  Workflows   │      │
│  │  - Projects  │  │ - RAG Agent  │  │ Work Orders  │      │
│  │  - Knowledge │  │ - Doc Agent  │  │ (Port 8053)  │      │
│  │  - Crawling  │  │              │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       DATA ACCESS LAYER                      │
│  ┌────────────────────────────────────────────────────┐     │
│  │           Supabase Client Manager                  │     │
│  │  - Connection pooling                              │     │
│  │  - Async operations                                │     │
│  │  - Query building                                  │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       PERSISTENCE LAYER                      │
│  ┌────────────────────────────────────────────────────┐     │
│  │      Supabase (PostgreSQL + pgvector)              │     │
│  │  - 15+ tables                                      │     │
│  │  - Vector search                                   │     │
│  │  - Full-text search                                │     │
│  │  - Row-level security                              │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

#### 1. Client Layer
- **Browsers**: User interaction via React UI
- **IDEs**: MCP tool access for AI-enabled editors
- **CLI Tools**: Claude Code CLI for workflow execution

#### 2. Presentation Layer
- **React UI**: User-facing interface with Tron-inspired design
- **MCP Server**: HTTP-based MCP protocol for IDE integration
- **Agent Server**: AI agent execution and streaming

#### 3. API Gateway Layer
- **Request routing**: Route to appropriate service modules
- **Authentication**: Validate Supabase keys
- **Middleware**: ETag caching, CORS, logging
- **Error handling**: Centralized exception handlers

#### 4. Business Logic Layer
- **Services**: Domain logic (projects, tasks, knowledge)
- **Agents**: AI-powered operations (PydanticAI)
- **Workflows**: Multi-step orchestration (agent work orders)

#### 5. Data Access Layer
- **Supabase Client**: Database operations abstraction
- **Connection Management**: Pooling and lifecycle
- **Query Building**: Type-safe query construction

#### 6. Persistence Layer
- **PostgreSQL**: Primary data store
- **pgvector**: Vector embeddings storage
- **Supabase**: Managed database with auth/API

---

## Component Architecture

### 1. Main API Server (Port 8181)

**Location**: `python/src/server/`

#### Entry Point
```python
# python/src/server/main.py
app = FastAPI(title="Archon API", version="0.1.0")

# Middleware stack
app.add_middleware(LoggingMiddleware)
app.add_middleware(CORSMiddleware)

# Route modules
app.include_router(projects_router, prefix="/api")
app.include_router(knowledge_router, prefix="/api")
# ... 8 more routers
```

#### API Route Modules

| Module | File | Endpoints | Purpose |
|--------|------|-----------|---------|
| **Projects** | `api_routes/projects_api.py` | `/api/projects/*` | Project/task CRUD, streaming creation |
| **Knowledge** | `api_routes/knowledge_api.py` | `/api/knowledge/*` | RAG search, crawling, uploads |
| **Progress** | `api_routes/progress_api.py` | `/api/progress/*` | Operation tracking |
| **MCP** | `api_routes/mcp_api.py` | `/api/mcp/*` | MCP server status/execution |
| **Settings** | `api_routes/settings_api.py` | `/api/settings/*` | Configuration management |
| **Providers** | `api_routes/provider_api.py` | `/api/providers/*` | LLM provider discovery |
| **Version** | `api_routes/version_api.py` | `/api/version/*` | Version checking |
| **Agent Chat** | `api_routes/agent_chat_api.py` | `/api/agent-chat/*` | AI chat interface |
| **Bug Reports** | `api_routes/bug_report_api.py` | `/api/bug-report/*` | Error reporting |
| **Work Orders Proxy** | `api_routes/agent_work_orders_proxy.py` | `/api/agent-work-orders/*` | Proxy to work orders service |

#### Service Layer Organization

```
python/src/server/services/
├── projects/
│   ├── project_service.py              # Project CRUD
│   ├── project_creation_service.py     # Streaming creation with AI
│   ├── task_service.py                 # Task management
│   ├── document_service.py             # Document operations
│   ├── source_linking_service.py       # Link sources to projects
│   └── versioning_service.py           # Version history
├── knowledge/
│   ├── knowledge_item_service.py       # Document chunks
│   ├── knowledge_summary_service.py    # Source summaries
│   └── database_metrics_service.py     # Performance metrics
├── crawling/
│   ├── crawling_service.py             # Main orchestration (~1,300 lines)
│   ├── discovery_service.py            # URL discovery
│   ├── code_extraction_service.py      # Code snippet extraction (~2,000 lines)
│   ├── document_storage_operations.py  # Document persistence
│   ├── page_storage_operations.py      # Page metadata
│   ├── progress_mapper.py              # Progress tracking
│   ├── strategies/                     # Crawling strategies
│   └── helpers/                        # Utility functions
├── search/                              # Vector search
├── embeddings/                          # Embedding generation
├── storage/                             # Document storage
├── ollama/                              # Local LLM management
├── client_manager.py                    # Supabase client
├── credential_service.py                # Secret management (~750 lines)
├── llm_provider_service.py             # Multi-provider LLM (~1,200 lines)
├── provider_discovery_service.py       # Provider detection (~650 lines)
├── threading_service.py                # Thread pool management (~700 lines)
├── source_management_service.py        # Source lifecycle (~700 lines)
├── mcp_service_client.py               # MCP communication
└── mcp_session_manager.py              # MCP session state
```

#### Configuration Module

```
python/src/server/config/
├── config.py                   # Environment validation (280 lines)
│   ├── validate_supabase_key() # JWT decoding, role verification
│   ├── validate_supabase_url() # HTTPS enforcement
│   ├── load_environment_config()
│   ├── get_rag_strategy_config()
│   └── get_mcp_monitoring_config()
├── logfire_config.py          # Structured logging setup
├── version.py                 # Repository configuration
├── service_discovery.py       # Dynamic service discovery
└── database.py                # Database client setup
```

### 2. MCP Server (Port 8051)

**Location**: `python/src/mcp_server/`

#### Architecture
- **Protocol**: HTTP with Server-Sent Events (SSE)
- **Size**: Lightweight (~150MB container vs 1.6GB monolithic)
- **Security**: HTTP health checks (no Docker socket)

#### Tool Organization

```
python/src/mcp_server/features/
├── rag/
│   └── rag_tools.py                    # Knowledge base tools
│       ├── archon:rag_search_knowledge_base
│       ├── archon:rag_search_code_examples
│       ├── archon:rag_get_available_sources
│       ├── archon:rag_list_pages_for_source
│       └── archon:rag_read_full_page
├── projects/
│   └── project_tools.py                # Project management
│       ├── archon:find_projects
│       └── archon:manage_project       # action: create/update/delete
├── tasks/
│   └── task_tools.py                   # Task management
│       ├── archon:find_tasks
│       └── archon:manage_task
└── documents/
    └── document_tools.py               # Document management
        ├── archon:find_documents
        ├── archon:manage_document
        ├── archon:find_versions
        └── archon:manage_version
```

#### MCP Server Implementation

```python
# python/src/mcp_server/mcp_server.py (~600 lines)
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Archon MCP Server")

@mcp.tool()
async def rag_search_knowledge_base(
    query: str,
    source_id: Optional[str] = None
) -> list[dict]:
    """Search knowledge base with RAG"""
    response = await service_client.post(
        "/api/knowledge/search",
        json={"query": query, "source_id": source_id}
    )
    return response.json()

# Start server
if __name__ == "__main__":
    mcp.run(transport="sse", port=8051)
```

### 3. AI Agents Service (Port 8052)

**Location**: `python/src/agents/`

#### Components

```
python/src/agents/
├── base_agent.py               # Abstract agent base class
├── rag_agent.py                # RAG-powered query agent
├── document_agent.py           # Document generation agent
├── server.py                   # FastAPI server (port 8052)
└── mcp_client.py               # MCP tool integration
```

#### Agent Capabilities

| Agent | Purpose | Tools |
|-------|---------|-------|
| **RAG Agent** | Semantic search and retrieval | MCP search tools |
| **Document Agent** | Document generation, project creation | MCP project/document tools |

#### Example: Document Agent

```python
# python/src/agents/document_agent.py
from pydantic_ai import Agent

class DocumentAgent:
    def __init__(self):
        self.agent = Agent(
            model="claude-3-5-sonnet-20241022",
            system_prompt="You are a document generation assistant..."
        )

    async def generate_project_structure(
        self,
        description: str,
        knowledge_sources: list[str]
    ) -> AsyncIterator[str]:
        """Generate project structure with streaming"""
        async for chunk in self.agent.run_stream(
            prompt=f"Create project: {description}",
            tools=[
                self.mcp_client.rag_search,
                self.mcp_client.create_task
            ]
        ):
            yield chunk
```

### 4. Agent Work Orders Service (Port 8053)

**Location**: `python/src/agent_work_orders/`

#### Architecture
Independent microservice for workflow orchestration using Claude Code CLI.

#### Directory Structure

```
python/src/agent_work_orders/
├── api/                        # FastAPI routes
│   ├── routes.py              # REST endpoints
│   └── middleware.py          # Request processing
├── agent_executor/             # Task execution engine
│   ├── executor.py            # Main execution logic
│   └── claude_interface.py    # Claude Code CLI wrapper
├── command_loader/             # Claude command loading
│   └── claude_command_loader.py
├── database/                   # State persistence
│   └── client.py              # DB client setup
├── github_integration/         # GitHub API
│   └── github_client.py       # PR creation, issue tracking
├── sandbox_manager/            # Git sandbox management
│   ├── git_branch_sandbox.py  # Branch isolation
│   └── worktree_manager.py    # Git worktree operations
├── state_manager/              # Workflow state
│   ├── work_order_repository.py
│   ├── supabase_repository.py
│   ├── file_state_repository.py
│   └── repository_factory.py   # Factory pattern
├── workflow_engine/            # Orchestration
│   ├── workflow_operations.py
│   ├── workflow_orchestrator.py
│   └── agent_names.py          # Agent roles
├── utils/                      # Helpers
│   ├── git_operations.py
│   ├── worktree_operations.py
│   ├── structured_logger.py
│   ├── log_buffer.py
│   └── state_reconciliation.py
├── main.py                     # Entry point
├── server.py                   # FastAPI app
└── config.py                   # Configuration
```

#### Workflow Execution Flow

```
1. Create Work Order
   ↓
2. Workflow Orchestrator
   ├── Create Git Sandbox (branch/worktree)
   ├── Load Claude Commands
   └── Initialize Agent Executor
   ↓
3. Agent Executor
   ├── Execute Claude Code CLI
   ├── Stream logs to client
   └── Track state changes
   ↓
4. State Manager
   ├── Persist work order state
   ├── Track file changes
   └── Store execution logs
   ↓
5. GitHub Integration (if configured)
   ├── Create PR
   ├── Update issue
   └── Link work order
```

### 5. React Frontend (Port 3737)

**Location**: `archon-ui-main/src/`

#### Architecture Pattern: Vertical Slices

Each feature is a self-contained slice with its own:
- **Components**: UI elements
- **Hooks**: Data fetching (TanStack Query)
- **Services**: API communication
- **Types**: TypeScript definitions
- **Views**: Page layouts

```
archon-ui-main/src/features/
├── knowledge/                  # Knowledge base feature
│   ├── components/
│   │   ├── KnowledgeSourceCard.tsx
│   │   ├── DocumentViewer.tsx
│   │   └── SearchBar.tsx
│   ├── hooks/
│   │   └── useKnowledgeQueries.ts      # Query keys + hooks
│   ├── services/
│   │   └── knowledgeService.ts         # API calls
│   ├── types/
│   │   └── index.ts                    # Type definitions
│   ├── views/
│   │   └── KnowledgeBaseView.tsx
│   └── inspector/                       # Advanced tools
├── projects/                   # Project management feature
│   ├── components/
│   │   ├── ProjectCard.tsx
│   │   ├── ProjectList.tsx
│   │   └── NewProjectModal.tsx
│   ├── hooks/
│   │   └── useProjectQueries.ts        # projectKeys factory
│   ├── services/
│   │   └── projectService.ts
│   ├── types/
│   │   └── index.ts
│   ├── views/
│   │   └── ProjectsView.tsx
│   ├── tasks/                          # Task sub-feature
│   │   ├── components/
│   │   │   ├── TaskCard.tsx
│   │   │   ├── KanbanColumn.tsx
│   │   │   └── TaskEditModal.tsx
│   │   ├── hooks/
│   │   │   └── useTaskQueries.ts       # taskKeys factory
│   │   ├── services/
│   │   │   └── taskService.ts
│   │   ├── types/
│   │   │   └── task.ts
│   │   └── views/
│   │       ├── BoardView.tsx           # Kanban board
│   │       └── TableView.tsx           # Table layout
│   └── documents/                      # Document sub-feature
│       ├── components/
│       ├── hooks/
│       └── services/
├── agent-work-orders/          # Workflow execution UI
├── progress/                   # Operation progress tracking
├── mcp/                        # MCP integration & testing
├── settings/                   # Configuration UI
├── shared/                     # Cross-feature utilities
│   ├── api/
│   │   └── apiClient.ts               # HTTP client with ETag
│   ├── config/
│   │   ├── queryClient.ts             # TanStack Query config
│   │   └── queryPatterns.ts           # STALE_TIMES, etc.
│   ├── hooks/
│   │   ├── useSmartPolling.ts         # Visibility-aware polling
│   │   └── useDebounce.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       ├── optimistic.ts              # Optimistic updates
│       └── helpers.ts
└── ui/                         # UI components & primitives
    ├── primitives/             # Radix UI wrappers (15+)
    │   ├── button.tsx
    │   ├── dialog.tsx
    │   ├── select.tsx
    │   └── ...
    ├── components/             # Generic components
    │   ├── ErrorBoundary.tsx
    │   └── LoadingSpinner.tsx
    └── hooks/
        ├── useToast.ts
        └── useTheme.ts
```

#### Routing Structure

```typescript
// archon-ui-main/src/App.tsx
const router = createBrowserRouter([
  { path: "/", element: <KnowledgeBasePage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
  { path: "/settings", element: <SettingsPage /> },
  { path: "/mcp", element: <MCPPage /> },
  { path: "/projects", element: <ProjectsView /> },
  { path: "/projects/:projectId", element: <ProjectDetail /> },
  { path: "/agent-work-orders", element: <AgentWorkOrdersPage /> },
  { path: "/agent-work-orders/:id", element: <AgentWorkOrderDetailPage /> },
  { path: "/style-guide", element: <StyleGuidePage /> },
]);
```

---

## Data Flow

### 1. User Interaction Flow

```
User Action (Browser)
  ↓
React Component
  ↓
TanStack Query Hook (useQuery/useMutation)
  ↓
Service Function (projectService.create)
  ↓
API Client (callAPIWithETag)
  ↓ HTTP Request (with If-None-Match header)
Vite Dev Proxy (in dev) / Nginx (in prod)
  ↓
FastAPI Route Handler (/api/projects)
  ↓
Service Layer (project_service.py)
  ↓
Supabase Client
  ↓
PostgreSQL Database
  ↓ Response
Service Layer
  ↓ (generate ETag)
FastAPI Response (200 OK or 304 Not Modified)
  ↓
API Client (handle response)
  ↓
TanStack Query Cache Update
  ↓
React Component Re-render
```

### 2. Crawling Flow

```
User: Start Crawl
  ↓
POST /api/knowledge/crawl
  ↓
Crawling Service
  ├── Validate URL
  ├── Create source record
  └── Start async crawl
      ↓
      Discovery Service
      ├── Fetch initial page
      ├── Extract links
      └── Queue pages
      ↓
      For each page:
      ├── Fetch HTML
      ├── Extract content
      ├── Extract code snippets (Code Extraction Service)
      ├── Extract metadata
      ├── Generate embeddings (OpenAI)
      ├── Store in documents table
      └── Update progress
      ↓
      Progress Mapper
      └── Track completion status
```

### 3. RAG Search Flow

```
User: Submit search query
  ↓
POST /api/knowledge/search
  ↓
Knowledge Service
  ├── Generate query embedding (OpenAI)
  ├── Vector search (pgvector)
  │   └── SELECT * FROM documents
  │       ORDER BY embedding <-> query_embedding
  │       LIMIT 10
  ├── Full-text search (tsvector)
  │   └── SELECT * FROM documents
  │       WHERE to_tsvector(content) @@ plainto_tsquery(query)
  ├── Hybrid ranking (combine scores)
  ├── Optional: Reranking service
  └── Return top results
  ↓
Response with relevant documents
```

### 4. MCP Tool Execution Flow

```
IDE (Cursor/Windsurf): Invoke tool
  ↓
MCP Client (in IDE)
  ↓ HTTP POST to MCP server
MCP Server (port 8051)
  ↓
Tool Handler (e.g., find_projects)
  ↓
MCP Service Client
  ↓ HTTP GET to main API
Main API Server (port 8181)
  ↓
Service Layer
  ↓
Supabase
  ↓ Response
Service Layer
  ↓ JSON
MCP Server
  ↓ Tool result
IDE
  ↓
Display to user / Use in AI context
```

### 5. Streaming Project Creation Flow

```
User: Create project with AI
  ↓
POST /api/projects (streaming endpoint)
  ↓
Project Creation Service
  ↓
Document Agent (AI Agents Service)
  ├── Analyze description
  ├── Search knowledge base (MCP tool)
  ├── Generate project structure
  ├── Create tasks (stream each)
  └── Link documents
  ↓ (streaming response)
Progress Updates (SSE/chunks)
  ↓
Frontend receives chunks
  ↓
Real-time UI updates
```

### 6. Agent Work Order Execution Flow

```
User: Create work order
  ↓
POST /api/agent-work-orders
  ↓
Workflow Orchestrator
  ├── Create Git sandbox
  │   ├── Create branch (claude/task-{session_id})
  │   └── Create worktree
  ├── Load Claude commands
  │   └── Parse .claude/commands/*.md
  ├── Initialize executor
  └── Start execution
      ↓
      Agent Executor
      ├── Execute Claude Code CLI
      │   └── claude-code --project . --command "..."
      ├── Stream logs (SSE)
      ├── Track file changes
      └── Monitor completion
      ↓
      State Manager
      ├── Update work order state
      ├── Store execution logs
      └── Track metrics
      ↓
      GitHub Integration (if configured)
      ├── Commit changes
      ├── Push branch
      ├── Create PR
      └── Link to work order
      ↓
      Cleanup
      ├── Remove worktree
      └── Archive logs
```

---

## Database Schema

### Core Tables

#### Knowledge Management

```sql
-- Sources (websites, documents)
CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    description TEXT,
    crawl_status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documents (chunks with embeddings)
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding VECTOR(1536), -- OpenAI ada-002
    chunk_index INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search index
ALTER TABLE documents ADD COLUMN content_tsvector TSVECTOR;
CREATE INDEX documents_content_tsvector_idx ON documents USING GIN(content_tsvector);

-- Vector search index
CREATE INDEX documents_embedding_idx ON documents USING ivfflat (embedding vector_cosine_ops);

-- Code examples
CREATE TABLE code_examples (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    language TEXT,
    summary TEXT,
    relevance_score REAL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Page metadata
CREATE TABLE page_metadata (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    description TEXT,
    og_image TEXT,
    last_crawled TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crawled pages (tracking)
CREATE TABLE archon_crawled_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, crawled, failed
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Project Management

```sql
-- Projects
CREATE TABLE archon_projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT,
    features TEXT[] DEFAULT '{}', -- Array of feature names
    documents TEXT[] DEFAULT '{}', -- Array of document IDs
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks
CREATE TABLE archon_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'todo', -- todo, doing, review, done
    assignee TEXT, -- User, Archon, AI IDE Agent
    priority INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document versions
CREATE TABLE archon_document_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    changes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(document_id, version)
);
```

#### System Tables

```sql
-- Settings (key-value store)
CREATE TABLE archon_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration tracking
CREATE TABLE migration_tracking (
    id SERIAL PRIMARY KEY,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(version, name)
);
```

#### Agent Work Orders

```sql
-- Work orders
CREATE TABLE agent_work_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending', -- pending, running, completed, failed, cancelled
    github_issue_url TEXT,
    github_pr_url TEXT,
    branch_name TEXT,
    execution_logs JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Work order state
CREATE TABLE agent_work_order_state (
    work_order_id UUID PRIMARY KEY REFERENCES agent_work_orders(id) ON DELETE CASCADE,
    current_step TEXT,
    file_changes JSONB DEFAULT '[]',
    agent_context JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes & Performance

```sql
-- Frequently queried columns
CREATE INDEX sources_crawl_status_idx ON sources(crawl_status);
CREATE INDEX documents_source_id_idx ON documents(source_id);
CREATE INDEX archon_tasks_project_id_idx ON archon_tasks(project_id);
CREATE INDEX archon_tasks_status_idx ON archon_tasks(status);
CREATE INDEX agent_work_orders_status_idx ON agent_work_orders(status);

-- Composite indexes for common queries
CREATE INDEX archon_tasks_project_status_idx ON archon_tasks(project_id, status);
CREATE INDEX archon_tasks_status_order_idx ON archon_tasks(status, order_index);
```

---

## API Architecture

### REST API Patterns

All endpoints follow RESTful conventions:

```
GET    /api/{resource}           # List all
POST   /api/{resource}           # Create
GET    /api/{resource}/{id}      # Get one
PUT    /api/{resource}/{id}      # Update
DELETE /api/{resource}/{id}      # Delete
```

### Nested Resources

```
GET    /api/projects/{id}/tasks          # Tasks for project
GET    /api/projects/{id}/docs           # Documents for project
POST   /api/projects/{id}/versions       # Create version
GET    /api/projects/{id}/features       # Get project features
```

### Search & Query Endpoints

```
POST   /api/knowledge/search             # RAG search
POST   /api/knowledge/code-search        # Code-specific search
GET    /api/knowledge/sources            # List sources
GET    /api/progress/active              # Active operations
```

### ETag Implementation

All list endpoints support ETags for bandwidth optimization:

```python
# Backend (python/src/server/utils/etag_utils.py)
from hashlib import md5
import json

def generate_etag(data: dict) -> str:
    """Generate ETag from response data"""
    json_str = json.dumps(data, sort_keys=True)
    hash_digest = md5(json_str.encode()).hexdigest()
    return f'"{hash_digest}"'

def check_etag(request: Request, data: dict) -> bool:
    """Check if client's ETag matches current data"""
    client_etag = request.headers.get("If-None-Match")
    if not client_etag:
        return False

    current_etag = generate_etag(data)
    return client_etag == current_etag

# Usage in route
@router.get("/api/projects")
async def list_projects(request: Request):
    projects = await project_service.list_projects()

    if check_etag(request, projects):
        return Response(status_code=304)  # Not Modified

    etag = generate_etag(projects)
    return Response(
        content=json.dumps(projects),
        media_type="application/json",
        headers={"ETag": etag}
    )
```

### Response Formats

**Success Response**:
```json
{
  "id": "uuid",
  "title": "Example",
  "data": {...},
  "created_at": "2025-01-20T10:00:00Z"
}
```

**Error Response**:
```json
{
  "error": "Error message",
  "detail": "Detailed error information",
  "statusCode": 400
}
```

**Streaming Response** (project creation):
```
data: {"type": "progress", "message": "Analyzing description..."}

data: {"type": "task_created", "task": {...}}

data: {"type": "complete", "project": {...}}
```

---

## Frontend Architecture

### State Management Philosophy

**No prop drilling, no Redux, no Zustand for server state.**

All server state is managed by TanStack Query v5:
- **Query Cache**: Stores fetched data
- **Query Keys**: Identifies data in cache
- **Optimistic Updates**: Instant UI feedback
- **Smart Polling**: Visibility-aware refetching

### TanStack Query Configuration

```typescript
// archon-ui-main/src/features/shared/config/queryClient.ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,              // 30 seconds
      gcTime: 600_000,                // 10 minutes
      retry: (failureCount, error) => {
        // Don't retry 4xx errors
        if (error.statusCode >= 400 && error.statusCode < 500) {
          return false;
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,     // Refetch when tab focused
      refetchOnReconnect: true,       // Refetch on network reconnect
      structuralSharing: true,        // Optimize re-renders
    },
    mutations: {
      retry: false,                   // Don't retry mutations
    },
  },
});
```

### Query Patterns

```typescript
// archon-ui-main/src/features/shared/config/queryPatterns.ts
export const STALE_TIMES = {
  instant: 0,                 // Always fresh
  realtime: 3_000,            // 3 seconds
  frequent: 5_000,            // 5 seconds
  normal: 30_000,             // 30 seconds (default)
  rare: 300_000,              // 5 minutes
  static: Infinity,           // Never stale
} as const;

export const DISABLED_QUERY_KEY = ["disabled"] as const;

export function createRetryLogic(maxRetries = 2) {
  return (failureCount: number, error: any) => {
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return false; // Don't retry client errors
    }
    return failureCount < maxRetries;
  };
}
```

### Query Key Factories

Each feature defines its query keys:

```typescript
// Example: archon-ui-main/src/features/projects/hooks/useProjectQueries.ts
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => [...projectKeys.all, "detail", id] as const,
  features: (id: string) => [...projectKeys.all, id, "features"] as const,
};

// Usage in hooks
export function useProjects() {
  return useQuery({
    queryKey: projectKeys.lists(),
    queryFn: projectService.listProjects,
    staleTime: STALE_TIMES.normal,
  });
}

export function useProjectDetail(id?: string) {
  return useQuery({
    queryKey: id ? projectKeys.detail(id) : DISABLED_QUERY_KEY,
    queryFn: () => projectService.getProject(id!),
    enabled: !!id,
    staleTime: STALE_TIMES.normal,
  });
}
```

### Optimistic Updates

```typescript
// archon-ui-main/src/features/shared/utils/optimistic.ts
import { nanoid } from 'nanoid';

export function createOptimisticEntity<T>(data: Partial<T>): T & { _localId: string; _optimistic: boolean } {
  return {
    ...data,
    _localId: nanoid(),
    _optimistic: true,
  } as T & { _localId: string; _optimistic: boolean };
}

export function replaceOptimisticEntity<T>(
  items: T[],
  localId: string | undefined,
  serverData: T
): T[] {
  if (!localId) return [...items, serverData];

  return items.map(item =>
    (item as any)._localId === localId ? serverData : item
  );
}

// Usage in mutation
export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: projectService.create,

    onMutate: async (newProject) => {
      // Cancel in-flight queries
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot for rollback
      const previous = queryClient.getQueryData(projectKeys.lists());

      // Optimistic update
      const optimisticProject = createOptimisticEntity(newProject);
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] = []) =>
        [...old, optimisticProject]
      );

      return { previous, localId: optimisticProject._localId };
    },

    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previous) {
        queryClient.setQueryData(projectKeys.lists(), context.previous);
      }
    },

    onSuccess: (data, variables, context) => {
      // Replace optimistic with real data
      queryClient.setQueryData(projectKeys.lists(), (old: Project[] = []) =>
        replaceOptimisticEntity(old, context?.localId, data)
      );
    },
  });
}
```

### Smart Polling

```typescript
// archon-ui-main/src/features/ui/hooks/useSmartPolling.ts
import { useEffect, useState } from 'react';

export function useSmartPolling(baseInterval: number): number {
  const [interval, setInterval] = useState(baseInterval);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setInterval(0); // Pause when tab hidden
      } else if (document.hasFocus()) {
        setInterval(baseInterval); // Full speed when focused
      } else {
        setInterval(baseInterval * 1.5); // Slower when unfocused
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    window.addEventListener('blur', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
      window.removeEventListener('blur', handleVisibilityChange);
    };
  }, [baseInterval]);

  return interval;
}

// Usage
export function useTasksPolling(projectId?: string) {
  const refetchInterval = useSmartPolling(5000); // Base 5s

  return useQuery({
    queryKey: projectId ? taskKeys.byProject(projectId) : DISABLED_QUERY_KEY,
    queryFn: () => taskService.getTasksByProject(projectId!),
    enabled: !!projectId,
    staleTime: STALE_TIMES.frequent,
    refetchInterval, // Adapts to visibility
  });
}
```

### API Client

```typescript
// archon-ui-main/src/features/shared/api/apiClient.ts
export class APIServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'APIServiceError';
  }
}

export async function callAPIWithETag<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle 304 Not Modified
  if (response.status === 304) {
    // Browser automatically returns cached data
    // This branch may not be reached in standard browsers
    throw new Error('304 should be handled by browser cache');
  }

  if (!response.ok) {
    const error = await response.json();
    throw new APIServiceError(
      error.error || error.detail || 'Unknown error',
      error.code || 'UNKNOWN',
      response.status
    );
  }

  return response.json();
}
```

---

## Integration Points

### 1. Frontend ↔ Backend

**Protocol**: REST over HTTP
**Transport**: JSON
**Caching**: ETag-based (browser-native)

```typescript
// Frontend service
export const projectService = {
  async listProjects(): Promise<Project[]> {
    return callAPIWithETag('/api/projects');
  },

  async getProject(id: string): Promise<Project> {
    return callAPIWithETag(`/api/projects/${id}`);
  },

  async createProject(data: CreateProjectRequest): Promise<Project> {
    return callAPIWithETag('/api/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};
```

**Proxy Configuration** (Development):
```typescript
// archon-ui-main/vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://archon-server:8181',
        changeOrigin: true,
      },
    },
  },
});
```

### 2. IDE ↔ MCP Server

**Protocol**: MCP over HTTP with SSE
**Transport**: JSON

```
Cursor/Windsurf
  ↓ (MCP client)
HTTP POST to archon-mcp:8051
  ↓
MCP Server receives tool invocation
  ↓ (HTTP client)
HTTP GET/POST to archon-server:8181
  ↓
Main API processes request
  ↓
Response to MCP Server
  ↓
MCP Server formats tool result
  ↓
Response to IDE
```

**MCP Configuration** (.mcprc.json in IDE):
```json
{
  "mcpServers": {
    "archon": {
      "url": "http://localhost:8051",
      "transport": "sse"
    }
  }
}
```

### 3. Agent Service ↔ API Server

**Protocol**: HTTP REST
**Transport**: JSON, streaming for long operations

```python
# python/src/agents/mcp_client.py
class MCPServiceClient:
    def __init__(self, base_url: str):
        self.base_url = base_url
        self.client = httpx.AsyncClient(timeout=30.0)

    async def search_knowledge_base(self, query: str) -> list[dict]:
        response = await self.client.post(
            f"{self.base_url}/api/knowledge/search",
            json={"query": query}
        )
        response.raise_for_status()
        return response.json()

    async def create_task(self, project_id: str, task_data: dict) -> dict:
        response = await self.client.post(
            f"{self.base_url}/api/projects/{project_id}/tasks",
            json=task_data
        )
        response.raise_for_status()
        return response.json()
```

### 4. Work Orders Service ↔ Claude Code CLI

**Protocol**: Subprocess execution
**Transport**: Stdin/stdout

```python
# python/src/agent_work_orders/agent_executor/executor.py
import subprocess
import asyncio

class AgentExecutor:
    async def execute_command(self, command: str) -> AsyncIterator[str]:
        """Execute Claude Code CLI command"""
        process = await asyncio.create_subprocess_exec(
            "claude-code",
            "--project", self.sandbox_path,
            "--command", command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Stream output
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            yield line.decode('utf-8')

        await process.wait()
```

### 5. External Service Integration

#### Supabase

```python
# python/src/server/services/client_manager.py
from supabase import create_client, AsyncClient

class SupabaseClientManager:
    _instance: Optional[AsyncClient] = None

    @classmethod
    def get_client(cls) -> AsyncClient:
        if cls._instance is None:
            cls._instance = create_client(
                supabase_url=os.getenv("SUPABASE_URL"),
                supabase_key=os.getenv("SUPABASE_SERVICE_KEY")
            )
        return cls._instance
```

#### OpenAI (Embeddings)

```python
# python/src/server/services/embeddings/openai_embeddings.py
from openai import AsyncOpenAI

class OpenAIEmbeddingsService:
    def __init__(self, api_key: str):
        self.client = AsyncOpenAI(api_key=api_key)

    async def generate_embedding(self, text: str) -> list[float]:
        response = await self.client.embeddings.create(
            model="text-embedding-ada-002",
            input=text
        )
        return response.data[0].embedding
```

#### GitHub

```python
# python/src/agent_work_orders/github_integration/github_client.py
from github import Github

class GitHubClient:
    def __init__(self, token: str):
        self.client = Github(token)

    def create_pull_request(
        self,
        repo: str,
        title: str,
        body: str,
        head: str,
        base: str = "main"
    ) -> str:
        repo_obj = self.client.get_repo(repo)
        pr = repo_obj.create_pull(
            title=title,
            body=body,
            head=head,
            base=base
        )
        return pr.html_url
```

---

## Security Architecture

### Authentication & Authorization

#### Supabase Service Key Validation

```python
# python/src/server/config/config.py
def validate_supabase_key(key: str) -> bool:
    """Validate service key by decoding JWT (no signature verification)"""
    try:
        # Decode without verification to check role
        payload = jwt.decode(key, options={"verify_signature": False})
        role = payload.get("role")

        # Must be service_role, not anon
        if role != "service_role":
            raise ValueError(f"Invalid key role: {role}. Must use service_role key.")

        return True
    except Exception as e:
        raise ValueError(f"Invalid Supabase key: {e}")

# Called at startup
load_environment_config()
```

#### URL Security

```python
def validate_supabase_url(url: str) -> bool:
    """Enforce HTTPS for remote URLs"""
    if url.startswith("http://"):
        # Allow localhost for local development
        if "localhost" not in url and "127.0.0.1" not in url and "host.docker.internal" not in url:
            raise ValueError("Supabase URL must use HTTPS")
    return True
```

### Docker Security

**No Docker Socket Mounting**:
```yaml
# docker-compose.yml
services:
  archon-mcp:
    # NO docker.sock mounting
    # volumes:
    #   - /var/run/docker.sock:/var/run/docker.sock  # DANGEROUS

    # Use HTTP health checks instead
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8051/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

**Rationale**: CVE-2025-9074 (CVSS 9.3) - Docker socket access allows container escape.

### HTTP Security

#### CORS Configuration

```python
# python/src/server/main.py
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3737",  # Frontend dev
        "http://archon-frontend:3737",  # Docker
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

#### Error Response Sanitization

```python
@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Sanitize error messages for production"""
    if settings.DEBUG:
        # Development: detailed errors
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal Server Error",
                "detail": str(exc),
                "traceback": traceback.format_exc()
            }
        )
    else:
        # Production: generic errors
        logger.error(f"Unhandled exception: {exc}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": "Internal Server Error"}
        )
```

### Database Security

#### Row-Level Security (RLS)

Supabase RLS policies control data access:
```sql
-- Example: Users can only see their own work orders
CREATE POLICY "Users see own work orders"
ON agent_work_orders
FOR SELECT
USING (auth.uid() = user_id);

-- Service role bypasses RLS
```

#### SQL Injection Prevention

Using Supabase client with parameterized queries:
```python
# SAFE: Parameterized
result = await supabase.table("projects").select("*").eq("id", project_id).execute()

# DANGEROUS: String interpolation (DON'T DO THIS)
# result = await supabase.rpc(f"SELECT * FROM projects WHERE id = '{project_id}'")
```

---

## Performance Architecture

### Frontend Performance

#### Request Deduplication

TanStack Query automatically deduplicates requests with same query key:
```typescript
// These 3 components mount simultaneously
<ProjectCard id="123" />
<ProjectDetail id="123" />
<ProjectHeader id="123" />

// Only ONE request to /api/projects/123 is made
// All three components share the same cache entry
```

#### Smart Polling

Reduces unnecessary requests based on visibility:
```typescript
// Tab hidden: 0 requests/min
// Tab unfocused: 40 requests/min (1.5x slower)
// Tab focused: 60 requests/min (base speed)
```

#### ETag Caching

70% bandwidth reduction for unchanged data:
```
First request:  GET /api/projects → 200 OK (5 KB)
Second request: GET /api/projects (If-None-Match: "abc123") → 304 Not Modified (0 KB)
Third request:  GET /api/projects (If-None-Match: "abc123") → 304 Not Modified (0 KB)
```

#### Code Splitting

```typescript
// Route-based code splitting
const ProjectsView = lazy(() => import('@/features/projects/views/ProjectsView'));
const KnowledgeBasePage = lazy(() => import('@/pages/KnowledgeBasePage'));

// Component rendered in Suspense
<Suspense fallback={<LoadingSpinner />}>
  <ProjectsView />
</Suspense>
```

### Backend Performance

#### Connection Pooling

Supabase client maintains connection pool:
```python
# Singleton client
class SupabaseClientManager:
    _instance: Optional[AsyncClient] = None

    @classmethod
    def get_client(cls) -> AsyncClient:
        if cls._instance is None:
            cls._instance = create_client(...)  # Creates pool
        return cls._instance
```

#### Async Operations

All I/O operations are async:
```python
# Concurrent crawling
async def crawl_pages(urls: list[str]) -> list[dict]:
    tasks = [crawl_single_page(url) for url in urls]
    return await asyncio.gather(*tasks)
```

#### Thread Pool for CPU-Intensive Tasks

```python
# python/src/server/services/threading_service.py
from concurrent.futures import ThreadPoolExecutor

class ThreadingService:
    def __init__(self, max_workers: int = 10):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)

    async def run_in_thread(self, func, *args, **kwargs):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self.executor, func, *args, **kwargs)
```

#### Batch Database Operations

```python
# Batch insert documents
async def store_documents_batch(documents: list[dict]) -> None:
    # Insert in chunks of 100
    chunk_size = 100
    for i in range(0, len(documents), chunk_size):
        chunk = documents[i:i + chunk_size]
        await supabase.table("documents").insert(chunk).execute()
```

### Database Performance

#### Vector Search Optimization

```sql
-- IVFFlat index for approximate nearest neighbor
CREATE INDEX documents_embedding_idx
ON documents
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Query uses index automatically
SELECT * FROM documents
ORDER BY embedding <-> '[0.1, 0.2, ...]'::vector
LIMIT 10;
```

#### Full-Text Search

```sql
-- GIN index for tsvector
CREATE INDEX documents_content_tsvector_idx
ON documents
USING GIN(content_tsvector);

-- Update tsvector on insert
CREATE TRIGGER documents_tsvector_update
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION
  tsvector_update_trigger(content_tsvector, 'pg_catalog.english', content);
```

#### Hybrid Search

Combines vector and full-text search:
```python
async def hybrid_search(query: str, limit: int = 10) -> list[dict]:
    # Generate embedding
    embedding = await embeddings_service.generate_embedding(query)

    # Vector search
    vector_results = await supabase.rpc(
        "vector_search",
        {"query_embedding": embedding, "match_count": limit * 2}
    ).execute()

    # Full-text search
    fts_results = await supabase.table("documents").select("*").text_search(
        "content_tsvector", query
    ).limit(limit * 2).execute()

    # Combine and rerank
    combined = merge_and_rerank(vector_results, fts_results)
    return combined[:limit]
```

---

## Deployment Architecture

### Docker Compose Services

```yaml
# docker-compose.yml
version: '3.8'

services:
  # Frontend (React)
  archon-frontend:
    build: ./archon-ui-main
    ports:
      - "3737:3737"
    environment:
      - VITE_API_URL=http://archon-server:8181
    volumes:
      - ./archon-ui-main:/app
      - /app/node_modules
    networks:
      - app-network

  # Main API Server (FastAPI)
  archon-server:
    build:
      context: ./python
      dockerfile: Dockerfile.server
    ports:
      - "8181:8181"
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LOGFIRE_TOKEN=${LOGFIRE_TOKEN}
    volumes:
      - ./python:/app
    networks:
      - app-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8181/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # MCP Server
  archon-mcp:
    build:
      context: ./python
      dockerfile: Dockerfile.mcp
    ports:
      - "8051:8051"
    environment:
      - ARCHON_SERVER_URL=http://archon-server:8181
    volumes:
      - ./python:/app
    networks:
      - app-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8051/health"]

  # AI Agents Service
  archon-agents:
    build:
      context: ./python
      dockerfile: Dockerfile.agents
    ports:
      - "8052:8052"
    environment:
      - ARCHON_SERVER_URL=http://archon-server:8181
      - ARCHON_MCP_URL=http://archon-mcp:8051
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./python:/app
    networks:
      - app-network
    profiles:
      - agents

  # Agent Work Orders Service
  archon-agent-work-orders:
    build:
      context: ./python
      dockerfile: Dockerfile.agent-work-orders
    ports:
      - "8053:8053"
    environment:
      - ARCHON_SERVER_URL=http://archon-server:8181
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
      - GH_TOKEN=${GITHUB_PAT_TOKEN}
      - STATE_STORAGE_TYPE=supabase
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
    volumes:
      - ./python:/app
      - /tmp/agent-work-orders:/tmp/agent-work-orders
    networks:
      - app-network
    profiles:
      - work-orders

networks:
  app-network:
    driver: bridge
```

### Development Workflows

#### Hybrid Development (Recommended)

```bash
# Backend in Docker, Frontend local
make dev

# Or manually:
docker compose --profile backend up -d
cd archon-ui-main && npm run dev
```

**Benefits**:
- Fast frontend hot reload
- Backend services isolated
- Easy debugging

#### Full Docker

```bash
# All services in Docker
make dev-docker

# Or manually:
docker compose up --build -d
```

**Benefits**:
- Production-like environment
- Consistent across machines
- Easy onboarding

#### All Local (3 Terminals)

```bash
# Terminal 1: Backend
cd python
uv run python -m uvicorn src.server.main:app --port 8181 --reload

# Terminal 2: Agent Work Orders (optional)
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload

# Terminal 3: Frontend
cd archon-ui-main
npm run dev
```

**Benefits**:
- Maximum debugging capability
- Direct log access
- Fastest iteration

### Production Deployment

**Not officially supported yet** (beta development), but recommended approach:

```yaml
# docker-compose.prod.yml
services:
  archon-frontend:
    build:
      context: ./archon-ui-main
      target: production
    environment:
      - NODE_ENV=production
    # No volumes (baked into image)

  archon-server:
    build:
      context: ./python
      dockerfile: Dockerfile.server
      target: production
    environment:
      - LOG_LEVEL=INFO
      - DEBUG=false
    # No volumes

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - archon-frontend
      - archon-server
```

**Nginx Reverse Proxy** (nginx.conf):
```nginx
upstream frontend {
    server archon-frontend:3737;
}

upstream api {
    server archon-server:8181;
}

server {
    listen 80;
    server_name archon.example.com;

    location / {
        proxy_pass http://frontend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Increase timeout for long operations
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
```

---

## File Structure Reference

### Complete Directory Tree

```
Archon/
├── archon-ui-main/                     # Frontend (React)
│   ├── src/
│   │   ├── features/                   # Vertical slices
│   │   │   ├── knowledge/              # Knowledge base feature
│   │   │   ├── projects/               # Project management
│   │   │   │   ├── tasks/              # Task sub-feature
│   │   │   │   └── documents/          # Document sub-feature
│   │   │   ├── agent-work-orders/      # Workflow UI
│   │   │   ├── progress/               # Progress tracking
│   │   │   ├── mcp/                    # MCP integration
│   │   │   ├── settings/               # Configuration
│   │   │   ├── shared/                 # Cross-feature utilities
│   │   │   └── ui/                     # UI components
│   │   ├── pages/                      # Page components
│   │   ├── components/                 # Legacy components
│   │   ├── contexts/                   # React contexts
│   │   ├── App.tsx                     # Root component
│   │   └── main.tsx                    # Entry point
│   ├── public/                         # Static assets
│   ├── tests/                          # Test setup
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── biome.json                      # Biome config
│   └── tsconfig.json
├── python/                             # Backend
│   ├── src/
│   │   ├── server/                     # Main API server
│   │   │   ├── api_routes/             # 10+ route modules
│   │   │   ├── services/               # Business logic
│   │   │   │   ├── projects/           # Project services
│   │   │   │   ├── knowledge/          # Knowledge services
│   │   │   │   ├── crawling/           # Crawling services
│   │   │   │   ├── search/             # Search services
│   │   │   │   └── embeddings/         # Embedding services
│   │   │   ├── config/                 # Configuration
│   │   │   ├── middleware/             # Middleware
│   │   │   ├── utils/                  # Utilities
│   │   │   └── main.py                 # FastAPI entry
│   │   ├── mcp_server/                 # MCP server
│   │   │   ├── features/               # MCP tools
│   │   │   │   ├── rag/
│   │   │   │   ├── projects/
│   │   │   │   ├── tasks/
│   │   │   │   └── documents/
│   │   │   └── mcp_server.py           # MCP entry
│   │   ├── agents/                     # AI agents
│   │   │   ├── base_agent.py
│   │   │   ├── rag_agent.py
│   │   │   ├── document_agent.py
│   │   │   └── server.py               # Agents entry
│   │   └── agent_work_orders/          # Workflow service
│   │       ├── api/
│   │       ├── agent_executor/
│   │       ├── command_loader/
│   │       ├── database/
│   │       ├── github_integration/
│   │       ├── sandbox_manager/
│   │       ├── state_manager/
│   │       ├── workflow_engine/
│   │       ├── utils/
│   │       └── server.py               # Work orders entry
│   ├── tests/                          # Pytest tests
│   ├── pyproject.toml                  # Python dependencies (uv)
│   ├── .env.example
│   ├── Dockerfile.server
│   ├── Dockerfile.mcp
│   ├── Dockerfile.agents
│   └── Dockerfile.agent-work-orders
├── migration/                          # Database migrations
│   ├── 0.1.0/                          # Versioned migrations
│   │   ├── 001_add_source_url_display_name.sql
│   │   ├── 002_add_hybrid_search_tsvector.sql
│   │   └── ...
│   ├── complete_setup.sql              # Full schema
│   └── agent_work_orders_repositories.sql
├── PRPs/                               # Project documentation
│   └── ai_docs/
│       ├── ARCHITECTURE.md
│       ├── DATA_FETCHING_ARCHITECTURE.md
│       ├── QUERY_PATTERNS.md
│       ├── ETAG_IMPLEMENTATION.md
│       └── API_NAMING_CONVENTIONS.md
├── docker-compose.yml
├── Makefile
├── CLAUDE.md                           # Development guidelines
└── README.md
```

### Key File Locations

#### Configuration
- `/python/.env` - Environment variables
- `/python/src/server/config/config.py` - Configuration validation
- `/archon-ui-main/vite.config.ts` - Frontend build config
- `/docker-compose.yml` - Service orchestration

#### Entry Points
- `/python/src/server/main.py` - Main API server (1000+ lines)
- `/python/src/mcp_server/mcp_server.py` - MCP server (600+ lines)
- `/python/src/agents/server.py` - AI agents service
- `/python/src/agent_work_orders/server.py` - Work orders service
- `/archon-ui-main/src/main.tsx` - Frontend entry

#### Core Services
- `/python/src/server/services/projects/project_service.py` - Project CRUD
- `/python/src/server/services/crawling/crawling_service.py` - Web crawling (~1,300 lines)
- `/python/src/server/services/credential_service.py` - Secret management (~750 lines)
- `/python/src/server/services/llm_provider_service.py` - LLM integration (~1,200 lines)

#### Frontend Core
- `/archon-ui-main/src/features/shared/config/queryClient.ts` - TanStack Query setup
- `/archon-ui-main/src/features/shared/api/apiClient.ts` - HTTP client with ETag
- `/archon-ui-main/src/features/shared/utils/optimistic.ts` - Optimistic updates
- `/archon-ui-main/src/features/ui/hooks/useSmartPolling.ts` - Smart polling

#### Database
- `/migration/complete_setup.sql` - Full database schema
- `/migration/0.1.0/` - Versioned migrations (16 files)

---

## Conclusion

Archon is a sophisticated, well-architected knowledge management and AI assistant platform with:

1. **Clean Architecture**: Layered design with clear separation of concerns
2. **Microservices**: 4 independent services + frontend
3. **Modern Stack**: React 18, FastAPI, Supabase, TanStack Query v5
4. **Performance**: ETag caching, smart polling, optimistic updates
5. **Security**: Service key validation, CORS, no Docker socket
6. **Scalability**: Async operations, connection pooling, batch processing
7. **Developer Experience**: Vertical slices, hot reload, comprehensive testing

The architecture supports rapid iteration (beta development) while maintaining code quality, type safety, and performance optimization.
