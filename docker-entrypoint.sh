#!/bin/bash
set -e

# Ensure required subdirectories exist.
# Named volumes inherit these from the image layer on first run; bind mounts do not,
# which causes the Claude subprocess to fail silently when spawned with a missing cwd.
if [ -n "${HARNEESLAB_HOME:-}" ]; then
  HARNEESLAB_DATA_DIR="$HARNEESLAB_HOME"
elif [ -n "${ARCHON_HOME:-}" ]; then
  HARNEESLAB_DATA_DIR="$ARCHON_HOME"
elif [ "${HARNEESLAB_DOCKER:-}" = "true" ]; then
  HARNEESLAB_DATA_DIR="/.harneeslab"
else
  HARNEESLAB_DATA_DIR="/.archon"
fi
export HARNEESLAB_HOME="$HARNEESLAB_DATA_DIR"

mkdir -p "$HARNEESLAB_DATA_DIR/workspaces" "$HARNEESLAB_DATA_DIR/worktrees"

# Determine if we need to use gosu for privilege dropping
if [ "$(id -u)" = "0" ]; then
  # Running as root: fix volume permissions, then drop to appuser
  if ! chown -Rh appuser:appuser "$HARNEESLAB_DATA_DIR" 2>/dev/null; then
    echo "ERROR: Failed to fix ownership of $HARNEESLAB_DATA_DIR — volume may be read-only or mounted with incompatible options" >&2
    exit 1
  fi
  RUNNER="gosu appuser"
else
  # Already running as non-root (e.g., --user flag or Kubernetes)
  RUNNER=""
fi

# Configure git to use GH_TOKEN for HTTPS clones via credential helper
# Uses a helper function so the token stays in the environment, not in ~/.gitconfig
if [ -n "$GH_TOKEN" ]; then
  $RUNNER git config --global credential."https://github.com".helper \
    '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'
fi

# Run setup-auth (exits after configuring Codex credentials), then exec the server
# exec ensures bun is PID 1 and receives SIGTERM for graceful shutdown
$RUNNER bun run setup-auth
exec $RUNNER bun run start
