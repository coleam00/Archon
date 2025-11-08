# Railway Deployment Guide

Complete guide for deploying Archon to Railway.app with Docker Compose support.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1: Prepare Your Repository](#step-1-prepare-your-repository)
- [Step 2: Create Railway Project](#step-2-create-railway-project)
- [Step 3: Configure Services](#step-3-configure-services)
- [Step 4: Set Environment Variables](#step-4-set-environment-variables)
- [Step 5: Deploy Services](#step-5-deploy-services)
- [Step 6: Configure Domains](#step-6-configure-domains)
- [Step 7: Verify Deployment](#step-7-verify-deployment)
- [Cost Estimation](#cost-estimation)
- [Monitoring & Maintenance](#monitoring--maintenance)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before deploying to Railway, ensure you have:

- [ ] **Railway Account** - Sign up at [railway.app](https://railway.app)
- [ ] **GitHub Repository** - Connected to Railway
- [ ] **Supabase Project** - With credentials ready
  - Supabase URL
  - Service Role Key (NOT anon key!)
- [ ] **API Keys** - At least one LLM provider
  - OpenAI API Key, OR
  - Anthropic API Key (recommended)
- [ ] **Railway CLI** (optional) - For advanced management

## Step 1: Prepare Your Repository

### 1.1 Review Configuration Files

Ensure these files exist in your repository:

```bash
# Check configuration files
ls -la railway.json           # Railway deployment config
ls -la .railwayignore         # Files to exclude from build
ls -la docker-compose.yml     # Multi-service orchestration
ls -la railway.env.template   # Environment variable reference
```

### 1.2 Commit and Push

```bash
git add .
git commit -m "feat: Add Railway deployment configuration"
git push origin main
```

## Step 2: Create Railway Project

### 2.1 Initialize Project

1. Go to [railway.app/new](https://railway.app/new)
2. Click **"Deploy from GitHub repo"**
3. Select your **Smart-Founds-Grant** repository
4. Railway will auto-detect `docker-compose.yml`

### 2.2 Railway Auto-Detection

Railway will automatically create services based on your docker-compose.yml:

- ✅ `archon-server` - Backend API (port 8181)
- ✅ `archon-mcp` - MCP server for IDE integration (port 8051)
- ✅ `archon-frontend` - React UI (port 3737)
- ⚠️ `archon-agents` - Disabled by default (opt-in with profile)

## Step 3: Configure Services

### 3.1 Service-Specific Settings

Railway creates a service for each container. Configure each:

#### **archon-server** (Backend)

- **Build Command**: Automatic (uses Dockerfile.server)
- **Start Command**: Defined in Dockerfile
- **Port**: 8181 (internal)
- **Health Check**: `/health` endpoint
- **Resources**: 2GB RAM, 2 vCPU (recommended)

#### **archon-mcp** (MCP Server)

- **Build Command**: Automatic (uses Dockerfile.mcp)
- **Start Command**: Defined in Dockerfile
- **Port**: 8051 (internal)
- **Health Check**: TCP socket check
- **Resources**: 1GB RAM, 1 vCPU

#### **archon-frontend** (React UI)

- **Build Command**: `npm run build`
- **Start Command**: `npm run preview` or `npm start`
- **Port**: 3737 (internal)
- **Health Check**: HTTP GET on `/`
- **Resources**: 1GB RAM, 1 vCPU

### 3.2 Enable Agents (Optional)

To enable the AI agents service:

1. Go to your project settings
2. Add environment variable: `AGENTS_ENABLED=true`
3. Railway will start the `archon-agents` service
4. **Warning**: This increases costs (~$10-15/month more)

## Step 4: Set Environment Variables

### 4.1 Shared Variables (All Services)

Add these to **all three services** (archon-server, archon-mcp, archon-frontend):

```bash
# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# LLM Providers (at least one required)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Environment
ENVIRONMENT=production
LOG_LEVEL=INFO

# Service Discovery
SERVICE_DISCOVERY_MODE=railway
```

### 4.2 Service-Specific Variables

#### **archon-server only**:

```bash
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
AGENTS_ENABLED=false  # or true if using agents
```

#### **archon-mcp only**:

```bash
ARCHON_MCP_PORT=8051
API_SERVICE_URL=http://archon-server.railway.internal:8181
TRANSPORT=sse
```

#### **archon-frontend only**:

```bash
ARCHON_UI_PORT=3737
PROD=true
VITE_SHOW_DEVTOOLS=false
```

### 4.3 Optional Variables

For enhanced monitoring and observability:

```bash
# Sentry (error tracking)
SENTRY_DSN=https://...@sentry.io/...

# Logfire (structured logging)
LOGFIRE_TOKEN=your-token

# OpenTelemetry (distributed tracing)
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
```

### 4.4 Using Railway CLI

Alternatively, use Railway CLI to set variables:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link

# Set variables for a service
railway variables set SUPABASE_URL=https://... --service archon-server
railway variables set SUPABASE_SERVICE_KEY=... --service archon-server
```

## Step 5: Deploy Services

### 5.1 Automatic Deployment

1. Railway will automatically deploy when you push to your repository
2. Monitor build logs in Railway dashboard
3. Each service builds independently

### 5.2 Manual Deployment

To trigger manual deployment:

1. Go to your project dashboard
2. Select a service
3. Click **"Deploy"** in the top right
4. Watch build logs for errors

### 5.3 Build Order

Railway builds services in dependency order:

1. **archon-server** builds first (5-8 minutes)
   - Installs Python dependencies
   - Installs Playwright browsers
   - Health check passes
2. **archon-mcp** builds next (2-3 minutes)
   - Waits for archon-server health check
3. **archon-frontend** builds last (3-5 minutes)
   - Waits for archon-server health check

**Total deployment time**: ~10-15 minutes

### 5.4 Monitoring Deployment

```bash
# Using Railway CLI
railway logs --service archon-server
railway logs --service archon-mcp
railway logs --service archon-frontend
```

## Step 6: Configure Domains

### 6.1 Generate Railway Domains

Railway provides free `.railway.app` domains:

1. Go to each service's **Settings** tab
2. Click **"Generate Domain"**
3. Railway creates: `<service>-production.up.railway.app`

Example domains:

- `archon-server-production.up.railway.app`
- `archon-mcp-production.up.railway.app`
- `archon-frontend-production.up.railway.app`

### 6.2 Custom Domains (Optional)

To use your own domain:

1. Go to service **Settings** → **Networking**
2. Click **"Add Custom Domain"**
3. Enter your domain: `app.archon.dev`
4. Add CNAME record to your DNS:
   ```
   CNAME app -> <service-name>.up.railway.app
   ```
5. Wait for DNS propagation (~5-60 minutes)

**Recommended custom domains**:

- Frontend: `app.archon.dev` or `archon.yourdomain.com`
- API: `api.archon.dev` or `api-archon.yourdomain.com`
- MCP: `mcp.archon.dev` or `mcp-archon.yourdomain.com`

### 6.3 SSL Certificates

Railway provides automatic SSL certificates:

- ✅ Free SSL for `.railway.app` domains
- ✅ Free SSL for custom domains (via Let's Encrypt)
- ✅ Auto-renewal

## Step 7: Verify Deployment

### 7.1 Health Checks

Test each service health endpoint:

```bash
# Backend API
curl https://archon-server-production.up.railway.app/health
# Expected: {"status": "healthy"}

# MCP Server
curl https://archon-mcp-production.up.railway.app/health
# Expected: {"status": "healthy"}

# Frontend (browser)
open https://archon-frontend-production.up.railway.app
```

### 7.2 Functional Tests

1. **Login to Frontend**
   - Visit your frontend URL
   - Verify UI loads correctly
   - Check for console errors

2. **Test API Connection**
   - Navigate to Settings page
   - Verify settings load
   - Test saving a setting

3. **Test MCP Server**
   - Go to MCP Tools page
   - Execute a simple tool (e.g., `find_projects`)
   - Verify response

4. **Test Knowledge Base**
   - Upload a document
   - Trigger RAG search
   - Verify results

### 7.3 Monitor Logs

```bash
# Watch logs in real-time
railway logs --service archon-server --follow
railway logs --service archon-mcp --follow
railway logs --service archon-frontend --follow
```

## Cost Estimation

### Railway Pricing

Railway uses usage-based pricing:

- **Hobby Plan**: $5/month + usage
- **Pro Plan**: $20/month + usage

### Expected Costs

For moderate traffic (100-500 requests/day):

| Service | Resources | Est. Cost/Month |
|---------|-----------|-----------------|
| archon-server | 2GB RAM, 2 vCPU | $8-12 |
| archon-mcp | 1GB RAM, 1 vCPU | $3-5 |
| archon-frontend | 1GB RAM, 1 vCPU | $3-5 |
| **Total (without agents)** | | **$14-22** |
| archon-agents (optional) | 2GB RAM, 2 vCPU | $10-15 |
| **Total (with agents)** | | **$24-37** |

### Cost Optimization Tips

1. **Disable Agents**: Set `AGENTS_ENABLED=false` if not needed
2. **Scale Down**: Reduce resources during low traffic periods
3. **Set Sleep Mode**: Use Railway's sleep mode for dev/staging
4. **Monitor Usage**: Set up billing alerts

## Monitoring & Maintenance

### 8.1 Set Usage Alerts

1. Go to **Project Settings** → **Billing**
2. Click **"Add Alert"**
3. Set threshold: `$50/month`
4. Add email notification

### 8.2 Uptime Monitoring

Use a service like:

- **UptimeRobot** (free tier available)
- **Pingdom**
- **Better Uptime**

Monitor endpoints:

- `https://your-frontend.railway.app/`
- `https://your-api.railway.app/health`

### 8.3 Log Management

Configure Logfire or similar:

1. Add `LOGFIRE_TOKEN` to environment
2. Logs stream to Logfire dashboard
3. Set up alerts for errors

### 8.4 Error Tracking

Configure Sentry:

1. Create Sentry project
2. Add `SENTRY_DSN` to environment
3. Errors automatically reported

## Troubleshooting

### Build Fails

**Symptom**: Service fails to build

**Common causes**:

1. **Missing dependencies**
   ```bash
   # Check pyproject.toml and package.json
   # Ensure all dependencies are listed
   ```

2. **Dockerfile syntax error**
   ```bash
   # Test locally first
   docker build -t test-server -f python/Dockerfile.server ./python
   ```

3. **Out of memory during build**
   ```bash
   # Increase build resources in Railway settings
   # Or optimize Dockerfile to use less memory
   ```

**Solution**:

- Check build logs in Railway dashboard
- Fix errors locally first
- Push and redeploy

### Service Won't Start

**Symptom**: Service builds but won't start

**Common causes**:

1. **Missing environment variables**
   ```bash
   # Check logs for missing variable errors
   railway logs --service archon-server
   ```

2. **Health check failing**
   ```bash
   # Verify health endpoint works locally
   curl http://localhost:8181/health
   ```

3. **Port mismatch**
   ```bash
   # Ensure service listens on correct port
   # Railway injects $PORT automatically
   ```

**Solution**:

- Review environment variables
- Check service logs
- Verify health check configuration

### High Costs

**Symptom**: Unexpected high usage costs

**Common causes**:

1. **Memory leaks** - Check for growing memory usage
2. **Infinite loops** - Review logs for repeated errors
3. **Too many workers** - Reduce `WEB_CONCURRENCY`
4. **Unused services** - Disable agents if not needed

**Solution**:

- Review Railway metrics dashboard
- Optimize resource allocation
- Set up billing alerts
- Consider scaling down during off-hours

### CORS Errors

**Symptom**: Frontend can't connect to API

**Solution**:

```bash
# Add VITE_ALLOWED_HOSTS to frontend service
VITE_ALLOWED_HOSTS=your-api-domain.railway.app

# Or configure CORS in backend (if needed)
# Railway internal networking should handle this automatically
```

### Database Connection Issues

**Symptom**: Can't connect to Supabase

**Common causes**:

1. **Wrong API key** - Using anon instead of service_role
2. **Invalid URL** - Incorrect Supabase project URL
3. **Network restrictions** - Supabase firewall rules

**Solution**:

```bash
# Verify credentials
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_KEY

# Test connection
curl -H "apikey: $SUPABASE_SERVICE_KEY" "$SUPABASE_URL/rest/v1/"
```

### MCP Server Not Accessible

**Symptom**: MCP tools not working

**Solution**:

```bash
# Check MCP service health
curl https://your-mcp.railway.app/health

# Verify API_SERVICE_URL is correct
railway variables --service archon-mcp

# Ensure archon-server is healthy first
railway logs --service archon-server
```

## Advanced Configuration

### Using Railway Private Networking

For better security and performance:

1. Enable **Private Networking** in project settings
2. Services can communicate via `<service-name>.railway.internal`
3. Update `API_SERVICE_URL` in archon-mcp:
   ```bash
   API_SERVICE_URL=http://archon-server.railway.internal:8181
   ```

### Staging Environment

Create a separate Railway environment for staging:

```bash
# Using Railway CLI
railway environment create staging
railway link --environment staging

# Deploy to staging
git push origin staging
```

### Database Migrations

For Supabase schema updates:

1. Test migrations in local Supabase
2. Run migration SQL in Supabase dashboard
3. Verify via Settings UI in Archon
4. Redeploy services if schema changes affect code

## Rollback Procedure

If deployment fails:

1. **Immediate rollback**:
   ```bash
   railway rollback --service archon-server
   ```

2. **Revert to previous commit**:
   ```bash
   git revert HEAD
   git push origin main
   # Railway auto-deploys previous version
   ```

3. **Manual intervention**:
   - Go to service **Deployments** tab
   - Find last working deployment
   - Click **"Redeploy"**

## Support

- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Railway Discord**: [discord.gg/railway](https://discord.gg/railway)
- **Archon Issues**: GitHub repository issues
- **Supabase Support**: [supabase.com/support](https://supabase.com/support)

## Next Steps

After successful deployment:

- [ ] Set up monitoring and alerts
- [ ] Configure custom domains
- [ ] Enable error tracking (Sentry)
- [ ] Set up log aggregation (Logfire)
- [ ] Create staging environment
- [ ] Document any custom configurations
- [ ] Schedule regular health checks
- [ ] Plan for backups and disaster recovery

---

**Deployment Status**: ✅ Complete

Last updated: 2025-11-08
