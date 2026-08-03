#!/bin/bash
# validate-setup.sh - Validate Remote Coding Agent configuration
#
# Usage: ./scripts/validate-setup.sh

set -e

echo "Remote Coding Agent Setup Validator"
echo "======================================="
echo ""

ERRORS=0
WARNINGS=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
  echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
  echo -e "${RED}✗${NC} $1"
  ((ERRORS++))
}

check_warn() {
  echo -e "${YELLOW}!${NC} $1"
  ((WARNINGS++))
}

# Check .env file
echo "Configuration Files"
echo "----------------------"

if [ -f ".env" ]; then
  check_pass ".env file exists"
else
  check_fail ".env file not found (copy from .env.example)"
fi

# Check required environment variables
echo ""
echo "Required Environment Variables"
echo "----------------------------------"

# Load .env if exists
if [ -f ".env" ]; then
  set -a
  source .env 2>/dev/null || true
  set +a
fi

if [ -n "$DATABASE_URL" ]; then
  check_pass "DATABASE_URL is set"
else
  check_fail "DATABASE_URL not set"
fi

# AI Assistants
echo ""
echo "AI Assistants"
echo "----------------"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$CLAUDE_API_KEY" ]; then
  check_pass "Claude credentials configured"
else
  check_warn "Claude credentials not found"
fi

if [ -n "$CODEX_ID_TOKEN" ] && [ -n "$CODEX_ACCESS_TOKEN" ]; then
  check_pass "Codex credentials configured"
else
  check_warn "Codex credentials not found"
fi

if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$CLAUDE_API_KEY" ] && [ -z "$CODEX_ID_TOKEN" ]; then
  check_fail "No AI assistant credentials found (need at least one)"
fi

# Platforms
echo ""
echo "Platform Adapters"
echo "--------------------"

PLATFORMS=0

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  check_pass "Telegram configured"
  ((PLATFORMS++))
else
  check_warn "Telegram not configured"
fi

if [ -n "$DISCORD_BOT_TOKEN" ]; then
  check_pass "Discord configured"
  ((PLATFORMS++))
else
  check_warn "Discord not configured"
fi

if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_APP_TOKEN" ]; then
  check_pass "Slack configured"
  ((PLATFORMS++))
else
  check_warn "Slack not configured"
fi

if [ -n "$GITHUB_TOKEN" ] && [ -n "$WEBHOOK_SECRET" ]; then
  check_pass "GitHub webhooks configured"
  ((PLATFORMS++))
else
  check_warn "GitHub webhooks not configured"
fi

if [ $PLATFORMS -eq 0 ]; then
  check_fail "No platform adapters configured (need at least one)"
fi

# Docker
echo ""
echo "Docker"
echo "---------"

if command -v docker &> /dev/null; then
  check_pass "Docker is installed"

  if docker compose version &> /dev/null; then
    check_pass "Docker Compose is available"
  else
    check_warn "Docker Compose not found"
  fi
else
  check_warn "Docker not installed (required for containerized deployment)"
fi

# Archon paths
echo ""
echo "Archon Paths"
echo "---------------"

ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
echo "  Home: $ARCHON_HOME"
echo "  Workspaces: $ARCHON_HOME/workspaces"
echo "  Worktrees: $ARCHON_HOME/worktrees"

if [ -d "$ARCHON_HOME" ]; then
  check_pass "Archon home directory exists"
  if [ -f "$ARCHON_HOME/config.yaml" ]; then
    check_pass "Global config exists ($ARCHON_HOME/config.yaml)"
  else
    check_warn "Global config will be created on first run"
  fi
else
  check_warn "Archon home directory will be created on first run"
fi

# Summary
echo ""
echo "======================================="
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}Validation failed with $ERRORS error(s) and $WARNINGS warning(s)${NC}"
  echo ""
  echo "Please fix the errors above before running the application."
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}Validation passed with $WARNINGS warning(s)${NC}"
  echo ""
  echo "The application should work, but some features may be unavailable."
  exit 0
else
  echo -e "${GREEN}All checks passed!${NC}"
  echo ""
  echo "You can start the application with:"
  echo "  bun run dev      # Development with hot reload"
  echo "  docker compose up -d  # Docker deployment"
  exit 0
fi
