# Code Review Checklist for Environment Variable Migration

## Overview

This document provides a comprehensive checklist for reviewing and updating the Archon codebase to ensure all components properly use environment variables for deployment mode switching.

## Critical Files to Review

### Frontend (archon-ui-main/)

#### Primary Configuration Files
| File | What to Check | Required Changes |
|------|--------------|------------------|
| `src/services/api.ts` | API base URL configuration | Ensure uses `import.meta.env.VITE_API_URL` |
| `src/services/api.service.ts` | Service endpoints | Remove hard-coded localhost references |
| `src/config/index.ts` | Global configuration | All URLs from environment variables |
| `vite.config.ts` | Proxy configuration | Should handle both local and LAN modes |
| `src/contexts/AppContext.tsx` | Context providers | Check for hard-coded service URLs |

#### Search Commands
```bash
# Find all localhost references
grep -r "localhost:" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx"

# Find hard-coded IP addresses
grep -r "127.0.0.1\|192.168" src/ --include="*.ts" --include="*.tsx"

# Find hard-coded ports
grep -r ":8181\|:8051\|:8052\|:3737" src/ --include="*.ts" --include="*.tsx"

# Find http:// references (should use protocol from env)
grep -r "http://" src/ | grep -v "https://" | grep -v ".md"

# Check for WebSocket connections
grep -r "ws://" src/ --include="*.ts" --include="*.tsx"
grep -r "new WebSocket" src/ --include="*.ts" --include="*.tsx"
```

### Backend (python/)

#### Primary Configuration Files
| File | What to Check | Required Changes |
|------|--------------|------------------|
| `src/server/main.py` | CORS configuration | Use `os.getenv("CORS_ORIGINS", "").split(",")` |
| `src/server/config.py` | Service configuration | All service URLs from environment |
| `src/server/api_routes/*.py` | Inter-service calls | Use environment for service discovery |
| `src/mcp/server.py` | MCP configuration | API service URL from environment |
| `src/mcp/config.py` | MCP settings | Remove hard-coded addresses |
| `src/agents/config.py` | Agent configuration | Service URLs from environment |

#### Search Commands
```bash
# Find all localhost references
grep -r "localhost" src/ --include="*.py"

# Find hard-coded IP addresses
grep -r "127.0.0.1\|192.168" src/ --include="*.py"

# Find hard-coded ports
grep -r ":8181\|:8051\|:8052\|:3737" src/ --include="*.py"

# Find CORS configuration
grep -r "cors\|CORS\|allow_origins" src/ --include="*.py"

# Find service URL definitions
grep -r "http://" src/ --include="*.py" | grep -v "https://"

# Check environment variable usage
grep -r "os.getenv\|os.environ" src/ --include="*.py"
```

### Docker Configuration

#### Files to Review
| File | What to Check | Required Changes |
|------|--------------|------------------|
| `docker-compose.yml` | Service configuration | Add conditional Traefik labels |
| `docker-compose.yml` | Network configuration | Make proxy network conditional |
| `docker-compose.yml` | Port bindings | Consider conditional binding |
| `.env.example` | Environment template | Include all new variables |

## Environment Variables Checklist

### Required Variables for Mode Switching

#### Core Control Variables
- [ ] `DEPLOYMENT_MODE` - Controls local vs LAN mode
- [ ] `ENABLE_TRAEFIK` - Enables/disables Traefik labels
- [ ] `USE_PROXY_NETWORK` - Controls proxy network attachment

#### Service Configuration
- [ ] `HOST` - Hostname (localhost or domain)
- [ ] `DOMAIN` - Full domain for Traefik routing
- [ ] `VITE_API_URL` - Frontend API endpoint
- [ ] `CORS_ORIGINS` - Allowed CORS origins
- [ ] `VITE_ALLOWED_HOSTS` - Vite dev server hosts

#### Service Discovery
- [ ] `API_SERVICE_URL` - Backend API URL
- [ ] `MCP_SERVICE_URL` - MCP server URL
- [ ] `AGENTS_SERVICE_URL` - Agents service URL

## Common Code Patterns to Fix

### Frontend Patterns

#### ❌ Bad - Hard-coded URL
```typescript
const API_BASE = "http://localhost:8181";
```

#### ✅ Good - Environment Variable
```typescript
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8181";
```

#### ❌ Bad - Hard-coded WebSocket
```typescript
const ws = new WebSocket("ws://localhost:8181/ws");
```

#### ✅ Good - Dynamic WebSocket
```typescript
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = import.meta.env.VITE_API_URL?.replace(/^https?:\/\//, '') || 'localhost:8181';
const ws = new WebSocket(`${protocol}//${host}/ws`);
```

### Backend Patterns

#### ❌ Bad - Hard-coded CORS
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3737"],
    ...
)
```

#### ✅ Good - Environment-based CORS
```python
cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3737").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    ...
)
```

#### ❌ Bad - Hard-coded Service URL
```python
API_URL = "http://localhost:8181"
response = requests.get(f"{API_URL}/endpoint")
```

#### ✅ Good - Environment Service Discovery
```python
API_URL = os.getenv("API_SERVICE_URL", "http://localhost:8181")
response = requests.get(f"{API_URL}/endpoint")
```

## Docker Compose Patterns

### Conditional Traefik Labels
```yaml
labels:
  - "traefik.enable=${ENABLE_TRAEFIK:-false}"
  - "traefik.docker.network=proxy"
  - "traefik.http.routers.service.rule=Host(`${DOMAIN}`)"
```

### Conditional Network
```yaml
networks:
  app-network:
    driver: bridge
  proxy:
    external: ${USE_PROXY_NETWORK:-false}
```

### Dynamic Port Binding
```yaml
ports:
  - "${BIND_ADDRESS:-127.0.0.1}:${PORT}:${PORT}"
```

## Verification Steps

### 1. After Code Updates
```bash
# Test local mode
cp .env.local .env
docker-compose up -d
curl http://localhost:3737/health

# Test LAN mode
cp .env.lan .env
docker-compose up -d
curl https://archon.mcdonaldhomelab.com/health
```

### 2. Check Service Communication
```bash
# From frontend container
docker exec archon-ui curl http://archon-server:8181/health

# From MCP container
docker exec archon-mcp curl http://archon-server:8181/health
```

### 3. Verify CORS
```bash
# Test CORS headers
curl -H "Origin: https://archon.mcdonaldhomelab.com" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: X-Requested-With" \
     -X OPTIONS \
     http://localhost:8181/api/health -v
```

## Completion Checklist

### Frontend
- [ ] All API calls use environment variables
- [ ] No hard-coded localhost references
- [ ] WebSocket connections are dynamic
- [ ] Build configuration supports both modes

### Backend
- [ ] CORS configuration reads from environment
- [ ] Service discovery uses environment variables
- [ ] Inter-service communication is configurable
- [ ] No hard-coded ports or addresses

### Docker
- [ ] Traefik labels are conditional
- [ ] Networks support both modes
- [ ] Port bindings are configurable
- [ ] Environment variables documented

### Testing
- [ ] Local mode works correctly
- [ ] LAN mode works with Traefik
- [ ] Switching between modes is seamless
- [ ] All services communicate properly

## Notes

- Always provide fallback values for local development
- Test both modes thoroughly after changes
- Document any new environment variables
- Update .env.example with all required variables

---

*Last updated: September 2025*  
*Part of: Archon LAN Migration Project (ARCHON-LAN-001)*