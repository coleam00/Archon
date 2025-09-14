#!/bin/bash
# Rebuild Archon UI with proper production configuration

set -e

# Configuration - UPDATE THESE
DOCKER_USERNAME="yourusername"  # Replace with your Docker Hub username
VERSION_TAG="production"        # New version tag

echo "Fixing Archon UI for Azure Container Apps..."

# Step 1: Update vite.config.js in archon-ui-main directory
echo "Creating fixed vite.config.js..."
cat > ./archon-ui-main/vite.config.js << 'EOF'
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
EOF

# Step 2: Create production Dockerfile
echo "Creating production Dockerfile..."
cat > ./archon-ui-main/Dockerfile << 'EOF'
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
EOF

echo "Configuration files created"

# Step 3: Build and push new image
echo "Building production image..."
docker build -t $DOCKER_USERNAME/archon-ui:$VERSION_TAG ./archon-ui-main/

echo "Pushing to Docker Hub..."
docker push $DOCKER_USERNAME/archon-ui:$VERSION_TAG

echo "New production image pushed: $DOCKER_USERNAME/archon-ui:$VERSION_TAG"

echo ""
echo "Now update the Azure Container App:"
echo "az containerapp update \\"
echo "  --name archon-ui \\"
echo "  --resource-group rg-archon \\"
echo "  --image $DOCKER_USERNAME/archon-ui:$VERSION_TAG"
echo ""
echo "This will serve static files instead of using Vite dev server!"