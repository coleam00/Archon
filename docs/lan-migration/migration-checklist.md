# LAN Migration Checklist

## Pre-Deployment Checklist

### Infrastructure Requirements
- [ ] LAN server with Docker and Docker Compose installed
- [ ] Traefik proxy running with external network `proxy`
- [ ] DNS resolution: `archon.mcdonaldhomelab.com` → LAN server IP
- [ ] Firewall allows ports 80/443 for Let's Encrypt challenges
- [ ] Supabase project credentials available

### Traefik Configuration Verification
- [ ] External `proxy` network exists: `docker network ls | grep proxy`
- [ ] Let's Encrypt resolver configured in Traefik
- [ ] Traefik dashboard accessible (optional)
- [ ] SSL certificate generation working for other services

## Deployment Steps

### 1. Repository Setup
- [ ] Clone Archon repository to LAN server
- [ ] Verify current branch and latest code
- [ ] Check file permissions for Docker socket access

### 2. Environment Configuration  
- [ ] Copy `.env.lan.example` to `.env`
- [ ] Update `SUPABASE_URL` with your project URL
- [ ] Update `SUPABASE_SERVICE_KEY` with service role key
- [ ] Optional: Add `OPENAI_API_KEY` and `LOGFIRE_TOKEN`

### 3. Network Preparation
- [ ] Verify proxy network: `docker network inspect proxy`
- [ ] Test DNS resolution: `nslookup archon.mcdonaldhomelab.com`
- [ ] Confirm no port conflicts on target server

### 4. Deployment Execution
- [ ] Deploy: `docker-compose -f docker-compose-lan.yml up -d`
- [ ] Monitor startup logs: `docker-compose logs -f`
- [ ] Wait for all health checks to pass: `docker-compose ps`

## Post-Deployment Validation

### Service Health Checks
- [ ] All containers running: `docker-compose ps` (all "Up (healthy)")
- [ ] API health: `curl -k https://archon.mcdonaldhomelab.com/api/health`
- [ ] Frontend accessible: `https://archon.mcdonaldhomelab.com`
- [ ] SSL certificate valid (green lock in browser)

### Functional Testing
- [ ] Login/authentication works
- [ ] Knowledge base upload/crawl functions
- [ ] Search functionality operational
- [ ] MCP tools accessible (if using MCP clients)
- [ ] API endpoints responding correctly

### Network Validation
- [ ] External access via domain works
- [ ] Internal service communication functional
- [ ] No direct port access (ports properly blocked)
- [ ] Traefik routing logs show correct backend selection

## Maintenance Setup

### Monitoring Configuration
- [ ] Log rotation configured for Docker containers
- [ ] Disk space monitoring for Docker volumes
- [ ] SSL certificate renewal monitoring
- [ ] Service restart policies verified

### Backup Procedures
- [ ] Supabase data backup strategy in place
- [ ] Docker volume backup if using local storage
- [ ] Configuration file backups (.env, docker-compose files)

### Update Process
- [ ] Git pull workflow established
- [ ] Container rebuild/restart procedure documented
- [ ] Rollback plan in case of deployment issues

## Security Validation

### Network Security
- [ ] Only ports 80/443 exposed to external networks
- [ ] MCP service not externally accessible
- [ ] Agents service not externally accessible  
- [ ] Internal Docker network properly isolated

### SSL/TLS Configuration
- [ ] HTTPS enforced for all external access
- [ ] Valid SSL certificates automatically obtained
- [ ] HTTP to HTTPS redirects functional
- [ ] SSL/TLS configuration rated A+ (test with ssllabs.com)

### Access Control
- [ ] No sensitive data in environment variables exposed
- [ ] API keys manageable via Archon UI
- [ ] Supabase RLS policies properly configured
- [ ] No default passwords or credentials in use

## Troubleshooting Guide

### Common Deployment Issues

**Container fails to start:**
- Check Docker logs: `docker-compose logs <service-name>`
- Verify environment variables in `.env`
- Confirm network connectivity to Supabase
- Check disk space and Docker resources

**SSL certificate not generated:**
- Verify DNS resolution from public internet
- Check Traefik logs for ACME challenge errors
- Confirm ports 80/443 accessible externally
- Review Let's Encrypt rate limits

**Frontend loads but API fails:**
- Test API directly: `curl https://archon.mcdonaldhomelab.com/api/health`
- Check Traefik routing configuration
- Verify backend service health
- Review CORS configuration

**Internal service communication errors:**
- Check Docker network configuration
- Verify service discovery environment variables
- Test internal connectivity: `docker exec archon-server ping archon-mcp`
- Review service dependency order

### Rollback Procedures

**Emergency rollback:**
```bash
# Stop LAN deployment
docker-compose -f docker-compose-lan.yml down

# Return to developer mode (if needed locally)
docker-compose up -d
```

**Configuration rollback:**
```bash
# Revert to previous configuration
git checkout HEAD~1 -- docker-compose-lan.yml .env.lan.example

# Redeploy with previous configuration  
docker-compose -f docker-compose-lan.yml up -d --build
```

## Success Criteria

### Technical Validation
- ✅ All services healthy and responsive
- ✅ SSL certificates valid and auto-renewing
- ✅ API endpoints returning expected responses
- ✅ Frontend fully functional with LAN access
- ✅ Internal service communication working
- ✅ No security vulnerabilities exposed

### User Experience Validation
- ✅ Archon accessible at `https://archon.mcdonaldhomelab.com`
- ✅ All features working as expected
- ✅ Performance acceptable for LAN usage
- ✅ Mobile/tablet access functional
- ✅ Browser compatibility confirmed

### Operational Readiness
- ✅ Monitoring and alerting configured
- ✅ Backup procedures established
- ✅ Update/maintenance procedures documented
- ✅ Support team trained on LAN deployment
- ✅ Documentation complete and accessible

## Final Sign-off

**Deployment completed by:** ________________  
**Date:** ________________  
**Validation completed by:** ________________  
**Date:** ________________

**Additional Notes:**
_________________________
_________________________
_________________________