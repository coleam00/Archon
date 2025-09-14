# Quick Fix for MCP Server - Update Environment Variables Only
# This script updates the existing MCP server with proper environment variables

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
Write-Info "   Quick Fix MCP Server                 "
Write-Info "        Environment Variables           "
Write-Info "========================================="
Write-Info ""

# Get current URLs
Write-Info "Getting current Container App URLs..."
try {
    $serverUrl = az containerapp show --name "archon-server" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    $mcpUrl = az containerapp show --name "archon-mcp" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    $agentsUrl = az containerapp show --name "archon-agents" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
    
    $serverFullUrl = "https://$serverUrl"
    $mcpFullUrl = "https://$mcpUrl"
    $agentsFullUrl = "https://$agentsUrl"
    
    Write-Success "Current URLs:"
    Write-Success "  Server: $serverFullUrl"
    Write-Success "  MCP: $mcpFullUrl"
    Write-Success "  Agents: $agentsFullUrl"
} catch {
    Write-Error "Failed to get Container App URLs"
    exit 1
}

# Confirm update
$confirm = Read-Host "Continue with environment variable update? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Warning "Operation cancelled by user."
    exit 0
}

Write-Info "Starting environment variable update..."

# Step 1: Update MCP server with proper environment variables
Write-Info "Updating MCP server environment variables..."
try {
    az containerapp update --name "archon-mcp" --resource-group $ResourceGroupName `
        --set-env-vars `
            "CONTAINER_ENV=azure" `
            "DEPLOYMENT_MODE=cloud" `
            "ARCHON_SERVER_PORT=8181" `
            "ARCHON_MCP_PORT=8051" `
            "ARCHON_AGENTS_PORT=8052" `
            "ARCHON_SERVER_URL=$serverFullUrl" `
            "ARCHON_AGENTS_URL=$agentsFullUrl" `
            "AZURE_CONTAINER_APPS_DOMAIN=$($mcpUrl.Split('.')[1..($mcpUrl.Split('.').Length-1)] -join '.')" `
            "RESTART_TIMESTAMP=$(Get-Date -Format 'yyyyMMddHHmmss')"
    
    Write-Success "MCP server environment variables updated"
} catch {
    Write-Error "Failed to update MCP server environment variables: $_"
    exit 1
}

# Step 2: Update server with MCP URL
Write-Info "Updating server with MCP URL..."
try {
    az containerapp update --name "archon-server" --resource-group $ResourceGroupName `
        --set-env-vars `
            "ARCHON_MCP_URL=$mcpFullUrl" `
            "MCP_SERVER_URL=$mcpFullUrl" `
            "MCP_ENDPOINT=$mcpFullUrl/mcp"
    
    Write-Success "Server MCP configuration updated"
} catch {
    Write-Warning "Failed to update server MCP configuration (non-critical)"
}

# Step 3: Update agents with MCP URL
Write-Info "Updating agents with MCP URL..."
try {
    az containerapp update --name "archon-agents" --resource-group $ResourceGroupName `
        --set-env-vars `
            "ARCHON_MCP_URL=$mcpFullUrl" `
            "MCP_SERVER_URL=$mcpFullUrl" `
            "MCP_ENDPOINT=$mcpFullUrl/mcp"
    
    Write-Success "Agents MCP configuration updated"
} catch {
    Write-Warning "Failed to update agents MCP configuration (non-critical)"
}

# Step 4: Wait for MCP server to restart
Write-Info "Waiting for MCP server to restart..."
Start-Sleep -Seconds 30

# Step 5: Test MCP endpoints
Write-Info "Testing MCP endpoints..."
try {
    # Test root endpoint
    $rootResponse = Invoke-RestMethod -Uri $mcpFullUrl -Method Get -TimeoutSec 10
    Write-Success "Root endpoint working: $($rootResponse.service)"
    
    # Test health endpoint
    $healthResponse = Invoke-RestMethod -Uri "$mcpFullUrl/health" -Method Get -TimeoutSec 10
    Write-Success "Health endpoint working: $($healthResponse.status)"
    
    # Test MCP health endpoint
    $mcpHealthResponse = Invoke-RestMethod -Uri "$mcpFullUrl/mcp/health" -Method Get -TimeoutSec 10
    Write-Success "MCP health endpoint working: $($mcpHealthResponse.status)"
    
} catch {
    Write-Warning "Some endpoints may not be working yet: $($_.Exception.Message)"
    Write-Info "The MCP server may need a few more minutes to fully start up."
}

# Summary
Write-Success ""
Write-Success "Quick Fix Completed!"
Write-Success "========================================="
Write-Success ""
Write-Success "Updated Configuration:"
Write-Success "  MCP URL: $mcpFullUrl"
Write-Success "  Health Endpoint: $mcpFullUrl/health"
Write-Success "  MCP Endpoint: $mcpFullUrl/mcp"
Write-Success ""
Write-Info "Note: This fix only updates environment variables."
Write-Info "If the MCP server still has issues, you may need to rebuild the Docker image."
Write-Info ""
Write-Info "Next Steps:"
Write-Info "  1. Wait a few minutes for the MCP server to fully restart"
Write-Info "  2. Test the health endpoints manually"
Write-Info "  3. Test the MCP server from your AI coding assistant"
Write-Info "  4. Check Azure Container App logs if issues persist"
Write-Info ""
Write-Success "Your MCP server environment variables have been updated!"



