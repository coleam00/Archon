# Archon MCP Server Configuration Guide

This guide explains how to configure and troubleshoot the Archon MCP (Model Context Protocol) server's dual transport support.

## Table of Contents

- [Overview](#overview)
- [Transport Options](#transport-options)
- [Environment Variables](#environment-variables)
- [When to Use Each Transport](#when-to-use-each-transport)
- [Client Configuration](#client-configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Overview

The Archon MCP server provides AI clients with access to Archon's functionality through the Model Context Protocol. It supports two transport options:

- **Streamable HTTP** (`/mcp`): Modern transport supporting the latest MCP specification (2025-03-26)
- **SSE** (`/sse`): Legacy Server-Sent Events transport for backward compatibility

Both transports:
- Share the same FastMCP instance and tools
- Use the same lifespan context (sessions, connections)
- Provide identical functionality
- Can run simultaneously for maximum compatibility

## Transport Options

### Streamable HTTP (`/mcp`)

**Status**: Active ✅ | **Recommended**: Yes

The modern MCP transport that replaces SSE in the 2025-03-26 protocol specification.

**Features:**
- HTTP POST for bidirectional communication
- Single connection model (simpler than SSE)
- Better error handling
- Native support in modern MCP clients

**Use for:**
- Claude Code
- Claude Desktop
- Latest Cursor IDE versions
- Windsurf IDE
- New integrations

### SSE (`/sse`)

**Status**: Legacy ⚠️ | **Recommended**: No

Server-Sent Events transport maintained for backward compatibility with older MCP clients.

**Features:**
- HTTP + Server-Sent Events
- Streaming responses
- Deprecated as of MCP protocol 2025-03-26

**Use for:**
- Existing integrations that rely on SSE
- Older MCP clients without Streamable HTTP support
- Systems that require SSE specifically

> **Migration Path**: If you're currently using SSE, plan to migrate to Streamable HTTP. SSE will continue to work but won't receive new MCP protocol features.

## Environment Variables

### Transport Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ARCHON_MCP_ENABLE_STREAMABLE_HTTP` | `true` | Enable Streamable HTTP transport at `/mcp` |
| `ARCHON_MCP_ENABLE_SSE` | `true` | Enable SSE transport at `/sse` |
| `ARCHON_MCP_PORT` | `8051` | Port for the MCP server |

**Important**: At least one transport must be enabled. The server will fail to start if both are set to `false`.

### Server Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE_URL` | `http://archon-server:8080` | Archon Server API base URL |
| `AGENTS_BASE_URL` | `http://archon-agents:8052` | Archon Agents API base URL |
| `MCP_SERVICE_KEY` | *(required)* | Service key for authentication |

### Logging Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGFIRE_ENABLED` | `false` | Enable Logfire logging |
| `LOGFIRE_TOKEN` | *(optional)* | Logfire token (required if enabled) |

## When to Use Each Transport

### Choose Streamable HTTP When:

✅ **Starting a new integration** - It's the modern standard
✅ **Using Claude Code or Claude Desktop** - Native support
✅ **Using latest Cursor or Windsurf** - Better performance
✅ **You want future protocol features** - SSE is frozen

### Choose SSE When:

⚠️ **Maintaining existing SSE integrations** - Avoid breaking changes
⚠️ **Using older MCP clients** - That don't support Streamable HTTP
⚠️ **Testing legacy compatibility** - Validation purposes

### Enable Both When:

🔄 **Gradual migration** - Supporting both old and new clients
🔄 **Maximum compatibility** - Development environments
🔄 **Testing both transports** - Quality assurance

## Client Configuration

### Claude Code

**Streamable HTTP (Recommended):**
```bash
claude mcp add archon http://localhost:8051/mcp
```

**SSE (Legacy):**
```bash
claude mcp add --transport sse archon http://localhost:8051/sse
```

**Verify connection:**
```bash
claude mcp list
```

### Cursor IDE

**Streamable HTTP (Recommended):**

Add to Cursor settings (`~/.cursor/mcp_settings.json` or IDE settings):

```json
{
  "mcpServers": {
    "archon": {
      "url": "http://localhost:8051/mcp",
      "transport": "streamable-http"
    }
  }
}
```

**SSE (Legacy):**
```json
{
  "mcpServers": {
    "archon": {
      "uri": "http://localhost:8051/sse"
    }
  }
}
```

### Windsurf IDE

**Streamable HTTP (Recommended):**
```json
{
  "mcp.servers": {
    "archon": {
      "url": "http://localhost:8051/mcp",
      "transport": "streamable-http"
    }
  }
}
```

**SSE (Legacy):**
```json
{
  "mcp.servers": {
    "archon": {
      "uri": "http://localhost:8051/sse"
    }
  }
}
```

### PydanticAI (Programmatic)

**Streamable HTTP:**
```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStreamableHTTP

server = MCPServerStreamableHTTP('http://localhost:8051/mcp')
agent = Agent('openai:gpt-4', toolsets=[server])
```

**SSE:**
```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerSSE

server = MCPServerSSE('http://localhost:8051/sse')
agent = Agent('openai:gpt-4', toolsets=[server])
```

## Troubleshooting

### Server Won't Start

**Error**: `ValueError: At least one transport must be enabled`

**Solution**: Enable at least one transport:
```bash
export ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true
# OR
export ARCHON_MCP_ENABLE_SSE=true
```

### Client Can't Connect

**Symptom**: Connection refused or timeout

**Check**:
1. Is the server running?
   ```bash
   docker ps | grep archon-mcp
   # OR
   curl http://localhost:8051/mcp
   ```

2. Is the correct port exposed?
   ```bash
   docker port archon-mcp
   # Should show: 8051/tcp -> 0.0.0.0:8051
   ```

3. Is the firewall blocking the port?
   ```bash
   # macOS
   sudo lsof -i :8051

   # Linux
   sudo netstat -tlnp | grep 8051
   ```

### Wrong Transport Type

**Symptom**: Client shows "Not Acceptable" or "Unsupported transport"

**Solution**: Check your client configuration matches the server endpoint:

| Endpoint | Transport Type | Client Config |
|----------|---------------|---------------|
| `/mcp` | Streamable HTTP | Use `url` or `transport: streamable-http` |
| `/sse` | SSE | Use `uri` or `transport: sse` |

**Example Fix**:
```json
// WRONG - mixing transport types
{
  "archon": {
    "uri": "http://localhost:8051/mcp"  // ❌ uri is for SSE
  }
}

// CORRECT
{
  "archon": {
    "url": "http://localhost:8051/mcp"  // ✅ url for Streamable HTTP
  }
}
```

### Session Errors

**Symptom**: "Missing session ID" or "Invalid session"

**Cause**: The MCP protocol requires session initialization via the `initialize` method.

**Solution**: Most MCP clients handle this automatically. If you're implementing a custom client:

1. Send `initialize` request first:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "initialize",
     "params": {
       "protocolVersion": "2024-11-05",
       "capabilities": {},
       "clientInfo": {"name": "my-client", "version": "1.0"}
     }
   }
   ```

2. Store the session ID from response
3. Include session ID in subsequent requests (header or params, depending on transport)

### Tools Not Available

**Symptom**: Client can't see MCP tools

**Check**:
1. Is the server fully started?
   ```bash
   docker logs archon-mcp | grep "Application startup complete"
   ```

2. Can you list tools via API?
   ```bash
   curl -X POST http://localhost:8051/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
   ```

3. Check server logs for errors:
   ```bash
   docker logs archon-mcp --tail 100
   ```

### Performance Issues

**Symptom**: Slow response times

**Check**:
1. Network latency:
   ```bash
   curl -w "@-" -o /dev/null -s http://localhost:8051/mcp <<'EOF'
   time_namelookup:  %{time_namelookup}s\n
   time_connect:     %{time_connect}s\n
   time_total:       %{time_total}s\n
   EOF
   ```

2. Server resource usage:
   ```bash
   docker stats archon-mcp --no-stream
   ```

3. Backend API health:
   ```bash
   curl http://localhost:8181/api/health
   ```

**Optimization**:
- Use Streamable HTTP instead of SSE (lower overhead)
- Enable connection pooling in your client
- Check backend API performance (MCP is just a proxy)

## Development

### Running Locally

**With Docker:**
```bash
docker run -d \
  --name archon-mcp \
  -p 8051:8051 \
  -e ARCHON_MCP_PORT=8051 \
  -e ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true \
  -e ARCHON_MCP_ENABLE_SSE=true \
  -e API_BASE_URL=http://host.docker.internal:8181 \
  --env-file .env \
  archon-mcp:latest
```

**With Python:**
```bash
cd python
export ARCHON_MCP_PORT=8051
export ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true
export ARCHON_MCP_ENABLE_SSE=true
python -m src.mcp_server.mcp_server
```

### Testing Both Transports

**Quick health check:**
```bash
# Streamable HTTP
curl -X POST http://localhost:8051/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# SSE
curl -X POST http://localhost:8051/sse \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

### Configuration Examples

**Streamable HTTP only (production recommended):**
```bash
ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true
ARCHON_MCP_ENABLE_SSE=false
```

**SSE only (legacy systems):**
```bash
ARCHON_MCP_ENABLE_STREAMABLE_HTTP=false
ARCHON_MCP_ENABLE_SSE=true
```

**Both enabled (maximum compatibility):**
```bash
ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true
ARCHON_MCP_ENABLE_SSE=true
```

### Logs and Monitoring

**View server logs:**
```bash
# Docker
docker logs archon-mcp -f

# Follow logs for both transports
docker logs archon-mcp | grep -E "(Streamable HTTP|SSE)"
```

**Check which transports are enabled:**
```bash
docker logs archon-mcp 2>&1 | grep "Enabled:"
# Output: Enabled: Streamable HTTP at /mcp, SSE at /sse
```

**Monitor tool calls:**
```bash
docker logs archon-mcp | grep "tools/call"
```

## Additional Resources

- [MCP Protocol Specification](https://modelcontextprotocol.io/specification/)
- [FastMCP Documentation](https://github.com/modelcontextprotocol/python-sdk)
- [Archon MCP Server Documentation](../../docs/docs/mcp-server.mdx)
- [Environment Variables Reference](../../.env.example)

## Support

If you encounter issues not covered in this guide:

1. Check the [Archon GitHub Issues](https://github.com/yourusername/archon/issues)
2. Review server logs: `docker logs archon-mcp`
3. Verify your environment variables
4. Test with curl to isolate client vs server issues
5. Enable debug logging: `LOGFIRE_ENABLED=true`
