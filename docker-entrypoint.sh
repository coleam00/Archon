#!/bin/bash
set -e -o pipefail

# Ensure required subdirectories exist.
# Named volumes inherit these from the image layer on first run; bind mounts do not,
# which causes the Claude subprocess to fail silently when spawned with a missing cwd.
mkdir -p /.archon/workspaces /.archon/worktrees

# Determine if we need to use gosu for privilege dropping.
# Default: run commands as-is — already non-root (e.g., --user flag or
# Kubernetes), or root via the explicit ARCHON_ALLOW_ROOT_FALLBACK opt-in below.
RUNNER=""
if [ "$(id -u)" = "0" ]; then
  # A blanket `chown -R` rewrites metadata for every inode (#1970); only files
  # with wrong ownership are touched.
  # find + chown -h leaves symlinks un-dereferenced (no-dereference by design).
  #
  # chown can fail when the host controls ownership: on macOS VirtioFS bind
  # mounts, host UIDs cannot be remapped to appuser (1001) at all. On Linux,
  # SELinux/AppArmor denials or read-only mounts produce the same failure and
  # look identical from inside the container, so we cannot auto-distinguish.
  # Failures are accumulated (not exited inline) so we can branch once below
  # on the explicit ARCHON_ALLOW_ROOT_FALLBACK opt-in.
  chown_failed=0
  fix_ownership() {
    local err
    # -o is correct: we want appuser:appuser on both, not "either matches".
    if ! err=$(find "$1" \( ! -user appuser -o ! -group appuser \) -exec chown -h appuser:appuser {} + 2>&1 >/dev/null); then
      if [ -n "$err" ]; then
        echo "$err" >&2
      fi
      echo "ERROR: Failed to fix ownership of $1 — volume may be read-only or mounted with incompatible options" >&2
      chown_failed=1
    fi
  }
  fix_ownership /.archon
  # /home/appuser is persisted to a named volume (or bind-mounted via
  # ARCHON_USER_HOME) so Claude/Codex/Pi config, ~/.gitconfig, shell history,
  # and other user-specific state survive rebuilds. On bind mounts, host UIDs
  # don't map to appuser (1001), so fix ownership via fix_ownership as well.
  fix_ownership /home/appuser
  if [ "$chown_failed" = "0" ]; then
    RUNNER="gosu appuser"
  elif [ "${ARCHON_ALLOW_ROOT_FALLBACK:-0}" = "1" ]; then
    # Explicit opt-in (macOS VirtioFS escape hatch): continue as root.
    # IS_SANDBOX=1 satisfies ClaudeProvider's UID-0 guard
    # (packages/providers/src/claude/provider.ts), which otherwise refuses
    # bypassPermissions as root. Never auto-enabled — default stays fail-loud.
    echo "WARNING: ARCHON_ALLOW_ROOT_FALLBACK=1 — continuing as root with IS_SANDBOX=1." >&2
    export IS_SANDBOX=1
  else
    # Fail loud (default) — see the docker deployment guide for the
    # ARCHON_ALLOW_ROOT_FALLBACK opt-in.
    exit 1
  fi
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
find /.archon -name ".git" -prune -print0 | while IFS= read -r -d '' git_dir; do
  repo_dir="${git_dir%/.git}"
  $RUNNER bun -e 'import { addSafeDirectory, toRepoPath } from "@archon/git"; await addSafeDirectory(toRepoPath(process.argv[1]));' "$repo_dir"
done

# The token stays in the environment, not in the persisted ~/.gitconfig.
ARCHON_PAT_HELPER='!f() { echo "username=x-access-token"; echo "password=${GH_TOKEN}"; }; f'
# Mirrors selectGitHubAuthMode (packages/core/src/utils/github-auth-mode.ts)
# on the container env only: the server also loads /.archon/.env, which this
# script never reads, so docker.md requires the GitHub auth variables in the
# container env. A partial App config or an App/PAT conflict leaves PAT
# behavior untouched. scripts/docker-entrypoint.test.ts checks the two agree.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${WEBHOOK_SECRET:-}" ] &&
  [ -n "${GITHUB_APP_PRIVATE_KEY:-}${GITHUB_APP_PRIVATE_KEY_PATH:-}" ] &&
  [ -z "${GITHUB_TOKEN:-}" ]; then
  # Exact matching preserves operator helpers; Git returns 5 when none match.
  $RUNNER git config --global --fixed-value --unset-all \
    credential."https://github.com".helper "$ARCHON_PAT_HELPER" || [ $? -eq 5 ]
elif [ -n "${GH_TOKEN:-}" ]; then
  # --replace-all: `gh auth login` / `gh auth setup-git` can write several values;
  # a plain set then exits non-zero under `set -e`, crash-looping on restart.
  $RUNNER git config --global --replace-all credential."https://github.com".helper \
    "$ARCHON_PAT_HELPER"
fi
unset ARCHON_PAT_HELPER

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

# exec ensures bun is PID 1 and receives SIGTERM for graceful shutdown
$RUNNER bun run provision:docker
$RUNNER bun run setup-auth
exec $RUNNER bun run start
