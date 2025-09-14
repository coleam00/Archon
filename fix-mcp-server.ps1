# Fix MCP Server Configuration in Azure Container Apps
# This script updates the MCP server with proper environment variables and health endpoints

param(
    [Parameter(Mandatory=$true)]
    [string]$DockerUsername,
    
    [Parameter(Mandatory=$true)]
    [string]$SupabaseUrl,
    
    [Parameter(Mandatory=$true)]
    [string]$SupabaseServiceKey,
    
    [Parameter(Mandatory=$true)]
    [string]$OpenAIApiKey,
    
    [string]$ResourceGroupName = "rg-archon",
    [string]$ImageTag = "latest"
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
Write-Info "   Fix MCP Server Configuration         "
Write-Info "        Azure Container Apps            "
Write-Info "========================================="
Write-Info ""

# Validate Azure CLI
try {
    $azVersion = az version --output tsv --query '"azure-cli"' 2>$null
    Write-Success "Azure CLI version: $azVersion"
} catch {
    Write-Error "Azure CLI not found. Please install Azure CLI first."
    exit 1
}

# Check if logged in
try {
    $account = az account show --output tsv --query 'name' 2>$null
    Write-Success "Logged in to Azure account: $account"
} catch {
    Write-Error "Not logged in to Azure. Please run 'az login' first."
    exit 1
}

Write-Info "Configuration:"
Write-Info "  Resource Group: $ResourceGroupName"
Write-Info "  Docker Images: $DockerUsername/archon-*:$ImageTag"
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

# Confirm deployment
$confirm = Read-Host "Continue with MCP server fix? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Warning "Operation cancelled by user."
    exit 0
}

Write-Info "Starting MCP server fix..."

# Step 1: Build and push updated MCP server image
Write-Info "Building updated MCP server image..."
try {
    $imageName = "$DockerUsername/archon-mcp:azure-fixed"
    
    # Build the image
    docker build -f python/Dockerfile.mcp -t $imageName ./python/
    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed"
    }
    Write-Success "MCP server image built successfully"
    
    # Push the image
    docker push $imageName
    if ($LASTEXITCODE -ne 0) {
        throw "Docker push failed"
    }
    Write-Success "MCP server image pushed successfully"
    
} catch {
    Write-Error "Failed to build/push MCP server image: $_"
    exit 1
}

# Step 2: Update MCP server with proper environment variables
Write-Info "Updating MCP server environment variables..."
try {
    az containerapp update --name "archon-mcp" --resource-group $ResourceGroupName `
        --image $imageName `
        --set-env-vars `
            "CONTAINER_ENV=azure" `
            "DEPLOYMENT_MODE=cloud" `
            "ARCHON_SERVER_PORT=8181" `
            "ARCHON_MCP_PORT=8051" `
            "ARCHON_AGENTS_PORT=8052" `
            "ARCHON_SERVER_URL=$serverFullUrl" `
            "ARCHON_AGENTS_URL=$agentsFullUrl" `
            "AZURE_CONTAINER_APPS_DOMAIN=$($mcpUrl.Split('.')[1..($mcpUrl.Split('.').Length-1)] -join '.')" `
            "SUPABASE_URL=$SupabaseUrl" `
            "SUPABASE_SERVICE_KEY=$SupabaseServiceKey" `
            "OPENAI_API_KEY=$OpenAIApiKey" `
            "RESTART_TIMESTAMP=$(Get-Date -Format 'yyyyMMddHHmmss')"
    
    Write-Success "MCP server environment variables updated"
} catch {
    Write-Error "Failed to update MCP server environment variables: $_"
    exit 1
}

# Step 3: Update server with MCP URL
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

# Step 4: Update agents with MCP URL
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

# Step 5: Wait for MCP server to be ready
Write-Info "Waiting for MCP server to be ready..."
$maxAttempts = 30
$attempt = 0
$ready = $false

while ($attempt -lt $maxAttempts -and -not $ready) {
    $attempt++
    Write-Info "Attempt $attempt/$maxAttempts - Checking MCP server health..."
    
    try {
        $healthResponse = Invoke-RestMethod -Uri "$mcpFullUrl/health" -Method Get -TimeoutSec 10
        if ($healthResponse.status -eq "healthy" -or $healthResponse.status -eq "starting") {
            $ready = $true
            Write-Success "MCP server is responding to health checks"
        } else {
            Write-Info "MCP server status: $($healthResponse.status)"
        }
    } catch {
        Write-Info "MCP server not ready yet: $($_.Exception.Message)"
    }
    
    if (-not $ready -and $attempt -lt $maxAttempts) {
        Start-Sleep -Seconds 10
    }
}

if (-not $ready) {
    Write-Warning "MCP server may not be fully ready yet. Check logs for details."
} else {
    Write-Success "MCP server is ready!"
}

# Step 6: Test MCP endpoints
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
}

# Summary
Write-Success ""
Write-Success "MCP Server Fix Completed!"
Write-Success "========================================="
Write-Success ""
Write-Success "Updated Configuration:"
Write-Success "  MCP Server Image: $imageName"
Write-Success "  MCP URL: $mcpFullUrl"
Write-Success "  Health Endpoint: $mcpFullUrl/health"
Write-Success "  MCP Endpoint: $mcpFullUrl/mcp"
Write-Success ""
Write-Info "Next Steps:"
Write-Info "  1. Test the MCP server from your AI coding assistant"
Write-Info "  2. Check Azure Container App logs if issues persist"
Write-Info "  3. Verify all services are communicating properly"
Write-Info ""
Write-Info "MCP Configuration for AI Clients:"
$mcpConfig = @"
{
  "mcpServers": {
    "archon": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-fetch",
        "$mcpFullUrl"
      ]
    }
  }
}
"@
Write-Info $mcpConfig
Write-Info ""
Write-Success "Your MCP server should now be working properly!"



