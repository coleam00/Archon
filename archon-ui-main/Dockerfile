# Multi-stage Dockerfile for development and production
FROM node:18-alpine AS base

WORKDIR /app

# Install system dependencies needed for some npm packages
RUN apk add --no-cache python3 make g++ git curl

# Copy package files
COPY package*.json ./

# Install dependencies including dev dependencies for testing
RUN npm ci

# Copy source code
COPY . .

# Development stage (default for docker-compose.yml)
FROM base AS development

# Create coverage directory with proper permissions
RUN mkdir -p /app/coverage && chmod 777 /app/coverage

# Expose the port configured in package.json (3737)
EXPOSE 3737

# Start Vite dev server (already configured with --port 3737 --host in package.json)
CMD ["npm", "run", "dev"]

# Production stage (for docker-compose-lan.yml)
FROM base AS production

# Accept build arguments for Vite environment variables
ARG VITE_MCP_HOST=localhost
ARG VITE_MCP_PROTOCOL=http
ARG VITE_MCP_USE_PROXY=false
ARG VITE_MCP_PORT=8051
ARG VITE_API_URL
ARG VITE_ARCHON_SERVER_PORT

# Set environment variables for the build process
ENV VITE_MCP_HOST=$VITE_MCP_HOST
ENV VITE_MCP_PROTOCOL=$VITE_MCP_PROTOCOL
ENV VITE_MCP_USE_PROXY=$VITE_MCP_USE_PROXY
ENV VITE_MCP_PORT=$VITE_MCP_PORT
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ARCHON_SERVER_PORT=$VITE_ARCHON_SERVER_PORT

# Build the application
RUN npm run build

# Install serve to serve the production build
RUN npm install -g serve

# Expose port 3737
EXPOSE 3737

# Serve the production build
CMD ["serve", "-s", "dist", "-l", "3737"]
