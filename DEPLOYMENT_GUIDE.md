# Archon Deployment Guide

## Overview

Archon can be deployed using two approaches:

### Option A: Full Railway Deployment (Recommended)
**Best for**: Production deployments requiring full features, long-running operations, and multi-service orchestration.

**Advantages**:
- Native Docker Compose support (all services in one platform)
- No size limits (backend ~800MB Docker image)
- No timeout limits (supports minutes-long crawling operations)
- Stateful architecture support
- Simpler environment variable management
- Lower cost (single platform)

### Option B: Hybrid Deployment (Vercel Frontend + Railway Backend)
**Best for**: Teams preferring Vercel's CDN for frontend performance.

**Advantages**:
- Vercel's global CDN for frontend assets
- Fast edge deployment for UI updates
- Separation of frontend and backend concerns

**Limitations**:
- More complex setup (two platforms)
- CORS configuration required
- Higher cost (two platforms)
- More environment variables to manage

---

## Prerequisites

### Required Accounts
1. **Railway Account**: https://railway.app (for both options)
2. **Vercel Account**: https://vercel.com (only for Option B)
3. **Supabase Account**: https://supabase.com
4. **Anthropic API Key**: https://console.anthropic.com (for Claude)
5. **OpenAI API Key**: https://platform.openai.com (optional)

### Required Tools (Local Development)
- Git
- Docker & Docker Compose (for local testing)
- Node.js 20+ (for frontend development)
- Python 3.12+ (for backend development)

---

## Option A: Full Railway Deployment (Recommended)

### Step 1: Prepare Your Repository

1. **Ensure all changes are committed and pushed**:
```bash
git add .
git commit -m "chore: Prepare for Railway deployment"
git push origin main
```

2. **Verify critical files exist**:
- `railway.json` - Railway configuration ✅
- `railway.env.template` - Environment variables template ✅
- `docker-compose.yml` - Multi-service orchestration ✅
- `python/Dockerfile.server` - Backend server image ✅
- `python/Dockerfile.mcp` - MCP server image ✅
- `archon-ui-main/Dockerfile` - Frontend image ✅

### Step 2: Create Railway Project

1. **Login to Railway**: https://railway.app/dashboard

2. **Create New Project**:
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Connect your GitHub account
   - Select `Smart-Founds-Grant` repository
   - Railway will auto-detect `docker-compose.yml`

3. **Railway creates 4 services automatically**:
   - `archon-server` (FastAPI backend)
   - `archon-mcp` (MCP server)
   - `archon-frontend` (React UI)
   - `archon-agents` (AI agents - optional, requires profile)

### Step 3: Configure Environment Variables

For each service, add the required environment variables from `railway.env.template`:

#### Service: archon-server

**Required Variables**:
```bash
# Supabase (CRITICAL)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# LLM Provider (at least one required)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Application Settings
ENVIRONMENT=production
LOG_LEVEL=INFO
SERVICE_DISCOVERY_MODE=railway

# Ports (Railway auto-assigns)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052

# Features
AGENTS_ENABLED=false
ENABLE_CLAUDE_CACHING=true

# CORS Security (CRITICAL)
ALLOWED_ORIGINS=https://your-railway-frontend.up.railway.app
```

**Optional Variables**:
```bash
# Observability (recommended for production)
SENTRY_DSN=https://...@sentry.io/...
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
LOGFIRE_TOKEN=your-logfire-token

# Performance
WEB_CONCURRENCY=1
```

#### Service: archon-mcp

**Required Variables**:
```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# Service Discovery
SERVICE_DISCOVERY_MODE=railway
TRANSPORT=sse

# Ports
ARCHON_MCP_PORT=8051
ARCHON_SERVER_PORT=8181

# Features
AGENTS_ENABLED=false
```

#### Service: archon-frontend

**Required Variables**:
```bash
# Production Mode
PROD=true
VITE_SHOW_DEVTOOLS=false

# Backend URL (Railway auto-generates this)
# Leave empty - Railway will proxy through frontend service
VITE_API_URL=

# CORS (if frontend on different domain)
ALLOWED_ORIGINS=
```

#### Service: archon-agents (Optional)

Only configure if you enable the agents profile. Same as archon-server but with:
```bash
ARCHON_AGENTS_PORT=8052
```

### Step 4: Enable Health Checks

Railway automatically configures health checks from `railway.json`:

```json
{
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 100
  }
}
```

Verify health endpoints respond:
- Server: `https://your-server.up.railway.app/health`
- MCP: `https://your-mcp.up.railway.app/health`
- Agents: `https://your-agents.up.railway.app/health` (if enabled)

### Step 5: Configure Custom Domain (Optional)

1. Go to `archon-frontend` service settings
2. Click "Networking" → "Custom Domain"
3. Add your domain (e.g., `archon.yourdomain.com`)
4. Update DNS with Railway's CNAME record
5. Update CORS in `archon-server` environment variables:
   ```bash
   ALLOWED_ORIGINS=https://archon.yourdomain.com
   ```

### Step 6: Deploy

1. **Trigger Deployment**:
   - Railway auto-deploys on every `git push` to main
   - Or click "Deploy" in Railway dashboard

2. **Monitor Deployment**:
   - Watch build logs in Railway dashboard
   - Verify all services start successfully
   - Check health checks pass

3. **Deployment Order** (Railway handles automatically):
   - archon-server (starts first, has health check)
   - archon-mcp (waits for server health check)
   - archon-frontend (waits for server health check)
   - archon-agents (optional, if enabled)

### Step 7: Verify Deployment

1. **Access Frontend**:
   - Visit: `https://your-frontend.up.railway.app`
   - Or custom domain: `https://archon.yourdomain.com`

2. **Test Backend Health**:
```bash
curl https://your-server.up.railway.app/health
# Expected: {"status": "healthy"}
```

3. **Test MCP Server**:
```bash
curl https://your-mcp.up.railway.app/health
# Expected: {"status": "healthy"}
```

4. **Test Full Stack**:
   - Login to Archon UI
   - Try crawling a website (Knowledge Base → Add Source)
   - Verify RAG search works
   - Check MCP tools (if using IDE integration)

### Step 8: Post-Deployment Configuration

1. **Enable Monitoring**:
   - Set up Sentry for error tracking
   - Configure OpenTelemetry for distributed tracing
   - Enable Logfire for structured logging

2. **Configure Supabase**:
   - Verify RLS policies are correct
   - Enable point-in-time recovery (PITR)
   - Set up automated backups

3. **Security Hardening**:
   - Review CORS configuration
   - Verify API authentication (once JWT is implemented)
   - Enable rate limiting
   - Review Supabase security settings

---

## Option B: Hybrid Deployment (Vercel Frontend + Railway Backend)

### Step 1: Deploy Backend to Railway

Follow **Option A Steps 1-3** but skip `archon-frontend` service configuration.

### Step 2: Configure Backend for CORS

In Railway `archon-server` environment variables:

```bash
# CRITICAL: Add Vercel domain to CORS whitelist
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-app-<hash>.vercel.app
```

**Important**: Vercel generates a unique hash for each deployment. Add both:
- Production domain: `your-app.vercel.app`
- Preview domains: `your-app-*.vercel.app` (use wildcard subdomain)

### Step 3: Get Railway Backend URL

After Railway deployment completes:

1. Go to `archon-server` service
2. Copy the public URL: `https://your-server.up.railway.app`
3. Save this URL for Vercel configuration

### Step 4: Deploy Frontend to Vercel

1. **Install Vercel CLI** (optional):
```bash
npm install -g vercel
```

2. **Login to Vercel**:
```bash
vercel login
```

3. **Deploy from Root Directory**:

Using CLI:
```bash
# From project root
vercel --prod

# Vercel will detect vercel.json configuration
# Build command: cd archon-ui-main && npm install --legacy-peer-deps && npm run build
# Output directory: archon-ui-main/dist
```

Using Vercel Dashboard:
- Go to https://vercel.com/new
- Import `Smart-Founds-Grant` repository
- Configure:
  - **Root Directory**: Leave as `.` (vercel.json handles this)
  - **Build Command**: Auto-detected from `vercel.json`
  - **Output Directory**: Auto-detected from `vercel.json`
  - **Install Command**: `npm install --legacy-peer-deps`

### Step 5: Configure Vercel Environment Variables

In Vercel project settings → Environment Variables:

```bash
# Backend URL (from Railway)
VITE_API_URL=https://your-server.up.railway.app

# Production settings
VITE_SHOW_DEVTOOLS=false
NODE_ENV=production
```

### Step 6: Update Railway CORS (Again)

After Vercel deployment, update Railway `archon-server` CORS:

```bash
# Add actual Vercel URLs
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-app-git-main-youruser.vercel.app
```

### Step 7: Verify Hybrid Deployment

1. **Test Frontend**:
   - Visit: `https://your-app.vercel.app`
   - Check browser console for CORS errors (should be none)

2. **Test API Connection**:
   - Open browser DevTools → Network tab
   - Verify API requests go to Railway backend
   - Check for 200 responses (not 403 or 502)

3. **Test End-to-End**:
   - Try crawling a website
   - Verify RAG search works
   - Check all features function correctly

---

## Environment Variables Reference

### Critical Variables (Must Configure)

| Variable | Service | Description | Example |
|----------|---------|-------------|---------|
| `SUPABASE_URL` | server, mcp, agents | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | server, mcp, agents | Supabase service role key | `eyJhbGc...` |
| `ANTHROPIC_API_KEY` | server | Claude API key | `sk-ant-...` |
| `ALLOWED_ORIGINS` | server | CORS whitelist (comma-separated) | `https://app.vercel.app` |

### Optional Variables (Recommended for Production)

| Variable | Service | Description | Default |
|----------|---------|-------------|---------|
| `SENTRY_DSN` | server, frontend | Error tracking | None |
| `ENABLE_CLAUDE_CACHING` | server | Reduce LLM costs by 70% | `true` |
| `LOG_LEVEL` | server, mcp | Logging verbosity | `INFO` |
| `WEB_CONCURRENCY` | server | Uvicorn workers | `1` |
| `AGENTS_ENABLED` | server, mcp | Enable AI agents service | `false` |

### Full List

See `railway.env.template` for complete documentation.

---

## Troubleshooting

### Issue: Frontend can't connect to backend (CORS errors)

**Symptoms**:
```
Access to fetch at 'https://backend.railway.app/api/projects' from origin 'https://frontend.vercel.app'
has been blocked by CORS policy
```

**Solution**:
1. Check Railway `archon-server` logs for CORS rejections
2. Verify `ALLOWED_ORIGINS` includes exact Vercel URL
3. Check for trailing slashes (must match exactly)
4. Restart Railway service after updating CORS

**Validation**:
```bash
# Test CORS preflight
curl -X OPTIONS https://your-server.up.railway.app/api/projects \
  -H "Origin: https://your-app.vercel.app" \
  -H "Access-Control-Request-Method: GET" \
  -v

# Should see:
# Access-Control-Allow-Origin: https://your-app.vercel.app
```

### Issue: Railway build fails (out of memory)

**Symptoms**:
```
Error: Docker build failed
Killed (Out of memory)
```

**Solution**:
1. Railway offers 8GB RAM during builds (should be enough)
2. Check Dockerfile for memory-intensive steps
3. Use multi-stage builds (already configured)
4. Disable agents service if not needed:
   ```bash
   AGENTS_ENABLED=false
   ```

### Issue: Health check failures

**Symptoms**:
```
Health check failed: Connection refused
Service is unhealthy
```

**Solution**:
1. Check service logs for startup errors
2. Verify environment variables are set correctly
3. Check Supabase connection (most common cause)
4. Increase health check timeout:
   ```json
   {
     "deploy": {
       "healthcheckTimeout": 200
     }
   }
   ```

### Issue: Vercel build fails (peer dependencies)

**Symptoms**:
```
npm ERR! peer react@"15.x || 16.x || 17.x || 18.x" from @sentry/react@7.120.4
```

**Solution**:
1. Verify `vercel.json` has correct install command:
   ```json
   {
     "installCommand": "npm install --legacy-peer-deps"
   }
   ```
2. Check `package.json` has Sentry v10:
   ```json
   {
     "dependencies": {
       "@sentry/react": "^10.0.0"
     }
   }
   ```

### Issue: MCP service can't connect to server

**Symptoms**:
```
Failed to connect to archon-server:8181
Connection refused
```

**Solution**:
1. Verify `SERVICE_DISCOVERY_MODE=railway` in both services
2. Check Railway internal networking is enabled
3. Verify archon-server health check passes before MCP starts
4. Check Railway service dependency order:
   - archon-server must start first
   - archon-mcp depends on archon-server health check

### Issue: 502 Bad Gateway from Railway

**Symptoms**:
```
502 Bad Gateway
nginx/1.21.1
```

**Solution**:
1. Service crashed during startup - check logs
2. Health check failing - verify `/health` endpoint responds
3. Port mismatch - verify `ARCHON_SERVER_PORT=8181` matches Dockerfile EXPOSE
4. Out of memory - check Railway metrics, upgrade plan if needed

---

## Cost Estimation

### Railway (Full Stack)

**Hobby Plan** ($5/month):
- 512MB RAM per service
- 1GB disk
- Shared CPU
- **Total**: $5/month for 1 project (3 services)

**Pro Plan** ($20/month):
- 8GB RAM per service
- 100GB disk
- Dedicated CPU
- **Total**: $20/month for unlimited projects

**Recommended**: Start with Hobby, upgrade to Pro when you exceed limits.

### Vercel (Frontend Only)

**Hobby** (Free):
- 100GB bandwidth/month
- 6000 build minutes/month
- **Limitations**: Hobby plan shows Vercel branding

**Pro** ($20/month):
- 1TB bandwidth
- Unlimited builds
- Custom domains
- No branding

### Hybrid (Vercel + Railway)

**Minimum**: Free (Vercel Hobby + Railway Hobby trial)
**Recommended**: $25/month (Vercel Pro $20 + Railway Hobby $5)
**Production**: $40/month (Vercel Pro $20 + Railway Pro $20)

---

## Performance Optimization

### Railway

1. **Enable Build Caching**:
   ```json
   {
     "build": {
       "builder": "DOCKERFILE"
     }
   }
   ```
   Already configured in `railway.json` ✅

2. **Use Uvicorn with Single Worker**:
   ```bash
   WEB_CONCURRENCY=1
   ```
   Railway's vertical scaling is more efficient than horizontal

3. **Enable Claude Caching**:
   ```bash
   ENABLE_CLAUDE_CACHING=true
   ```
   Reduces LLM costs by 70%

### Vercel

1. **Edge Functions** (not applicable - Archon uses SSR)

2. **Asset Optimization**:
   - Vite already optimizes bundles ✅
   - Code splitting enabled (61% reduction) ✅
   - Brotli compression automatic on Vercel ✅

3. **CDN Caching**:
   ```json
   {
     "headers": [
       {
         "source": "/assets/(.*)",
         "headers": [
           {
             "key": "Cache-Control",
             "value": "public, max-age=31536000, immutable"
           }
         ]
       }
     ]
   }
   ```
   Already configured in `vercel.json` ✅

---

## Security Checklist

### Pre-Deployment

- [ ] Review CORS configuration (no wildcards with credentials)
- [ ] Verify Supabase RLS policies are enabled
- [ ] Check all environment variables are set correctly
- [ ] Remove any hardcoded secrets from code
- [ ] Verify `.env` files are in `.gitignore`

### Post-Deployment

- [ ] Enable HTTPS (automatic on Railway/Vercel)
- [ ] Configure custom domain with SSL
- [ ] Set up Sentry for error tracking
- [ ] Enable rate limiting (via Railway/Vercel)
- [ ] Implement JWT authentication (pending - see IMPLEMENTATION_SUMMARY.md)
- [ ] Review Supabase security settings
- [ ] Enable database backups
- [ ] Set up monitoring and alerts

### Production Readiness

**Blockers** (must implement before production):
- [ ] JWT authentication (5-7 days estimated)

**Recommended** (can deploy without, but should add soon):
- [ ] Correlation IDs for debugging (2 hours)
- [ ] Database connection pooling (4 hours)
- [ ] E2E tests with Playwright (1 week)

See `BEST_PRACTICES_2025_CONSOLIDATED.md` for complete roadmap.

---

## Rollback Procedure

### Railway

1. **Via Dashboard**:
   - Go to service → Deployments
   - Find previous successful deployment
   - Click "Redeploy"

2. **Via Git**:
   ```bash
   git revert <commit-hash>
   git push origin main
   # Railway auto-deploys
   ```

### Vercel

1. **Via Dashboard**:
   - Go to project → Deployments
   - Find previous deployment
   - Click "Promote to Production"

2. **Via CLI**:
   ```bash
   vercel rollback <deployment-url>
   ```

---

## Next Steps

After successful deployment:

1. **Monitoring**:
   - Set up Sentry error tracking
   - Configure uptime monitoring (e.g., UptimeRobot)
   - Enable Railway metrics dashboard

2. **Performance**:
   - Implement remaining optimizations from `BEST_PRACTICES_2025_CONSOLIDATED.md`
   - Add correlation IDs for debugging
   - Configure database connection pooling

3. **Security**:
   - Implement JWT authentication (production blocker)
   - Set up automated security scanning
   - Review Supabase security audit

4. **Testing**:
   - Add E2E tests with Playwright
   - Increase test coverage (60%+ frontend, 75%+ backend)
   - Set up CI/CD with GitHub Actions

5. **Features**:
   - Enable AI agents service (if needed)
   - Configure hybrid search (70% better relevance)
   - Enable reranking (15% accuracy improvement)

---

## Support

**Issues**: https://github.com/bilalmachraa82/Smart-Founds-Grant/issues

**Railway Docs**: https://docs.railway.app
**Vercel Docs**: https://vercel.com/docs
**Supabase Docs**: https://supabase.com/docs

---

**Last Updated**: 2025-11-08
**Branch**: `claude/system-logic-analysis-011CUJxdL8NVMoV8KTKrmyt9`
**Status**: ✅ Ready for deployment
