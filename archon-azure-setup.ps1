# Deploy Archon to Azure Container Apps
# PowerShell Script for complete deployment

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
    [string]$Location = "East US",
    [string]$EnvironmentName = "archon-env",
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
Write-Info "   Archon Azure Container Apps          "
Write-Info "        Deployment Script               "
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

Write-Info "Deployment Configuration:"
Write-Info "  Resource Group: $ResourceGroupName"
Write-Info "  Location: $Location"
Write-Info "  Environment: $EnvironmentName"
Write-Info "  Docker Images: $DockerUsername/archon-*:$ImageTag"
Write-Info ""

# Confirm deployment
$confirm = Read-Host "Continue with deployment? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Warning "Deployment cancelled by user."
    exit 0
}

Write-Info "Starting deployment..."

# Step 1: Create Resource Group
Write-Info "Creating resource group..."
try {
    az group create --name $ResourceGroupName --location $Location --output none
    Write-Success "Resource group '$ResourceGroupName' created/updated"
} catch {
    Write-Error "Failed to create resource group"
    exit 1
}

# Step 2: Create Container Apps Environment
Write-Info "Creating Container Apps environment..."
try {
    az containerapp env create `
        --name $EnvironmentName `
        --resource-group $ResourceGroupName `
        --location $Location `
        --output none
    Write-Success "Container Apps environment '$EnvironmentName' created"
} catch {
    Write-Error "Failed to create Container Apps environment"
    exit 1
}

# Step 3: Deploy Archon Server (Backend API)
Write-Info "Deploying Archon Server..."
try {
    az containerapp create `
        --name "archon-server" `
        --resource-group $ResourceGroupName `
        --environment $EnvironmentName `
        --image "$DockerUsername/archon-server:$ImageTag" `
        --target-port 8181 `
        --ingress external `
        --env-vars `
            "SUPABASE_URL=$SupabaseUrl" `
            "SUPABASE_SERVICE_KEY=$SupabaseServiceKey" `
            "OPENAI_API_KEY=$OpenAIApiKey" `
            "HOST=0.0.0.0" `
            "PORT=8181" `
        --cpu 1.0 `
        --memory 2Gi `
        --min-replicas 1 `
        --max-replicas 3 `
        --output none
    Write-Success "Archon Server deployed"
} catch {
    Write-Error "Failed to deploy Archon Server"
    exit 1
}

# Get Server URL
$serverUrl = az containerapp show --name "archon-server" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
$serverFullUrl = "https://$serverUrl"
Write-Info "Server URL: $serverFullUrl"

# Step 4: Deploy MCP Server
Write-Info "Deploying MCP Server..."
try {
    az containerapp create `
        --name "archon-mcp" `
        --resource-group $ResourceGroupName `
        --environment $EnvironmentName `
        --image "$DockerUsername/archon-mcp:$ImageTag" `
        --target-port 8051 `
        --ingress external `
        --env-vars `
            "SUPABASE_URL=$SupabaseUrl" `
            "SUPABASE_SERVICE_KEY=$SupabaseServiceKey" `
            "ARCHON_SERVER_URL=$serverFullUrl" `
            "HOST=0.0.0.0" `
            "PORT=8051" `
        --cpu 0.5 `
        --memory 1Gi `
        --min-replicas 1 `
        --max-replicas 2 `
        --output none
    Write-Success "MCP Server deployed"
} catch {
    Write-Error "Failed to deploy MCP Server"
    exit 1
}

# Get MCP URL
$mcpUrl = az containerapp show --name "archon-mcp" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
$mcpFullUrl = "https://$mcpUrl"
Write-Info "MCP URL: $mcpFullUrl"

# Step 5: Deploy Agents Service
Write-Info "Deploying Agents Service..."
try {
    az containerapp create `
        --name "archon-agents" `
        --resource-group $ResourceGroupName `
        --environment $EnvironmentName `
        --image "$DockerUsername/archon-agents:$ImageTag" `
        --target-port 8052 `
        --ingress external `
        --env-vars `
            "SUPABASE_URL=$SupabaseUrl" `
            "SUPABASE_SERVICE_KEY=$SupabaseServiceKey" `
            "OPENAI_API_KEY=$OpenAIApiKey" `
            "ARCHON_SERVER_URL=$serverFullUrl" `
            "HOST=0.0.0.0" `
            "PORT=8052" `
        --cpu 1.0 `
        --memory 2Gi `
        --min-replicas 1 `
        --max-replicas 2 `
        --output none
    Write-Success "Agents Service deployed"
} catch {
    Write-Error "Failed to deploy Agents Service"
    exit 1
}

# Get Agents URL
$agentsUrl = az containerapp show --name "archon-agents" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
$agentsFullUrl = "https://$agentsUrl"
Write-Info "Agents URL: $agentsFullUrl"

# Step 6: Deploy Frontend UI
Write-Info "Deploying Frontend UI..."
try {
    az containerapp create `
        --name "archon-ui" `
        --resource-group $ResourceGroupName `
        --environment $EnvironmentName `
        --image "$DockerUsername/archon-ui:$ImageTag" `
        --target-port 3737 `
        --ingress external `
        --env-vars `
            "VITE_API_URL=$serverFullUrl" `
            "VITE_MCP_URL=$mcpFullUrl" `
            "VITE_AGENTS_URL=$agentsFullUrl" `
            "HOST=0.0.0.0" `
            "PORT=3737" `
        --cpu 0.5 `
        --memory 1Gi `
        --min-replicas 1 `
        --max-replicas 2 `
        --output none
    Write-Success "Frontend UI deployed"
} catch {
    Write-Error "Failed to deploy Frontend UI"
    exit 1
}

# Get UI URL
$uiUrl = az containerapp show --name "archon-ui" --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" --output tsv
$uiFullUrl = "https://$uiUrl"

# Step 7: Configure CORS for Server
Write-Info "Configuring CORS..."
try {
    az containerapp update `
        --name "archon-server" `
        --resource-group $ResourceGroupName `
        --set-env-vars `
            "CORS_ORIGINS=$uiFullUrl" `
        --output none
    Write-Success "CORS configured for server"
} catch {
    Write-Warning "CORS configuration failed (non-critical)"
}

# Step 8: Setup Application Insights (Optional)
Write-Info "Setting up Application Insights..."
try {
    az monitor app-insights component create `
        --app "archon-insights" `
        --location $Location `
        --resource-group $ResourceGroupName `
        --output none

    $instrumentationKey = az monitor app-insights component show `
        --app "archon-insights" `
        --resource-group $ResourceGroupName `
        --query "instrumentationKey" `
        --output tsv

    # Update all apps with monitoring
    $apps = @("archon-server", "archon-mcp", "archon-agents", "archon-ui")
    foreach ($app in $apps) {
        az containerapp update `
            --name $app `
            --resource-group $ResourceGroupName `
            --set-env-vars `
                "APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=$instrumentationKey" `
            --output none
    }
    Write-Success "Application Insights configured"
} catch {
    Write-Warning "Application Insights setup failed (optional feature)"
}

# Deployment Summary
Write-Success ""
Write-Success "Archon Deployment Completed Successfully!"
Write-Success "========================================="
Write-Success ""
Write-Success "Access URLs:"
Write-Success "  Frontend UI:  $uiFullUrl"
Write-Success "  Server API:   $serverFullUrl"
Write-Success "  MCP Server:   $mcpFullUrl"
Write-Success "  Agents:       $agentsFullUrl"
Write-Success ""
Write-Info "Next Steps:"
Write-Info "  1. Open the Frontend UI and configure your API keys"
Write-Info "  2. Test by uploading a document or crawling a website"
Write-Info "  3. Configure your AI coding assistant with the MCP URL"
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
Write-Info "Cost Monitoring:"
Write-Info "  View costs: https://portal.azure.com/#blade/Microsoft_Azure_CostManagement"
Write-Info "  Set budgets: az consumption budget create --help"
Write-Info ""

# Save deployment info to file
$deploymentInfo = @{
    "DeploymentDate" = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "ResourceGroup" = $ResourceGroupName
    "Environment" = $EnvironmentName
    "URLs" = @{
        "Frontend" = $uiFullUrl
        "Server" = $serverFullUrl
        "MCP" = $mcpFullUrl
        "Agents" = $agentsFullUrl
    }
    "DockerImages" = @{
        "UI" = "$DockerUsername/archon-ui:$ImageTag"
        "Server" = "$DockerUsername/archon-server:$ImageTag"
        "MCP" = "$DockerUsername/archon-mcp:$ImageTag"
        "Agents" = "$DockerUsername/archon-agents:$ImageTag"
    }
}

$deploymentInfo | ConvertTo-Json -Depth 3 | Out-File "archon-deployment-info.json"
Write-Info "Deployment details saved to: archon-deployment-info.json"

Write-Success "Your Archon AI platform is now live and ready for use!"