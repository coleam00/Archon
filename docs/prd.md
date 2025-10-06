# Archon LAN Migration Product Requirements Document (PRD)

## Goals and Background Context

### Goals
- Enable multi-device access to Archon knowledge management system across local network
- Migrate from single-machine localhost deployment to centralized LAN-accessible server architecture  
- Integrate seamlessly with existing Traefik proxy infrastructure for HTTPS and domain management
- Maintain zero-authentication simplicity for trusted local network users
- Provide instant rollback capability between local and LAN deployment modes
- Reduce maintenance overhead from multiple instances to single centralized deployment

### Background Context

Archon currently operates as a single-machine installation accessible only via localhost, creating significant limitations for multi-device workflows and requiring redundant installations across workstations. This PRD addresses the migration to a centralized LAN deployment using existing homelab infrastructure (Traefik proxy with Let's Encrypt) to enable secure, HTTPS-accessible knowledge management from any device on the local network.

The solution leverages a unified deployment strategy with environment variable control, allowing instant switching between local and LAN modes without code changes - providing both progressive migration capabilities and immediate rollback options if issues arise.

### Change Log
| Date | Version | Description | Author |
|------|---------|-------------|---------|
| 2025-01-09 | 1.0 | Initial PRD creation based on Mary's analysis | John (PM) |

## Requirements

### Functional Requirements

**FR1:** The system shall enable deployment mode switching via environment variables (DEPLOYMENT_MODE=local|lan) without code changes

**FR2:** The system shall integrate with existing Traefik proxy infrastructure when ENABLE_TRAEFIK=true, automatically configuring SSL routing for archon.mcdonaldhomelab.com

**FR3:** The system shall provide instant rollback capability, allowing switch from LAN to local mode in under 30 seconds via environment file switching

**FR4:** The system shall maintain all existing Archon functionality (knowledge base, MCP tools, document upload/search) in both deployment modes

**FR5:** The system shall expose services via HTTPS at https://archon.mcdonaldhomelab.com/ (frontend), /api/* (backend), and /mcp/* (MCP server) when in LAN mode

**FR6:** The system shall use conditional Docker network attachment - connecting to 'proxy' network only in LAN mode while maintaining internal 'archon-internal' network isolation

**FR7:** The system shall provide health check endpoints for all services to enable monitoring and auto-recovery

**FR8:** The system shall eliminate CORS complexity through single-origin proxy routing when in LAN mode

### Non-Functional Requirements

**NFR1:** API response time must average <200ms for all endpoints when deployed in LAN mode

**NFR2:** The system must achieve >99% uptime with automatic container restart capabilities

**NFR3:** SSL certificates must achieve A+ rating via Let's Encrypt integration and auto-renewal

**NFR4:** The system must support minimum 5 concurrent users without performance degradation  

**NFR5:** Memory usage per service must not exceed: Frontend 512MB, Backend 1GB, MCP 256MB

**NFR6:** Deployment switching (local ↔ LAN) must complete in <30 seconds including container restart

**NFR7:** The system must be accessible from any device on LAN (192.168.0.0/16, 10.0.0.0/8) when in LAN mode

**NFR8:** All services must auto-recover within 30 seconds of container failure

## Technical Assumptions

### Repository Structure: Monorepo
The existing Archon monorepo structure will be maintained, containing all services (frontend, backend, MCP, agents) in a single repository with unified Docker Compose orchestration.

### Service Architecture
**Microservices within Monorepo** - Archon maintains separate containerized services (frontend, backend, MCP server, agents) orchestrated via Docker Compose, with dual network architecture (external proxy network + internal service network).

### Testing Requirements
**Unit + Integration** - Maintain existing test coverage with unit tests for individual services plus integration testing for environment switching and deployment mode validation.

### Additional Technical Assumptions and Requests
- Existing Traefik v3.x infrastructure is operational with 'proxy' external network available
- Let's Encrypt certificate resolver is configured and functional in Traefik
- Target server meets minimum requirements: 4GB RAM, 2 CPU cores, Docker 24.0+
- Internal Supabase instance remains at supabase.mcdonaldhomelab.com
- Zero-authentication approach acceptable for trusted LAN environment
- Environment variable precedence: .env file overrides docker-compose defaults

## Epic List

**Epic 1: Foundation & Environment Configuration** - Establish environment-based deployment switching infrastructure and create configuration templates for both local and LAN modes

**Epic 2: Docker Compose & Network Integration** - Implement conditional Traefik labels and dual network architecture to support both deployment modes within single configuration

**Epic 3: Service Deployment & Validation** - Deploy services in LAN mode, verify Traefik integration, and validate instant rollback capabilities  

**Epic 4: Performance Optimization & Documentation** - Optimize performance for multi-user access and create comprehensive deployment documentation

## Epic 1: Foundation & Environment Configuration

**Expanded Goal:** Create the foundational infrastructure for environment-based deployment switching by developing configuration templates, environment variable schemas, and deployment automation that enables instant switching between local and LAN modes without code changes.

### Story 1.1: Environment Template Creation
As a system administrator,
I want standardized environment templates for local and LAN deployment modes,
so that I can easily configure and switch between deployment environments.

#### Acceptance Criteria
1. `.env.local` template created with localhost configuration (DEPLOYMENT_MODE=local, ENABLE_TRAEFIK=false, USE_PROXY_NETWORK=false)
2. `.env.lan` template created with LAN configuration (DEPLOYMENT_MODE=lan, ENABLE_TRAEFIK=true, DOMAIN=archon.mcdonaldhomelab.com)
3. Both templates include all required environment variables with appropriate default values
4. Environment variable documentation explains each setting and its impact on deployment mode
5. Templates are validated to ensure no missing or conflicting variables

### Story 1.2: Deployment Mode Switching Script
As a system administrator,
I want an automated deployment script that switches between local and LAN modes,
so that I can deploy and rollback instantly without manual configuration.

#### Acceptance Criteria
1. `deploy.sh` script accepts mode parameter (local|lan|status)
2. Script validates Traefik proxy network exists before LAN deployment
3. Script copies appropriate environment template to .env file
4. Script restarts Docker Compose services with new configuration
5. Script provides clear success/failure feedback and current deployment status
6. Script includes verification checks (health endpoints, network connectivity)

### Story 1.3: Environment Variable Validation System
As a developer,
I want environment variable validation in each service,
so that configuration errors are caught early and deployment failures are prevented.

#### Acceptance Criteria
1. Each service validates required environment variables on startup
2. Missing or invalid environment variables cause service to fail fast with clear error messages
3. Environment variable schema documented for each service (frontend, backend, MCP)
4. Validation includes network connectivity checks (database, inter-service communication)
5. Health check endpoints return configuration validation status

## Epic 2: Docker Compose & Network Integration

**Expanded Goal:** Implement conditional Docker Compose configuration that adapts network topology, service exposure, and Traefik integration based on deployment mode while maintaining single source of truth for all service definitions.

### Story 2.1: Conditional Traefik Labels Implementation
As a system administrator,
I want Docker services to automatically configure Traefik labels based on deployment mode,
so that LAN mode enables proxy routing while local mode remains isolated.

#### Acceptance Criteria
1. Traefik labels are conditionally applied via `traefik.enable=${ENABLE_TRAEFIK}` environment variable
2. Frontend service configured with Host rule for archon.mcdonaldhomelab.com
3. Backend API configured with PathPrefix rule for /api/* with strip prefix middleware
4. MCP service configured with PathPrefix rule for /mcp/* 
5. All services include SSL certificate resolver configuration for Let's Encrypt
6. Services without Traefik labels remain inaccessible from external network

### Story 2.2: Dual Network Architecture Setup
As a system architect,
I want services to connect to appropriate networks based on deployment mode,
so that LAN mode enables external access while maintaining internal service isolation.

#### Acceptance Criteria
1. External 'proxy' network connection controlled by `USE_PROXY_NETWORK` environment variable
2. Internal 'archon-internal' network always active for inter-service communication
3. Frontend, backend, and MCP services connect to both networks in LAN mode
4. Agents service remains on internal network only (no proxy access)
5. Network configuration prevents external access to internal-only services
6. Service discovery works correctly across both network configurations

### Story 2.3: Port Binding and Service Exposure Control
As a security administrator,
I want port bindings to adapt based on deployment mode,
so that local mode restricts access to localhost while LAN mode allows network access.

#### Acceptance Criteria
1. Local mode binds services to 127.0.0.1 (localhost only)
2. LAN mode binds services to 0.0.0.0 (all interfaces) or relies on Traefik routing
3. Port binding configuration controlled by environment variables
4. No unnecessary port exposure in either deployment mode
5. Service accessibility testing validates intended exposure level
6. Documentation clearly explains port binding differences between modes

## Epic 3: Service Deployment & Validation

**Expanded Goal:** Deploy Archon services in LAN mode with full Traefik integration, validate all functionality works correctly across multiple devices, and verify instant rollback capabilities work reliably under various scenarios.

### Story 3.1: LAN Mode Service Deployment
As a system administrator,
I want to deploy Archon services in LAN mode with Traefik integration,
so that all services are accessible via HTTPS from any device on the local network.

#### Acceptance Criteria
1. All services successfully deploy in LAN mode using deploy.sh script
2. Services are accessible at https://archon.mcdonaldhomelab.com (frontend), /api (backend), /mcp (MCP)
3. SSL certificates are automatically provisioned and achieve A+ rating
4. Health check endpoints return success status for all services
5. Internal service communication works correctly (frontend→backend, MCP→backend)
6. Container resource limits are enforced and services remain within specified memory bounds

### Story 3.2: Multi-Device Access Validation
As a knowledge worker,
I want to access Archon from multiple devices on the local network,
so that I can use the knowledge management system from laptop, desktop, and mobile devices.

#### Acceptance Criteria
1. Frontend accessible from at least 3 different devices on the LAN
2. All core functionality works from each device (search, upload, navigation)
3. MCP tools connectable from IDE on different workstations
4. Performance meets requirements (<200ms API response, <2s page loads)
5. Concurrent usage by 5 users shows no performance degradation
6. Mobile responsiveness maintained for tablet/phone access

### Story 3.3: Rollback and Recovery Validation
As a system administrator,
I want to validate instant rollback capabilities and failure recovery,
so that I can confidently deploy knowing reliable fallback options exist.

#### Acceptance Criteria
1. Rollback from LAN to local mode completes in <30 seconds
2. Local mode deployment works correctly after rollback
3. All data integrity maintained during mode switching
4. Container failure triggers automatic restart within 30 seconds  
5. Network connectivity issues don't prevent local mode operation
6. Deployment script handles edge cases (network down, Traefik unavailable) gracefully

## Epic 4: Performance Optimization & Documentation

**Expanded Goal:** Optimize system performance for multi-user LAN access, implement comprehensive monitoring, and create detailed documentation that enables ongoing maintenance and troubleshooting of the dual-mode deployment system.

### Story 4.1: Performance Monitoring and Optimization
As a system administrator,  
I want comprehensive performance monitoring and optimization,
so that the LAN deployment meets all performance requirements under normal and peak loads.

#### Acceptance Criteria
1. Performance monitoring dashboard shows response times, resource usage, and user load
2. API response times consistently <200ms for all endpoints under 5 concurrent users
3. Memory usage remains within limits: Frontend <512MB, Backend <1GB, MCP <256MB
4. Caching strategies implemented where appropriate to improve response times
5. Load testing validates system performance with 10 concurrent users
6. Performance regression testing integrated into deployment validation

### Story 4.2: Comprehensive Deployment Documentation
As a future system maintainer,
I want detailed documentation covering deployment, troubleshooting, and maintenance,
so that I can effectively manage and troubleshoot the dual-mode deployment system.

#### Acceptance Criteria
1. Complete deployment guide with step-by-step instructions for both modes
2. Troubleshooting guide covering common issues and solutions
3. Environment variable reference documentation with examples
4. Network architecture diagrams showing service relationships and data flow
5. Monitoring and maintenance procedures documented
6. Rollback procedures and disaster recovery steps clearly outlined

### Story 4.3: Automated Health Monitoring and Alerting
As a system administrator,
I want automated health monitoring and alerting,
so that I'm notified of issues before they impact users.

#### Acceptance Criteria
1. Health check monitoring for all services with configurable intervals
2. SSL certificate expiration monitoring and renewal alerts
3. Resource usage monitoring with threshold-based alerts
4. Service restart and recovery logging
5. Integration with existing homelab monitoring infrastructure
6. Alert escalation procedures documented for different failure scenarios

### Story 4.4: Data Safety and Backup Validation
As a system administrator,
I want to ensure data integrity and backup procedures during deployment mode switching,
so that no data is lost during migration or rollback operations.

#### Acceptance Criteria
1. Document backup procedure for Supabase data before first LAN deployment
2. Validate that deployment mode switching preserves all application data
3. Test data consistency across local and LAN modes
4. Create recovery procedure for data corruption scenarios
5. Document volume mount persistence across deployment modes
6. Validate configuration data (.env files) backup and recovery

## Checklist Results Report

### PM Validation Summary
- **Overall Completeness:** 95% (after addressing data safety gap)
- **MVP Scope:** Appropriately sized for 7-day implementation
- **Epic Structure:** Sequential and optimized for AI agent execution
- **Requirements Quality:** Clear, testable, and comprehensive
- **Technical Readiness:** Ready for architect handoff

### Validation Status: ✅ APPROVED
All critical requirements validated, minor gaps addressed, PRD ready for implementation.

## Next Steps

### UX Expert Prompt
*Not applicable for this infrastructure migration project - no UI changes required*

### Architect Prompt
"Create technical architecture for Archon LAN migration implementing environment-based deployment switching with Traefik integration. Focus on Docker Compose conditional configuration, dual network architecture (proxy + internal), and automated SSL certificate management. Reference this PRD for functional requirements and performance targets. Deliverables: Updated docker-compose.yml, environment templates, deployment automation, and technical implementation guide."