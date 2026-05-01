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
  RUNNER="gosu appuser"
else
  # Already running as non-root (e.g., --user flag or Kubernetes)
  RUNNER=""
fi

# Register all git repositories under /.archon as safe directories.
# Git 2.35.2+ (CVE-2022-24765) rejects repos owned by a different UID.
# On macOS bind mounts (VirtioFS), host UIDs don't map to appuser (1001),
# so git prints "dubious ownership" and refuses all operations.
# The Dockerfile RUN-layer registers fixed paths, but that gitconfig lives
# in the image layer — bind mounts don't inherit it on restart, and
# worktrees are nested at arbitrary depths unknown at build time.
find /.archon -name ".git" -prune -print 2>/dev/null | while IFS= read -r git_dir; do
  $RUNNER git config --global --add safe.directory "$(dirname "$git_dir")"
done

# Configure git to use GH_TOKEN for HTTPS clones via credential helper
# Uses a helper function so the token stays in the environment, not in ~/.gitconfig
if [ -n "$GH_TOKEN" ]; then
  $RUNNER git config --global credential."https://github.com".helper \
    '!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'
fi

# Pin the glibc Claude Code binary to bypass the SDK's musl-first resolver.
# Bun's hoisted linker installs both glibc and musl optional-dep variants for
# the current CPU arch; the SDK picks musl first, which fails to execute on
# this Debian (glibc) image. Only sets CLAUDE_BIN_PATH if the user has not
# already provided one via docker run -e or docker-compose env_file.
if [ -z "${CLAUDE_BIN_PATH:-}" ]; then
  case "$(uname -m)" in
    x86_64)  _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" ;;
    aarch64) _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude" ;;
    *) echo "WARN: Unsupported CPU architecture $(uname -m). Set CLAUDE_BIN_PATH manually if Claude fails to start." >&2 ;;
  esac
  if [ -n "${_CLAUDE_BIN_CANDIDATE:-}" ]; then
    if [ -f "$_CLAUDE_BIN_CANDIDATE" ]; then
      export CLAUDE_BIN_PATH="$_CLAUDE_BIN_CANDIDATE"
    else
      echo "WARN: Pinned Claude binary not found at ${_CLAUDE_BIN_CANDIDATE}. SDK will use its default resolver — Claude may fail to start." >&2
    fi
  fi
fi

# Run setup-auth (exits after configuring Codex credentials), then exec the server
# exec ensures bun is PID 1 and receives SIGTERM for graceful shutdown
$RUNNER bun run setup-auth
exec $RUNNER bun run start
