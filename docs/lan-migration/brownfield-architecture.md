# Brownfield Architecture Analysis: LAN Migration Enhancement

## 1. Current System Assessment

### Existing Architecture Overview

#### Service Architecture
Archon V2 Alpha operates as a microservices-based knowledge management system with the following components:

**Core Services:**
- **Frontend (port 3737)**: React + TypeScript + Vite + TailwindCSS
- **Main Server (port 8181)**: FastAPI with HTTP polling for updates  
- **MCP Server (port 8051)**: Lightweight HTTP-based MCP protocol server
- **Agents Service (port 8052)**: PydanticAI agents for AI/ML operations

**Data Layer:**
- **Database**: Supabase (PostgreSQL + pgvector for embeddings)
- **Storage**: Document processing, embeddings, knowledge base

#### Technology Stack Analysis
```
Frontend: React 18.3.1, TypeScript 5.5.4, Vite 5.2.0, TailwindCSS 3.4.17
Backend: Python 3.12, FastAPI, Uvicorn, Pydantic 2.0+
Database: PostgreSQL (Supabase), pgvector for embeddings
Infrastructure: Docker Compose, uv for Python dependency management
Testing: Vitest (frontend), Pytest (backend)
Linting: ESLint + TypeScript ESLint, Ruff + Mypy
```

#### Communication Patterns
- **HTTP Polling Architecture**: Replaced Socket.IO with HTTP polling (1-2s active, 5-10s background)
- **ETag Caching**: 304 Not Modified responses reduce bandwidth by ~70%
- **Smart Pausing**: Polling stops when browser tab is inactive
- **Progress Endpoints**: Dedicated endpoints for operation status tracking

### Existing System Strengths

#### Well-Established Development Patterns
- **Microservices Decomposition**: Clear service boundaries with dedicated responsibilities
- **Type Safety**: Full TypeScript frontend, Pydantic backend models
- **Testing Infrastructure**: Comprehensive test suites (Vitest, Pytest) with coverage reporting
- **Development Tooling**: Hot reload, linting, formatting, dependency management
- **Documentation**: Detailed CLAUDE.md with development guidelines

#### Robust Data Management
- **Embedding Pipeline**: Contextual embeddings, batch processing, parallel operations
- **Document Processing**: PDF, DOCX, Markdown support with chunking strategies
- **Knowledge Base**: RAG search capabilities with pgvector integration
- **Progress Tracking**: Real-time progress reporting for long-running operations

#### Production-Ready Infrastructure
- **Containerization**: Docker Compose orchestration with service networking
- **Environment Management**: Structured configuration via .env files
- **Observability**: Logfire integration for monitoring and debugging
- **Error Handling**: Alpha-appropriate error strategies (fail fast vs. continue processing)

### Integration Complexity Assessment

#### Low Complexity Areas
- **Configuration Management**: Well-established patterns for new services
- **Database Integration**: Existing Supabase patterns easily extensible
- **API Consistency**: Clear REST endpoint conventions to follow
- **Frontend Service Layer**: Established patterns for new service integration

#### Medium Complexity Areas  
- **Service Discovery**: Requires new Docker Compose service and networking
- **Polling Integration**: Need to extend existing HTTP polling for peer status
- **Testing Strategy**: Network testing requires mock/simulation capabilities
- **Error Handling**: Network-specific error patterns need definition

#### High Complexity Areas
- **Network Infrastructure**: Host networking vs. container networking trade-offs
- **Security Boundaries**: Peer authentication and authorization mechanisms  
- **State Synchronization**: Distributed system consistency challenges
- **Performance Impact**: Network discovery overhead on existing operations

## 2. Requirements Integration Analysis

### Core LAN Migration Requirements Mapping

#### Discovery Service Requirements
```python
# Maps to existing service patterns in python/src/server/services/
class NetworkDiscoveryService:
    """
    Integrates with existing service architecture:
    - Follows same initialization patterns as credential_service
    - Uses existing Logfire integration for observability
    - Leverages Supabase client for peer persistence
    """
```

**Integration Points:**
- Service registration in `main.py` following existing patterns
- Configuration via environment variables (`.env` file)
- Health check endpoint integration (`/health` expansion)
- Logging via established `search_logger` patterns

#### Peer Communication Requirements  
```typescript
// Extends existing API service patterns in archon-ui-main/src/services/
interface PeerCommunicationService {
  // Follows same patterns as projectService, serverHealthService
  discoverPeers(): Promise<NetworkPeer[]>;
  connectToPeer(peerId: string): Promise<PeerConnection>;
  shareTo(peerId: string, items: ShareableItem[]): Promise<void>;
}
```

**Integration Points:**
- HTTP polling extension for peer status monitoring
- ETag caching support for peer discovery results  
- Error handling consistent with existing service error patterns
- React hooks following `usePolling`, `useDatabaseMutation` patterns

### Security Integration Requirements

#### Authentication Extensions
```python
# Extends existing credential_service.py patterns
class PeerAuthenticationService:
    """
    Builds on existing authentication infrastructure:
    - Leverages existing JWT token handling (python-jose)
    - Integrates with Supabase auth patterns
    - Follows existing API key management
    """
```

#### Network Security Boundaries
- **Existing**: Service-to-service communication within Docker network
- **Extension**: Host network discovery with controlled peer access
- **Integration**: Firewall rules compatible with existing port allocation

### Data Management Integration

#### Knowledge Base Sharing
```sql
-- Extends existing database schema (archon_ prefix pattern)
CREATE TABLE archon_shared_knowledge_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_peer_id VARCHAR NOT NULL,
    target_peer_id VARCHAR NOT NULL,
    knowledge_item_id UUID REFERENCES documents(id),
    shared_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR CHECK (status IN ('pending', 'accepted', 'rejected'))
);
```

**Integration Points:**
- Reuses existing `documents`, `sources` tables
- Follows established UUID primary key patterns
- Maintains existing created_at/updated_at timestamp conventions
- Leverages existing pgvector embeddings for shared content

## 3. Service Architecture Integration

### New Service Integration Strategy

#### Discovery Service Architecture
```yaml
# docker-compose.yml integration
services:
  archon-discovery:
    build:
      context: ./python
      dockerfile: Dockerfile.discovery
    container_name: archon-discovery
    ports:
      - "8053:8053"
    environment:
      - DISCOVERY_PORT=8053
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - LOGFIRE_TOKEN=${LOGFIRE_TOKEN}
    networks:
      - archon-network
    depends_on:
      - archon-server
```

**Service Integration Points:**
- **Health Checks**: Extends existing `/health` endpoint patterns
- **Logging**: Uses established Logfire integration (`safe_span` patterns)
- **Configuration**: Follows existing environment variable patterns
- **Networking**: Integrates with existing `archon-network` Docker network

#### API Gateway Integration
```python
# Extends python/src/server/main.py
from .api_routes.network_routes import network_router

app = FastAPI(title="Archon API")

# Existing routers
app.include_router(projects_router, prefix="/api")
app.include_router(knowledge_router, prefix="/api") 
app.include_router(mcp_router, prefix="/api")

# New network router integration
app.include_router(network_router, prefix="/api/network")
```

### Frontend Service Integration

#### Detailed Component Architecture

**Component Hierarchy & State Management:**
```typescript
// Core deployment management container
DeploymentPage
├── DeploymentModeSelector          // Environment switching UI
├── NetworkDiscoveryPanel           // Peer discovery interface  
│   ├── DiscoveryControls          // Start/stop discovery
│   ├── PeerGrid                   // Grid of discovered peers
│   │   └── PeerCard[]             // Individual peer display
│   └── NetworkDiagnostics         // Connection health display
├── EnvironmentConfigPanel          // Template generation UI
│   ├── ConfigurationForm          // Network settings
│   └── TemplatePreview            // Generated config preview
└── DeploymentStatusPanel          // Progress and validation
    ├── ProgressIndicator          // Real-time progress
    ├── ValidationResults          // Health check results
    └── LogStream                  // Deployment logs
```

**State Management Patterns:**
```typescript
// Global deployment state using existing patterns
interface DeploymentState {
  mode: 'local' | 'lan' | 'switching';
  discoveredPeers: NetworkPeer[];
  isDiscovering: boolean;
  activeConnections: PeerConnection[];
  networkConfig: NetworkConfiguration;
  deploymentProgress: ProgressStatus;
}

// Context provider following existing patterns
export const DeploymentContext = createContext<{
  state: DeploymentState;
  actions: DeploymentActions;
}>({} as any);

// Custom hooks following usePolling, useDatabaseMutation patterns  
export function useDeploymentMode() {
  const { data, error, mutate } = useDatabaseMutation<DeploymentMode>(
    'deployment-mode',
    '/api/deployment/mode'
  );
  return { mode: data, error, setMode: mutate };
}

export function useNetworkDiscovery() {
  const { data: peers, error, isLoading } = usePolling(
    '/api/deployment/network/peers',
    { interval: 2000, enabled: discoveryEnabled }
  );
  
  const startDiscovery = useCallback(async (options: DiscoveryOptions) => {
    // Implementation follows existing service patterns
  }, []);
  
  return { peers, error, isLoading, startDiscovery, stopDiscovery };
}
```

#### Service Layer Extensions  
```typescript
// archon-ui-main/src/services/networkService.ts
// Follows patterns established in projectService.ts, serverHealthService.ts

export class NetworkService {
  private baseUrl = '/api/network';
  
  // Consistent error handling with existing services
  async discoverPeers(): Promise<NetworkPeer[]> {
    try {
      const response = await fetch(`${this.baseUrl}/peers`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Network discovery failed:', error);
      throw error;
    }
  }
  
  // Environment template generation
  async generateTemplate(config: NetworkConfig): Promise<DeploymentTemplate> {
    const response = await fetch(`${this.baseUrl}/template/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    
    if (!response.ok) {
      throw new Error(`Template generation failed: ${response.statusText}`);
    }
    
    return response.json();
  }
}
```

#### React Hook Integration
```typescript
// Follows existing patterns: usePolling, useDatabaseMutation
export function useNetworkDiscovery() {
  // Integrates with existing polling infrastructure
  const { data: peers, error, isLoading } = usePolling(
    '/api/network/peers',
    { interval: 5000, enabled: discoveryEnabled }
  );
  
  // Consistent state management patterns
  return { peers, error, isLoading, startDiscovery, stopDiscovery };
}
```

### Database Schema Integration

#### Schema Extension Strategy
```sql
-- Follows existing archon_ table naming conventions
-- Maintains UUID primary keys, timestamptz patterns
-- Integrates with existing foreign key relationships

-- Peer registry
CREATE TABLE archon_network_peers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname VARCHAR NOT NULL,
    ip_address INET NOT NULL,
    port INTEGER NOT NULL,
    services JSONB DEFAULT '[]',
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR CHECK (status IN ('online', 'offline', 'connecting')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shared knowledge tracking  
CREATE TABLE archon_peer_knowledge_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_peer_id UUID REFERENCES archon_network_peers(id),
    target_peer_id UUID REFERENCES archon_network_peers(id),
    document_id UUID REFERENCES documents(id),
    shared_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR CHECK (status IN ('pending', 'accepted', 'rejected', 'synced')),
    metadata JSONB DEFAULT '{}'
);

-- Indexes for performance (follows existing patterns)
CREATE INDEX idx_network_peers_status ON archon_network_peers(status);
CREATE INDEX idx_network_peers_last_seen ON archon_network_peers(last_seen);
CREATE INDEX idx_peer_shares_status ON archon_peer_knowledge_shares(status);
```

**Migration Strategy:**
- Migration files follow existing `YYYYMMDD_description.sql` pattern
- Rollback procedures for each schema change
- Test data seeding follows existing test fixtures pattern

## 4. Infrastructure and Deployment Integration

### Existing Infrastructure Compatibility

#### Docker and Service Architecture
- All services currently containerized using Docker Compose
- Multi-service architecture: main server (8181), MCP (8051), agents (8052), frontend (3737)
- Service discovery via internal Docker networks
- Volume mounting for development (bind mounts for code directories)

#### Environment Configuration Management
- Uses `.env` files for configuration
- Service-specific environment variables
- Secret management via Supabase service keys
- Port configuration for service communication

### LAN Enhancement Infrastructure Requirements

#### Discovery Service Infrastructure
```yaml
# Additional service in docker-compose.yml
lan-discovery:
  build: 
    context: ./python
    dockerfile: Dockerfile.discovery
  ports:
    - "8053:8053"  # Discovery service port
  environment:
    - DISCOVERY_PORT=8053
    - NETWORK_INTERFACE=auto-detect
  networks:
    - archon-network
```

#### Network Configuration
- Broadcast subnet detection for peer discovery
- Port allocation strategy for multi-instance scenarios
- Network interface binding configuration
- mDNS/Bonjour integration points

### Deployment Strategy Integration

#### Development Environment
- Docker Compose remains primary development environment
- Local network testing capabilities
- Multi-instance simulation on single host
- Debug network discovery tools

#### Production Deployment
- Container-to-container communication preservation
- Host network mode for discovery service
- Firewall configuration guidelines
- Network security considerations

### Monitoring and Observability
- Extended Logfire integration for network metrics
- Discovery service health monitoring
- Peer connection status tracking
- Network performance monitoring

## 5. Coding Standards and Conventions

### Existing Standards Compliance

#### Python Backend Standards
```python
# Code Style Enforcement (pyproject.toml)
[tool.ruff]
line-length = 120
target-version = "py312"

[tool.ruff.lint]
select = ["E", "W", "F", "I", "B", "C4", "UP"]  # pycodestyle, pyflakes, isort, bugbear, comprehensions, pyupgrade
ignore = ["E501", "B008", "C901", "W191"]      # line-length handled separately, allow defaults, complexity

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
```

**Key Python Standards:**
- Python 3.12+ with full type hints
- 120 character line limit
- Double quotes for strings
- Space indentation (4 spaces)
- Ruff for linting and formatting
- Mypy for type checking with strict settings

#### TypeScript Frontend Standards  
```typescript
// ESLint Configuration (.eslintrc.cjs)
extends: [
  'eslint:recommended',
  '@typescript-eslint/recommended', 
  'plugin:react-hooks/recommended'
]

// TypeScript Configuration (tsconfig.json)
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

**Key TypeScript Standards:**
- Strict TypeScript with full type safety
- React functional components with hooks
- Path aliases (`@/*` for `./src/*`)
- ES2020 target with bundler module resolution
- ESLint + TypeScript ESLint integration

#### Testing Patterns
**Backend (Pytest):**
```python
# Test file naming: test_*.py
# Async test support with pytest-asyncio
# Markers: @pytest.mark.unit, @pytest.mark.integration, @pytest.mark.slow
# Mock patterns using pytest-mock

def test_network_discovery_basic(mock_supabase_client):
    """Test basic network discovery functionality."""
    # Arrange, Act, Assert pattern
    pass
```

**Frontend (Vitest):**
```typescript
// Test file naming: *.test.{ts,tsx}
// Testing Library for React components
// Mock patterns using vi.fn()

describe('LAN Peer Discovery', () => {
  it('should discover peers on local network', () => {
    // Given, When, Then pattern
  });
});
```

#### Documentation Style
- Docstrings follow Google style for Python
- JSDoc comments for complex TypeScript functions  
- Inline comments focus on "why" not "what"
- README files use consistent structure
- Code examples include error handling

### Enhancement-Specific Standards

#### Network Service Patterns
```python
# Network service base class pattern
class NetworkServiceBase:
    """Base class for all network-related services."""
    
    def __init__(self, logger: Logger, config: NetworkConfig):
        self.logger = logger
        self.config = config
        self._is_running = False
    
    async def start(self) -> None:
        """Start the network service."""
        raise NotImplementedError
    
    async def stop(self) -> None:
        """Stop the network service."""
        self._is_running = False
    
    @property
    def is_running(self) -> bool:
        """Check if service is currently running."""
        return self._is_running
```

#### Peer Discovery Conventions
```typescript
// Peer interface standardization
interface NetworkPeer {
  id: string;
  hostname: string;
  ip_address: string;
  port: number;
  services: PeerService[];
  last_seen: Date;
  status: 'online' | 'offline' | 'connecting';
  metadata: PeerMetadata;
}

// Event naming for peer discovery
type PeerDiscoveryEvent = 
  | 'peer-discovered'
  | 'peer-lost' 
  | 'peer-updated'
  | 'discovery-started'
  | 'discovery-stopped';
```

#### Configuration Management
```python
# Network configuration using Pydantic models
from pydantic import BaseModel, Field, validator

class NetworkDiscoveryConfig(BaseModel):
    """Network discovery service configuration."""
    
    enabled: bool = Field(default=True, description="Enable network discovery")
    port: int = Field(default=8053, ge=1024, le=65535)
    broadcast_interval: int = Field(default=30, ge=5, le=300)  # seconds
    peer_timeout: int = Field(default=120, ge=30, le=600)      # seconds
    
    @validator('port')
    def port_not_in_use_by_other_services(cls, v):
        """Ensure discovery port doesn't conflict with existing services."""
        reserved_ports = {8181, 8051, 8052, 3737}
        if v in reserved_ports:
            raise ValueError(f'Port {v} is reserved by another service')
        return v
```

### Critical Integration Rules

#### API Compatibility Requirements
```python
# All new endpoints must follow existing patterns
@router.post("/api/network/peers", response_model=List[NetworkPeer])
async def list_network_peers(
    request: Request,
    include_offline: bool = Query(False, description="Include offline peers")
) -> List[NetworkPeer]:
    """List discovered network peers."""
    # Implementation follows existing error handling patterns
    pass

# Maintain ETag support for polling endpoints
@router.get("/api/network/discovery/status")
async def get_discovery_status(
    request: Request,
    if_none_match: str = Header(None)
) -> Response:
    """Get network discovery status with ETag support."""
    # ETag implementation consistent with existing patterns
    pass
```

#### Database Integration Standards
```python
# Database schema follows existing conventions
"""
Network discovery tables follow archon_ prefix pattern:
- archon_network_peers
- archon_network_discovery_logs
- archon_peer_services

All tables include:
- id (UUID primary key)
- created_at (timestamptz)
- updated_at (timestamptz)
"""

# Migration file naming: YYYYMMDD_add_network_discovery.sql
# Use existing Supabase client patterns
async def store_discovered_peer(client, peer: NetworkPeer) -> str:
    """Store discovered peer using established Supabase patterns."""
    result = await client.table('archon_network_peers').upsert({
        'id': peer.id,
        'hostname': peer.hostname,
        'ip_address': peer.ip_address,
        'port': peer.port,
        'services': [service.dict() for service in peer.services],
        'last_seen': peer.last_seen.isoformat(),
        'status': peer.status,
        'metadata': peer.metadata.dict() if peer.metadata else {}
    }).execute()
    return result.data[0]['id']
```

#### Error Handling Consistency
```python
# Network-specific exceptions follow existing patterns
class NetworkDiscoveryError(Exception):
    """Base exception for network discovery errors."""
    
    def __init__(self, message: str, peer_id: str = None, **kwargs):
        self.peer_id = peer_id
        self.metadata = kwargs
        super().__init__(message)

class PeerConnectionError(NetworkDiscoveryError):
    """Failed to connect to discovered peer."""
    pass

class DiscoveryServiceError(NetworkDiscoveryError):
    """Network discovery service failure."""
    pass

# Error handling follows alpha principles:
# - Fail fast for service startup issues
# - Continue processing other peers if one fails
# - Detailed logging with context
```

#### Logging Consistency  
```python
# Use existing search_logger for consistency
from ...config.logfire_config import safe_span, search_logger

async def discover_network_peers() -> List[NetworkPeer]:
    """Discover peers on local network."""
    with safe_span("discover_network_peers") as span:
        search_logger.info("Starting network peer discovery", 
                          network_interface=interface, 
                          timeout=discovery_timeout)
        
        discovered_peers = []
        failed_connections = []
        
        try:
            # Discovery logic
            peers = await scan_network_for_peers()
            
            for peer_addr in peers:
                try:
                    peer = await connect_and_identify_peer(peer_addr)
                    discovered_peers.append(peer)
                    search_logger.info("Peer discovered successfully",
                                     peer_id=peer.id,
                                     peer_hostname=peer.hostname)
                except PeerConnectionError as e:
                    failed_connections.append({
                        'peer_address': peer_addr,
                        'error': str(e)
                    })
                    search_logger.warning("Failed to connect to peer",
                                        peer_address=peer_addr,
                                        error=str(e))
            
            span.set_attribute("discovered_peers_count", len(discovered_peers))
            span.set_attribute("failed_connections_count", len(failed_connections))
            
            return discovered_peers
            
        except Exception as e:
            search_logger.error("Network discovery failed", 
                              error=str(e), 
                              exc_info=True)
            raise DiscoveryServiceError(f"Network discovery failed: {e}") from e
```

#### Frontend Integration Standards
```typescript
// Service layer follows existing patterns
class NetworkDiscoveryService {
  private baseUrl: string;
  
  constructor(baseUrl: string = '/api') {
    this.baseUrl = baseUrl;
  }
  
  // Follow existing service method patterns
  async getDiscoveredPeers(includeOffline = false): Promise<NetworkPeer[]> {
    try {
      const response = await fetch(`${this.baseUrl}/network/peers?include_offline=${includeOffline}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch peers: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error fetching discovered peers:', error);
      throw error;
    }
  }
}

// Hook patterns follow existing conventions
export function useNetworkDiscovery() {
  const [peers, setPeers] = useState<NetworkPeer[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Implementation follows usePolling patterns
  // Error handling consistent with other hooks
  
  return {
    peers,
    isDiscovering, 
    error,
    startDiscovery,
    stopDiscovery,
    refreshPeers
  };
}
```

## 5.5. Accessibility Requirements for Network Interfaces

### WCAG 2.1 AA Compliance Standards

#### Network Discovery UI Accessibility
```typescript
// Accessible peer discovery components
export function PeerDiscoveryPanel() {
  return (
    <section 
      role="region" 
      aria-labelledby="discovery-heading"
      aria-describedby="discovery-description"
    >
      <h2 id="discovery-heading">Network Peer Discovery</h2>
      <p id="discovery-description">
        Discover and connect to Archon instances on your local network
      </p>
      
      {/* Discovery controls with proper labeling */}
      <div role="group" aria-labelledby="discovery-controls">
        <h3 id="discovery-controls">Discovery Controls</h3>
        <button
          aria-describedby="start-discovery-help"
          onClick={startDiscovery}
          disabled={isDiscovering}
        >
          {isDiscovering ? 'Discovering...' : 'Start Discovery'}
        </button>
        <div id="start-discovery-help" className="sr-only">
          Scan the local network for available Archon peers
        </div>
      </div>
      
      {/* Live region for discovery status */}
      <div aria-live="polite" aria-atomic="true">
        {discoveryStatus && (
          <p role="status">{discoveryStatus}</p>
        )}
      </div>
    </section>
  );
}
```

#### Peer Management Accessibility Features
**Required ARIA Implementation:**
- **Live Regions**: Discovery progress updates announced to screen readers
- **Role Attribution**: Proper semantic roles for network status indicators
- **Keyboard Navigation**: Full keyboard support for all peer management actions
- **Focus Management**: Logical focus flow through discovery and connection workflows
- **Status Announcements**: Connection state changes announced via `aria-live`

```typescript
// Accessible peer card component
export function PeerCard({ peer, onConnect, onDisconnect }: PeerCardProps) {
  const statusId = `peer-${peer.id}-status`;
  const actionsId = `peer-${peer.id}-actions`;
  
  return (
    <article 
      className="peer-card"
      aria-labelledby={`peer-${peer.id}-name`}
      aria-describedby={statusId}
    >
      <h3 id={`peer-${peer.id}-name`}>
        {peer.hostname}
      </h3>
      
      {/* Connection status with appropriate ARIA */}
      <div id={statusId} role="status" aria-live="polite">
        <span 
          className={`status-indicator ${peer.status}`}
          aria-label={`Connection status: ${peer.status}`}
        >
          {peer.status}
        </span>
      </div>
      
      {/* Keyboard accessible actions */}
      <div id={actionsId} role="group" aria-label="Peer actions">
        <button 
          onClick={() => onConnect(peer.id)}
          aria-describedby={`connect-help-${peer.id}`}
        >
          Connect
        </button>
        <div id={`connect-help-${peer.id}`} className="sr-only">
          Establish connection to {peer.hostname}
        </div>
      </div>
    </article>
  );
}
```

#### Visual Accessibility Requirements
**Color and Contrast:**
- Connection status indicators must not rely solely on color
- Minimum 4.5:1 contrast ratio for all text elements
- High contrast mode support for network diagrams

**Motion and Animation:**
- Reduced motion support for discovery scanning animations
- Disable auto-refresh when `prefers-reduced-motion` detected
- Optional static view for network topology displays

#### Screen Reader Optimization
**Content Structure:**
- Proper heading hierarchy for network configuration sections
- Descriptive link text for peer connection actions
- Table headers for network peer listings
- Form field labels and error associations

```typescript
// Screen reader optimized peer table
export function PeerTable({ peers }: { peers: NetworkPeer[] }) {
  return (
    <table role="table" aria-label="Discovered network peers">
      <thead>
        <tr>
          <th scope="col" id="hostname">Hostname</th>
          <th scope="col" id="ip">IP Address</th>
          <th scope="col" id="status">Status</th>
          <th scope="col" id="services">Services</th>
          <th scope="col" id="actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {peers.map(peer => (
          <tr key={peer.id}>
            <th scope="row" headers="hostname">{peer.hostname}</th>
            <td headers="ip">{peer.ip_address}</td>
            <td headers="status">
              <span aria-label={`Status: ${peer.status}`}>
                {peer.status}
              </span>
            </td>
            <td headers="services">
              {peer.services.join(', ')}
            </td>
            <td headers="actions">
              <button 
                aria-label={`Connect to ${peer.hostname}`}
                onClick={() => connectToPeer(peer.id)}
              >
                Connect
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

## 6. Risk Assessment and Mitigation Strategies

### High-Risk Areas

#### Network Security and Trust
**Risk**: Peer authentication and data security in LAN environment
**Impact**: High - Potential for unauthorized access to knowledge base
**Mitigation Strategies:**
- Certificate-based peer authentication
- Encrypted peer-to-peer communication (TLS 1.3)
- Configurable trust levels (trusted network vs. open discovery)
- Rate limiting on peer connections
- Audit logging for all peer interactions

#### State Synchronization Complexity  
**Risk**: Distributed system consistency challenges across peers
**Impact**: High - Data corruption or conflicts in shared knowledge
**Mitigation Strategies:**
- Read-only sharing model (no distributed writes initially)
- Version vector tracking for conflict detection
- Eventual consistency model with clear conflict resolution
- Rollback capabilities for failed synchronization
- Comprehensive integration testing with multiple peers

#### Performance Impact on Existing System
**Risk**: Network discovery overhead affecting current operations  
**Impact**: Medium - Potential degradation of existing functionality
**Mitigation Strategies:**
- Configurable discovery intervals (default: conservative 30s)
- Background threading for network operations
- Circuit breaker pattern for failing peers
- Resource usage monitoring and alerting
- Graceful degradation when network features disabled

### Medium-Risk Areas

#### Service Discovery Reliability
**Risk**: Network discovery service reliability and peer detection accuracy
**Impact**: Medium - Inconsistent peer visibility, connection failures
**Mitigation Strategies:**
- Multiple discovery mechanisms (broadcast + mDNS)
- Exponential backoff for failed connections  
- Peer timeout and reconnection logic
- Health check integration for service status
- Comprehensive logging for troubleshooting

#### Development Environment Complexity
**Risk**: Increased complexity in local development setup
**Impact**: Medium - Developer productivity impact
**Mitigation Strategies:**
- Docker Compose integration maintains existing workflow
- Mock network services for testing
- Single-instance development mode
- Clear documentation and setup scripts
- Gradual rollout with feature flags

### Low-Risk Areas

#### Configuration Management
**Risk**: Configuration complexity for network settings
**Impact**: Low - Manageable through existing patterns
**Mitigation**: Follow existing .env patterns, provide sensible defaults

#### Testing Strategy Integration  
**Risk**: Network testing complexity
**Impact**: Low - Can be managed with proper mocking
**Mitigation**: Mock services for unit tests, Docker network for integration tests

## 7. Implementation Roadmap

### Phase 1: Foundation Implementation Plan (Weeks 1-2)
**Objective**: Establish deployment mode switching and network discovery infrastructure

#### Week 1: Core Infrastructure
**Sprint 1.1: Environment & Configuration (Days 1-2)**
```bash
# Implementation tasks in priority order
1. Create environment templates (.env.local, .env.lan) 
2. Implement DeploymentModeManager service
3. Add deployment mode API endpoints (/api/deployment/mode)
4. Create environment variable validation system
5. Update Docker Compose with conditional configurations

# Acceptance criteria:
✓ Environment switching working via API calls
✓ Docker services start in both local and LAN modes  
✓ Configuration validation prevents invalid states
✓ Health checks include deployment mode status
```

**Sprint 1.2: Database & Models (Days 3-4)**
```sql
-- Schema implementation priority
1. Add deployment configuration to archon_settings table
2. Create network peer tracking tables (archon_network_peers)
3. Implement configuration persistence services
4. Add database migration scripts
5. Create data access layer for network configuration

-- Validation requirements:
✓ All tables follow existing archon_ naming conventions
✓ UUID primary keys and timestamp patterns maintained
✓ No breaking changes to existing schema
✓ Migration rollback procedures tested
```

**Sprint 1.3: Service Architecture (Days 5-7)**
```python
# Service implementation order
1. NetworkDiscoveryService (python/src/server/services/deployment/)
2. Docker orchestration service integration  
3. Health monitoring extensions for network services
4. Service registration in main FastAPI app
5. Background task integration for periodic discovery

# Success metrics:
✓ Services follow existing singleton factory patterns
✓ Logging integration with Logfire established
✓ Error handling follows alpha development principles  
✓ Service discovery integrates with existing Docker networking
```

#### Week 2: API Integration & Testing
**Sprint 1.4: API Development (Days 8-10)**
```python
# API endpoint implementation priority
1. /api/deployment/mode (GET/POST) - mode management
2. /api/deployment/network/discover - trigger network scanning  
3. /api/deployment/network/peers - list discovered peers
4. /api/deployment/health/services - network health status
5. Progress tracking integration for long-running operations

# Integration requirements:
✓ Follow existing FastAPI router patterns (/api/ prefix)
✓ Pydantic request/response models with full type safety
✓ ETag caching support for polling endpoints
✓ Consistent error handling with existing endpoints
```

**Sprint 1.5: Testing & Documentation (Days 11-12)**
```bash
# Testing implementation priorities
1. Unit tests for NetworkDiscoveryService
2. API endpoint tests with mock network scenarios
3. Docker Compose multi-instance testing setup
4. Integration tests for deployment mode switching
5. Performance impact testing on existing functionality

# Documentation deliverables:
✓ API documentation for new endpoints
✓ Development environment setup guide
✓ Network testing procedures and troubleshooting
✓ Deployment mode switching user guide
```

**Sprint 1.6: Integration & Validation (Days 13-14)**
```yaml
# Final integration checklist
Infrastructure:
  - ✓ Docker Compose conditional configuration working
  - ✓ Environment variable switching < 30 seconds
  - ✓ Health checks passing in both deployment modes
  - ✓ Service discovery working with existing patterns

Backend Services:
  - ✓ NetworkDiscoveryService operational and stable
  - ✓ Database integration following existing patterns
  - ✓ API endpoints functional with proper error handling
  - ✓ Background tasks not impacting existing performance

Testing & Quality:
  - ✓ Unit test coverage > 80% for new components
  - ✓ Integration tests passing with multi-instance setup
  - ✓ No regression in existing API response times
  - ✓ Memory usage within projected limits (< 50MB additional)
```

#### Phase 1 Success Criteria & Handoff
**Deployment Ready Checklist:**
- ✅ Deployment mode switching functional via environment variables
- ✅ Network discovery service discovering and persisting peers  
- ✅ Docker Compose integration maintains existing development workflow
- ✅ Database schema extensions deployed without breaking changes
- ✅ API endpoints operational with comprehensive error handling
- ✅ Health checks validate both local and LAN deployment modes
- ✅ Testing infrastructure supports multi-instance scenarios
- ✅ Documentation enables developer onboarding and troubleshooting

**Performance Validation:**
- API response times: No degradation > 10% for existing endpoints
- Memory overhead: Additional usage < 50MB for network services  
- Discovery latency: Network scan completes within 30 seconds
- Service startup: No increase in container startup time
- Database impact: No performance degradation on existing queries

**Developer Experience:**
- Existing development commands (uv run, npm run dev) unchanged
- New testing commands documented and functional  
- IDE debugging configuration for network services
- Clear error messages for configuration issues
- Rollback procedures tested and documented

### Phase 2: API and Frontend Integration (Weeks 3-4)
**Objective**: Integrate network features with existing UI

**Deliverables:**
- REST API endpoints for peer management
- Frontend service layer integration
- React components for peer discovery
- HTTP polling integration for peer status
- Error handling and user feedback

**Success Criteria:**
- UI displays discovered peers with real-time updates
- Consistent error handling across network operations
- ETag caching working for peer status endpoints
- Responsive UI with proper loading states

### Phase 3: Knowledge Sharing Foundation (Weeks 5-6)
**Objective**: Basic peer-to-peer knowledge sharing

**Deliverables:**  
- Peer communication protocols
- Knowledge item sharing API
- Security framework implementation
- Basic conflict resolution
- Audit logging for peer interactions

**Success Criteria:**
- Successful knowledge item transfer between peers
- Security mechanisms prevent unauthorized access
- All peer interactions logged for audit
- No data corruption in knowledge base

### Phase 4: Production Readiness (Weeks 7-8)
**Objective**: Performance optimization and production deployment

**Deliverables:**
- Performance optimization and monitoring
- Production deployment configuration
- Documentation and operational guides
- Migration guides for existing installations
- Rollback procedures and disaster recovery

**Success Criteria:**
- Network features perform within acceptable overhead limits
- Production deployment successful without service disruption
- Complete operational documentation
- Successful rollback testing

## 7.5. Development Environment Setup for Network Testing

### Local Network Testing Environment

#### Multi-Instance Docker Setup
```yaml
# docker-compose.network-test.yml
version: '3.8'
services:
  archon-coordinator:
    build: ./python
    container_name: archon-coordinator
    environment:
      - DEPLOYMENT_MODE=lan
      - ENABLE_TRAEFIK=false
      - INSTANCE_ID=coordinator
      - ARCHON_SERVER_PORT=8181
    ports:
      - "8181:8181"    # Main server
      - "8051:8051"    # MCP server
      - "3737:3737"    # Frontend
    networks:
      test-network:
        ipv4_address: 172.20.0.10
    volumes:
      - ./python:/app/python
      - ./archon-ui-main:/app/frontend

  archon-node-1:
    build: ./python
    container_name: archon-node-1
    environment:
      - DEPLOYMENT_MODE=lan
      - ENABLE_TRAEFIK=false
      - INSTANCE_ID=node-1
      - ARCHON_SERVER_PORT=8182
      - COORDINATOR_URL=http://172.20.0.10:8181
    ports:
      - "8182:8182"
      - "8052:8051"    # MCP server
      - "3738:3737"    # Frontend
    networks:
      test-network:
        ipv4_address: 172.20.0.11
    depends_on:
      - archon-coordinator

  archon-node-2:
    build: ./python
    container_name: archon-node-2
    environment:
      - DEPLOYMENT_MODE=lan
      - ENABLE_TRAEFIK=false
      - INSTANCE_ID=node-2
      - ARCHON_SERVER_PORT=8183
      - COORDINATOR_URL=http://172.20.0.10:8181
    ports:
      - "8183:8183"
      - "8053:8051"    # MCP server
      - "3739:3737"    # Frontend
    networks:
      test-network:
        ipv4_address: 172.20.0.12
    depends_on:
      - archon-coordinator

networks:
  test-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
          gateway: 172.20.0.1
```

#### Development Testing Commands
```bash
# Start multi-instance test environment
make network-test-start() {
  docker-compose -f docker-compose.network-test.yml up -d
  echo "✅ Multi-instance environment started:"
  echo "   Coordinator: http://localhost:8181"
  echo "   Node 1:      http://localhost:8182" 
  echo "   Node 2:      http://localhost:8183"
}

# Monitor network discovery logs
make network-test-logs() {
  docker-compose -f docker-compose.network-test.yml logs -f --tail=100
}

# Test network connectivity
make network-test-connectivity() {
  echo "Testing peer discovery between instances..."
  
  # Test coordinator can reach nodes
  curl -s http://localhost:8181/api/deployment/network/peers | jq .
  
  # Test nodes can reach coordinator
  curl -s http://localhost:8182/api/deployment/health/services | jq .
  curl -s http://localhost:8183/api/deployment/health/services | jq .
}

# Cleanup test environment
make network-test-clean() {
  docker-compose -f docker-compose.network-test.yml down -v
  docker network prune -f
}
```

#### Local Network Simulation Scripts
```python
# scripts/simulate_network_peers.py
"""Simulate network peers for testing discovery functionality."""
import asyncio
import aiohttp
from aiohttp import web
import json

class MockPeerSimulator:
    """Simulate Archon peers for testing."""
    
    def __init__(self, peer_id: str, port: int):
        self.peer_id = peer_id
        self.port = port
        self.app = web.Application()
        self._setup_routes()
    
    def _setup_routes(self):
        """Setup mock API endpoints."""
        self.app.router.add_get('/health', self.health_check)
        self.app.router.add_get('/api/deployment/mode', self.get_deployment_mode)
        self.app.router.add_get('/api/network/peers', self.get_peers)
    
    async def health_check(self, request):
        """Mock health check endpoint."""
        return web.json_response({
            'status': 'healthy',
            'peer_id': self.peer_id,
            'services': ['knowledge', 'mcp'],
            'version': '2.0.0-test'
        })
    
    async def get_deployment_mode(self, request):
        """Mock deployment mode endpoint."""
        return web.json_response({
            'mode': 'lan',
            'peer_id': self.peer_id,
            'is_configured': True
        })
    
    async def get_peers(self, request):
        """Mock peer listing endpoint."""
        return web.json_response([
            {
                'id': self.peer_id,
                'hostname': f'test-peer-{self.peer_id}',
                'ip_address': '172.20.0.10',
                'port': self.port,
                'status': 'online',
                'services': ['knowledge', 'mcp'],
                'last_seen': '2025-01-09T12:00:00Z'
            }
        ])
    
    async def start_server(self):
        """Start the mock peer server."""
        runner = web.AppRunner(self.app)
        await runner.setup()
        site = web.TCPSite(runner, 'localhost', self.port)
        await site.start()
        print(f"Mock peer {self.peer_id} started on port {self.port}")

# Usage example
async def main():
    """Start multiple mock peers for testing."""
    peers = [
        MockPeerSimulator('peer-1', 8191),
        MockPeerSimulator('peer-2', 8192),
        MockPeerSimulator('peer-3', 8193)
    ]
    
    # Start all mock peers
    await asyncio.gather(*[peer.start_server() for peer in peers])
    
    print("Mock peers running. Press Ctrl+C to stop.")
    try:
        await asyncio.sleep(float('inf'))
    except KeyboardInterrupt:
        print("Shutting down mock peers...")

if __name__ == '__main__':
    asyncio.run(main())
```

#### Network Testing Utilities
```python
# tests/utils/network_test_helpers.py
"""Utilities for network testing scenarios."""
import asyncio
import docker
import pytest
from typing import List, Dict

class NetworkTestManager:
    """Manage network testing environment."""
    
    def __init__(self):
        self.client = docker.from_env()
        self.test_network_name = 'archon-test-network'
        self.running_containers = []
    
    async def setup_test_network(self) -> str:
        """Create isolated test network."""
        try:
            network = self.client.networks.get(self.test_network_name)
            network.remove()  # Clean up existing
        except docker.errors.NotFound:
            pass
        
        network = self.client.networks.create(
            self.test_network_name,
            driver='bridge',
            ipam=docker.types.IPAMConfig(
                pool_configs=[
                    docker.types.IPAMPool(subnet='172.25.0.0/16')
                ]
            )
        )
        return network.id
    
    async def start_archon_instance(
        self, 
        instance_id: str, 
        ip_address: str,
        ports: Dict[int, int] = None
    ) -> str:
        """Start Archon instance for testing."""
        
        container = self.client.containers.run(
            'archon:test',
            name=f'archon-test-{instance_id}',
            environment={
                'INSTANCE_ID': instance_id,
                'DEPLOYMENT_MODE': 'lan',
                'ENABLE_TRAEFIK': 'false',
            },
            ports=ports or {},
            networks=[self.test_network_name],
            detach=True,
            remove=True
        )
        
        # Connect to network with specific IP
        network = self.client.networks.get(self.test_network_name)
        network.connect(container.id, ipv4_address=ip_address)
        
        self.running_containers.append(container)
        return container.id
    
    async def test_peer_discovery(self, coordinator_ip: str) -> List[Dict]:
        """Test peer discovery functionality."""
        import aiohttp
        
        async with aiohttp.ClientSession() as session:
            # Wait for coordinator to be ready
            await asyncio.sleep(5)
            
            # Trigger peer discovery
            async with session.post(f'http://{coordinator_ip}:8181/api/deployment/network/discover') as resp:
                discovery_result = await resp.json()
            
            # Wait for discovery to complete
            await asyncio.sleep(10)
            
            # Get discovered peers
            async with session.get(f'http://{coordinator_ip}:8181/api/deployment/network/peers') as resp:
                peers = await resp.json()
            
            return peers
    
    async def cleanup(self):
        """Clean up test environment."""
        # Stop all test containers
        for container in self.running_containers:
            try:
                container.stop(timeout=10)
            except Exception:
                pass
        
        # Remove test network
        try:
            network = self.client.networks.get(self.test_network_name)
            network.remove()
        except docker.errors.NotFound:
            pass

@pytest.fixture
async def network_test_env():
    """Pytest fixture for network testing."""
    manager = NetworkTestManager()
    await manager.setup_test_network()
    
    yield manager
    
    await manager.cleanup()
```

#### IDE Configuration for Network Testing
```json
// .vscode/launch.json - Network testing debug configurations
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Network Discovery Service",
      "type": "python",
      "request": "launch",
      "program": "${workspaceFolder}/python/src/server/services/deployment/network_discovery_service.py",
      "env": {
        "PYTHONPATH": "${workspaceFolder}/python/src",
        "DEPLOYMENT_MODE": "lan",
        "NETWORK_INTERFACE": "auto-detect",
        "LOG_LEVEL": "DEBUG"
      },
      "console": "integratedTerminal"
    },
    {
      "name": "Debug Multi-Instance Network Test",
      "type": "python",
      "request": "launch",
      "program": "${workspaceFolder}/scripts/simulate_network_peers.py",
      "env": {
        "PYTHONPATH": "${workspaceFolder}/python/src",
        "LOG_LEVEL": "DEBUG"
      },
      "console": "integratedTerminal"
    }
  ]
}
```

#### Troubleshooting Network Issues
```bash
# Common network testing troubleshooting commands
alias archon-network-debug="
echo '🔍 Network Testing Debug Commands:'
echo '=================================='
echo ''
echo '📊 Container Status:'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ''
echo '🌐 Network Information:'
docker network ls | grep archon
echo ''
echo '🔗 Container Network Details:'
docker inspect archon-coordinator | jq '.[0].NetworkSettings.Networks'
echo ''
echo '📡 Port Connectivity:'
netstat -tlnp | grep -E ':(8181|8182|8183|8051|8052|8053)'
echo ''
echo '🚀 Health Checks:'
curl -s http://localhost:8181/health | jq .
curl -s http://localhost:8182/health | jq .
curl -s http://localhost:8183/health | jq .
"
```

## 8. Testing Strategy

### Unit Testing Approach

#### Backend Network Services
```python
# Test isolation using mocks
@pytest.fixture
def mock_network_scanner():
    with mock.patch('socket.socket') as mock_socket:
        yield mock_socket

def test_peer_discovery_basic_scan(mock_network_scanner):
    """Test basic network scanning functionality."""
    # Arrange
    mock_peers = [('192.168.1.100', 8181), ('192.168.1.101', 8181)]
    mock_network_scanner.return_value.sendto.return_value = None
    
    # Act
    discovered = scan_network_for_archon_peers('192.168.1.0/24')
    
    # Assert
    assert len(discovered) == 2
    assert all(isinstance(peer, NetworkPeer) for peer in discovered)
```

#### Frontend Network Components
```typescript
// Component testing with mocked services
describe('PeerDiscoveryPanel', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([mockNetworkPeer])
    });
  });

  it('should display discovered peers', async () => {
    render(<PeerDiscoveryPanel />);
    
    await waitFor(() => {
      expect(screen.getByText('192.168.1.100')).toBeInTheDocument();
    });
  });
});
```

### Integration Testing Strategy

#### Multi-Service Network Testing
```python
@pytest.mark.integration
async def test_peer_discovery_end_to_end(test_app, mock_supabase):
    """Test complete peer discovery workflow."""
    # Start discovery service
    discovery_service = NetworkDiscoveryService(config=test_config)
    await discovery_service.start()
    
    # Simulate peer announcement
    await simulate_peer_broadcast('192.168.1.100', 8181)
    
    # Verify peer registration
    response = await test_app.get('/api/network/peers')
    assert response.status_code == 200
    peers = response.json()
    assert len(peers) == 1
    assert peers[0]['ip_address'] == '192.168.1.100'
```

#### Docker Network Testing
```yaml
# docker-compose.test.yml
version: '3.8'
services:
  archon-server-1:
    build: ./python
    environment:
      - INSTANCE_ID=server-1
    networks:
      test-network:
        ipv4_address: 172.20.0.10
        
  archon-server-2:  
    build: ./python
    environment:
      - INSTANCE_ID=server-2
    networks:
      test-network:
        ipv4_address: 172.20.0.11

networks:
  test-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### Performance Testing Requirements

#### Network Discovery Performance
- **Peer Detection Time**: < 30 seconds for local network scan
- **Memory Overhead**: < 50MB additional memory usage
- **CPU Impact**: < 5% additional CPU usage during discovery
- **Network Bandwidth**: < 100KB/s for discovery traffic

#### Existing System Impact Testing
- **API Response Time**: No degradation > 10% for existing endpoints
- **Database Performance**: No impact on existing query performance
- **Frontend Responsiveness**: No UI lag during network operations
- **Resource Utilization**: Network features gracefully degrade under load

### Security Testing Approach

#### Peer Authentication Testing
```python
@pytest.mark.security
async def test_unauthorized_peer_rejection():
    """Verify that peers without valid credentials are rejected."""
    # Attempt connection with invalid certificate
    with pytest.raises(PeerAuthenticationError):
        await connect_to_peer('192.168.1.100', invalid_cert=True)

@pytest.mark.security  
async def test_encrypted_communication():
    """Verify all peer communication is encrypted."""
    connection = await establish_peer_connection('192.168.1.100')
    assert connection.is_encrypted
    assert connection.tls_version >= '1.3'
```

#### Data Integrity Testing
```python
@pytest.mark.security
async def test_knowledge_sharing_integrity():
    """Verify shared knowledge maintains integrity."""
    original_doc = create_test_document()
    shared_doc = await share_document_to_peer(original_doc, peer_id='test-peer')
    
    # Verify content integrity
    assert shared_doc.content_hash == original_doc.content_hash
    assert shared_doc.metadata['shared_from'] == 'local-instance'
    assert 'signature' in shared_doc.metadata
```

## 9. Performance Considerations

### Current System Performance Baseline

#### Existing Performance Characteristics
- **API Response Times**: 50-200ms for typical knowledge queries
- **Database Operations**: Sub-second for most operations
- **Document Processing**: 1-5 seconds per document depending on size
- **Memory Usage**: ~500MB baseline for all services
- **CPU Utilization**: 10-20% during normal operations

### Network Enhancement Performance Impact

#### Network Discovery Overhead
```python
# Performance monitoring integration
from ...config.logfire_config import safe_span

async def discover_network_peers_with_monitoring() -> List[NetworkPeer]:
    with safe_span("network_peer_discovery", 
                   network_interface=interface,
                   discovery_timeout=timeout) as span:
        start_time = time.time()
        
        try:
            peers = await scan_network_for_peers()
            
            # Performance metrics
            span.set_attribute("discovery_duration_ms", (time.time() - start_time) * 1000)
            span.set_attribute("peers_discovered_count", len(peers))
            span.set_attribute("network_bandwidth_used_kb", get_network_usage())
            
            return peers
        except Exception as e:
            span.record_exception(e)
            raise
```

**Projected Impact:**
- **Additional Memory**: 30-50MB for network service
- **CPU Overhead**: 2-5% during discovery operations  
- **Network Bandwidth**: 10-50KB for typical discovery cycle
- **Discovery Latency**: 5-30 seconds depending on network size

#### Peer Communication Performance
```python
# Asynchronous peer operations to minimize blocking
async def share_knowledge_batch(peer_id: str, items: List[KnowledgeItem]) -> Dict[str, Any]:
    """Share multiple knowledge items efficiently."""
    
    # Batch processing to reduce network round trips
    batches = chunk_items(items, batch_size=10)
    results = []
    
    async with asyncio.Semaphore(5):  # Limit concurrent connections
        for batch in batches:
            batch_result = await share_knowledge_batch_to_peer(peer_id, batch)
            results.append(batch_result)
    
    return aggregate_results(results)
```

**Performance Targets:**
- **Peer Connection Establishment**: < 2 seconds
- **Knowledge Item Transfer**: < 100KB/s sustainable transfer rate
- **Concurrent Peer Connections**: Support 5-10 active peer connections
- **Background Operations**: No blocking of main application functionality

### Optimization Strategies

#### Resource Management
```python
# Connection pooling for peer communications
class PeerConnectionPool:
    def __init__(self, max_connections_per_peer: int = 3):
        self._pools: Dict[str, aiohttp.ClientSession] = {}
        self._max_connections = max_connections_per_peer
    
    async def get_connection(self, peer_id: str) -> aiohttp.ClientSession:
        if peer_id not in self._pools:
            connector = aiohttp.TCPConnector(limit_per_host=self._max_connections)
            self._pools[peer_id] = aiohttp.ClientSession(connector=connector)
        
        return self._pools[peer_id]
    
    async def close_all(self):
        for session in self._pools.values():
            await session.close()
        self._pools.clear()
```

#### Intelligent Caching
```python
# Cache peer discovery results to reduce network scanning
from functools import lru_cache
from datetime import datetime, timedelta

class PeerDiscoveryCache:
    def __init__(self, cache_duration: timedelta = timedelta(minutes=5)):
        self._cache: Dict[str, Tuple[List[NetworkPeer], datetime]] = {}
        self._cache_duration = cache_duration
    
    async def get_or_discover_peers(self, network_segment: str) -> List[NetworkPeer]:
        now = datetime.now()
        
        if network_segment in self._cache:
            peers, cached_at = self._cache[network_segment]
            if now - cached_at < self._cache_duration:
                return peers
        
        # Cache miss - perform discovery
        peers = await discover_peers_in_network_segment(network_segment)
        self._cache[network_segment] = (peers, now)
        return peers
```

#### Monitoring and Alerting
```python
# Performance monitoring integration
async def monitor_network_performance():
    """Monitor network enhancement performance impact."""
    
    metrics = {
        'discovery_operations_per_minute': await get_discovery_rate(),
        'peer_connections_active': await get_active_peer_count(),
        'network_bandwidth_usage_mbps': await get_network_usage(),
        'discovery_service_memory_mb': await get_service_memory_usage(),
        'discovery_service_cpu_percent': await get_service_cpu_usage(),
    }
    
    # Alert if performance thresholds exceeded
    if metrics['discovery_service_memory_mb'] > 100:
        search_logger.warning("Network discovery memory usage high", **metrics)
    
    if metrics['discovery_service_cpu_percent'] > 10:
        search_logger.warning("Network discovery CPU usage high", **metrics)
    
    return metrics
```

## 10. Security Framework

### Existing Security Posture Assessment

#### Current Security Measures
- **Environment Variables**: Sensitive configuration via .env files
- **Database Security**: Supabase service keys with row-level security
- **API Security**: No authentication currently (local-only deployment)
- **Service Communication**: Docker network isolation
- **Input Validation**: Pydantic models for API validation

### Network Security Enhancement Requirements

#### Peer Authentication Framework
```python
# Certificate-based peer authentication
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

class PeerAuthenticationService:
    """Manages peer certificates and authentication."""
    
    def __init__(self, ca_cert_path: str, ca_key_path: str):
        self.ca_cert = self._load_ca_certificate(ca_cert_path)
        self.ca_key = self._load_ca_private_key(ca_key_path)
    
    async def generate_peer_certificate(self, peer_id: str, hostname: str) -> Tuple[bytes, bytes]:
        """Generate certificate for authenticated peer."""
        
        # Generate key pair
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key = private_key.public_key()
        
        # Create certificate
        subject = x509.Name([
            x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, peer_id),
            x509.NameAttribute(x509.oid.NameOID.ORGANIZATION_NAME, "Archon Network"),
        ])
        
        cert = x509.CertificateBuilder().subject_name(subject)
        cert = cert.issuer_name(self.ca_cert.subject)
        cert = cert.public_key(public_key)
        cert = cert.serial_number(x509.random_serial_number())
        cert = cert.not_valid_before(datetime.utcnow())
        cert = cert.not_valid_after(datetime.utcnow() + timedelta(days=365))
        cert = cert.add_extension(x509.SubjectAlternativeName([
            x509.DNSName(hostname),
        ]), critical=False)
        
        # Sign with CA
        cert = cert.sign(self.ca_key, hashes.SHA256())
        
        # Serialize certificate and key
        cert_pem = cert.public_bytes(serialization.Encoding.PEM)
        key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )
        
        return cert_pem, key_pem
    
    async def validate_peer_certificate(self, cert_pem: bytes) -> bool:
        """Validate peer certificate against CA."""
        try:
            cert = x509.load_pem_x509_certificate(cert_pem)
            
            # Verify signature
            ca_public_key = self.ca_cert.public_key()
            ca_public_key.verify(
                cert.signature,
                cert.tbs_certificate_bytes,
                cert.signature_algorithm_oid._name
            )
            
            # Check expiration
            if cert.not_valid_after < datetime.utcnow():
                return False
                
            return True
            
        except Exception as e:
            search_logger.warning("Certificate validation failed", error=str(e))
            return False
```

#### Encrypted Communication
```python
# TLS-secured peer communication
import ssl
import aiohttp
from aiohttp import ClientConnectorError

class SecurePeerClient:
    """Secure client for peer-to-peer communication."""
    
    def __init__(self, client_cert_path: str, client_key_path: str, ca_cert_path: str):
        self.ssl_context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
        self.ssl_context.load_cert_chain(client_cert_path, client_key_path)
        self.ssl_context.load_verify_locations(ca_cert_path)
        self.ssl_context.minimum_version = ssl.TLSVersion.TLSv1_3
        
    async def connect_to_peer(self, peer_address: str, peer_port: int) -> aiohttp.ClientSession:
        """Establish secure connection to peer."""
        
        connector = aiohttp.TCPConnector(ssl=self.ssl_context)
        session = aiohttp.ClientSession(connector=connector)
        
        try:
            # Verify connection with health check
            async with session.get(f'https://{peer_address}:{peer_port}/health') as response:
                if response.status != 200:
                    raise PeerConnectionError(f"Peer health check failed: {response.status}")
                
                return session
                
        except ClientConnectorError as e:
            await session.close()
            raise PeerConnectionError(f"Failed to establish secure connection: {e}")
```

#### Trust Management
```python
# Configurable trust levels for network peers
from enum import Enum
from typing import Set

class PeerTrustLevel(Enum):
    UNTRUSTED = "untrusted"      # Unknown peers - no access
    DISCOVERY = "discovery"       # Can discover but not access data
    TRUSTED = "trusted"          # Full access to shared knowledge
    ADMIN = "admin"              # Can manage peer relationships

class PeerTrustManager:
    """Manages trust relationships between peers."""
    
    def __init__(self, supabase_client):
        self.client = supabase_client
        self._trust_cache: Dict[str, PeerTrustLevel] = {}
    
    async def get_peer_trust_level(self, peer_id: str) -> PeerTrustLevel:
        """Get trust level for specific peer."""
        
        if peer_id in self._trust_cache:
            return self._trust_cache[peer_id]
        
        # Query database for trust relationship
        result = await self.client.table('archon_peer_trust').select('*').eq('peer_id', peer_id).execute()
        
        if result.data:
            trust_level = PeerTrustLevel(result.data[0]['trust_level'])
        else:
            trust_level = PeerTrustLevel.DISCOVERY  # Default for new peers
        
        self._trust_cache[peer_id] = trust_level
        return trust_level
    
    async def authorize_peer_action(self, peer_id: str, required_level: PeerTrustLevel) -> bool:
        """Check if peer is authorized for specific action."""
        
        peer_trust = await self.get_peer_trust_level(peer_id)
        
        # Trust level hierarchy
        hierarchy = {
            PeerTrustLevel.UNTRUSTED: 0,
            PeerTrustLevel.DISCOVERY: 1,
            PeerTrustLevel.TRUSTED: 2,
            PeerTrustLevel.ADMIN: 3
        }
        
        return hierarchy[peer_trust] >= hierarchy[required_level]
```

### Security Configuration Management

#### Environment-Based Security Settings
```python
# Security configuration via environment variables
from pydantic import BaseSettings, Field
from typing import Optional

class NetworkSecurityConfig(BaseSettings):
    """Network security configuration."""
    
    # Certificate paths
    ca_certificate_path: str = Field(..., env='NETWORK_CA_CERT_PATH')
    client_certificate_path: str = Field(..., env='NETWORK_CLIENT_CERT_PATH')
    client_private_key_path: str = Field(..., env='NETWORK_CLIENT_KEY_PATH')
    
    # Trust settings
    auto_trust_local_network: bool = Field(True, env='NETWORK_AUTO_TRUST_LOCAL')
    require_peer_certificates: bool = Field(True, env='NETWORK_REQUIRE_CERTS')
    max_peer_connections: int = Field(10, env='NETWORK_MAX_PEER_CONNECTIONS')
    
    # Security timeouts
    peer_connection_timeout: int = Field(30, env='NETWORK_CONNECTION_TIMEOUT')
    certificate_validation_timeout: int = Field(10, env='NETWORK_CERT_VALIDATION_TIMEOUT')
    
    # Allowed network ranges (CIDR notation)
    trusted_network_ranges: Optional[str] = Field(None, env='NETWORK_TRUSTED_RANGES')
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
```

#### Runtime Security Monitoring
```python
# Security event logging and alerting
class NetworkSecurityMonitor:
    """Monitor and log network security events."""
    
    def __init__(self, logger):
        self.logger = logger
        self._failed_auth_attempts: Dict[str, int] = defaultdict(int)
        self._rate_limits: Dict[str, datetime] = {}
    
    async def log_authentication_attempt(self, peer_address: str, peer_id: str, success: bool):
        """Log peer authentication attempts."""
        
        if success:
            self.logger.info("Peer authentication successful",
                           peer_id=peer_id,
                           peer_address=peer_address)
            # Reset failed attempts on success
            self._failed_auth_attempts[peer_address] = 0
        else:
            self._failed_auth_attempts[peer_address] += 1
            self.logger.warning("Peer authentication failed",
                              peer_id=peer_id,
                              peer_address=peer_address,
                              failed_attempts=self._failed_auth_attempts[peer_address])
            
            # Rate limiting after repeated failures
            if self._failed_auth_attempts[peer_address] >= 3:
                self._rate_limits[peer_address] = datetime.utcnow() + timedelta(minutes=15)
                self.logger.error("Peer rate limited due to authentication failures",
                                peer_address=peer_address)
    
    async def is_peer_rate_limited(self, peer_address: str) -> bool:
        """Check if peer is currently rate limited."""
        
        if peer_address in self._rate_limits:
            if datetime.utcnow() < self._rate_limits[peer_address]:
                return True
            else:
                # Rate limit expired
                del self._rate_limits[peer_address]
        
        return False
    
    async def log_data_access(self, peer_id: str, action: str, resource: str, authorized: bool):
        """Log peer data access attempts."""
        
        log_data = {
            'peer_id': peer_id,
            'action': action,
            'resource': resource,
            'authorized': authorized,
            'timestamp': datetime.utcnow().isoformat()
        }
        
        if authorized:
            self.logger.info("Peer data access authorized", **log_data)
        else:
            self.logger.warning("Peer data access denied", **log_data)
```

---

*This brownfield architecture analysis provides a comprehensive foundation for integrating LAN migration capabilities into the existing Archon codebase while maintaining architectural consistency and minimizing risks to current functionality.*