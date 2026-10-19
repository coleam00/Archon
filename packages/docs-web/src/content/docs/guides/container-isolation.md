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
   teardown → container removed → output collected → volumes removed
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

Any pause — an approval/interactive gate mid-run, or the write-back gate at the end — **`docker stop`s the container**. A multi-day wait costs ~0 CPU/RAM. Approve/reject/resume rediscover the container by its `diy.archon.env-id` label and `docker start` it (or recreate one over the persisted upper volume if the container is gone). New environments also keep a separate durable artifacts volume. Suspension stops the producer, then collects its output. Resume and recreation reuse both recorded volumes and the recorded artifacts path; missing storage **fails loudly**, rather than silently starting with empty output.

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

New environments mount the frozen workflow source read-only, but never mount the canonical host artifacts directory into the main container, in either overlay mode. `$ARTIFACTS_DIR` keeps the same absolute path inside the container and on the host, with separate physical storage: a writable output volume inside, engine-owned storage outside. Canonical storage must not overlap the project or source mounts.

Before each agent pass or deterministic invocation, Archon publishes byte copies of engine-owned `nodes/`, `.archon/` listings and spills, and managed credential files into the output volume. These copies are inputs; modifying them cannot change authoritative host metadata. After each invocation, including errors and cancellation, Archon collects container-authored output before validating pointers, retrying, evaluating completion conditions, or recording completion. Reports, screenshots and evidence markers therefore appear, update and disappear on the host **at collection, not live**. Host-only runs retain their current behavior.

Trusted, network-disabled helpers perform the transfers while the producer is frozen. Transfers, Docker exec admission, in-container cancellation signals, and lifecycle operations share one runtime queue. Admission holds the queue until the command acknowledges from inside the producer; command bodies can then run concurrently and are briefly frozen during transfers. Commands and cancellation signals queued during a transfer wait until it finishes. If an exec loses its admission acknowledgement or a provider disconnects with an unfinished admission/control operation, Archon refuses further transfers and commands in that owner process and requires explicit inspection and recovery. It does not infer that the container has stopped. Collection copies regular bytes with ordinary modes and canonical-root ownership, without container-supplied ownership, executable bits, xattrs or hardlinks. Contained links to regular files become independent byte copies. Linked directories, escaping/dangling/cyclic links and special files are refused and fail the node/run visibly. Known engine-input leaf links are replaced without writing through to their targets. Container copies of engine-owned namespaces are never imported back.

Terminal cleanup removes the producer, collects once more, checkpoints final collection in the existing exchange metadata, then removes the volumes. Failed volume removal or status updates can retry teardown without requiring the deleted output volume; a checkpointed environment can only finish destruction. If collection fails, Archon preserves the volumes and environment record for recovery. An interrupted helper or an unexplained paused producer requires explicit operator inspection of the environment/helper identifiers reported in the error. Confirm ownership and preserve output before removing a helper or unpausing a producer; Archon does not guess that the previous owner is dead.

**Legacy exception:** an environment whose metadata lacks `artifactExchange` keeps its original writable host artifacts bind until it ends, including resume and recreation. There is no live migration; these environments retain the earlier symlink-write exposure and best-effort ownership hand-back. New environments record version 1 exchange metadata in the existing JSON, without schema changes. Continue them with a binary that understands that version; downgrade continuation is not supported.

Before a named script or other capture-backed read is dispatched, Archon hashes the host capture and compares it with the run's pinned source identity. This refuses a mismatch present at that checkpoint; it does not close the check-to-exec race, contain a same-UID host process, or cancel parallel nodes already running.

## macOS / Linux notes

The overlay upper/work dirs live on a VM-local named volume, never a host bind mount (a host-bind upperdir hits `EACCES` on macOS). The merged overlay is mounted at the **same absolute path** as the host cwd, so `working_path` and every path substitution are unchanged inside the container. On a standard Docker Desktop / rootful Engine daemon, `native` (CAP_SYS_ADMIN) is available only after the runner starts and reports the dedicated FUSE mount failure status; a missing `/dev/fuse` stops the run before that point.
