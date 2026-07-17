#!/usr/bin/env bash
#
# Archon runner entrypoint (PID 1).
#
# Mounts the overlayfs — read-only lower bind of the project root
# (/mnt/lower) + writable upper/work on the per-run volume (/mnt/upper) — at the
# host's absolute cwd ($ARCHON_WORKSPACE_PATH), so working_path, $ARTIFACTS_DIR,
# and every path substitution stay unchanged (same-absolute-path invariant).
#
# The mount MODE is dictated by the backend via $ARCHON_OVERLAY_MODE so the
# security posture is explicit per container, not guessed here:
#   - fuse   → fuse-overlayfs (backend ran us with /dev/fuse and NO CAP_SYS_ADMIN;
#              only works where the daemon grants unprivileged FUSE mounts —
#              rootless / userns-remap — otherwise this FAILS FAST and the backend
#              retries in native mode).
#   - native → kernel `mount -t overlay` (backend ran us WITH CAP_SYS_ADMIN +
#              apparmor=unconfined). See SECURITY.md: CAP_SYS_ADMIN lets
#              in-container root remount the /mnt/lower bind read-write, so native
#              mode is isolation-hardening, NOT a sandbox against a hostile agent.
#
# On mount failure we exit 1 immediately (fail fast) so the backend's ready-poll
# sees the container exit and falls back / surfaces the error without waiting out
# the full timeout. All real work arrives later via `docker exec`.
set -euo pipefail

WS="${ARCHON_WORKSPACE_PATH:?ARCHON_WORKSPACE_PATH must be set}"
MODE="${ARCHON_OVERLAY_MODE:-native}"
LOWER=/mnt/lower
UPPER=/mnt/upper/data
WORK=/mnt/upper/work

# Upper/work MUST live on the named volume (VM-local), never a host bind, or the
# overlay upperdir hits EACCES on macOS (orbstack#1376). claude-home is a sibling
# so Claude session state stays OFF the write-back diff.
mkdir -p "$UPPER" "$WORK" /mnt/upper/claude-home
mkdir -p "$WS"

overlay_opts="lowerdir=${LOWER},upperdir=${UPPER},workdir=${WORK}"

case "$MODE" in
  fuse)
    if fuse-overlayfs -o "$overlay_opts" "$WS" 2>/tmp/overlay-fuse.err; then
      echo "archon-runner: fuse-overlayfs mounted at ${WS} (no CAP_SYS_ADMIN)"
    else
      echo "archon-runner: FATAL — fuse-overlayfs mount failed at ${WS}" >&2
      cat /tmp/overlay-fuse.err >&2 2>/dev/null || true
      echo "archon-runner: (unprivileged FUSE mount needs a rootless/userns daemon)" >&2
      exit 1
    fi
    ;;
  native)
    if mount -t overlay overlay -o "$overlay_opts" "$WS" 2>/tmp/overlay-native.err; then
      echo "archon-runner: native overlay mounted at ${WS} (CAP_SYS_ADMIN)"
    else
      echo "archon-runner: FATAL — native overlay mount failed at ${WS}" >&2
      cat /tmp/overlay-native.err >&2 2>/dev/null || true
      exit 1
    fi
    ;;
  *)
    echo "archon-runner: FATAL — unknown ARCHON_OVERLAY_MODE='${MODE}' (want fuse|native)" >&2
    exit 1
    ;;
esac

# Ready sentinel the backend's prepare() polls for (docker exec test -f).
touch /mnt/upper/.ready

# PID 1 idles; nodes run via `docker exec`. `sleep infinity` reaps nothing, which
# is fine — exec'd processes are children of the docker daemon, not of PID 1.
exec sleep infinity
