# Agent Work Orders Service

Independent microservice for executing agent-based workflows using Claude Code CLI.

## Purpose

The Agent Work Orders service is a standalone FastAPI application that:

- Executes Claude Code CLI commands for automated development workflows
- Manages git worktrees for isolated execution environments
- Integrates with GitHub for PR creation and management
- Provides a complete workflow orchestration system with 6 compositional commands

## Architecture

This service runs independently from the main Archon server and can be deployed:

- **Locally**: For development using `uv run`
- **Docker**: As a standalone container
- **Hybrid**: Mix of local and Docker services

### Service Communication

The agent service communicates with:

- **Archon Server** (`http://archon-server:8181` or `http://localhost:8181`)
- **Archon MCP** (`http://archon-mcp:8051` or `http://localhost:8051`)

Service discovery is automatic based on `SERVICE_DISCOVERY_MODE`:

- `local`: Uses localhost URLs
- `docker_compose`: Uses Docker container names

## Running Locally

### Prerequisites

- Python 3.12+
- Claude Code CLI installed (`curl -fsSL https://claude.ai/install.sh | bash`)
- Git and GitHub CLI (`gh`)
- uv package manager

### Quick Start

```bash
# Using make (recommended)
make agent-work-orders

# Or using the provided script
cd python
./scripts/start-agent-service.sh

# Or manually
export SERVICE_DISCOVERY_MODE=local
export ARCHON_SERVER_URL=http://localhost:8181
export ARCHON_MCP_URL=http://localhost:8051
uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload
```

## Running with Docker

### Build and Run

```bash
# Build the Docker image
cd python
docker build -f Dockerfile.agent-work-orders -t archon-agent-work-orders .

# Run the container
docker run -p 8053:8053 \
  -e SERVICE_DISCOVERY_MODE=local \
  -e ARCHON_SERVER_URL=http://localhost:8181 \
  archon-agent-work-orders
```

### Docker Compose

```bash
# Start with agent work orders service profile
docker compose --profile work-orders up -d

# Or include in default services (edit docker-compose.yml to remove profile)
docker compose up -d
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_WORK_ORDERS_PORT` | `8053` | Port for agent work orders service |
| `SERVICE_DISCOVERY_MODE` | `local` | Service discovery mode (`local` or `docker_compose`) |
| `ARCHON_SERVER_URL` | Auto | Main server URL (auto-configured by discovery mode) |
| `ARCHON_MCP_URL` | Auto | MCP server URL (auto-configured by discovery mode) |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude CLI executable |
| `GH_CLI_PATH` | `gh` | Path to GitHub CLI executable |
| `GH_TOKEN` | - | GitHub Personal Access Token for gh CLI authentication (required for PR creation) |
| `LOG_LEVEL` | `INFO` | Logging level |
| `STATE_STORAGE_TYPE` | `memory` | State storage (`memory`, `file`, or `supabase`) - Use `supabase` for production |
| `FILE_STATE_DIRECTORY` | `agent-work-orders-state` | Directory for file-based state (when `STATE_STORAGE_TYPE=file`) |
| `SUPABASE_URL` | - | Supabase project URL (required when `STATE_STORAGE_TYPE=supabase`) |
| `SUPABASE_SERVICE_KEY` | - | Supabase service key (required when `STATE_STORAGE_TYPE=supabase`) |

### State Storage Options

The service supports three state storage backends:

**Memory Storage** (`STATE_STORAGE_TYPE=memory`):
- **Default**: Easiest for development/testing
- **Pros**: No setup required, fast
- **Cons**: State lost on service restart, no persistence
- **Use for**: Local development, unit tests

**File Storage** (`STATE_STORAGE_TYPE=file`):
- **Legacy**: File-based JSON persistence
- **Pros**: Simple, no external dependencies
- **Cons**: No ACID guarantees, race conditions possible, file corruption risk
- **Use for**: Single-instance deployments, backward compatibility

**Supabase Storage** (`STATE_STORAGE_TYPE=supabase`):
- **Recommended for production**: PostgreSQL-backed persistence via Supabase
- **Pros**: ACID guarantees, concurrent access support, foreign key constraints, indexes
- **Cons**: Requires Supabase configuration and credentials
- **Use for**: Production deployments, multi-instance setups

### Supabase Configuration

Agent Work Orders can use Supabase for production-ready persistent state management.

#### Setup Steps

1. **Reuse existing Archon Supabase credentials** - No new database or credentials needed. The agent work orders service shares the same Supabase project as the main Archon server.

2. **Apply database migration**:
   - Navigate to your Supabase project dashboard at https://app.supabase.com
   - Open SQL Editor
   - Copy and paste the migration from `migration/agent_work_orders_state.sql` (in the project root)
   - Execute the migration
   - See `migration/AGENT_WORK_ORDERS.md` for detailed instructions

3. **Set environment variable**:
   ```bash
   export STATE_STORAGE_TYPE=supabase
   ```

4. **Verify configuration**:
   ```bash
   # Start the service
   make agent-work-orders

   # Check health endpoint
   curl http://localhost:8053/health | jq
   ```

   Expected response:
   ```json
   {
     "status": "healthy",
     "storage_type": "supabase",
     "database": {
       "status": "healthy",
       "tables_exist": true
     }
   }
   ```

#### Database Tables

When using Supabase storage, two tables are created:

- **`archon_agent_work_orders`**: Main work order state and metadata
- **`archon_agent_work_order_steps`**: Step execution history with foreign key constraints

#### Troubleshooting

**Error: "tables_exist": false**
- Migration not applied - see `database/migrations/README.md`
- Check Supabase dashboard SQL Editor for error messages

**Error: "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set"**
- Environment variables not configured
- Ensure same credentials as main Archon server are set

**Service starts but work orders not persisted**
- Check `STATE_STORAGE_TYPE` is set to `supabase` (case-insensitive)
- Verify health endpoint shows `"storage_type": "supabase"`

### Service Discovery Modes

**Local Mode** (`SERVICE_DISCOVERY_MODE=local`):
- Default for development
- Services on `localhost` with different ports
- Ideal for mixed local/Docker setup

**Docker Compose Mode** (`SERVICE_DISCOVERY_MODE=docker_compose`):
- Automatic in Docker deployments
- Uses container names for service discovery
- All services in same Docker network

## API Endpoints

### Core Endpoints

- `GET /health` - Health check with dependency validation
- `GET /` - Service information
- `GET /docs` - OpenAPI documentation

### Work Order Endpoints

All endpoints under `/api/agent-work-orders`:

- `POST /` - Create new work order
- `GET /` - List all work orders (optional status filter)
- `GET /{id}` - Get specific work order
- `GET /{id}/steps` - Get step execution history

## Development Workflows

### Hybrid (Recommended - Backend in Docker, Agent Work Orders Local)

```bash
# Terminal 1: Start backend in Docker and frontend
make dev-work-orders

# Terminal 2: Start agent work orders service
make agent-work-orders
```

### All Local (3 terminals)

```bash
# Terminal 1: Backend
cd python
uv run python -m uvicorn src.server.main:app --port 8181 --reload

# Terminal 2: Agent Work Orders Service
make agent-work-orders

# Terminal 3: Frontend
cd archon-ui-main
npm run dev
```

### Full Docker

```bash
# All services in Docker
docker compose --profile work-orders up -d

# View agent work orders service logs
docker compose logs -f archon-agent-work-orders
```

## Troubleshooting

### GitHub Authentication (PR Creation Fails)

The `gh` CLI requires authentication for PR creation. There are two options:

**Option 1: PAT Token (Recommended for Docker)**

Set `GH_TOKEN` or `GITHUB_TOKEN` environment variable with your Personal Access Token:

```bash
# In .env file
GITHUB_PAT_TOKEN=ghp_your_token_here

# Docker compose automatically maps GITHUB_PAT_TOKEN to GH_TOKEN
```

The token needs these scopes:
- `repo` (full control of private repositories)
- `workflow` (if creating PRs with workflow files)

**Option 2: gh auth login (Local development only)**

```bash
gh auth login
# Follow interactive prompts
```

### Claude CLI Not Found

```bash
# Install Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash

# Verify installation
claude --version
```

### Service Connection Errors

Check health endpoint to see dependency status:

```bash
curl http://localhost:8053/health
```

This shows:
- Claude CLI availability
- Git availability
- Archon server connectivity
- MCP server connectivity

### Port Conflicts

If port 8053 is in use:

```bash
# Change port
export AGENT_WORK_ORDERS_PORT=9053
./scripts/start-agent-service.sh
```

### Docker Service Discovery

If services can't reach each other in Docker:

```bash
# Verify network
docker network inspect archon_app-network

# Test connectivity
docker exec archon-agent-work-orders ping archon-server
docker exec archon-agent-work-orders curl http://archon-server:8181/health
```

## Testing

### Unit Tests

```bash
cd python
uv run pytest tests/agent_work_orders/ -m unit -v
```

### Integration Tests

```bash
uv run pytest tests/integration/test_agent_service_communication.py -v
```

### Manual Testing

```bash
# Create a work order
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -H "Content-Type: application/json" \
  -d '{
    "repository_url": "https://github.com/test/repo",
    "sandbox_type": "worktree",
    "user_request": "Fix authentication bug",
    "selected_commands": ["create-branch", "planning"]
  }'

# List work orders
curl http://localhost:8053/api/agent-work-orders/

# Get specific work order
curl http://localhost:8053/api/agent-work-orders/<id>
```

## Monitoring

### Health Checks

The `/health` endpoint provides detailed status:

```json
{
  "status": "healthy",
  "service": "agent-work-orders",
  "version": "0.1.0",
  "dependencies": {
    "claude_cli": { "available": true, "version": "2.0.21" },
    "git": { "available": true },
    "archon_server": { "available": true, "url": "..." },
    "archon_mcp": { "available": true, "url": "..." }
  }
}
```

### Logs

Structured logging with context:

```bash
# Docker logs
docker compose logs -f archon-agent-work-orders

# Local logs (stdout)
# Already visible in terminal running the service
```

## Architecture Details

### Dependencies

- **FastAPI**: Web framework
- **httpx**: HTTP client for service communication
- **Claude Code CLI**: Agent execution
- **Git**: Repository operations
- **GitHub CLI**: PR management

### File Structure

```
src/agent_work_orders/
├── server.py              # Standalone server entry point
├── main.py               # Legacy FastAPI app (deprecated)
├── config.py             # Configuration management
├── api/
│   └── routes.py         # API route handlers
├── agent_executor/       # Claude CLI execution
├── workflow_engine/      # Workflow orchestration
├── sandbox_manager/      # Git worktree management
└── github_integration/   # GitHub operations
```

## Future Improvements

- Claude Agent SDK migration (replace CLI with Python SDK)
- Direct MCP tool integration
- Multiple instance scaling with load balancing
- Prometheus metrics and distributed tracing
- WebSocket support for real-time log streaming
- Queue system (RabbitMQ/Redis) for work order management
