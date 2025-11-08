# Railway Deployment Checklist

Use this checklist to ensure a smooth deployment to Railway. Check off each item as you complete it.

## Pre-Deployment Preparation

### Code & Repository

- [ ] All code changes committed to Git
- [ ] All tests passing locally
  ```bash
  make test  # Run all tests
  ```
- [ ] Local Docker builds successful
  ```bash
  docker compose build  # Build all services
  docker compose up -d  # Start all services
  ```
- [ ] No sensitive data in repository
  - [ ] No `.env` file committed
  - [ ] No API keys in code
  - [ ] No hardcoded credentials
- [ ] GitHub repository pushed to remote
  ```bash
  git push origin main
  ```

### Configuration Files

- [ ] `railway.json` exists in repository root
- [ ] `.railwayignore` exists in repository root
- [ ] `docker-compose.yml` is Railway-compatible
- [ ] `railway.env.template` is up to date
- [ ] `RAILWAY_DEPLOYMENT.md` guide is available

### External Services

- [ ] **Supabase project created**
  - [ ] Database schema deployed
  - [ ] Row Level Security (RLS) configured
  - [ ] API URL copied
  - [ ] Service Role key copied (NOT anon key!)
- [ ] **LLM API keys obtained** (at least one)
  - [ ] OpenAI API key, OR
  - [ ] Anthropic API key (recommended)
- [ ] **Optional monitoring services**
  - [ ] Sentry project created (for error tracking)
  - [ ] Logfire account setup (for structured logging)
  - [ ] OpenTelemetry endpoint configured (optional)

### Railway Account

- [ ] Railway account created at [railway.app](https://railway.app)
- [ ] GitHub connected to Railway
- [ ] Payment method added (if not on free tier)
- [ ] Usage alerts configured ($50/month recommended)

## Deployment Steps

### Step 1: Create Railway Project

- [ ] Navigate to [railway.app/new](https://railway.app/new)
- [ ] Select "Deploy from GitHub repo"
- [ ] Choose `Smart-Founds-Grant` repository
- [ ] Railway detects `docker-compose.yml`
- [ ] All services created automatically:
  - [ ] `archon-server`
  - [ ] `archon-mcp`
  - [ ] `archon-frontend`

### Step 2: Configure Environment Variables

#### All Services (archon-server, archon-mcp, archon-frontend)

- [ ] Set required variables:
  - [ ] `SUPABASE_URL=https://your-project.supabase.co`
  - [ ] `SUPABASE_SERVICE_KEY=your-service-role-key`
  - [ ] `OPENAI_API_KEY=sk-...` (if using OpenAI)
  - [ ] `ANTHROPIC_API_KEY=sk-ant-...` (if using Anthropic)
  - [ ] `ENVIRONMENT=production`
  - [ ] `LOG_LEVEL=INFO`
  - [ ] `SERVICE_DISCOVERY_MODE=railway`

#### archon-server specific

- [ ] Set service variables:
  - [ ] `ARCHON_SERVER_PORT=8181`
  - [ ] `ARCHON_MCP_PORT=8051`
  - [ ] `ARCHON_AGENTS_PORT=8052`
  - [ ] `AGENTS_ENABLED=false` (or `true` if using agents)

#### archon-mcp specific

- [ ] Set service variables:
  - [ ] `ARCHON_MCP_PORT=8051`
  - [ ] `API_SERVICE_URL=http://archon-server.railway.internal:8181`
  - [ ] `TRANSPORT=sse`

#### archon-frontend specific

- [ ] Set service variables:
  - [ ] `ARCHON_UI_PORT=3737`
  - [ ] `PROD=true`
  - [ ] `VITE_SHOW_DEVTOOLS=false`

#### Optional monitoring variables (all services)

- [ ] `SENTRY_DSN=https://...@sentry.io/...`
- [ ] `LOGFIRE_TOKEN=your-token`
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT=https://...`

### Step 3: Deploy Services

- [ ] Trigger deployment (automatic on push, or manual via Railway dashboard)
- [ ] Monitor build logs for each service:
  - [ ] archon-server build completes (5-8 minutes)
  - [ ] archon-mcp build completes (2-3 minutes)
  - [ ] archon-frontend build completes (3-5 minutes)
- [ ] All services show "Deployed" status
- [ ] No build errors in logs

### Step 4: Configure Networking

#### Generate Railway Domains

- [ ] Generate domain for archon-server
  - [ ] Domain: `archon-server-production.up.railway.app`
- [ ] Generate domain for archon-mcp
  - [ ] Domain: `archon-mcp-production.up.railway.app`
- [ ] Generate domain for archon-frontend
  - [ ] Domain: `archon-frontend-production.up.railway.app`

#### Custom Domains (Optional)

- [ ] Add custom domain for frontend: `app.archon.dev`
- [ ] Add custom domain for API: `api.archon.dev`
- [ ] Add custom domain for MCP: `mcp.archon.dev`
- [ ] Configure DNS CNAME records
- [ ] Wait for SSL certificate provisioning
- [ ] Verify HTTPS works

### Step 5: Health Checks

- [ ] Test archon-server health endpoint
  ```bash
  curl https://archon-server-production.up.railway.app/health
  # Expected: {"status": "healthy"}
  ```
- [ ] Test archon-mcp health endpoint
  ```bash
  curl https://archon-mcp-production.up.railway.app/health
  # Expected: {"status": "healthy"}
  ```
- [ ] Test archon-frontend loads
  ```bash
  open https://archon-frontend-production.up.railway.app
  # Should load the UI successfully
  ```

### Step 6: Functional Testing

#### Frontend Tests

- [ ] Visit frontend URL
- [ ] UI loads without errors
- [ ] No console errors in browser DevTools
- [ ] Navigation works (all pages accessible)

#### Backend API Tests

- [ ] Navigate to Settings page
- [ ] Settings load correctly
- [ ] Can save settings
- [ ] Changes persist after refresh

#### MCP Server Tests

- [ ] Navigate to MCP Tools page
- [ ] MCP server status shows "Connected"
- [ ] Execute simple tool (e.g., `find_projects`)
- [ ] Tool executes successfully with response

#### Knowledge Base Tests

- [ ] Upload a test document
- [ ] Document appears in knowledge sources
- [ ] Perform RAG search
- [ ] Search returns relevant results

#### End-to-End Test

- [ ] Create a new project
- [ ] Add tasks to project
- [ ] Upload document to project
- [ ] Search across knowledge base
- [ ] Execute MCP tool to find project
- [ ] All operations complete successfully

## Post-Deployment Configuration

### Monitoring Setup

- [ ] Configure usage alerts in Railway
  - [ ] Set threshold: $50/month
  - [ ] Add email notification
- [ ] Setup uptime monitoring
  - [ ] UptimeRobot or similar service
  - [ ] Monitor frontend URL
  - [ ] Monitor API health endpoint
- [ ] Configure error tracking
  - [ ] Sentry receiving errors
  - [ ] Alert rules configured
- [ ] Setup log aggregation
  - [ ] Logfire receiving logs
  - [ ] Dashboards created

### Security Review

- [ ] All sensitive variables in Railway (not in code)
- [ ] HTTPS enabled on all domains
- [ ] CORS configured correctly
- [ ] Supabase RLS policies active
- [ ] API rate limiting configured
- [ ] No debug endpoints exposed

### Performance Optimization

- [ ] Resource allocation reviewed
  - [ ] archon-server: 2GB RAM, 2 vCPU
  - [ ] archon-mcp: 1GB RAM, 1 vCPU
  - [ ] archon-frontend: 1GB RAM, 1 vCPU
- [ ] Health check intervals optimized
- [ ] Caching configured (ETag support)
- [ ] Database connection pooling active

### Documentation

- [ ] Deployment documented
  - [ ] Railway project URL saved
  - [ ] Domain names documented
  - [ ] Service URLs recorded
- [ ] Credentials secured
  - [ ] API keys in password manager
  - [ ] Railway credentials secured
  - [ ] Supabase credentials secured
- [ ] Team access configured
  - [ ] Railway team members invited
  - [ ] Roles assigned correctly

## Ongoing Maintenance

### Daily

- [ ] Check service health (automated monitoring)
- [ ] Review error logs (if alerts triggered)

### Weekly

- [ ] Review Railway usage/costs
- [ ] Check for service restarts
- [ ] Review application logs
- [ ] Monitor performance metrics

### Monthly

- [ ] Review and optimize costs
- [ ] Update dependencies
- [ ] Review security alerts
- [ ] Backup critical data
- [ ] Test disaster recovery plan

## Rollback Plan

In case of deployment issues:

### Immediate Rollback (via Railway CLI)

```bash
railway rollback --service archon-server
railway rollback --service archon-mcp
railway rollback --service archon-frontend
```

### Git Rollback

```bash
git revert HEAD
git push origin main
# Railway auto-deploys previous version
```

### Manual Rollback

- [ ] Go to service **Deployments** tab in Railway
- [ ] Find last working deployment
- [ ] Click **"Redeploy"**
- [ ] Verify services return to working state

## Success Criteria

Deployment is successful when:

- [x] All services deployed and running
- [x] All health checks passing
- [x] Frontend accessible and functional
- [x] API responding to requests
- [x] MCP server accessible
- [x] Database connection established
- [x] No errors in logs
- [x] Monitoring and alerts active
- [x] SSL certificates valid
- [x] Custom domains working (if configured)

## Cost Validation

- [ ] Current costs within budget
- [ ] Usage alerts configured
- [ ] No unexpected charges
- [ ] Resource allocation optimized

**Expected monthly cost**: $14-22 (without agents) or $24-37 (with agents)

## Support Resources

- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Railway Discord**: [discord.gg/railway](https://discord.gg/railway)
- **Deployment Guide**: See `RAILWAY_DEPLOYMENT.md`
- **Environment Variables**: See `railway.env.template`

## Deployment Sign-Off

- [ ] Deployment completed successfully
- [ ] All tests passing
- [ ] Monitoring active
- [ ] Documentation updated
- [ ] Team notified

**Deployed by**: _____________________
**Deployment date**: _____________________
**Railway project URL**: _____________________
**Frontend URL**: _____________________
**API URL**: _____________________
**MCP URL**: _____________________

---

**Status**: ✅ Ready for Production

Last updated: 2025-11-08
