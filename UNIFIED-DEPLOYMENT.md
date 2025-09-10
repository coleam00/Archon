# Unified Docker Deployment

This repository now uses a **single unified docker-compose.yml** file that works for both local development and LAN/production deployments through environment variables.

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
| **BUILD_TARGET** | `development` | `production` |
| **BIND_IP** | `127.0.0.1` | `0.0.0.0` |
| **HOST** | `localhost` | `archon.yourdomain.com` |
| **CORS_ORIGINS** | `http://localhost:3737` | `https://archon.yourdomain.com` |
| **VITE_MCP_USE_PROXY** | `false` | `true` |
| **Volume Mounts** | Enabled | Disabled |
| **Docker Socket** | Mounted | Not mounted |
| **External Proxy** | Not used | Traefik proxy network |

## Environment Variables

### Core Settings
- `DEPLOYMENT_MODE`: `local` or `lan`
- `BUILD_TARGET`: `development` or `production`
- `NODE_ENV`: `development` or `production`

### Network Configuration
- `HOST`: Domain or localhost
- `BIND_IP`: IP to bind ports to (127.0.0.1 for local, 0.0.0.0 for LAN)
- `CORS_ORIGINS`: Allowed CORS origins
- `API_BASE_URL`: Base URL for API

### MCP Configuration
- `VITE_MCP_HOST`: MCP server hostname
- `VITE_MCP_PROTOCOL`: `http` or `https`
- `VITE_MCP_USE_PROXY`: `true` for LAN (routes through /mcp)
- `VITE_MCP_PORT`: MCP server port

## Migration from Separate Files

If you're currently using separate docker-compose files:

1. **Backup current configuration**:
   ```bash
   cp .env .env.backup
   cp docker-compose.yml docker-compose.yml.backup
   cp docker-compose-lan.yml docker-compose-lan.yml.backup
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

1. **Single source of truth**: One docker-compose file to maintain
2. **Environment-based configuration**: Everything controlled via .env
3. **Easier testing**: Switch between modes by changing .env
4. **Reduced complexity**: No need to remember different compose files
5. **Version control friendly**: Same file structure for all deployments

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

External MCP clients can connect to:
- **Local**: `http://localhost:8051/mcp`
- **LAN**: `https://archon.yourdomain.com/mcp`

The configuration automatically handles routing based on `VITE_MCP_USE_PROXY` setting.