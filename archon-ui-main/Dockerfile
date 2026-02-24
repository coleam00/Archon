# Simple Vite dev server setup
FROM node:18-alpine

WORKDIR /app

# Install system dependencies needed for some npm packages
RUN apk add --no-cache python3 make g++ git curl

# Copy package files
COPY package*.json ./

# Install dependencies — use npm install to handle platform-specific optional
# packages (biome darwin-x64 vs linux-arm64) when building in Docker on Apple Silicon
RUN npm install --no-audit --no-fund

# Create coverage directory with proper permissions
RUN mkdir -p /app/coverage && chmod 777 /app/coverage

# Copy source code
COPY . .

# Set memory limit for Node.js
ENV NODE_OPTIONS=--max-old-space-size=4096

# Expose the port configured in package.json (3737)
EXPOSE 3737

# Start Vite dev server (already configured with --port 3737 --host in package.json)
CMD ["npm", "run", "dev"]
