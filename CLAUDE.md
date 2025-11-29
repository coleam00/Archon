# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Archon is an AI "Agenteer" - an AI agent that autonomously builds, refines, and optimizes other AI agents. It uses Pydantic AI for agent implementation and LangGraph for workflow orchestration. The current version (V6) includes a library of prebuilt tools, examples, and MCP server integrations.

## Common Commands

### Running Archon

**Docker (Recommended):**
```bash
python run_docker.py
```
This builds both containers (main + MCP) and starts Archon at http://localhost:8501.

**Local Python:**
```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
streamlit run streamlit_ui.py
```

### Starting the Graph Service Manually
```bash
uvicorn graph_service:app --host 0.0.0.0 --port 8100
```

### Running MCP Server Standalone
```bash
cd mcp
python mcp_server.py
```

## Architecture

### Core Workflow (LangGraph)

The agent workflow is defined in `archon/archon_graph.py` and follows this flow:

1. **Parallel Start**: `define_scope_with_reasoner` and `advisor_with_examples` run concurrently
2. **Coder Agent**: Main coding agent generates the AI agent code
3. **User Interrupt**: Waits for user feedback
4. **Routing**: Routes to one of:
   - `coder_agent` - for direct feedback
   - Parallel refinement (`refine_prompt`, `refine_tools`, `refine_agent`) - when user says "refine"
   - `finish_conversation` - when done
5. **Loop**: Returns to step 3 until conversation ends

### Key Components

**Agent Definitions** (`archon/`):
- `archon_graph.py` - LangGraph workflow orchestration and state management
- `pydantic_ai_coder.py` - Main coding agent with RAG documentation tools
- `advisor_agent.py` - Recommends starting points from prebuilt components
- `agent_prompts.py` - System prompts for all agents
- `agent_tools.py` - Shared tool implementations (RAG search, file operations)
- `refiner_agents/` - Specialized agents for autonomous refinement:
  - `prompt_refiner_agent.py` - Optimizes system prompts
  - `tools_refiner_agent.py` - Validates and improves tool implementations
  - `agent_refiner_agent.py` - Refines agent configuration and dependencies

**Services**:
- `graph_service.py` - FastAPI service exposing the LangGraph workflow (port 8100)
- `streamlit_ui.py` - Web UI entry point (port 8501)
- `mcp/mcp_server.py` - MCP server for AI IDE integration (Cursor, Windsurf, etc.)

**Streamlit Pages** (`streamlit_pages/`):
- `chat.py` - Main chat interface for agent creation
- `environment.py` - API key and model configuration
- `database.py` - Supabase vector database setup
- `documentation.py` - Pydantic AI docs crawler
- `agent_service.py` - Service status and logs
- `mcp.py` - MCP configuration for AI IDEs

**Utilities**:
- `utils/utils.py` - Environment variable management, client initialization, logging
- `agent-resources/` - Prebuilt tools, examples, and MCP server configs

### State Management

The LangGraph workflow uses `AgentState` (TypedDict) with:
- `latest_user_message` - Current user input
- `messages` - Serialized Pydantic AI message history
- `scope` - Reasoner output (architecture plan)
- `advisor_output` - Recommended starting point
- `file_list` - Available agent-resources files
- `refined_*` - Outputs from refiner agents

### Configuration

Environment variables are stored in `workbench/env_vars.json` (auto-created) with profile support. Key variables:
- `LLM_PROVIDER` - OpenAI, Anthropic, or Ollama
- `PRIMARY_MODEL` / `REASONER_MODEL` - Model names
- `BASE_URL` / `LLM_API_KEY` - API configuration
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` - Vector database
- `EMBEDDING_*` - Embedding model configuration

### Docker Architecture

Two containers:
1. **archon:latest** - Main app (Streamlit + FastAPI graph service)
2. **archon-mcp:latest** - MCP server for IDE integration

The MCP container communicates with the main container's graph service via `GRAPH_SERVICE_URL`.

## Development Notes

- All agent message history uses Pydantic AI's `ModelMessagesTypeAdapter` for JSON serialization
- The workflow uses LangGraph's `interrupt()` for user input collection
- Logs are written to `workbench/logs.txt`
- The `iterations/` directory contains previous versions (V1-V6) for reference

## Database Schema

Supabase vector database uses:
```sql
CREATE TABLE site_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT,
    chunk_number INTEGER,
    title TEXT,
    summary TEXT,
    content TEXT,
    metadata JSONB,
    embedding VECTOR(1536)
);
```
