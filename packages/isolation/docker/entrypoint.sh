#!/usr/bin/env bash
#
# Archon runner entrypoint (PID 1).
#
# Mounts the overlayfs — read-only lower bind of the project root
# (/mnt/lower) + writable upper/work on the per-run volume (/mnt/upper) — at the
# host's absolute cwd ($ARCHON_WORKSPACE_PATH), so working_path, $ARTIFACTS_DIR,
# and every path substitution stay unchanged (same-absolute-path invariant).
# Native `mount -t overlay` first (needs CAP_SYS_ADMIN); fuse-overlayfs fallback
# (needs /dev/fuse). Then signals readiness and sleeps forever — all real work
# arrives via `docker exec`.
set -euo pipefail

WS="${ARCHON_WORKSPACE_PATH:?ARCHON_WORKSPACE_PATH must be set}"
LOWER=/mnt/lower
UPPER=/mnt/upper/data
WORK=/mnt/upper/work

# Upper/work MUST live on the named volume (VM-local), never a host bind, or the
# overlay upperdir hits EACCES on macOS (orbstack#1376). claude-home is a sibling
# so Claude session state stays OFF the write-back diff.
mkdir -p "$UPPER" "$WORK" /mnt/upper/claude-home
mkdir -p "$WS"

overlay_opts="lowerdir=${LOWER},upperdir=${UPPER},workdir=${WORK}"

if mount -t overlay overlay -o "$overlay_opts" "$WS" 2>/tmp/overlay-native.err; then
  echo "archon-runner: native overlay mounted at ${WS}"
elif command -v fuse-overlayfs >/dev/null 2>&1 \
  && fuse-overlayfs -o "$overlay_opts" "$WS" 2>/tmp/overlay-fuse.err; then
  echo "archon-runner: fuse-overlayfs mounted at ${WS}"
else
  echo "archon-runner: FATAL — could not mount overlay at ${WS}" >&2
  echo "--- native mount error ---" >&2
  cat /tmp/overlay-native.err >&2 2>/dev/null || true
  echo "--- fuse-overlayfs error ---" >&2
  cat /tmp/overlay-fuse.err >&2 2>/dev/null || true
  exit 1
fi

# Ready sentinel the backend's prepare() polls for (docker exec test -f).
touch /mnt/upper/.ready

# PID 1 idles; nodes run via `docker exec`. `sleep infinity` reaps nothing, which
# is fine — exec'd processes are children of the docker daemon, not of PID 1.
exec sleep infinity
