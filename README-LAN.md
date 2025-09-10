# Archon LAN Deployment

Quick setup guide for deploying Archon on your LAN with Traefik proxy integration.

## Quick Start

### Prerequisites
- Docker & Docker Compose installed on LAN server
- Traefik proxy running with `proxy` network
- DNS: `archon.mcdonaldhomelab.com` → LAN server IP

### Deploy
```bash
# Clone repository
git clone <repo-url>
cd Archon

# Configure environment
cp .env.lan.example .env
# Edit .env with your Supabase credentials

# Deploy with LAN configuration (standalone file)
docker-compose -f docker-compose-lan.yml up -d

# Access at: https://archon.mcdonaldhomelab.com
```

## What This Gives You

### 🌐 Production-Ready LAN Access
- **HTTPS with SSL**: Automatic Let's Encrypt certificates via Traefik
- **Domain Access**: `https://archon.mcdonaldhomelab.com`
- **Path Routing**: API at `/api/*`, frontend at `/`
- **Security**: No direct port access, all traffic through Traefik

### 🔒 Secure Architecture  
- **Network Isolation**: MCP and Agents services internal-only
- **SSL Termination**: All external traffic encrypted
- **Service Discovery**: Containers communicate via internal Docker network
- **Access Control**: Traefik handles all external routing

### 🚀 Zero-Impact Developer Experience
- **Localhost Unchanged**: `docker-compose up` still works for development  
- **Environment Separation**: LAN deployment completely separate from dev
- **Easy Switching**: Same codebase, different Docker Compose files

## Architecture

```
Internet → Traefik Proxy → Docker Networks
                        ├── archon-frontend:3737 (/)
                        ├── archon-server:8181 (/api/*)  
                        └── Internal Services
                            ├── archon-mcp:8051
                            └── archon-agents:8052
```

## Files Overview

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Developer localhost deployment |
| `docker-compose-lan.yml` | LAN server override with Traefik labels |  
| `.env.lan.example` | Environment template for LAN server |
| `docs/lan-migration/` | Detailed deployment documentation |

## Key Differences: Dev vs LAN

| Aspect | Developer | LAN Server |
|--------|-----------|------------|
| **Access** | `http://localhost:3737` | `https://archon.mcdonaldhomelab.com` |
| **Security** | HTTP, direct ports | HTTPS, Traefik proxy |  
| **Network** | Port mappings | External proxy network |
| **SSL** | None | Let's Encrypt via Traefik |
| **Command** | `docker-compose up` | `docker-compose -f docker-compose-lan.yml up -d` |

## Next Steps

1. **Complete Setup**: Follow [LAN Deployment Guide](docs/lan-migration/lan-deployment-guide.md)
2. **Pre-flight Check**: Use [Migration Checklist](docs/lan-migration/migration-checklist.md)  
3. **Troubleshooting**: Reference deployment guide for common issues
4. **Phase 2 Details**: See [Phase 2 Story](docs/stories/phase-2-lan-configuration-support.md)

## Support

For issues or questions:
- Check the deployment guide troubleshooting section
- Review Docker Compose logs: `docker-compose logs -f`
- Verify Traefik configuration and proxy network setup
- Ensure DNS resolution and SSL certificate generation