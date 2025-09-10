#!/bin/bash

# Archon LAN Deployment Script
# This script deploys Archon with proper Traefik network integration

echo "🚀 Starting Archon LAN Deployment..."

# Check if proxy network exists
if ! docker network ls | grep -q "proxy"; then
    echo "❌ Error: Traefik proxy network not found!"
    echo "Please ensure Traefik is running and the proxy network exists."
    exit 1
fi

echo "✅ Traefik proxy network found"

# Stop any existing deployment
echo "🔄 Stopping existing containers..."
docker-compose -f docker-compose-lan.yml down

# Build and start containers
echo "🏗️ Building and starting containers..."
docker-compose -f docker-compose-lan.yml up -d --build

# Wait for containers to be running
echo "⏳ Waiting for containers to start..."
sleep 10

# Connect containers to proxy network
echo "🔗 Connecting containers to Traefik proxy network..."
docker network connect proxy archon-ui 2>/dev/null || echo "  archon-ui already connected or not running"
docker network connect proxy archon-server 2>/dev/null || echo "  archon-server already connected or not running"

# Verify connections
echo "🔍 Verifying network connections..."
echo "Containers on proxy network:"
docker network inspect proxy --format '{{range .Containers}}{{println .Name}}{{end}}' | grep archon || echo "No Archon containers found on proxy network"

# Copy Traefik config if it exists locally
if [ -f "traefik/data/config.yml" ]; then
    echo "📋 Traefik config.yml found locally"
    echo "Please copy it to your Traefik installation:"
    echo "  cp traefik/data/config.yml /home/dmcdonald/dockge/traefik-3/data/config.yml"
    echo "Then restart Traefik:"
    echo "  docker restart traefik"
fi

# Health check
echo "🏥 Checking container health..."
docker-compose -f docker-compose-lan.yml ps

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Next steps:"
echo "1. Ensure traefik/data/config.yml is copied to your Traefik directory"
echo "2. Restart Traefik to load the new configuration"
echo "3. Access Archon at: https://archon.mcdonaldhomelab.com"
echo ""
echo "🔧 Troubleshooting commands:"
echo "  docker logs archon-ui"
echo "  docker logs archon-server"
echo "  docker logs traefik | grep archon"
echo "  docker network inspect proxy | grep archon"