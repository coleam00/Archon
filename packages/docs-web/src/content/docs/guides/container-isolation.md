---
title: Container Isolation
description: Run folder-project workflows inside an overlay-isolated Docker container with governed, approval-gated write-back to the live root.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 12
---

[Folder projects](/guides/multi-repo-projects/) — directories with or without git, where Archon applies no git machinery — run **in place** at the live root by default: every write lands immediately. That is honest but ungoverned, and unsafe for unattended automation against real client data. **Container isolation** runs the whole workflow inside a Docker container over a **read-only mount of the project root plus a writable overlay upper layer**, so nothing touches the live folder until you approve it.

This is folder-project-only. Repo projects use [git worktrees](/guides/worktrees/) and are unaffected.

## How it works

```
prepare → container (root mounted read-only, overlay upper on a per-run volume)
   claude + bash/script nodes all run INSIDE via `docker exec`
   env = the Archon-managed bag + auth only (never the host process.env)
        │
   … approval gate?  →  docker stop (0 RAM while paused)  →  approve/resume → docker start
        │
   nodes done → WRITE-BACK GATE: overlay diff summarized, run pauses
        │
   approve → diff applied to the live root → run completed
   reject  → diff discarded, live root untouched → run completed (noted)
        │
   teardown → container + volume removed
```

The overlay's upper layer **is** the diff by overlayfs construction, so computing what changed is a directory walk, not a tree comparison. Claude nodes run via the SDK's `spawnClaudeCodeProcess` hook into `docker exec`; `bash:`/`script:` nodes exec in the same container rather than silently falling back to host execution.

## Prerequisites

1. **Docker** running on the host (Engine ≥ 20.10 / Docker Desktop).
2. **The runner image**, built from the current in-repo Dockerfile:

   ```bash
   bun run build:runner-image
   ```

   This tags `archon-runner:<version>` and `archon-runner:latest` (the default). It bakes in the Claude native binary, git, bash, bun, uv, and `fuse-overlayfs`.

   Rebuild existing runner images after upgrading Archon, including custom images with their own tags. The current entrypoint reports FUSE mount failure with exit status 78; older entrypoints that return a generic status cannot authorize native fallback.

## Running

```bash
# Register the folder + run in a container in one go
cd /path/to/ops-root
bun run cli workflow run my-workflow --folder --container "reorganize the invoices"
```

You'll see the container come up, nodes execute inside it, and — when the run finishes with changes — a **write-back gate**:

```
Container run finished — review before applying to the live folder.
7 file(s) changed (3 added, 3 modified, 1 deleted):
  + invoices/2026-06/summary.md
  ~ invoices/index.md
  - invoices/stale.tmp
  … and 3 more
Approve to APPLY these changes to the live folder, or reject to discard them.
```

Drive it like any other pause:

```bash
bun run cli workflow approve <run-id>   # apply the diff to the live root, then complete
bun run cli workflow reject  <run-id>   # discard the overlay, live root untouched, complete
```

An **empty diff** skips the gate and completes silently. Set `container.write_back: auto` on a workflow to apply without pausing (logged, for unattended jobs).

## Pause economics

Any pause, including unreadable-source recovery before or inside the DAG, an approval/interactive gate mid-run, or the write-back gate at the end, **`docker stop`s the container**. A multi-day wait costs ~0 CPU/RAM. Approve/reject/resume rediscover the container by its `diy.archon.env-id` label and `docker start` it (or recreate one over the persisted upper volume if the container is gone). If the volume itself is gone — the only place the un-applied work lived — resume **fails loudly** rather than silently restarting from an empty overlay.

Unreadable-source suspension uses a one-second Docker stop grace and a two-second timeout per Docker call (ownership restoration, stop, and failure inspection), keeping Docker work under the file store's ten-second lock wait. Other pauses retain Docker's default stop grace.

Resume acquisition and suspension of an ordinary DAG or write-back pause exclude one another. If resume acquires the run first, old cleanup skips suspension. Otherwise resume cannot acquire the next execution claim until suspension settles. This holds the SQL run lock (SQLite writer reservation) or file-store lock during Docker work. Another file-store process may reach its existing ten-second lock acquisition timeout and must retry; a timeout does not grant ownership.

Stopping is best-effort: a backend failure is logged and reported to the operator, and the run stays paused for retry. No `container_stopped` event is emitted on failure; the container may keep consuming resources until resume or teardown.

Container pauses are only resumable **from the CLI**, where the Docker backend is wired. Approving or rejecting a container run from chat or the Web UI records the decision but cannot continue the container. The run stays paused until you run `archon workflow resume <run-id>` from the CLI in the same project. Do not re-send the decision: the gate is already resolved.

## Selection and configuration

Precedence: `--container` flag > workflow `container.enabled` > config `container.enabled` > off. See [configuration](/reference/configuration/#container-isolation-folder-projects) for the `container:` config block (image, network, memory, pids) and the `container.write_back` workflow policy.

`archon isolation list` shows active container environments (a paused run's container appears here with its age and is **never** auto-pruned); `archon isolation cleanup` reaps the containers + volumes of terminal or orphaned runs older than the threshold.

## Provider support

| Provider | In-container | Notes |
|----------|:---:|-------|
| **Claude** | ✅ | Spawns its CLI via `docker exec`; the binary is baked into the runner image. |
| **Codex** | 🔜 | Needs an in-container spawn of `codex app-server` + the binary in the image; `CODEX_HOME/auth.json` on the upper volume. Fails fast today via the `containerExec` capability. |
| **Pi** | 🔜 | In-process harness; needs a container tool-transport (Flue-style) or an in-image shim. |
| **OpenCode / Copilot / community** | 🔜 | Declare `containerExec: true` and implement their own exec-in-container translation against the `ExecutionContext` contract. |

A non-Claude node in a container run **fails fast before any node executes**, naming the provider and the `containerExec` capability — never a silent host escape.

## Security posture

The container is the isolation boundary: read-only lower bind + overlay upper on a VM-local volume + Archon-managed env only (the host `process.env` never crosses) + approval-gated write-back. The apply is the **one** moment the live root is written.

Overlay mount mode is chosen least-privilege-first: `fuse-overlayfs` (only `--device /dev/fuse`, no `CAP_SYS_ADMIN`) is attempted first and works on rootless / userns-remap daemons. Native fallback requires the runner to report a FUSE mount failure with exit status 78. Docker startup failures, including a missing `/dev/fuse`, readiness timeouts, unconfirmed exit status, and failed log checks stop preparation without fallback. A transient inspection failure can recover: a later inspection confirming exit 78 permits fallback. On a standard rootful daemon, a confirmed FUSE mount failure permits `native` (kernel overlay + `CAP_SYS_ADMIN`), which lets in-container root remount the read-only lower — so `native` is isolation-hardening, **not** a sandbox against a hostile agent. The full threat model, the `native` caveat, and the `docker exec -e` secrets-in-`ps` limitation are documented in `packages/isolation/docker/SECURITY.md` — read it before running untrusted work.

Two Archon-owned host directories are bound into the container at their host paths: the run's frozen workflow source, read-only, and `$ARTIFACTS_DIR`, read-write. The artifacts bind is what lets an in-container node leave screenshots, reports, or the `evidence_policy` marker where the engine and the operator read them. It is the only host directory the container can write; its contents are run output and the host never executes them. Archon's own host writes into it refuse a symlinked parent directory and replace a symlinked file instead of writing through it, so a link planted by a node cannot redirect an engine write elsewhere on the host. On a rootful Linux daemon the container's root user owns what it writes there, so Archon attempts to restore host ownership when the container is suspended or destroyed. This is best-effort: failures are logged as `isolation.container_artifacts_chown_failed` and do not stop suspension or destruction.

Before a named script or other capture-backed read is dispatched, Archon hashes the host capture and compares it with the run's pinned source identity. This refuses a mismatch present at that checkpoint; it does not close the check-to-exec race, contain a same-UID host process, or cancel parallel nodes already running.

## macOS / Linux notes

The overlay upper/work dirs live on a VM-local named volume, never a host bind mount (a host-bind upperdir hits `EACCES` on macOS). The merged overlay is mounted at the **same absolute path** as the host cwd, so `working_path` and every path substitution are unchanged inside the container. On a standard Docker Desktop / rootful Engine daemon, `native` (CAP_SYS_ADMIN) is available only after the runner starts and reports the dedicated FUSE mount failure status; a missing `/dev/fuse` stops the run before that point.
