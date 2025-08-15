# Simple Vite dev server setup
FROM node:18-alpine

WORKDIR /app

# Install system dependencies needed for some npm packages
RUN apk add --no-cache python3 make g++ git curl

# Copy package files
COPY package*.json ./

# Install dependencies including dev dependencies for testing
RUN npm ci

# Create coverage directory with proper permissions
RUN mkdir -p /app/coverage && chmod 777 /app/coverage

# Copy source code
COPY . .

# Expose Vite's default port
EXPOSE 5173

# Add a small startup script to wait a moment before starting Vite
# This helps ensure the backend is fully ready even after healthcheck passes
RUN echo '#!/bin/sh\nsleep 3\nexec npm run dev -- --host 0.0.0.0' > /app/start.sh && chmod +x /app/start.sh

# Start Vite dev server with host binding for Docker
CMD ["/app/start.sh"] 