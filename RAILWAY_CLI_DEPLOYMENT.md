# Railway CLI Deployment Guide

## Quick Deploy (TL;DR)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Link services
railway service

# Set environment variables
railway variables set SUPABASE_URL=<your-url>
railway variables set SUPABASE_SERVICE_KEY=<your-key>
railway variables set ANTHROPIC_API_KEY=<your-key>
# ... more variables (see below)

# Deploy!
railway up
```

---

## Detailed Step-by-Step Guide

### Prerequisites

- Node.js 18+ installed
- Git repository pushed to GitHub
- Supabase project created
- Anthropic/OpenAI API keys

### Step 1: Install Railway CLI

**Option A: NPM (Recommended)**
```bash
npm install -g @railway/cli
```

**Option B: Shell Script (Linux/macOS)**
```bash
curl -fsSL https://railway.app/install.sh | sh
```

**Option C: Homebrew (macOS)**
```bash
brew install railway
```

**Option D: Manual Download (Windows/Linux/macOS)**
Download from: https://github.com/railwayapp/cli/releases

**Verify Installation**:
```bash
railway --version
# Should output: railway version 4.x.x
```

### Step 2: Login to Railway

```bash
railway login
```

This will:
1. Open a browser window
2. Prompt you to authorize Railway CLI
3. Store authentication token locally

**Verify Login**:
```bash
railway whoami
# Should output: Logged in as <your-email>
```

### Step 3: Initialize Railway Project

From the project root directory (`/home/user/Smart-Founds-Grant`):

```bash
# Initialize new Railway project
railway init

# Prompts:
# ? Enter project name: archon-production
# ? Select a team: <your-team>
```

This creates a `.railway` directory with project metadata.

**What This Does**:
- Creates a new Railway project
- Links your local directory to Railway
- Detects `docker-compose.yml` automatically
- Creates services for each container

### Step 4: View Created Services

```bash
railway status

# Output shows:
# Project: archon-production
# Services:
#   - archon-server (from docker-compose.yml)
#   - archon-mcp (from docker-compose.yml)
#   - archon-frontend (from docker-compose.yml)
```

### Step 5: Configure Environment Variables

Railway needs environment variables for each service. You have two options:

#### Option A: Interactive (Easier)

```bash
# Select a service
railway service

# Prompts:
# ? Select a service:
#   > archon-server
#     archon-mcp
#     archon-frontend

# After selecting, set variables:
railway variables set SUPABASE_URL=https://your-project.supabase.co
railway variables set SUPABASE_SERVICE_KEY=your-service-key-here
railway variables set ANTHROPIC_API_KEY=sk-ant-your-key-here
railway variables set OPENAI_API_KEY=sk-your-key-here
railway variables set ALLOWED_ORIGINS=https://archon-production.up.railway.app
railway variables set ENVIRONMENT=production
railway variables set LOG_LEVEL=INFO
railway variables set SERVICE_DISCOVERY_MODE=railway
railway variables set ARCHON_SERVER_PORT=8181
railway variables set ARCHON_MCP_PORT=8051
railway variables set ARCHON_AGENTS_PORT=8052
railway variables set AGENTS_ENABLED=false
railway variables set ENABLE_CLAUDE_CACHING=true
railway variables set WEB_CONCURRENCY=1
railway variables set PYTHONUNBUFFERED=1
railway variables set PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
```

Repeat for each service (archon-mcp, archon-frontend).

#### Option B: Bulk Import (Faster)

Create a `.env` file for each service:

**archon-server.env**:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-key-here
ALLOWED_ORIGINS=https://archon-production.up.railway.app
ENVIRONMENT=production
LOG_LEVEL=INFO
SERVICE_DISCOVERY_MODE=railway
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
AGENTS_ENABLED=false
ENABLE_CLAUDE_CACHING=true
WEB_CONCURRENCY=1
PYTHONUNBUFFERED=1
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
```

Then import:
```bash
railway service archon-server
railway variables set --from-env-file archon-server.env

railway service archon-mcp
railway variables set --from-env-file archon-mcp.env

railway service archon-frontend
railway variables set --from-env-file archon-frontend.env
```

**Complete variable templates are in** `railway-env-templates/` directory.

#### Verify Variables Set

```bash
railway service archon-server
railway variables

# Should list all variables you just set
```

### Step 6: Deploy Services

**Deploy All Services**:
```bash
railway up
```

**Deploy Specific Service**:
```bash
railway service archon-server
railway up
```

**What Happens During Deploy**:
1. Railway detects `docker-compose.yml`
2. Builds Docker images for each service
3. Pushes images to Railway registry
4. Starts containers with environment variables
5. Assigns public URLs to services
6. Runs health checks

**Monitor Deployment**:
```bash
# Follow logs in real-time
railway logs --follow

# Or specify service
railway service archon-server
railway logs --follow
```

### Step 7: Get Service URLs

```bash
railway service archon-server
railway domain

# Output:
# Service Domains:
#   - https://archon-server-production-xxxx.up.railway.app
```

Repeat for each service to get their URLs.

### Step 8: Update CORS Configuration

Now that you have the frontend URL, update CORS:

```bash
railway service archon-server
railway variables set ALLOWED_ORIGINS=<frontend-url>

# Example:
railway variables set ALLOWED_ORIGINS=https://archon-frontend-production-yyyy.up.railway.app

# Redeploy for changes to take effect
railway up
```

### Step 9: Configure Custom Domain (Optional)

```bash
railway service archon-frontend
railway domain add archon.yourdomain.com

# Prompts:
# Railway will provide a CNAME record
# Add this to your DNS provider
```

Update CORS again with custom domain:
```bash
railway service archon-server
railway variables set ALLOWED_ORIGINS=https://archon.yourdomain.com
railway up
```

### Step 10: Verify Deployment

**Check Service Health**:
```bash
# Get server URL
railway service archon-server
railway domain

# Test health endpoint
curl https://your-server-url.up.railway.app/health
# Expected: {"status":"healthy"}

# Check MCP
railway service archon-mcp
railway domain
curl https://your-mcp-url.up.railway.app/health
# Expected: {"status":"healthy"}
```

**Access Frontend**:
```bash
railway service archon-frontend
railway domain
# Visit URL in browser
```

**View Logs**:
```bash
railway service archon-server
railway logs --follow
```

---

## Environment Variables by Service

### archon-server

**Required**:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here
ALLOWED_ORIGINS=https://your-frontend-url.up.railway.app
```

**Recommended**:
```bash
OPENAI_API_KEY=sk-your-key-here
SENTRY_DSN=https://...@sentry.io/...
LOGFIRE_TOKEN=your-logfire-token
ENABLE_CLAUDE_CACHING=true
```

**Configuration**:
```bash
ENVIRONMENT=production
LOG_LEVEL=INFO
SERVICE_DISCOVERY_MODE=railway
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
AGENTS_ENABLED=false
WEB_CONCURRENCY=1
PYTHONUNBUFFERED=1
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
```

**Complete list**: See `railway-env-templates/archon-server.env`

### archon-mcp

**Required**:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key-here
SERVICE_DISCOVERY_MODE=railway
TRANSPORT=sse
```

**Configuration**:
```bash
LOG_LEVEL=INFO
ARCHON_MCP_PORT=8051
ARCHON_SERVER_PORT=8181
AGENTS_ENABLED=false
```

**Complete list**: See `railway-env-templates/archon-mcp.env`

### archon-frontend

**Required**:
```bash
PROD=true
VITE_SHOW_DEVTOOLS=false
```

**Optional**:
```bash
VITE_ALLOWED_HOSTS=
SENTRY_DSN=https://...@sentry.io/...
```

**Complete list**: See `railway-env-templates/archon-frontend.env`

---

## Useful Railway CLI Commands

### Project Management

```bash
# List all projects
railway projects

# Switch project
railway link

# Delete project
railway delete
```

### Service Management

```bash
# List services
railway status

# Switch service
railway service

# Add new service
railway service add

# Delete service
railway service delete
```

### Environment Variables

```bash
# List all variables
railway variables

# Set single variable
railway variables set KEY=value

# Set multiple variables
railway variables set KEY1=value1 KEY2=value2

# Import from file
railway variables set --from-env-file .env

# Delete variable
railway variables delete KEY

# Export variables to file
railway variables get > .env.backup
```

### Deployment

```bash
# Deploy current service
railway up

# Deploy specific service
railway service <name>
railway up

# Deploy from specific branch
railway up --branch main

# Deploy with detached mode
railway up --detach
```

### Logs

```bash
# View logs
railway logs

# Follow logs in real-time
railway logs --follow

# View logs for specific deployment
railway logs --deployment <deployment-id>

# Filter logs by time
railway logs --since 1h
railway logs --since 30m
```

### Domains

```bash
# List domains
railway domain

# Add domain
railway domain add <domain>

# Remove domain
railway domain remove <domain>

# Generate domain (Railway subdomain)
railway domain generate
```

### Database (if using Railway PostgreSQL)

```bash
# Connect to database
railway connect postgres

# Get database URL
railway variables get DATABASE_URL
```

### Monitoring

```bash
# View deployment status
railway status

# View deployment metrics
railway metrics

# View build logs
railway logs --type build
```

---

## Automated Deployment Script

For convenience, use the provided deployment script:

```bash
./scripts/railway-deploy.sh
```

This script:
1. Checks Railway CLI is installed
2. Verifies you're logged in
3. Initializes project if needed
4. Sets all environment variables from templates
5. Deploys all services
6. Displays service URLs
7. Runs health checks

**Usage**:
```bash
# Make executable
chmod +x scripts/railway-deploy.sh

# Run with environment file
./scripts/railway-deploy.sh --env production.env

# Or interactive mode
./scripts/railway-deploy.sh --interactive
```

---

## Troubleshooting

### "railway: command not found"

**Issue**: Railway CLI not in PATH

**Solution**:
```bash
# NPM install
npm install -g @railway/cli

# Or add to PATH (if installed via script)
export PATH="$HOME/.railway/bin:$PATH"
echo 'export PATH="$HOME/.railway/bin:$PATH"' >> ~/.bashrc
```

### "Not logged in"

**Issue**: Authentication required

**Solution**:
```bash
railway login
```

### "No project linked"

**Issue**: Not in a Railway project

**Solution**:
```bash
railway init
# or
railway link  # Link to existing project
```

### "Service not found"

**Issue**: Trying to deploy non-existent service

**Solution**:
```bash
# List available services
railway status

# Switch to correct service
railway service <name>
```

### "Build failed"

**Issue**: Docker build error

**Solution**:
```bash
# View build logs
railway logs --type build

# Common causes:
# 1. Missing environment variables during build
# 2. Dockerfile errors
# 3. Out of memory (upgrade Railway plan)

# Test build locally
docker compose build
```

### "Health check failed"

**Issue**: Service not responding to health checks

**Solution**:
```bash
# View runtime logs
railway logs --follow

# Common causes:
# 1. Missing environment variables (SUPABASE_URL, etc.)
# 2. Port mismatch (verify ARCHON_*_PORT variables)
# 3. Service crashed during startup

# Check health endpoint manually
curl https://your-service-url.up.railway.app/health
```

### "CORS errors in frontend"

**Issue**: Backend rejecting requests from frontend

**Solution**:
```bash
# Get frontend URL
railway service archon-frontend
railway domain

# Update CORS in backend
railway service archon-server
railway variables set ALLOWED_ORIGINS=<frontend-url>
railway up  # Redeploy
```

### "502 Bad Gateway"

**Issue**: Railway can't connect to service

**Solution**:
```bash
# Check service is running
railway service <name>
railway logs

# Verify port configuration
railway variables get ARCHON_SERVER_PORT  # Should match Dockerfile EXPOSE

# Restart service
railway service restart
```

---

## CI/CD Integration (GitHub Actions)

Railway CLI works great in CI/CD pipelines:

```yaml
# .github/workflows/deploy.yml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Railway CLI
        run: npm install -g @railway/cli

      - name: Deploy to Railway
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
        run: railway up --service archon-server
```

**Get Railway Token**:
```bash
railway token
```

Add token to GitHub Secrets → `RAILWAY_TOKEN`

---

## Cost Optimization

### Development vs Production

**Development** (use Railway's free trial):
```bash
railway init --name archon-dev
railway variables set ENVIRONMENT=development
railway variables set LOG_LEVEL=DEBUG
railway variables set AGENTS_ENABLED=false  # Save resources
```

**Production**:
```bash
railway init --name archon-production
railway variables set ENVIRONMENT=production
railway variables set LOG_LEVEL=INFO
railway variables set ENABLE_CLAUDE_CACHING=true  # Save 70% on LLM costs
```

### Resource Limits

```bash
# View current usage
railway metrics

# Adjust concurrency to save memory
railway variables set WEB_CONCURRENCY=1

# Disable agents if not needed
railway variables set AGENTS_ENABLED=false
```

---

## Rollback

```bash
# List deployments
railway deployments

# Rollback to previous deployment
railway rollback <deployment-id>

# Or use Railway dashboard
# https://railway.app/project/<project-id>/deployments
```

---

## Support

**Railway CLI Documentation**: https://docs.railway.app/develop/cli
**Railway CLI GitHub**: https://github.com/railwayapp/cli
**Railway Discord**: https://discord.gg/railway

**Archon Issues**: https://github.com/bilalmachraa82/Smart-Founds-Grant/issues

---

**Last Updated**: 2025-11-08
**Railway CLI Version**: 4.11.0
**Status**: ✅ Ready for CLI deployment
