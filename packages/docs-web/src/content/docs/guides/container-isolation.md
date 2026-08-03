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

[Folder projects](/getting-started/concepts/#folder-projects-non-git-workspaces) — a multi-repo root or a plain business-ops directory — run **in place** at the live root by default: every write lands immediately. That is honest but ungoverned, and unsafe for unattended automation against real client data. **Container isolation** runs the whole workflow inside a Docker container over a **read-only mount of the project root plus a writable overlay upper layer**, so nothing touches the live folder until you approve it.

This is folder-project-only. Repo projects use [git worktrees](/reference/architecture/) and are unaffected.

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

The overlay's upper layer **is** the diff by overlayfs construction, so computing what changed is a directory walk, not a tree comparison. Claude nodes run via the SDK's `spawnClaudeCodeProcess` hook into `docker exec`; `bash:`/`script:` nodes exec in the same container — there is no host-escape path.

## Prerequisites

1. **Docker** running on the host (Engine ≥ 20.10 / Docker Desktop).
2. **The runner image**, built once from the in-repo Dockerfile:

   ```bash
   bun run build:runner-image
   ```

   This tags `archon-runner:<version>` and `archon-runner:latest` (the default). It bakes in the Claude native binary, git, bash, bun, uv, and `fuse-overlayfs`.

## Running

```bash
# Register the folder + run in a container in one go
cd /path/to/ops-root
bun run cli workflow run assist --folder --container "reorganize the invoices"
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

Any pause — an approval/interactive gate mid-run, or the write-back gate at the end — **`docker stop`s the container**. A multi-day wait costs ~0 CPU/RAM. Approve/reject/resume rediscover the container by its `diy.archon.env-id` label and `docker start` it (or recreate one over the persisted upper volume if the container is gone). If the volume itself is gone — the only place the un-applied work lived — resume **fails loudly** rather than silently restarting from an empty overlay.

Container pauses are only resumable **from the CLI**, where the Docker backend is wired. Approving a container run from chat/web fails with a pointer to the CLI (the run stays resumable).

## Selection and configuration

Precedence: `--container` flag > workflow `container.enabled` > config `container.enabled` > off. See [configuration](/reference/configuration/#container-isolation-folder-projects) for the `container:` config block (image, network, memory, pids) and the `container.write_back` workflow policy.

`archon isolation list` shows active container environments (a paused run's container appears here with its age and is **never** auto-pruned); `archon isolation cleanup` reaps the containers + volumes of terminal or orphaned runs older than the threshold.

## Provider support

| Provider | In-container | Notes |
|----------|:---:|-------|
| **Claude** | ✅ | Spawns its CLI via `docker exec`; the binary is baked into the runner image. |
| **Codex** | 🔜 | Needs the Codex SDK's spawn/transport override + the binary in the image; `CODEX_HOME/auth.json` on the upper volume. Fails fast today via the `containerExec` capability. |
| **Pi** | 🔜 | In-process harness; needs a container tool-transport (Flue-style) or an in-image shim. |
| **OpenCode / Copilot / community** | 🔜 | Declare `containerExec: true` and implement their own exec-in-container translation against the `ExecutionContext` contract. |

A non-Claude node in a container run **fails fast before any node executes**, naming the provider and the `containerExec` capability — never a silent host escape.

## Security posture

The container is the isolation boundary: read-only lower bind + overlay upper on a VM-local volume + Archon-managed env only (the host `process.env` never crosses) + approval-gated write-back. The apply is the **one** moment the live root is written.

Overlay mount mode is chosen least-privilege-first: `fuse-overlayfs` (only `--device /dev/fuse`, no `CAP_SYS_ADMIN`) is attempted first and works on rootless / userns-remap daemons; a standard rootful daemon falls back to `native` (kernel overlay + `CAP_SYS_ADMIN`), which lets in-container root remount the read-only lower — so `native` is isolation-hardening, **not** a sandbox against a hostile agent. The full threat model, the `native` caveat, and the `docker exec -e` secrets-in-`ps` limitation are documented in `packages/isolation/docker/SECURITY.md` — read it before running untrusted work.

## macOS / Linux notes

The overlay upper/work dirs live on a VM-local named volume, never a host bind mount (a host-bind upperdir hits `EACCES` on macOS). The merged overlay is mounted at the **same absolute path** as the host cwd, so `working_path` and every path substitution are unchanged inside the container. On a standard Docker Desktop / rootful Engine daemon, expect the `native` (CAP_SYS_ADMIN) overlay mode.
