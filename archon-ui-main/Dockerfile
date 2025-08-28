# Secure Vite dev server setup with non-root user
FROM node:20-alpine

# Install system dependencies needed for some npm packages
RUN apk add --no-cache python3 make g++ git curl dumb-init \
    && apk upgrade --no-cache

# Create non-root user for security
RUN addgroup -g 1001 -S appuser && \
    adduser -S -D -H -u 1001 -s /sbin/nologin -G appuser appuser

# Set working directory and change ownership
WORKDIR /app
RUN chown -R appuser:appuser /app

# Switch to non-root user for package installation
USER appuser

# Copy package files with proper ownership
COPY --chown=appuser:appuser package*.json ./

# Install all dependencies (including dev) for development server
RUN npm ci && npm cache clean --force

# Create coverage directory with proper permissions
RUN mkdir -p /app/coverage

# Copy source code with proper ownership
COPY --chown=appuser:appuser . .

# Remove potential security risks
RUN rm -rf .git .env* *.md || true

# Expose the port configured in package.json (3737)
EXPOSE 3737

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3737 || exit 1

# Use dumb-init to handle signals properly and run as non-root
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "dev"]
