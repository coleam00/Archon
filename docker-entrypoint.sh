#!/bin/bash
set -e

# Ensure required subdirectories exist.
# Named volumes inherit these from the image layer on first run; bind mounts do not,
# which causes the Claude subprocess to fail silently when spawned with a missing cwd.
mkdir -p /.archon/workspaces /.archon/worktrees

# Determine if we need to use gosu for privilege dropping
if [ "$(id -u)" = "0" ]; then
  # Running as root: try to fix volume permissions, then drop to appuser.
  # chown can fail when a host bind-mount controls ownership (e.g. macOS
  # VirtioFS: host UID 501 cannot be remapped to container appuser 1001).
  # On Linux the same failure is also produced by SELinux/AppArmor denials,
  # read-only mounts, or wrong --mount type — and they look identical from
  # inside the container, so we cannot auto-distinguish.
  #
  # Capture chown stderr so the diagnosis is actionable, then require an
  # explicit opt-in (ARCHON_ALLOW_ROOT_FALLBACK=1) before bypassing the
  # UID-0 safety guard in ClaudeProvider (provider.ts checks
  # `getProcessUid() === 0 && IS_SANDBOX !== '1'` and refuses to start).
  # Without the opt-in we exit loud — better than a silent root-execution
  # path on a misconfigured Linux host.
  chown_failed=0
  chown_errors=""
  if ! chown_err=$(chown -Rh appuser:appuser /.archon 2>&1); then
    chown_failed=1
    chown_errors="${chown_errors}  /.archon: ${chown_err}"$'\n'
  fi
  # /home/appuser is persisted to a named volume (or bind-mounted via
  # ARCHON_USER_HOME) so Claude/Codex/Pi config, ~/.gitconfig, shell history,
  # and other user-specific state survive rebuilds. Same chown story as
  # /.archon — bind mounts may carry host UIDs that don't map to appuser.
  if ! chown_err=$(chown -Rh appuser:appuser /home/appuser 2>&1); then
    chown_failed=1
    chown_errors="${chown_errors}  /home/appuser: ${chown_err}"$'\n'
  fi
  if [ "$chown_failed" = "0" ]; then
    RUNNER="gosu appuser"
  else
    echo "WARNING: chown failed:" >&2
    printf "%s" "$chown_errors" >&2
    if [ "${ARCHON_ALLOW_ROOT_FALLBACK:-0}" = "1" ]; then
      echo "WARNING: ARCHON_ALLOW_ROOT_FALLBACK=1 — continuing as root with IS_SANDBOX=1." >&2
      export IS_SANDBOX=1
      RUNNER=""
    else
      echo "ERROR: refusing to run as root. On macOS VirtioFS this is expected — set ARCHON_ALLOW_ROOT_FALLBACK=1 in your environment to opt in. On Linux, fix volume ownership instead." >&2
      exit 1
    fi
  fi
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

# Pin the glibc Claude Code binary to bypass the SDK's musl-first resolver.
# Bun's hoisted linker installs both glibc and musl optional-dep variants for
# the current CPU arch; the SDK picks musl first, which fails to execute on
# this Debian (glibc) image. Only sets CLAUDE_BIN_PATH if the user has not
# already provided one via docker run -e or docker-compose env_file.
if [ -z "${CLAUDE_BIN_PATH:-}" ]; then
  case "$(uname -m)" in
    x86_64)  _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" ;;
    aarch64) _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude" ;;
    *)
      echo "ERROR: Unsupported CPU architecture $(uname -m). Set CLAUDE_BIN_PATH manually to a glibc Claude binary." >&2
      exit 1
      ;;
  esac
  if [ -x "$_CLAUDE_BIN_CANDIDATE" ]; then
    export CLAUDE_BIN_PATH="$_CLAUDE_BIN_CANDIDATE"
  else
    echo "ERROR: Pinned Claude binary missing or non-executable at ${_CLAUDE_BIN_CANDIDATE}. The SDK package layout may have changed; set CLAUDE_BIN_PATH manually." >&2
    exit 1
  fi
  unset _CLAUDE_BIN_CANDIDATE
fi

# Run setup-auth (exits after configuring Codex credentials), then exec the server
# exec ensures bun is PID 1 and receives SIGTERM for graceful shutdown
$RUNNER bun run setup-auth
exec $RUNNER bun run start
