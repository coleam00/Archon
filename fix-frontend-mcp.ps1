# Fix Frontend MCP Integration in Azure Container Apps
# This script updates the frontend with proper MCP server configuration

param(
    [string]$ResourceGroupName = "rg-archon"
)

# Color functions for output
function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    else {
        $input | Write-Output
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

function Write-Success { Write-ColorOutput Green @args }
function Write-Info { Write-ColorOutput Cyan @args }
function Write-Warning { Write-ColorOutput Yellow @args }
function Write-Error { Write-ColorOutput Red @args }

# Header
Write-Info "========================================="
Write-Info "   Fix Frontend MCP Integration         "
Write-Info "        Azure Container Apps            "
Write-Info "========================================="
Write-Info ""

# Get current URLs
Write-Info "Getting current Container App URLs..."
try {
    $serverUrl = az containerapp show --name "archon-server" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    $mcpUrl = az containerapp show --name "archon-mcp" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    $agentsUrl = az containerapp show --name "archon-agents" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    $uiUrl = az containerapp show --name "archon-ui" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    
    $serverFullUrl = "https://$serverUrl"
    $mcpFullUrl = "https://$mcpUrl"
    $agentsFullUrl = "https://$agentsUrl"
    $uiFullUrl = "https://$uiUrl"
    
    Write-Success "Current URLs:"
    Write-Success "  Server: $serverFullUrl"
    Write-Success "  MCP: $mcpFullUrl"
    Write-Success "  Agents: $agentsFullUrl"
    Write-Success "  UI: $uiFullUrl"
} catch {
    Write-Error "Failed to get Container App URLs"
    exit 1
}

# Confirm update
$confirm = Read-Host "Continue with frontend MCP integration fix? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Warning "Operation cancelled by user."
    exit 0
}

Write-Info "Starting frontend MCP integration fix..."

# Step 1: Update frontend with proper environment variables
Write-Info "Updating frontend environment variables..."
try {
    az containerapp update --name "archon-ui" --resource-group $ResourceGroupName `
        --set-env-vars `
            "VITE_API_URL=$serverFullUrl" `
            "VITE_MCP_SERVER_URL=$mcpFullUrl" `
            "VITE_AGENTS_URL=$agentsFullUrl" `
            "VITE_DEPLOYMENT_ENV=azure" `
            "RESTART_TIMESTAMP=$(Get-Date -Format 'yyyyMMddHHmmss')"
    
    Write-Success "Frontend environment variables updated"
} catch {
    Write-Error "Failed to update frontend environment variables: $_"
    exit 1
}

# Step 2: Wait for frontend to restart
Write-Info "Waiting for frontend to restart..."
Start-Sleep -Seconds 30

# Step 3: Test frontend MCP integration
Write-Info "Testing frontend MCP integration..."
try {
    # Test if the frontend is accessible
    $uiResponse = Invoke-RestMethod -Uri $uiFullUrl -Method Get -TimeoutSec 10
    Write-Success "Frontend is accessible"
    
    # Test if MCP proxy is working by checking the MCP endpoint
    $mcpProxyUrl = "$uiFullUrl/mcp"
    Write-Info "Testing MCP proxy at: $mcpProxyUrl"
    
    # Note: The MCP endpoint will return 406 Not Acceptable for GET requests,
    # but this confirms the proxy is working and forwarding to the MCP server
    try {
        $mcpResponse = Invoke-WebRequest -Uri $mcpProxyUrl -Method Get -TimeoutSec 10
        Write-Success "MCP proxy is working (status: $($mcpResponse.StatusCode))"
    } catch {
        if ($_.Exception.Response.StatusCode -eq 406) {
            Write-Success "MCP proxy is working correctly (406 is expected for GET requests to MCP endpoint)"
        } else {
            Write-Warning "MCP proxy test returned unexpected status: $($_.Exception.Response.StatusCode)"
        }
    }
    
} catch {
    Write-Warning "Frontend MCP integration test failed: $($_.Exception.Message)"
    Write-Info "The frontend may need a few more minutes to fully restart."
}

# Summary
Write-Success ""
Write-Success "Frontend MCP Integration Fix Completed!"
Write-Success "========================================="
Write-Success ""
Write-Success "Updated Configuration:"
Write-Success "  Frontend URL: $uiFullUrl"
Write-Success "  API URL: $serverFullUrl"
Write-Success "  MCP Server URL: $mcpFullUrl"
Write-Success "  MCP Proxy: $uiFullUrl/mcp"
Write-Success ""
Write-Info "Next Steps:"
Write-Info "  1. Wait a few minutes for the frontend to fully restart"
Write-Info "  2. Open the frontend and navigate to the MCP page"
Write-Info "  3. Test MCP client connection from the frontend"
Write-Info "  4. Check browser console for any MCP-related errors"
Write-Info ""
Write-Info "Frontend MCP Configuration:"
Write-Info "  - VITE_API_URL: $serverFullUrl"
Write-Info "  - VITE_MCP_SERVER_URL: $mcpFullUrl"
Write-Info "  - VITE_AGENTS_URL: $agentsFullUrl"
Write-Info "  - VITE_DEPLOYMENT_ENV: azure"
Write-Info ""
Write-Success "Your frontend should now be able to connect to the MCP server!"



