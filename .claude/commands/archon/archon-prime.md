---
name: prime
description: |
  Prime Claude Code with deep context for a specific part of the Archon codebase.

  Usage: /prime "<service>" "<special focus>"
  Examples:
  /prime "frontend" "Focus on UI components and React"
  /prime "server" "Focus on FastAPI and backend services"
  /prime "knowledge" "Focus on RAG and knowledge management"
argument-hint: <service> <Specific focus>
---

You're about to work on the Archon V2 Beta codebase. This is a microservices-based knowledge management system with MCP integration. Here's what you need to know:

## Today's Focus area

Today we are focusing on: $ARGUMENTS
And pay special attention to: $ARGUMENTS

## Decision

Think hard and make an intelligent decision about which key files you need to read and create a todo list.
If you discover something you need to look deeper at or imports from files you need context from, append it to the todo list during the priming process. The goal is to get key understandings of the codebase so you are ready to make code changes to that part of the codebase.

## Architecture Overview

### Frontend (port 3737) - React + TypeScript + Vite

```
archon-ui-main/
├── src/
│   ├── App.tsx                    # Main app component with routing and providers
│   ├── index.tsx                  # React entry point with theme and settings
│   ├── components/
│   │   ├── layouts/               # Layout components (MainLayout, SideNavigation)
│   │   ├── knowledge-base/        # Knowledge management UI (crawling, items, search)
│   │   ├── project-tasks/         # Project and task management components
│   │   ├── prp/                   # Product Requirements Prompt viewer components
│   │   ├── mcp/                   # MCP client management and testing UI
│   │   ├── settings/              # Settings panels (API keys, features, RAG config)
│   │   └── ui/                    # Reusable UI components (buttons, cards, inputs)
│   ├── services/                  # API client services for backend communication
│   │   ├── knowledgeBaseService.ts    # Knowledge item CRUD and search operations
│   │   ├── projectService.ts          # Project and task management API calls
│   │   ├── mcpService.ts              # MCP server communication and tool execution
│   │   └── socketIOService.ts         # Real-time WebSocket event handling
│   ├── hooks/                     # Custom React hooks for state and effects
│   ├── contexts/                  # React contexts (Settings, Theme, Toast)
│   └── pages/                     # Main page components for routing
```

### Backend Server (port 8181) - FastAPI + Socket.IO

```
python/src/server/
├── main.py                        # FastAPI app initialization and routing setup
├── socketio_app.py               # Socket.IO server configuration and namespaces
├── config/
│   ├── config.py                 # Environment variables and app configuration
│   └── service_discovery.py     # Service URL resolution for Docker/local
├── fastapi/                      # API route handlers (thin wrappers)
│   ├── knowledge_api.py         # Knowledge base endpoints (crawl, upload, search)
│   ├── projects_api.py          # Project and task management endpoints
│   ├── mcp_api.py              # MCP tool execution and health checks
│   └── socketio_handlers.py    # Socket.IO event handlers and broadcasts
├── services/                     # Business logic layer
│   ├── knowledge/
│   │   ├── crawl_orchestration_service.py  # Website crawling coordination
│   │   ├── knowledge_item_service.py       # Knowledge item CRUD operations
│   │   └── code_extraction_service.py      # Extract code examples from docs
│   ├── projects/
│   │   ├── project_service.py              # Project management logic
│   │   ├── task_service.py                 # Task lifecycle and status management
│   │   └── versioning_service.py           # Document version control
│   ├── rag/
│   │   └── crawling_service.py             # Web crawling implementation
│   ├── search/
│   │   └── vector_search_service.py        # Semantic search with pgvector
│   ├── embeddings/
│   │   └── embedding_service.py            # OpenAI embeddings generation
│   └── storage/
│       └── document_storage_service.py     # Document chunking and storage
```

### MCP Server (port 8051) - Model Context Protocol

```
python/src/mcp/
├── mcp_server.py                 # FastAPI MCP server with SSE support
└── modules/
    ├── project_module.py         # Project and task MCP tools
    └── rag_module.py            # RAG query and search MCP tools
```

### Agents Service (port 8052) - PydanticAI

```
python/src/agents/
├── server.py                     # FastAPI server for agent endpoints
├── base_agent.py                # Base agent class with streaming support
├── document_agent.py            # Document processing and chunking agent
├── rag_agent.py                # RAG search and reranking agent
└── mcp_client.py              # Client for calling MCP tools
```

## Key Files to Read for Context

### When working on Frontend

Key files to consider:

- `archon-ui-main/src/App.tsx` - Main app structure and routing
- `archon-ui-main/src/services/knowledgeBaseService.ts` - API call patterns
- `archon-ui-main/src/services/socketIOService.ts` - Real-time events

### When working on Backend

Key files to consider:

- `python/src/server/main.py` - FastAPI app setup
- `python/src/server/services/knowledge/knowledge_item_service.py` - Service pattern example
- `python/src/server/api_routes/knowledge_api.py` - API endpoint pattern

### When working on MCP

Key files to consider:

- `python/src/mcp/mcp_server.py` - MCP server implementation
- `python/src/mcp/modules/rag_module.py` - Tool implementations

### When working on RAG

Key files to consider:

- `python/src/server/services/search/vector_search_service.py` - Vector search logic
- `python/src/server/services/embeddings/embedding_service.py` - Embedding generation
- `python/src/agents/rag_agent.py` - RAG reranking

### When working on Crawling

Key files to consider:

- `python/src/server/services/rag/crawling_service.py` - Core crawling logic
- `python/src/server/services/knowledge/crawl_orchestration_service.py` - Crawl coordination
- `python/src/server/services/storage/document_storage_service.py` - Document storage

### When working on Projects/Tasks

Key files to consider:

- `python/src/server/services/projects/task_service.py` - Task management
- `archon-ui-main/src/components/project-tasks/TaskBoardView.tsx` - Kanban UI

### When working on Agents

Key files to consider:

- `python/src/agents/base_agent.py` - Agent base class
- `python/src/agents/rag_agent.py` - RAG agent implementation

## Critical Rules for This Codebase

Follow the guidelines in CLAUDE.md

## Current Focus Areas

- The projects feature is optional (toggle in Settings UI)
- All services communicate via HTTP, not gRPC
- Socket.IO handles all real-time updates
- Frontend uses Vite proxy for API calls in development
- Python backend uses `uv` for dependency management

Remember: This is beta software. Prioritize functionality over production patterns. Make it work, make it right, then make it fast.
