# Pull Request  Fix Linux Docker Networking and Add Flexible Port Configuration

## Summary
<!-- Provide a brief description of what this PR accomplishes -->
This PR addresses critical deployment issues on Linux systems and adds flexible port configuration to avoid conflicts with existing services. These changes will help users successfully deploy Archon alongside other applications like Supabase projects and development servers.

## Problems Solved

### 1. 🐛 Docker Network Connectivity Issues on Linux
**Problem:** Containers couldn't reach host services through `host.docker.internal` on Linux systems, causing Supabase connection timeouts.

**Solution:** 
- Use `host-gateway` instead of hardcoded IPs for better cross-platform compatibility
- Document network configuration options for different deployment scenarios

### 2. 🐛 Port Conflicts with Existing Services
**Problem:** Default ports (3737, 8181, 8051, 8052) often conflict with other development tools.

**Solution:**
- Separate internal (container) ports from external (host) ports
- Use environment variables for flexible external port mapping
- Keep internal ports as defaults for simpler container-to-container communication

### 3. 🐛 DOCKER_HOST Environment Conflicts
**Problem:** Systems with Podman or custom Docker configurations fail due to DOCKER_HOST variable interference.

**Solution:**
- Add startup script that properly handles Docker environment
- Document the need to unset DOCKER_HOST when needed

### 4. 🐛 Supabase Network Isolation
**Problem:** When using local Supabase, Archon containers on separate networks cannot communicate with Supabase services.

**Solution:**
- Provide configuration option to join existing Supabase network
- Document both isolated and shared network approaches

## Changes Made
<!-- List the main changes in this PR -->
1.Updated `docker-compose.yml`
2. Created `start_archon.sh`
3. Enhanced `.env.example`
4.Created `DEPLOYMENT_TROUBLESHOOTING.md`


### 1. Updated `docker-compose.yml`
```yaml
# Separated internal and external ports
ports:
  - "${ARCHON_SERVER_PORT:-8181}:8181"  # External can change, internal stays consistent

# Fixed host.docker.internal for Linux
extra_hosts:
  - "host.docker.internal:host-gateway"  # Works on all platforms Tested only on ubuntu

# Network configuration options
networks:
  app-network:
    driver: bridge  # Default isolated network
    # OR for Supabase integration:
    # external: true
    # name: supabase_network_name
```

### 2. Created `start_archon.sh`
```bash
#!/bin/bash
# Handles environment setup and provides clear startup information
unset DOCKER_HOST  # Prevents Podman/custom Docker conflicts
docker compose up --build -d
echo "Access points:"
echo "  Web UI: http://localhost:${ARCHON_UI_PORT:-3737}"
# ... etc
```

### 3. Enhanced `.env.example`
```bash
# Custom port configuration to avoid conflicts
ARCHON_SERVER_PORT=8181  # Change to 9282 if 8181 is in use
ARCHON_MCP_PORT=8051     # Change to 9151 if 8051 is in use
ARCHON_AGENTS_PORT=8052  # Change to 9152 if 8052 is in use
ARCHON_UI_PORT=3737      # Change to 4838 if 3737 is in use

# Network configuration for local Supabase
# For local Supabase: use container name
# SUPABASE_URL=http://supabase_kong:8000
# For remote Supabase: use public URL
# SUPABASE_URL=https://your-project.supabase.co
```

### 4. Added Comprehensive Documentation
- `DEPLOYMENT_TROUBLESHOOTING.md` - Common issues and solutions


## Type of Change
<!-- Mark the relevant option with an "x" -->
- [X] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [X] Documentation update
- [ ] Performance improvement
- [ ] Code refactoring

## Affected Services
<!-- Mark all that apply with an "x" -->
- [ ] Frontend (React UI)
- [ ] Server (FastAPI backend)
- [ ] MCP Server (Model Context Protocol)
- [ ] Agents (PydanticAI service)
- [ ] Database (migrations/schema)
- [X] Docker/Infrastructure
- [X ] Documentation site

## Testing
<!-- Describe how you tested your changes -->
Tested on:
- ✅ Ubuntu 24.04 with Docker 28.3.3
- ✅ System with existing Supabase local deployment
- ✅ System with Podman installed (DOCKER_HOST conflict resolved)
- ✅ Multiple services running on default ports
- [ ] All existing tests pass
- [ ] Added new tests for new functionality
- [X] Manually tested affected user flows
- [X ] Docker builds succeed for all services

### Test Evidence
<!-- Provide specific test commands run and their results -->
```bash

DEPLOYMENT_SUCCESS.md

# Example: python -m pytest tests/
# Example: cd archon-ui-main && npm run test
```
## Breaking Changes
None

## Checklist
<!-- Mark completed items with an "x" -->
- [X ] My code follows the service architecture patterns
- [ ] If using an AI coding assistant, I used the CLAUDE.md rules
- [ ] I have added tests that prove my fix/feature works
- [ ] All new and existing tests pass locally
- [X] My changes generate no new warnings
- [X ] I have updated relevant documentation
- [X ] I have verified no regressions in existing features

## Breaking Changes
<!-- If this PR introduces breaking changes, describe them here -->
None - all changes are backward compatible with existing deployments.

## Additional Notes
<!-- Any additional information that reviewers should know -->
<!-- Screenshots, performance metrics, dependencies added, etc. -->