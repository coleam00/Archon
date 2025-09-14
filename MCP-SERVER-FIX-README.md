# MCP Server Fix for Azure Container Apps

## Problem Summary

Your MCP server was returning **404 Not Found** for health checks and **406 Not Acceptable** for MCP requests in Azure Container Apps. This was caused by:

1. **Missing Health Endpoints**: The MCP server didn't have `/health` endpoints for Azure health checks
2. **Service Discovery Issues**: The server couldn't properly connect to other services in the Azure environment
3. **Environment Configuration**: Missing environment variables for Azure Container App deployment

## What Was Fixed

### 1. Added Health Endpoints to MCP Server
- **Root endpoint** (`/`): Returns service information
- **Health endpoint** (`/health`): Returns health status for Azure Container App health checks
- **MCP health endpoint** (`/mcp/health`): MCP-specific health check

### 2. Fixed Service Discovery for Azure
- Added Azure environment detection (`CONTAINER_ENV=azure`)
- Updated service URLs to use external Azure Container App URLs
- Improved timeout handling for Azure network latency

### 3. Enhanced MCP Service Client
- Better error logging with endpoint information
- Azure-specific timeout configurations
- Improved health check reliability

## Files Modified

### Core MCP Server
- `python/src/mcp/mcp_server.py` - Added FastAPI health endpoints and improved configuration

### Service Discovery
- `python/src/server/config/service_discovery.py` - Added Azure environment support

### MCP Service Client
- `python/src/server/services/mcp_service_client.py` - Enhanced Azure compatibility

## How to Apply the Fix

### Option 1: Quick Fix (Environment Variables Only)

If you want to try fixing just the environment variables first:

```powershell
# Run the quick fix script
.\quick-fix-mcp.ps1
```

This will:
- Update the MCP server environment variables
- Configure proper service URLs
- Test the endpoints after restart

### Option 2: Complete Fix (Rebuild + Deploy)

For a complete fix that includes the code changes:

```powershell
# Run the complete fix script
.\fix-mcp-server.ps1 -DockerUsername "yourusername" -SupabaseUrl "your-supabase-url" -SupabaseServiceKey "your-key" -OpenAIApiKey "your-openai-key"
```

This will:
- Build a new Docker image with the fixes
- Push it to Docker Hub
- Update the Azure Container App
- Configure all environment variables
- Test the endpoints

### Option 3: Manual Fix

If you prefer to apply the changes manually:

1. **Update the MCP server environment variables**:
```bash
az containerapp update --name "archon-mcp" --resource-group "rg-archon" \
  --set-env-vars \
    "CONTAINER_ENV=azure" \
    "DEPLOYMENT_MODE=cloud" \
    "ARCHON_SERVER_PORT=8181" \
    "ARCHON_MCP_PORT=8051" \
    "ARCHON_AGENTS_PORT=8052" \
    "ARCHON_SERVER_URL=https://archon-server.purplemoss-0b16bcfe.eastus.azurecontainerapps.io" \
    "ARCHON_AGENTS_URL=https://archon-agents.purplemoss-0b16bcfe.eastus.azurecontainerapps.io" \
    "AZURE_CONTAINER_APPS_DOMAIN=purplemoss-0b16bcfe.eastus.azurecontainerapps.io"
```

2. **Rebuild and redeploy the MCP server** with the updated code

## Testing the Fix

### 1. Check Health Endpoints

After applying the fix, test these endpoints:

```bash
# Root endpoint
curl https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io/

# Health endpoint
curl https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io/health

# MCP health endpoint
curl https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io/mcp/health
```

### 2. Check Azure Container App Logs

```bash
az containerapp logs show --name "archon-mcp" --resource-group "rg-archon" --output table
```

Look for:
- ✅ "Health endpoints configured"
- ✅ "Service client initialized"
- ✅ No more 404/406 errors

### 3. Test MCP Connection

From your AI coding assistant, test the MCP connection:

```json
{
  "mcpServers": {
    "archon": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-fetch",
        "https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io"
      ]
    }
  }
}
```

## Expected Results

After the fix, you should see:

1. **Health checks passing** in Azure Container App
2. **No more 404/406 errors** in the logs
3. **Proper service communication** between MCP server and other services
4. **MCP tools working** from your AI coding assistant

## Troubleshooting

### If Health Endpoints Still Return 404

1. **Check if the MCP server restarted**:
   ```bash
   az containerapp revision list --name "archon-mcp" --resource-group "rg-archon"
   ```

2. **Verify environment variables**:
   ```bash
   az containerapp show --name "archon-mcp" --resource-group "rg-archon" --query "properties.configuration.template.containers[0].env"
   ```

3. **Check container logs** for startup errors:
   ```bash
   az containerapp logs show --name "archon-mcp" --resource-group "rg-archon" --output table
   ```

### If Services Can't Communicate

1. **Verify service URLs** are correct in the environment variables
2. **Check network policies** in Azure Container Apps
3. **Verify all services are running** and healthy

### If MCP Tools Still Don't Work

1. **Check MCP server logs** for tool registration errors
2. **Verify the MCP endpoint** is accessible
3. **Test with a simple MCP client** to isolate the issue

## Environment Variables Reference

### Required for MCP Server
- `CONTAINER_ENV=azure` - Enables Azure environment detection
- `DEPLOYMENT_MODE=cloud` - Sets cloud deployment mode
- `ARCHON_MCP_PORT=8051` - MCP server port
- `ARCHON_SERVER_PORT=8181` - API server port
- `ARCHON_AGENTS_PORT=8052` - Agents service port

### Service URLs
- `ARCHON_SERVER_URL` - Full URL to the API server
- `ARCHON_AGENTS_URL` - Full URL to the agents service
- `AZURE_CONTAINER_APPS_DOMAIN` - Azure Container Apps domain

### Database and API Keys
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Your Supabase service key
- `OPENAI_API_KEY` - Your OpenAI API key

## Architecture Changes

### Before (Broken)
```
MCP Server (No health endpoints)
    ↓
Service Discovery (Docker-only)
    ↓
HTTP Calls (Internal URLs)
```

### After (Fixed)
```
MCP Server (With health endpoints)
    ↓
Service Discovery (Azure-aware)
    ↓
HTTP Calls (External Azure URLs)
```

## Next Steps

1. **Apply the fix** using one of the provided scripts
2. **Test the health endpoints** to verify they're working
3. **Test MCP tools** from your AI coding assistant
4. **Monitor logs** to ensure continued stability
5. **Update your MCP client configuration** with the working URL

## Support

If you continue to experience issues after applying these fixes:

1. Check the Azure Container App logs for specific error messages
2. Verify all environment variables are set correctly
3. Ensure all dependent services (API server, agents) are healthy
4. Consider rebuilding the Docker image if environment variable changes don't resolve the issue

The fixes address the core architectural issues that were preventing your MCP server from working properly in the Azure Container Apps environment.



