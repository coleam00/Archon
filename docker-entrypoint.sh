#!/bin/bash
set -e

# Ensure required subdirectories exist.
# Named volumes inherit these from the image layer on first run; bind mounts do not,
# which causes the Claude subprocess to fail silently when spawned with a missing cwd.
mkdir -p /.archon/workspaces /.archon/worktrees

# Determine if we need to use gosu for privilege dropping
if [ "$(id -u)" = "0" ]; then
  # Running as root: fix volume permissions, then drop to appuser
  if ! chown -Rh appuser:appuser /.archon 2>/dev/null; then
    echo "ERROR: Failed to fix ownership of /.archon — volume may be read-only or mounted with incompatible options" >&2
    exit 1
  fi
  # /home/appuser is persisted to a named volume (or bind-mounted via
  # ARCHON_USER_HOME) so Claude/Codex/Pi config, ~/.gitconfig, shell history,
  # and other user-specific state survive rebuilds. On bind mounts, host UIDs
  # don't map to appuser (1001), so fix ownership the same way we do /.archon.
  if ! chown -Rh appuser:appuser /home/appuser 2>/dev/null; then
    echo "ERROR: Failed to fix ownership of /home/appuser — volume may be read-only or mounted with incompatible options" >&2
    exit 1
  fi
  RUNNER="gosu appuser"
else
  # Already running as non-root (e.g., --user flag or Kubernetes)
  RUNNER=""
fi

# Warn if vars known to be ignored inside the container were set via env_file: .env.
# These leak in but have no effect (ARCHON_HOME is overridden to /.archon by source;
# ARCHON_DATA is a host-side compose substitution token, never read by the container).
if [ -n "${ARCHON_HOME:-}" ]; then
  echo "[archon] ARCHON_HOME=${ARCHON_HOME} ignored in Docker (container home is fixed at /.archon)" >&2
fi
if [ -n "${ARCHON_DATA:-}" ]; then
  echo "[archon] ARCHON_DATA=${ARCHON_DATA} is a host-side compose token; not read inside the container" >&2
fi

# Register all git repositories under /.archon as safe directories.
# Git 2.35.2+ (CVE-2022-24765) rejects repos owned by a different UID.
# On macOS bind mounts (VirtioFS), host UIDs don't map to appuser (1001),
# so git prints "dubious ownership" and refuses all operations.
# The Dockerfile RUN-layer registers fixed paths, but that gitconfig lives
# in the image layer — bind mounts don't inherit it on restart, and
# worktrees are nested at arbitrary depths unknown at build time.
# With /home/appuser now persisted, ~/.gitconfig survives across restarts —
# so we must check before --add or duplicate safe.directory lines accumulate
# every boot.
find /.archon -name ".git" -prune -print 2>/dev/null | while IFS= read -r git_dir; do
  repo_dir="$(dirname "$git_dir")"
  if ! $RUNNER git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$repo_dir"; then
    $RUNNER git config --global --add safe.directory "$repo_dir"
  fi
done

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
