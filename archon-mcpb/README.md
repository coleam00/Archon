# Archon MCP Proxy Bundle

This directory contains the MCPB (MCP Bundle) package for connecting AI clients to your running Archon installation.

## 📦 What is this?

An **MCPB bundle** (`.mcpb` file) is a standardized package that enables easy installation of MCP servers in AI clients like Claude Desktop, Cursor, and Windsurf.

The Archon MCP Proxy Bundle is a **lightweight connection proxy** that:
- Provides single-click installation in Claude Desktop
- Forwards MCP requests from your AI client to the running Archon MCP server
- Validates connection before starting
- Handles session management, SSE parsing, and JSON-RPC notifications
- Configurable ports for flexible deployment

## 🔌 Architecture

```
Claude Desktop → stdio → proxy.py → HTTP → localhost:8051/mcp → Archon MCP Server
```

The bundle contains a robust proxy that:
1. Validates Archon API is running at `localhost:8181`
2. Connects to MCP server at `localhost:8051` (configurable)
3. Forwards stdin/stdout MCP protocol to HTTP with proper session handling
4. Parses Server-Sent Events (SSE) responses
5. Handles JSON-RPC notifications correctly (no response sent)
6. Provides clear error messages if Archon isn't accessible

## ⚠️ Important Prerequisites

**This is a CONNECTION PROXY, not a standalone server.**

Before using this bundle, you must have:

1. **Archon Running**
   - Full Docker Compose stack must be running
   - Start with: `docker compose up -d` in the main Archon directory
   - API server accessible at: `http://localhost:8181`
   - MCP server accessible at: `http://localhost:8051/mcp` (default, configurable)

2. **Python 3.12+**
   - Required for running the proxy
   - Only dependency: `httpx` (installed automatically)

**No Supabase credentials needed** - the running Archon instance already has these configured.

## 📋 Bundle Contents

```
archon-mcpb/
├── server/
│   ├── proxy.py              # HTTP-to-stdio proxy with session management
│   └── requirements.txt      # Minimal dependencies (httpx)
├── README.md                 # This file
├── build-bundle.ps1          # Build script (Windows PowerShell)
├── build-bundle.sh           # Build script (Linux/Mac Bash)
├── check-archon.py           # Health check utility
├── icon.png                  # Bundle icon (256x256px, included)
└── manifest.json             # MCPB manifest with configuration

2 directories, 8 files
```

## 🚀 Quick Start

### Step 1: Verify Archon is Running

Before building or installing the bundle:

```bash
# Check if Archon is accessible
python check-archon.py
```

You should see:
```
✓ API Server - OK (http://localhost:8181)
✓ MCP Server - OK (http://localhost:8051)
✓ Web UI - OK (http://localhost:3737)
```

If not, start Archon:
```bash
cd archon
docker compose up -d
```

### Step 2: Build the Bundle

**Option A: Using Official MCPB CLI (Recommended)**

Install MCPB tooling:
```bash
npm install -g @anthropic-ai/mcpb
```

Package the bundle:
```bash
# Linux/Mac
cd archon-mcpb
./build-bundle.sh

# Windows PowerShell
cd archon-mcpb
.\build-bundle.ps1
```

This creates `archon.mcpb` ready for installation (~60KB).

**Option B: Manual Build**

```bash
cd archon-mcpb
python3 -c "
import zipfile
from pathlib import Path

with zipfile.ZipFile('archon.mcpb', 'w', zipfile.ZIP_DEFLATED) as zipf:
    zipf.write('manifest.json')
    for file in Path('server').rglob('*'):
        if file.is_file():
            zipf.write(file)
    for file in ['icon.png', 'README.md', 'LICENSE', 'check-archon.py', 'requirements.txt']:
        if Path(file).exists():
            zipf.write(file)
"
```

## 📖 Using the Bundle

### Installation in Claude Desktop

1. Ensure Archon is running: `docker compose up -d`
2. In Claude Desktop, go to Settings → Extensions, then drag and drop the `archon.mcpb` file
3. Configure settings (see below)
4. The proxy will validate connection and start

### Configuration

The bundle prompts for **optional** settings:

| Setting | Description | Default | Required |
|---------|-------------|---------|----------|
| `mcp_port` | Port for MCP server | 8051 | No |
| `log_level` | Logging verbosity (DEBUG, INFO, WARNING, ERROR) | INFO | No |

**Fixed Configuration** (not configurable):
- API URL: `http://localhost:8181` (validated on startup)
- Host: `localhost` (proxy always connects locally)

### Custom Port Configuration

If your Archon MCP server runs on a different port:

1. During installation, set `mcp_port` to your custom port
2. Or update the setting after installation in Claude Desktop settings
3. The proxy will build the MCP URL as `http://localhost:{mcp_port}/mcp`

Example: If MCP server is on port 9051, set `mcp_port` to `9051`.

### Verify Connection

After installation, the proxy will:
1. Validate Archon API server is accessible at `localhost:8181`
2. Store MCP session ID from first request
3. Forward all MCP requests with proper session management
4. Provide all Archon MCP tools to Claude Desktop

If connection fails, check the logs or run:
```bash
python check-archon.py
```

Or manually verify:
```bash
curl http://localhost:8181/health
curl http://localhost:8051/health
```

## 🛠️ Available MCP Tools

Once connected, you'll have access to:

### Knowledge Management (RAG)
- `rag_get_available_sources` - List knowledge sources
- `rag_search_knowledge_base` - Semantic search (2-5 keywords recommended)
- `rag_search_code_examples` - Find code examples
- `rag_list_pages_for_source` - Browse documentation structure
- `rag_read_full_page` - Read complete page content

### Project Management
- `find_projects` - List/search projects or get specific project
- `manage_project` - Create/update/delete projects
- `get_project_features` - Get project features

### Task Management
- `find_tasks` - List/search tasks with filters
- `manage_task` - Create/update/delete tasks

### Document Management
- `find_documents` - List/search project documents
- `manage_document` - Create/update/delete documents
- `find_versions` - View version history
- `manage_version` - Create/restore document versions

### System
- `health_check` - Server health status
- `session_info` - Session information

## 🔧 Troubleshooting

### "Cannot connect to Archon at http://localhost:8181"

**Cause**: Archon API server isn't running or not accessible.

**Solution**:
1. Run health check: `python check-archon.py`
2. Start Archon: `cd archon && docker compose up -d`
3. Verify API: `curl http://localhost:8181/health`
4. Check Docker logs: `docker compose logs archon-server`

### "Connection refused" to MCP server

**Cause**: MCP server isn't running or wrong port configured.

**Solution**:
1. Verify MCP server: `curl http://localhost:8051/health`
2. Check Docker logs: `docker compose logs archon-mcp`
3. Verify port configuration in Claude Desktop settings
4. Ensure port matches your Docker Compose setup

### "Missing session ID" errors

**Cause**: Session management issue (should be fixed in latest version).

**Solution**:
1. Update to latest bundle version
2. Restart Claude Desktop
3. Check proxy logs in Claude Desktop (stderr output)

### MCP tools not appearing in Claude Desktop

**Cause**: Proxy didn't start successfully or bundle not installed correctly.

**Solution**:
1. Check Claude Desktop logs (Settings → MCP → View Logs)
2. Verify Archon is accessible first: `python check-archon.py`
3. Reinstall the bundle
4. Try restarting Claude Desktop

### Zod validation errors

**Cause**: JSON-RPC protocol mismatch (should be fixed in latest version).

**Solution**:
1. Ensure you're using the latest bundle
2. The proxy now correctly handles JSON-RPC notifications (no response sent)
3. If issue persists, report at: https://github.com/coleam00/archon/issues

## 🔍 Proxy Features

The proxy implements robust MCP protocol handling:

### Session Management
- Captures `mcp-session-id` header from initialize response
- Sends session ID with all subsequent requests
- Maintains session throughout connection lifetime

### Response Handling
- Parses Server-Sent Events (SSE) multi-line format
- Handles both `text/event-stream` and `application/json` responses
- Accepts 200 OK and 202 Accepted status codes

### Notification Handling
- Detects JSON-RPC notifications (requests with no `id` field)
- Correctly skips sending responses for notifications
- Complies with JSON-RPC 2.0 specification

### Error Handling
- Validates Archon connection before starting
- Provides detailed error messages
- Logs all operations to stderr for debugging

### Windows Compatibility
- Thread-based stdin reading (avoids ProactorEventLoop issues)
- Works on all platforms (Windows, Linux, macOS)

## 📚 Additional Resources

- [Main Archon Documentation](https://github.com/coleam00/archon)
- [MCPB Specification](https://github.com/anthropics/mcpb)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Archon Issues](https://github.com/coleam00/archon/issues)

## 📝 Development Notes

### Architecture

The Archon MCP server uses a **microservices architecture**:
- MCP server is lightweight (HTTP client only)
- All heavy operations (crawling, embeddings, RAG) handled by backend
- Connects via HTTP to `archon-server` service at port 8181
- Exposes MCP protocol at port 8051

### Why a Proxy?

Archon MCP cannot be truly standalone because:
- Requires PostgreSQL + pgvector database
- Needs web crawling infrastructure
- Depends on embedding generation services
- Best deployed as a full Docker Compose stack

The MCPB bundle provides **convenient client installation** while leveraging your existing Archon deployment.

### Build Scripts

Two build scripts are provided for convenience:

- **`build-bundle.sh`** - Bash script for Linux/Mac
- **`build-bundle.ps1`** - PowerShell script for Windows

Both scripts:
1. Validate required files exist
2. Check for MCPB CLI installation
3. Run `mcpb pack` to create the bundle
4. Rename output to `archon.mcpb`
5. Display bundle size and next steps

## 🤝 Contributing

To improve this bundle:
1. Test installation in different AI clients (Cursor, Windsurf)
2. Improve error messages and validation
3. Add more comprehensive documentation
4. Test with different port configurations
5. Report issues with detailed logs

Submit PRs to: https://github.com/coleam00/archon

## 📄 License

Archon Community License (ACL) v1.2 - See [LICENSE](https://github.com/coleam00/archon/blob/main/LICENSE)
