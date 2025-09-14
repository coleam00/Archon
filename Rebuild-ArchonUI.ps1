# Rebuild Archon UI with proper production configuration
# PowerShell Script

param(
    [Parameter(Mandatory=$true)]
    [string]$DockerUsername,
    
    [string]$VersionTag = "production",
    [string]$ResourceGroupName = "rg-archon"
)

Write-Host "Fixing Archon UI for Azure Container Apps..." -ForegroundColor Cyan

# Step 1: Create fixed vite.config.js
Write-Host "Creating fixed vite.config.js..." -ForegroundColor Yellow

$viteConfig = @"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: 'all'
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: 'all'
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
"@

$viteConfig | Out-File -FilePath ".\archon-ui-main\vite.config.js" -Encoding UTF8

# Step 2: Create production Dockerfile
Write-Host "Creating production Dockerfile..." -ForegroundColor Yellow

$dockerfile = @"
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build for production
RUN npm run build

# Install serve
RUN npm install -g serve

# Expose port 5173
EXPOSE 5173

# Serve static files (not dev server)
CMD ["serve", "-s", "dist", "-l", "5173"]
"@

$dockerfile | Out-File -FilePath ".\archon-ui-main\Dockerfile" -Encoding UTF8

Write-Host "Configuration files created" -ForegroundColor Green

# Step 3: Build and push new image
Write-Host "Building production image..." -ForegroundColor Yellow

try {
    # Build the Docker image
    docker build -t "$DockerUsername/archon-ui:$VersionTag" ./archon-ui-main/
    
    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed"
    }
    
    Write-Host "Pushing to Docker Hub..." -ForegroundColor Yellow
    docker push "$DockerUsername/archon-ui:$VersionTag"
    
    if ($LASTEXITCODE -ne 0) {
        throw "Docker push failed"
    }
    
    Write-Host "New production image pushed: $DockerUsername/archon-ui:$VersionTag" -ForegroundColor Green
    
} catch {
    Write-Host "Failed to build or push Docker image: $_" -ForegroundColor Red
    exit 1
}

# Step 4: Update Azure Container App
Write-Host "Updating Azure Container App..." -ForegroundColor Yellow

try {
    az containerapp update `
        --name "archon-ui" `
        --resource-group $ResourceGroupName `
        --image "$DockerUsername/archon-ui:$VersionTag" `
        --output none
        
    Write-Host "Azure Container App updated successfully!" -ForegroundColor Green
    
} catch {
    Write-Host "Failed to update Azure Container App: $_" -ForegroundColor Red
    exit 1
}

# Step 5: Wait and check status
Write-Host "Waiting for deployment to complete..." -ForegroundColor Yellow
Start-Sleep -Seconds 30

$latestRevision = az containerapp show `
    --name "archon-ui" `
    --resource-group $ResourceGroupName `
    --query "properties.latestRevisionName" `
    --output tsv

Write-Host "Latest revision: $latestRevision" -ForegroundColor Cyan

# Get the URL
$uiUrl = az containerapp show `
    --name "archon-ui" `
    --resource-group $ResourceGroupName `
    --query "properties.configuration.ingress.fqdn" `
    --output tsv

$uiFullUrl = "https://$uiUrl"

Write-Host ""
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "===================" -ForegroundColor Green
Write-Host ""
Write-Host "UI URL: $uiFullUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "1. Wait 2-3 minutes for the new revision to be fully deployed"
Write-Host "2. Open the UI URL in your browser"
Write-Host "3. The Vite hostname restriction should now be resolved"
Write-Host "4. Configure your API keys in the UI settings"
Write-Host ""

# Optional: Check the logs
$checkLogs = Read-Host "Would you like to check the container logs? (y/N)"
if ($checkLogs -eq "y" -or $checkLogs -eq "Y") {
    Write-Host "Fetching recent logs..." -ForegroundColor Yellow
    az containerapp logs show `
        --name "archon-ui" `
        --resource-group $ResourceGroupName `
        --tail 20
}