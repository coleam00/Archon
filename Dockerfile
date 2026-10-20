# =============================================================================
# Archon - Remote Agentic Coding Platform
# Multi-stage build: workspace layout → deps → image plugins + web build → production image
# =============================================================================

ARG BUN_VERSION=1.4.2

# ---------------------------------------------------------------------------
# Workspace layout, derived from packages/ so a new package needs no edit here
# ---------------------------------------------------------------------------
# Every workspace package.json and nothing else. A source-only change leaves this
# output byte-identical, so the install layers that copy it stay cached.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /app
COPY packages/ ./packages/
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -r {} +

# Package source for the production image. Each exclusion is deliberate; rm
# without -f fails the build if an excluded package is renamed or removed.
#   docs-web   - static site deployed separately (.github/workflows/deploy-docs.yml)
#   web        - ships only as the pre-built dist from the web-build stage
#   chat-slack - ships as a verified release binary in image-plugins;
#                the server never imports its source
FROM oven/bun:${BUN_VERSION}-slim AS sources
WORKDIR /app
COPY packages/ ./packages/
RUN rm -r packages/docs-web packages/web packages/chat-slack

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Every workspace manifest, docs-web and chat-slack included: the monorepo
# lockfile resolves against all of them.
COPY --from=manifests /app/packages/ ./packages/

# Install ALL dependencies (including devDependencies needed for web build)
# --linker=hoisted: Bun's default "isolated" linker stores packages in
# node_modules/.bun/ with symlinks that Vite/Rollup cannot resolve during
# production builds. Hoisted layout gives classic flat node_modules.
RUN bun install --frozen-lockfile --linker=hoisted

# Release acquisition happens only at build time; startup provisions from this bundle offline.
FROM deps AS image-plugins
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sources /app/packages/ ./packages/
COPY scripts/prepare-docker-plugins.ts ./scripts/
ARG SLACK_PLUGIN_TAG=v0.12.1
ARG SLACK_PLUGIN_COMMIT=5f2b4841aaca38180c0abbd32bc6345593292019
RUN SLACK_PLUGIN_TAG="$SLACK_PLUGIN_TAG" SLACK_PLUGIN_COMMIT="$SLACK_PLUGIN_COMMIT" \
    bun run scripts/prepare-docker-plugins.ts

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
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS production

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
    # ripgrep + jq: expected by Claude Code / Codex agents (rg is their default
    # code-search tool; jq powers JSON handling in bash workflow nodes) — see #1836
    ripgrep \
    jq \
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

# CLAUDE_BIN_PATH is set at container startup (docker-entrypoint.sh).
# The entrypoint pins the glibc variant to bypass the SDK's musl-first resolver.

ENV HOME=/home/appuser

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
# /app is still empty here (only WORKDIR created it) — non-recursive chown suffices.
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# A trailing `RUN chown -R /app` would duplicate every inode into a new image layer (#1970).
USER appuser

# Copy root package files and lockfile
COPY --chown=appuser:appuser package.json bun.lock ./

# Every workspace manifest (see the deps stage)
COPY --from=manifests --chown=appuser:appuser /app/packages/ ./packages/

# Install production dependencies only (--ignore-scripts skips husky prepare hook).
# Cache goes to /tmp and is removed in the same layer: not baked into the image,
# not copied into the /home/appuser volume on first run.
RUN HOME=/home/appuser BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache \
      bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted \
    && rm -rf /tmp/bun-install-cache

# Copy application source (Bun runs TypeScript directly, no compile step needed).
# The sources stage lists the packages left out.
COPY --from=sources --chown=appuser:appuser /app/packages/ ./packages/

COPY --from=image-plugins /opt/archon/image-plugins/ /opt/archon/image-plugins/
COPY --chown=appuser:appuser scripts/provision-docker-plugins.ts ./scripts/

# Copy pre-built web UI from build stage
COPY --from=web-build --chown=appuser:appuser /app/packages/web/dist/ ./packages/web/dist/

# Copy config, migrations, and bundled defaults
COPY --chown=appuser:appuser .archon/ ./.archon/
COPY --chown=appuser:appuser migrations/ ./migrations/
COPY --chown=appuser:appuser tsconfig*.json ./

# Back to root: the entrypoint must start as root to fix volume ownership,
# and the gosu git-config setup below requires it.
USER root

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex && chown appuser:appuser /home/appuser/.codex

# Configure git to trust Archon directories (as appuser)
RUN gosu appuser git config --global --fixed-value --replace-all safe.directory '/.archon/workspaces' '/.archon/workspaces' && \
    gosu appuser git config --global --fixed-value --replace-all safe.directory '/.archon/workspaces/*' '/.archon/workspaces/*' && \
    gosu appuser git config --global --fixed-value --replace-all safe.directory '/.archon/worktrees' '/.archon/worktrees' && \
    gosu appuser git config --global --fixed-value --replace-all safe.directory '/.archon/worktrees/*' '/.archon/worktrees/*'

# Copy entrypoint script (fixes volume permissions, drops to appuser)
# sed strips Windows CRLF in case .gitattributes eol=lf was bypassed
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Default port (matches .env.example PORT=3000)
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
