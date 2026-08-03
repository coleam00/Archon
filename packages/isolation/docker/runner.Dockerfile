# Archon container-isolation runner image.
#
# Runs a folder-project workflow inside an isolated container over a read-only
# bind of the project root (/mnt/lower) + a writable overlayfs upper layer on a
# per-run named volume (/mnt/upper), merged by entrypoint.sh at the host's
# absolute cwd. Ships the Claude Code native binary plus git/bash/bun/uv so
# Claude, bash: nodes, and script: nodes all execute in here.
#
# Build (tag with the Archon version, e.g. archon-runner:0.5.0):
#   docker build -t archon-runner:<version> \
#     -f packages/isolation/docker/runner.Dockerfile packages/isolation/docker
# Or: bun run build:runner-image
#
# Supply chain: the base image is pinned by digest and every tool below is
# version-pinned so the image is reproducible and a compromised installer
# endpoint can't silently pull a newer/tampered binary. The vendor installer
# SCRIPTS themselves are still fetched over TLS at build time and are not
# checksum-verified (they aren't published with stable checksums) — an accepted,
# documented residual (see SECURITY.md). Bump the *_VERSION args deliberately.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ENV DEBIAN_FRONTEND=noninteractive

# Pinned tool versions (bump deliberately; keep in sync with the version the
# maintainer validated). CLAUDE_VERSION 'stable' / 'latest' / 'X.Y.Z' accepted.
ARG CLAUDE_VERSION=2.1.211
ARG BUN_VERSION=1.3.14
ARG UV_VERSION=0.11.29

# Runtime deps: git/bash/rsync for workflow work, ca-certificates+curl for the
# installers, fuse-overlayfs as the overlay fallback, procps for in-container
# process signalling (the Claude spawn kills by pid across `docker exec`),
# unzip/xz for the bun/claude installers.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    bash \
    rsync \
    fuse-overlayfs \
    procps \
    unzip \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Claude Code native binary (self-contained), pinned to $CLAUDE_VERSION.
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && test -x /root/.local/bin/claude \
    || (echo "FATAL: claude binary not found after install" >&2 && exit 1)

# bun (script: nodes with runtime: bun) → /root/.bun/bin/bun, pinned to $BUN_VERSION.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && test -x /root/.bun/bin/bun \
    || (echo "FATAL: bun not found after install" >&2 && exit 1)

# uv (script: nodes with runtime: uv) → /root/.local/bin/uv, pinned via the
# versioned installer URL (https://astral.sh/uv/<version>/install.sh).
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && test -x /root/.local/bin/uv \
    || (echo "FATAL: uv not found after install" >&2 && exit 1)

ENV PATH="/root/.local/bin:/root/.bun/bin:${PATH}"

# The merged overlay is mounted at the host's absolute cwd, whose files git would
# otherwise flag as dubious-ownership. Trust every path (the container is
# single-purpose and isolated).
RUN git config --system --add safe.directory '*'

# Claude Code refuses --dangerously-skip-permissions as root UNLESS IS_SANDBOX=1.
# We run in-container work as root under this flag deliberately: writing across
# the host-owned read-only lower layer needs root, and the container is the
# isolation-hardening boundary (read-only lower bind + overlay upper on a VM-local
# volume + Archon-managed env only + approval-gated write-back, Phase C).
#
# SECURITY (read packages/isolation/docker/SECURITY.md): this is NOT a sandbox
# against a hostile / prompt-injected agent when the container runs in `native`
# overlay mode. Native mode grants CAP_SYS_ADMIN, so in-container root can
# `mount -o remount,rw /mnt/lower` and write straight through the :ro bind to the
# live host root — defeating the advertised isolation. The `fuse` mode (preferred,
# no CAP_SYS_ADMIN) closes that escape but only mounts on rootless/userns daemons.
# Non-root exec over overlay-on-bind is also fragile across storage drivers;
# hardening to a uid-matched non-root user is follow-up.
ENV IS_SANDBOX=1

# Claude session/config live on the upper VOLUME but OUTSIDE the overlay diff
# (/mnt/upper/claude-home is a sibling of the overlay's data/work dirs), so they
# survive a stop/start of the same run (Phase C) and never pollute the
# write-back file diff.
ENV CLAUDE_CONFIG_DIR=/mnt/upper/claude-home

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
