# Day-1 Prerequisites Checklist
## Before You Begin: Verification & Preparation

### ✅ Infrastructure Verification

#### Traefik Proxy Status
```bash
☐ docker ps | grep traefik                    # Confirm Traefik running
☐ docker network ls | grep proxy              # Verify 'proxy' network exists
☐ curl https://traefik.mcdonaldhomelab.com    # Test Traefik dashboard access
```
**Expected:** Traefik container running, proxy network active

#### Server Resources
```bash
☐ free -h                                     # Check RAM (need 4GB free)
☐ df -h                                       # Check disk (need 20GB free)
☐ nproc                                       # Check CPU cores (need 2+)
☐ docker --version                            # Docker 24.0+ required
☐ docker compose version                      # Compose v2 required
```

#### Network Configuration
```bash
☐ ip addr show                                # Note server IP address
☐ ping google.com                             # Verify internet connectivity
☐ nslookup archon.mcdonaldhomelab.com        # Test DNS resolution
☐ ping archon.mcdonaldhomelab.com            # Should resolve to server IP
```

---

### 📋 Access Requirements

#### Credentials Gathering
```
☐ Traefik dashboard access verified
☐ Server SSH/console access confirmed
☐ DNS management access available
☐ Internal Supabase credentials located:
   - SUPABASE_URL: https://supabase.mcdonaldhomelab.com
   - SUPABASE_SERVICE_KEY: _________________
☐ OpenAI API key (if using): _______________
```

#### Domain Configuration
```
☐ DNS A record exists/created:
   - archon.mcdonaldhomelab.com → [SERVER_IP]
☐ DNS propagation verified (nslookup from client)
☐ Let's Encrypt rate limits checked (5 certs/week)
```

---

### 🔧 Environment Preparation

#### Repository Setup
```bash
☐ cd /opt  # or your preferred directory
☐ git clone https://github.com/[your-repo]/Archon.git
☐ cd Archon
☐ ls -la   # Verify files present
```

#### Create Environment Template Files
```bash
☐ cp .env.example .env.local      # Local mode template
☐ cp .env.example .env.lan        # LAN mode template
☐ nano .env.local                 # Configure for local deployment:
```
```env
# .env.local - Local Development Mode
DEPLOYMENT_MODE=local
ENABLE_TRAEFIK=false
USE_PROXY_NETWORK=false
HOST=localhost
VITE_API_URL=http://localhost:8181
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=[your-service-key]

# Network Settings
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# Frontend Configuration  
VITE_API_URL=https://archon.mcdonaldhomelab.com/api
VITE_ALLOWED_HOSTS=192.168.0.0/16,10.0.0.0/8

# Optional
OPENAI_API_KEY=[if-using]
LOG_LEVEL=INFO
```

```bash
☐ nano .env.lan                    # Configure for LAN deployment:
```
```env
# .env.lan - LAN Deployment Mode  
DEPLOYMENT_MODE=lan
ENABLE_TRAEFIK=true
USE_PROXY_NETWORK=true
HOST=archon.mcdonaldhomelab.com
DOMAIN=archon.mcdonaldhomelab.com
VITE_API_URL=https://archon.mcdonaldhomelab.com/api
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=[your-service-key]

# Network Settings
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# Frontend Configuration
VITE_ALLOWED_HOSTS=192.168.0.0/16,10.0.0.0/8
CORS_ORIGINS=https://archon.mcdonaldhomelab.com

# Optional
OPENAI_API_KEY=[if-using]
LOG_LEVEL=INFO
```

#### Backup Current State
```bash
☐ docker ps > ~/archon-backup/current-containers.txt
☐ docker network ls > ~/archon-backup/current-networks.txt
☐ cp -r .env* ~/archon-backup/  # Backup any existing configs
☐ docker images | grep archon > ~/archon-backup/current-images.txt
```

---

### 🔎 Code Review Checklist

#### Frontend Code Review (archon-ui-main/)
```bash
☐ grep -r "localhost:" src/
☐ grep -r "127.0.0.1" src/
☐ grep -r "http://" src/ | grep -v "https://"
☐ grep -r ":8181\|:8051\|:3737" src/  # Hard-coded ports
```

**Key Files to Check:**
- `☐ src/services/api.ts` - API endpoint configuration
- `☐ src/config/*.ts` - Configuration files
- `☐ vite.config.ts` - Build configuration
- `☐ src/contexts/*.tsx` - React contexts that may have URLs

**Verify:**
```javascript
☐ API URLs use: import.meta.env.VITE_API_URL
☐ No hard-coded "localhost" or "127.0.0.1"
☐ WebSocket connections (if any) use environment variables
```

#### Backend Code Review (python/)
```bash
☐ grep -r "localhost" src/
☐ grep -r "127.0.0.1" src/
☐ grep -r "cors\|CORS" src/  # CORS configuration
☐ grep -r "http://" src/ | grep -v "https://"
```

**Key Files to Check:**
- `☐ src/server/main.py` - FastAPI CORS configuration
- `☐ src/server/config.py` - Service configuration
- `☐ src/mcp/server.py` - MCP server configuration
- `☐ src/agents/*.py` - Agent service configs

**Verify:**
```python
☐ CORS origins from: os.getenv("CORS_ORIGINS")
☐ Service URLs from environment variables
☐ No hard-coded service addresses
```

#### Docker Configuration Review
```bash
☐ Check docker-compose.yml for hard-coded values
☐ Verify all services can read from environment
☐ Check for conditional Traefik label support
```

---

### 🔍 Validation Tests

#### Network Connectivity
```bash
☐ From server: curl -I https://mcdonaldhomelab.com
☐ From server: docker run --rm --network proxy alpine ping -c 1 traefik
☐ From client: ping [SERVER_IP]
☐ From client: curl http://[SERVER_IP]:80  # Should redirect to HTTPS
```

#### Traefik Integration Test
```bash
☐ Create test container:
   docker run -d --name test-web \
     --network proxy \
     -l "traefik.enable=true" \
     -l "traefik.http.routers.test.rule=Host(\`test.mcdonaldhomelab.com\`)" \
     -l "traefik.docker.network=proxy" \
     nginx:alpine

☐ Test routing: curl https://test.mcdonaldhomelab.com
☐ Clean up: docker stop test-web && docker rm test-web
```

---

### ⚠️ Requirement Gates

**MUST PASS before proceeding:**

| Requirement | Status | Blocker? |
|-------------|---------|----------|
| Traefik proxy running | ☐ Pass | YES |
| 'proxy' network exists | ☐ Pass | YES |
| 4GB RAM available | ☐ Pass | YES |
| 20GB disk available | ☐ Pass | YES |
| DNS resolves correctly | ☐ Pass | YES |
| Internal Supabase credentials valid | ☐ Pass | YES |
| Git repository cloned | ☐ Pass | YES |
| Code review completed | ☐ Pass | YES |
| No hard-coded localhost found | ☐ Pass | YES |
| .env.local template created | ☐ Pass | YES |
| .env.lan template created | ☐ Pass | YES |

---

### 📝 Day-1 Completion Sign-off

```
Date: _____________
Completed by: _____________
All prerequisites: ☐ PASSED / ☐ FAILED

Issues found:
_________________________________
_________________________________

Ready to proceed to Day 2: ☐ YES / ☐ NO
```

---

### 🚀 Next Steps (Day 2)
Once all prerequisites pass:
1. Modify docker-compose.yml to support environment variables
2. Add conditional Traefik labels
3. Create deploy.sh script for mode switching
4. Test switching between local and LAN modes

---

*Last updated: January 2025*  
*Part of: Archon LAN Migration Project (ARCHON-LAN-001)*