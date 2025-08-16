# Simple Vite dev server setup
FROM node:18-alpine

# Add a build argument to manually bust the cache when needed
ARG CACHE_BUSTER=1

WORKDIR /app

# Install system dependencies needed for some npm packages
RUN apk add --no-cache python3 make g++ git curl

# Copy package files
COPY package*.json ./

# Install dependencies including dev dependencies for testing
# The CACHE_BUSTER arg is used here to force re-installation when needed
RUN echo "Cache buster: ${CACHE_BUSTER}" && npm ci

# Create coverage directory with proper permissions
RUN mkdir -p /app/coverage && chmod 777 /app/coverage

# Copy source code
COPY . .

# Expose Vite's default port
EXPOSE 5173

# Start Vite dev server with host binding for Docker
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"] 