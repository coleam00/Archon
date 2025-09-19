# Unified Docker Deployment

This repository uses a **unified docker-compose.yml** approach where both the original `docker-compose.yml` (for development) and `docker-compose.unified.yml` (for production/LAN) share the same environment variable configuration, allowing for flexible deployment modes.

## Quick Start

### Local Development
```bash
# Copy local environment template
cp .env.unified.local .env

# Edit .env with your Supabase credentials
nano .env

# Start services
docker-compose -f docker-compose.unified.yml up -d
```

Access at: `http://localhost:3737`

### LAN/Production Deployment
```bash
# Copy LAN environment template
cp .env.unified.lan .env

# Edit .env with your Supabase credentials and domain
nano .env

# Start services (with Traefik proxy)
docker-compose -f docker-compose.unified.yml up -d
```

Access at: `https://archon.yourdomain.com`

## Key Differences Between Modes

| Setting | Local Development | LAN/Production |
|---------|------------------|----------------|
| **Compose File** | `docker-compose.yml` | `docker-compose.unified.yml` |
| **BIND_IP** | `127.0.0.1` (localhost only) | `0.0.0.0` (LAN access) |
| **HOST** | `localhost` | `archon.yourdomain.com` |
| **CORS_ORIGINS** | `http://localhost:3737` | `https://archon.yourdomain.com` |
| **MCP Access** | Direct `localhost:8051` | Direct `domain:8051` |
| **Volume Mounts** | Enabled (development) | Minimal (production) |
| **External Proxy** | Not required | Traefik proxy network |
| **Service Profiles** | Standard services | All services + proxy |

## Environment Variables

### Core Settings
- `HOST`: Domain name or localhost (used for service discovery)
- `BIND_IP`: IP to bind ports to (`127.0.0.1` for local, `0.0.0.0` for LAN, empty for all interfaces)
- `CORS_ORIGINS`: Comma-separated list of allowed CORS origins
- `API_BASE_URL`: Base URL for API service

### Port Configuration
- `ARCHON_SERVER_PORT`: Main API server port (default: 8181)
- `ARCHON_MCP_PORT`: MCP server port (default: 8051)
- `ARCHON_AGENTS_PORT`: Agents service port (default: 8052)
- `ARCHON_UI_PORT`: Frontend port (default: 3737)

### MCP Configuration
- `VITE_MCP_HOST`: MCP server hostname (for frontend)
- `VITE_MCP_PROTOCOL`: `http` or `https`
- `VITE_MCP_USE_PROXY`: Whether to proxy MCP through frontend (usually `false`)
- `VITE_MCP_PORT`: MCP server port (for frontend)

## Migration from Separate Files

If you're currently using separate docker-compose files:

1. **Backup current configuration**:
   ```bash
   cp .env .env.backup
   cp docker-compose.yml docker-compose.yml.backup
   # Note: docker-compose-lan.yml is now replaced by docker-compose.unified.yml
   ```

2. **Choose your deployment mode**:
   - For local: `cp .env.unified.local .env`
   - For LAN: `cp .env.unified.lan .env`

3. **Update .env with your credentials**:
   - Copy `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from backup
   - Update domain settings if using LAN mode

4. **Switch to unified compose**:
   ```bash
   docker-compose down
   docker-compose -f docker-compose.unified.yml up -d
   ```

## Using with Traefik

For LAN deployment with Traefik:

1. **Ensure proxy network exists**:
   ```bash
   docker network create proxy
   ```

2. **Set in .env**:
   ```bash
   PROXY_NETWORK=proxy
   ```

3. **Configure Traefik labels** (optional - add to docker-compose.unified.yml):
   ```yaml
   labels:
     - "traefik.enable=true"
     - "traefik.http.routers.archon.rule=Host(`archon.yourdomain.com`)"
   ```

## Benefits of Unified Approach

1. **Shared environment variables**: Both dev and production use the same .env variable names
2. **Consistent configuration**: Same parameterization across deployment modes
3. **Flexible deployment**: Choose localhost-only or LAN-wide access via `BIND_IP`
4. **Direct MCP access**: External AI IDEs can connect directly to MCP server
5. **Simplified maintenance**: Fewer configuration files to manage

## Important Architectural Changes

⚠️ **This is NOT a zero-impact change**:
- Development environment now uses the same parameterization as production
- Setting `BIND_IP=0.0.0.0` in development will expose services on your LAN
- MCP server is now exposed by default for AI IDE connections
- Both `docker-compose.yml` and `docker-compose.unified.yml` read the same `.env` variables

## Troubleshooting

### Services not accessible externally
- Check `BIND_IP` is set to `0.0.0.0` for LAN
- Verify firewall rules allow the ports

### MCP connection issues
- Ensure `VITE_MCP_USE_PROXY` matches your deployment mode
- Check browser console for the loaded configuration

### Traefik proxy not working
- Verify proxy network exists: `docker network ls`
- Check `PROXY_NETWORK` in .env matches your Traefik network name

## Third-Party MCP Clients

External MCP clients can connect directly to the MCP server:
- **Local**: `http://localhost:8051/mcp`
- **LAN**: `http://your-server-ip:8051/mcp` or `https://archon.yourdomain.com:8051/mcp`

**Important Notes:**
- MCP server is **directly exposed** on port 8051 for AI IDE connections
- No proxy routing needed - clients connect directly to the MCP service
- Configure your AI IDE (Claude, Cursor, Windsurf) to point to these URLs
- The `VITE_MCP_USE_PROXY` setting affects frontend behavior, not external client access