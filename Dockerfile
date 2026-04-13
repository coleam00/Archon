# =============================================================================
# Archon - Remote Agentic Coding Platform
# Multi-stage build: deps → web build → production image
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS deps

WORKDIR /app

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files (monorepo lockfile depends on all of them)
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/

# Install ALL dependencies (including devDependencies needed for web build)
# --linker=hoisted: Bun's default "isolated" linker stores packages in
# node_modules/.bun/ with symlinks that Vite/Rollup cannot resolve during
# production builds. Hoisted layout gives classic flat node_modules.
RUN bun install --frozen-lockfile --linker=hoisted

# ---------------------------------------------------------------------------
# Stage 2: Build web UI (Vite + React)
# ---------------------------------------------------------------------------
FROM deps AS web-build

# Copy full source (needed for workspace resolution and web build)
COPY . .

# Build the web frontend — output goes to packages/web/dist/
RUN bun run build:web && \
    test -f packages/web/dist/index.html || \
    (echo "ERROR: Web build produced no index.html" >&2 && exit 1)

# ---------------------------------------------------------------------------
# Stage 3: Production image
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS production

# OCI Labels for GHCR
LABEL org.opencontainers.image.source="https://github.com/coleam00/Archon"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies + gosu for privilege dropping in entrypoint
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    ca-certificates \
    gnupg \
    gosu \
    postgresql-client \
    # Chromium for agent-browser E2E testing (drives browser via CDP)
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser CLI (Vercel Labs) for E2E testing workflows
# - Uses npm (not bun) because postinstall script downloads the native Rust binary
# - After install, symlink the Rust binary directly and purge nodejs/npm (~60MB saved)
# - The npm entry point is a Node.js wrapper; the native binary works standalone
# - agent-browser auto-detects Docker (via /.dockerenv) and adds --no-sandbox to Chromium
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g agent-browser@0.22.1 \
    && NATIVE_BIN=$(find /usr/local/lib/node_modules/agent-browser -name 'agent-browser-*' -type f -executable 2>/dev/null | head -1) \
    && if [ -n "$NATIVE_BIN" ]; then \
         cp "$NATIVE_BIN" /usr/local/bin/agent-browser-native \
         && chmod +x /usr/local/bin/agent-browser-native \
         && ln -sf /usr/local/bin/agent-browser-native /usr/local/bin/agent-browser; \
       else \
         echo "ERROR: agent-browser native binary not found after npm install" >&2 && exit 1; \
       fi \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/agent-browser \
    && apt-get purge -y nodejs npm \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Point agent-browser to system Chromium (avoids ~400MB Chrome for Testing download)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/

# Install production dependencies only (--ignore-scripts skips husky prepare hook)
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted

# Copy application source (Bun runs TypeScript directly, no compile step needed)
COPY packages/adapters/ ./packages/adapters/
COPY packages/cli/ ./packages/cli/
COPY packages/core/ ./packages/core/
COPY packages/git/ ./packages/git/
COPY packages/isolation/ ./packages/isolation/
COPY packages/paths/ ./packages/paths/
COPY packages/providers/ ./packages/providers/
COPY packages/server/ ./packages/server/
COPY packages/workflows/ ./packages/workflows/

# Copy pre-built web UI from build stage
COPY --from=web-build /app/packages/web/dist/ ./packages/web/dist/

# Copy config, migrations, and bundled defaults
COPY .archon/ ./.archon/
COPY migrations/ ./migrations/
COPY tsconfig*.json ./

# Fix permissions for appuser
RUN chown -R appuser:appuser /app

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex && chown appuser:appuser /home/appuser/.codex

# Configure git to trust Archon directories (as appuser)
RUN gosu appuser git config --global --add safe.directory '/.archon/workspaces' && \
    gosu appuser git config --global --add safe.directory '/.archon/workspaces/*' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees/*'

# Copy entrypoint script (fixes volume permissions, drops to appuser)
# sed strips Windows CRLF in case .gitattributes eol=lf was bypassed
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Default port (matches .env.example PORT=3000)
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
