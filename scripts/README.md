# Deployment Scripts

This directory contains automated deployment scripts for Archon.

## Available Scripts

### railway-deploy.sh

Automated Railway deployment script that handles:
- CLI installation verification
- Authentication check
- Project initialization
- Environment variable configuration
- Service deployment
- Health checks
- CORS configuration

**Usage**:
```bash
# Interactive mode (prompts before each step)
./scripts/railway-deploy.sh --interactive

# Automatic mode
./scripts/railway-deploy.sh
```

**Prerequisites**:
1. Railway CLI installed: `npm install -g @railway/cli`
2. Environment templates configured in `railway-env-templates/`
3. Git repository pushed to GitHub

**What it does**:
1. ✓ Verifies Railway CLI installation
2. ✓ Checks authentication (prompts login if needed)
3. ✓ Initializes Railway project
4. ✓ Configures environment variables from templates
5. ✓ Deploys all services (server, mcp, frontend)
6. ✓ Waits for deployment completion
7. ✓ Gets service URLs
8. ✓ Runs health checks
9. ✓ Updates CORS with frontend URL
10. ✓ Displays deployment summary

**Requirements**:
- Node.js 18+
- Railway CLI
- Bash shell
- curl (for health checks)

## Before Running

1. **Edit environment templates** in `railway-env-templates/`:
   - `archon-server.env` - Add your Supabase and API keys
   - `archon-mcp.env` - Add Supabase credentials
   - `archon-frontend.env` - Configure production settings

2. **Replace placeholder values**:
   - `your-project.supabase.co` → Your actual Supabase URL
   - `your-service-role-key-here` → Your Supabase service key
   - `sk-ant-your-key-here` → Your Anthropic API key
   - `sk-your-key-here` → Your OpenAI API key

3. **Verify Docker Compose configuration**:
   - Ensure `docker-compose.yml` is in project root
   - Railway auto-detects this file

## Troubleshooting

**Script fails with "Railway CLI not found"**:
```bash
npm install -g @railway/cli
```

**Script fails with "Not logged in"**:
```bash
railway login
```

**Environment variables not being set**:
- Check templates have no placeholder values
- Verify file paths are correct
- Try manual configuration: `railway service <name>` → `railway variables`

**Deployment fails**:
```bash
# View logs
railway logs --follow

# Check specific service
railway service archon-server
railway logs
```

**Health checks fail**:
- Services may still be starting (wait 1-2 minutes)
- Check environment variables are set correctly
- Verify Supabase connection

## Manual Deployment

If the script fails, you can deploy manually:

```bash
# Install and login
npm install -g @railway/cli
railway login

# Initialize project
railway init --name archon-production

# Configure each service
railway service archon-server
railway variables set --from-env-file railway-env-templates/archon-server.env

railway service archon-mcp
railway variables set --from-env-file railway-env-templates/archon-mcp.env

railway service archon-frontend
railway variables set --from-env-file railway-env-templates/archon-frontend.env

# Deploy
railway service archon-server
railway up

railway service archon-mcp
railway up

railway service archon-frontend
railway up
```

## Additional Resources

- **Full deployment guide**: `../RAILWAY_CLI_DEPLOYMENT.md`
- **Railway dashboard**: https://railway.app/dashboard
- **Railway CLI docs**: https://docs.railway.app/develop/cli
- **Railway support**: https://discord.gg/railway
