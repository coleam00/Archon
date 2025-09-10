# LAN Migration Enhancement - Brownfield Architecture Integration

This document outlines how the LAN service discovery and management enhancement integrates with Archon's existing brownfield architecture, following enterprise-grade migration patterns for minimal disruption.

## 1. Legacy System Analysis

### 1.1 Current Architecture Assessment

#### Service Architecture (Microservices Pattern)
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Frontend (UI)  │    │   Main Server   │    │   MCP Server    │
│   Port: 3737    │◄──►│   Port: 8181    │◄──►│   Port: 8051    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌─────────────────┐
                       │  Agents Service │
                       │   Port: 8052    │
                       │  (Profile-based)│
                       └─────────────────┘
```

#### Communication Patterns
- **Inter-Service**: HTTP REST APIs with health checks
- **Service Discovery**: Docker Compose internal networking
- **Frontend-Backend**: HTTP polling (replaced Socket.IO)
- **Data Flow**: FastAPI → Supabase (PostgreSQL + pgvector)

#### Technology Stack Assessment
- **Runtime**: Python 3.12 + uvicorn (FastAPI)
- **Frontend**: React + TypeScript + Vite + TailwindCSS  
- **Database**: Supabase (managed PostgreSQL)
- **Containerization**: Docker Compose with multi-stage builds
- **Package Management**: uv (Python), npm (Node.js)

### 1.2 Infrastructure Constraints

#### Current Deployment Model
- **Local-first**: Each user runs own instance
- **Network Scope**: Single-node Docker Compose
- **Service Discovery**: Environment variable + DNS resolution
- **Port Management**: Static port allocation via .env
- **External Access**: Optional Traefik reverse proxy

#### Technical Debt and Limitations
- **Single Node**: No horizontal scaling capability
- **Static Configuration**: Manual port management
- **Limited Discovery**: Only supports `docker_compose` and `local` modes
- **Network Isolation**: Services can't communicate across hosts

## 2. Source Tree Integration

### 2.1 Existing Source Structure
```
C:\funstuff\Archon/
├── python/
│   ├── src/
│   │   ├── server/           # Main FastAPI application
│   │   │   ├── api_routes/   # RESTful API endpoints
│   │   │   ├── services/     # Business logic layer
│   │   │   └── main.py       # Application entry point
│   │   ├── mcp_server/       # MCP protocol implementation
│   │   └── agents/           # PydanticAI agents
│   ├── Dockerfile.server     # Server container build
│   ├── Dockerfile.mcp        # MCP container build
│   └── Dockerfile.agents     # Agents container build
├── archon-ui-main/           # React frontend
├── docker-compose.yml        # Service orchestration
├── traefik/                  # Reverse proxy config (optional)
└── .env.example             # Environment template
```

### 2.2 Integration Points for LAN Enhancement

#### Core Service Layer Extensions
```python
# python/src/server/services/
├── discovery_service.py     # NEW: LAN service discovery
├── network_service.py       # NEW: Network topology management  
├── health_service.py        # EXTEND: Multi-node health checks
└── credential_service.py    # EXTEND: Cross-node credential sync
```

#### API Layer Enhancements
```python  
# python/src/server/api_routes/
├── internal_api.py          # EXTEND: Add LAN endpoints
├── discovery_api.py         # NEW: Service discovery API
└── admin_api.py             # EXTEND: Multi-node administration
```

#### Configuration Integration
```bash
# .env extensions (backward compatible)
ARCHON_LAN_DISCOVERY_ENABLED=false      # Feature toggle
ARCHON_LAN_PORT_RANGE=8000-8010         # Auto-allocation range
SERVICE_DISCOVERY_MODE=docker_compose   # Extend existing variable
```

### 2.3 Code Integration Strategy

#### Non-Breaking Extension Pattern
```python
# Extend existing service discovery without breaking current functionality
class ServiceDiscovery:
    def __init__(self):
        self.mode = os.getenv('SERVICE_DISCOVERY_MODE', 'local')
        self.lan_enabled = os.getenv('ARCHON_LAN_DISCOVERY_ENABLED', 'false').lower() == 'true'
    
    async def discover_services(self):
        if self.lan_enabled and self.mode == 'lan':
            return await self._discover_lan_services()
        elif self.mode == 'docker_compose':
            return await self._discover_docker_services()  # Existing
        else:
            return await self._discover_local_services()   # Existing
```

#### Database Schema Compatibility
- **No schema changes required**: LAN services use existing tables
- **Backward compatible**: All current APIs remain functional  
- **Extension approach**: Add new tables only for LAN-specific data

#### Frontend Integration Points
```typescript
// archon-ui-main/src/services/
├── discoveryService.ts      # NEW: LAN discovery UI integration
├── networkService.ts        # NEW: Network topology display
└── apiService.ts           # EXTEND: Multi-node API routing
```

### 2.4 Testing Integration

#### Existing Test Structure Preservation
```python
# python/tests/ (maintain existing structure)
├── test_api_essentials.py   # EXTEND: Add LAN endpoint tests
├── test_service_integration.py  # EXTEND: Multi-node scenarios
└── test_lan_discovery.py    # NEW: LAN-specific test suite
```

#### Development Workflow Integration
- **Local Development**: LAN discovery disabled by default
- **Testing**: Automated tests include both single-node and multi-node scenarios
- **CI/CD**: No changes to existing pipeline, add LAN validation stage

## 3. Infrastructure and Deployment Integration

### 3.1 Existing Infrastructure

#### Current Deployment Architecture
```yaml
# Primary Stack (docker-compose.yml)
services:
  archon-server:     # FastAPI backend (port 8181)
  archon-mcp:        # MCP server (port 8051)  
  archon-agents:     # AI agents (port 8052, profile-based)
  archon-frontend:   # React UI (port 3737)
networks:
  app-network:       # Bridge network for service communication
```

#### Infrastructure Tools in Use
- **Container Orchestration**: Docker Compose with profiles
- **Reverse Proxy**: Traefik (external/optional setup)
- **Service Discovery**: Docker Compose internal networking (`SERVICE_DISCOVERY_MODE=docker_compose`)
- **Health Monitoring**: Built-in Docker healthchecks for all services
- **Build System**: Multi-stage Dockerfiles with uv package manager

#### Environment Configuration
```bash
# Core Infrastructure Variables
HOST=localhost                    # Base hostname
ARCHON_SERVER_PORT=8181          # Main API port
ARCHON_MCP_PORT=8051             # MCP protocol port  
ARCHON_AGENTS_PORT=8052          # AI agents port
ARCHON_UI_PORT=3737              # Frontend port
SERVICE_DISCOVERY_MODE=docker_compose  # Network discovery mode
PROD=false                       # Production proxy mode
```

#### Current Environments
- **Development**: Local Docker Compose with hot reload
- **Production**: Same stack with PROD=true for single-port exposure
- **External Access**: Optional Traefik setup for domain routing

### 3.2 Enhancement Deployment Strategy

#### Deployment Approach: Zero-Downtime Rolling Enhancement

**Phase 1: Infrastructure Preparation**
```yaml
# New environment variables to add
ARCHON_LAN_DISCOVERY_ENABLED=true    # Feature toggle
ARCHON_LAN_PORT_RANGE=8000-8010      # Auto-port allocation
ARCHON_LAN_BROADCAST_INTERFACE=eth0  # Network interface
ARCHON_LAN_SERVICE_TIMEOUT=30        # Discovery timeout (seconds)
```

**Phase 2: Service Discovery Enhancement**
- Extend existing `SERVICE_DISCOVERY_MODE` to support `lan` mode
- Maintain backward compatibility with `docker_compose` and `local` modes
- Add graceful fallback to existing discovery when LAN fails

**Phase 3: Progressive Rollout**
1. Deploy with LAN discovery disabled by default
2. Enable per-environment via feature flag
3. Monitor service health and discovery performance
4. Full activation after validation

#### Infrastructure Changes Required

**Docker Compose Updates**:
```yaml
# Add to all services
environment:
  - ARCHON_LAN_DISCOVERY_ENABLED=${ARCHON_LAN_DISCOVERY_ENABLED:-false}
  - ARCHON_LAN_PORT_RANGE=${ARCHON_LAN_PORT_RANGE:-8000-8010}
  - ARCHON_LAN_BROADCAST_INTERFACE=${ARCHON_LAN_BROADCAST_INTERFACE:-}

# Network requirements
networks:
  app-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16  # Ensure consistent subnet for discovery
```

**Traefik Integration** (if used):
- No changes required - LAN services will register same as current
- Dynamic service discovery will work with existing router configurations
- Load balancing will automatically include discovered instances

#### Pipeline Integration

**Build Process** (unchanged):
1. Multi-stage Docker builds continue using uv
2. Health checks remain the same
3. Service dependencies preserved

**Deployment Steps**:
1. **Pre-deployment**: Validate network connectivity between nodes
2. **Deploy**: Rolling update of services with new environment variables
3. **Validate**: Check service discovery and health endpoints
4. **Activate**: Enable LAN discovery via configuration update
5. **Monitor**: Track discovery performance and service availability

### 3.3 Rollback Strategy

#### Rollback Method: Configuration-Based Instant Rollback

**Level 1: Feature Disable** (< 30 seconds)
```bash
# Instant rollback via environment variable
docker-compose exec archon-server sh -c "export ARCHON_LAN_DISCOVERY_ENABLED=false"
docker-compose restart archon-server archon-mcp archon-agents
```

**Level 2: Service Restart** (< 2 minutes)
```bash
# Restart with previous configuration
docker-compose down
docker-compose up -d
```

**Level 3: Container Rollback** (< 5 minutes)
```bash
# Roll back to previous image tag
docker-compose down
git checkout <previous-commit>
docker-compose up --build -d
```

#### Risk Mitigation

**Service Isolation**:
- LAN discovery runs in separate threads/processes
- Network failures don't affect existing service communication
- Health checks continue monitoring core functionality

**Graceful Degradation**:
```python
# Fallback mechanism in service discovery
try:
    discover_lan_services()
except NetworkError:
    logger.warning("LAN discovery failed, using docker_compose mode")
    use_docker_compose_discovery()
```

**Data Safety**:
- No database schema changes required
- No data migration needed
- Existing service configurations preserved

#### Monitoring and Validation

**Health Check Enhancements**:
```yaml
# Extended health check
healthcheck:
  test: ["CMD", "sh", "-c", "curl -f http://localhost:8181/health && curl -f http://localhost:8181/internal/lan/status"]
  interval: 30s
  timeout: 10s
  retries: 3
```

**Key Metrics to Monitor**:
- Service discovery latency (<500ms target)
- Network broadcast success rate (>95% target)
- Inter-service communication latency
- Container restart frequency
- Health check failure rates

**Rollback Triggers**:
- Service discovery failure >5 minutes
- Health check failure rate >10%
- Network connectivity loss between nodes
- Performance degradation >25% baseline

## 4. Migration Risk Assessment

*Coming next...*

## 5. Implementation Roadmap

*Coming next...*