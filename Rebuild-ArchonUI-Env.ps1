# Rebuild Archon UI with proper environment variables
param(
    [Parameter(Mandatory=$true)]
    [string]$DockerUsername,
    [string]$VersionTag = "env-fix"
)

Write-Host "Rebuilding Archon UI with environment variables..." -ForegroundColor Cyan

# Step 1: Create an .env file for the build
$envContent = @"
VITE_API_URL=https://archon-server.purplemoss-0b16bcfe.eastus.azurecontainerapps.io
VITE_MCP_URL=https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io
VITE_AGENTS_URL=https://archon-agents.purplemoss-0b16bcfe.eastus.azurecontainerapps.io
"@

$envContent | Out-File -FilePath ".\archon-ui-main\.env" -Encoding UTF8
Write-Host "Created .env file with backend URLs" -ForegroundColor Green

# Step 2: Create Dockerfile that uses environment variables during build
$dockerfile = @"
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code including .env
COPY . .

# Set build-time environment variables
ARG VITE_API_URL=https://archon-server.purplemoss-0b16bcfe.eastus.azurecontainerapps.io
ARG VITE_MCP_URL=https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io
ARG VITE_AGENTS_URL=https://archon-agents.purplemoss-0b16bcfe.eastus.azurecontainerapps.io

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_MCP_URL=$VITE_MCP_URL
ENV VITE_AGENTS_URL=$VITE_AGENTS_URL

# Build for production with environment variables
RUN npm run build

# Install serve
RUN npm install -g serve

# Expose port 5173
EXPOSE 5173

# Serve static files
CMD ["serve", "-s", "dist", "-l", "5173"]
"@

$dockerfile | Out-File -FilePath ".\archon-ui-main\Dockerfile" -Encoding UTF8
Write-Host "Created Dockerfile with environment variables" -ForegroundColor Green

# Step 3: Build with build args
Write-Host "Building Docker image with environment variables..." -ForegroundColor Yellow

docker build `
    --build-arg VITE_API_URL=https://archon-server.purplemoss-0b16bcfe.eastus.azurecontainerapps.io `
    --build-arg VITE_MCP_URL=https://archon-mcp.purplemoss-0b16bcfe.eastus.azurecontainerapps.io `
    --build-arg VITE_AGENTS_URL=https://archon-agents.purplemoss-0b16bcfe.eastus.azurecontainerapps.io `
    -t "$DockerUsername/archon-ui:$VersionTag" `
    ./archon-ui-main/

if ($LASTEXITCODE -eq 0) {
    Write-Host "Docker build successful!" -ForegroundColor Green
    
    Write-Host "Pushing to Docker Hub..." -ForegroundColor Yellow
    docker push "$DockerUsername/archon-ui:$VersionTag"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Image pushed successfully!" -ForegroundColor Green
        
        Write-Host "Updating Azure Container App..." -ForegroundColor Yellow
        az containerapp update `
            --name "archon-ui" `
            --resource-group "rg-archon" `
            --image "$DockerUsername/archon-ui:$VersionTag"
            
        Write-Host "Deployment complete! Wait 2-3 minutes and refresh your browser." -ForegroundColor Green
    }
} else {
    Write-Host "Docker build failed!" -ForegroundColor Red
}