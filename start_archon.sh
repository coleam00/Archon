#!/bin/bash

# Start Archon with proper Docker configuration

echo "Starting Archon deployment..."

# Unset DOCKER_HOST to use regular Docker daemon
unset DOCKER_HOST

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker daemon is not running. Please start Docker first."
    exit 1
fi

# Clean up any existing containers
echo "Cleaning up existing containers..."
docker compose down 2>/dev/null

# Build and start containers
echo "Building and starting Archon containers..."
docker compose up --build -d

# Wait for services to be healthy
echo "Waiting for services to become healthy..."
sleep 10

# Check container status
echo ""
echo "Container status:"
docker compose ps

# Display access URLs
echo ""
echo "========================================="
echo "Archon is starting up!"
echo "========================================="
echo ""
echo "Access points:"
echo "  Web UI:        http://localhost:${ARCHON_UI_PORT:-4838}"
echo "  API Server:    http://localhost:${ARCHON_SERVER_PORT:-9282}"
echo "  MCP Server:    http://localhost:${ARCHON_MCP_PORT:-9151}"
echo "  Agents:        http://localhost:${ARCHON_AGENTS_PORT:-9152}"
echo ""
echo "Supabase (local):"
echo "  Studio:        http://localhost:54323"
echo "  API:           http://localhost:54321"
echo ""
echo "To view logs:"
echo "  docker compose logs -f"
echo ""
echo "To stop Archon:"
echo "  docker compose down"
echo "========================================="