# Container isolation — security posture

The folder-project **container backend** (`--container`) runs a workflow inside a
Docker container over a read-only bind of the project root plus a writable
overlayfs upper layer. This document states, honestly, what that boundary does and
does **not** protect against, so operators can decide when it is appropriate.

> **One-line summary:** the container backend is an **isolation-hardening** feature
> for a **single-tenant, operator-trusted** deployment — it keeps a _well-behaved_
> agent's writes off the live root until an (approval-gated, Phase C) write-back.
> When it runs in the `native` overlay mode — the **fallback** used on a standard
> rootful daemon (the `fuse` mode is attempted first and is what runs on
> rootless/userns daemons) — it is **NOT** a sandbox against a **malicious or
> prompt-injected** agent.

## Threat model

**In scope (what it does buy you):**

- A well-behaved agent's file writes land in the overlay upper layer, not the live
  project root — so a buggy or mistaken run can't corrupt live business data
  mid-run (Phase C adds the approval-gated write-back that lets changes land only
  after review).
- Host `process.env` never crosses into the container — the container receives
  only the Archon-managed env bag (codebase env + per-user AI creds + GitHub
  token) plus a minimal base. See the env-isolation invariant.
- Resource caps: `--memory`, `--pids-limit`, and `--network bridge|none`.

**Out of scope (what it does NOT buy you):**

- **`native` overlay mode grants CAP_SYS_ADMIN, which is an isolation escape.**
  Native mode runs the container with `--cap-add SYS_ADMIN --security-opt
apparmor=unconfined` because the kernel `mount -t overlay` needs it. With
  CAP_SYS_ADMIN, in-container **root can remount the read-only bind read-write**:

  ```sh
  mount -o remount,rw /mnt/lower   # succeeds under native mode → writes hit the LIVE host root
  ```

  A hostile or prompt-injected agent that reaches a shell (bash/script node, or a
  tool call) can do this and write straight through to the live project root,
  bypassing the overlay entirely. Treat native mode as _isolation for cooperative
  runs_, not containment of an adversary.

- **`docker exec -e` puts secrets in the host process table.** Per-user API
  keys / tokens are delivered to in-container processes as `-e KEY=VALUE` flags on
  the `docker exec` argv, so they are briefly visible to anything that can read the
  **host** process list (`ps auxe`, `/proc/<pid>/cmdline`) during a node's
  execution. This is acceptable only on a single-tenant host the operator controls.
  A transient in-container env file is a tracked follow-up.

- **`$ARTIFACTS_DIR` is not mounted into the container.** The run's artifacts dir
  is created after the container is prepared, so it isn't bind-mounted. Engine-side
  typed-output sidecars still work (written on the host from captured stdout), but
  a container node that writes **directly** to `$ARTIFACTS_DIR` will fail (the path
  is absent inside the container). Workflows should write to the workspace (the
  overlay), not `$ARTIFACTS_DIR`.

- **Running as root.** In-container work runs as root under `IS_SANDBOX=1`.
  Combined with the CAP_SYS_ADMIN of native mode, the in-container root is
  powerful; the boundary is the container + the daemon's own confinement, not the
  in-container uid.

- **Build-time installers are version-pinned but not checksum-verified.** The
  runner image pins the base image by digest and pins the Claude/bun/uv **tool
  versions** (`runner.Dockerfile` build args), so a build won't silently pull a
  newer binary. But the vendor installer **scripts** (`claude.ai/install.sh`,
  `bun.sh/install`, `astral.sh/uv/<v>/install.sh`) are fetched over TLS and run as
  root at build time without an independent checksum/signature (they aren't
  published with stable checksums). A compromised installer endpoint could still
  tamper with the built image. Accepted residual for v1; re-evaluate if a
  published-checksum path becomes available.

## Overlay modes and how to get the stronger boundary

The backend picks the **least-privileged mode that mounts**, preferring `fuse`:

| Mode                | Flags                                                    | Remount escape?                                          | Where it mounts                                                                                         |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fuse` (preferred)  | `--device /dev/fuse`, **no** CAP_SYS_ADMIN               | **Closed** — no CAP_SYS_ADMIN, so `remount,rw` is denied | Only where the daemon grants unprivileged FUSE mounts: **rootless Docker** or a **userns-remap** daemon |
| `native` (fallback) | `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` | **Open** — see above                                     | Everywhere (standard rootful daemon)                                                                    |

On a **standard rootful daemon** (e.g. default Docker Desktop, default Docker
Engine), unprivileged FUSE mounts are denied, so the `fuse` attempt fails fast and
the backend falls back to `native` — meaning the remount escape is present. To get
the hardened boundary (no CAP_SYS_ADMIN), run the daemon **rootless** or with
**userns-remap**, where the `fuse` mode succeeds and the container never holds
CAP_SYS_ADMIN.

The mode that actually mounted is recorded on the `isolation_environments` row
(`metadata.overlayMode`) and logged (`isolation.container_overlay_fallback` warns
when native was used).

## Concurrency caveat

Multiple Claude nodes in the same DAG layer share one run container. The
in-container kill targets a per-invocation PID file (not a broad `pkill`), so an
abort of one node does not kill its siblings — but any hostile-agent caveat above
applies per node.

## Review gate

Because native mode is an opt-in feature whose isolation depends on the daemon's
configuration, **any change to the mount strategy, the granted capabilities, the
env-delivery mechanism, or the bind topology must be re-reviewed against this
document.** Do not widen capabilities or forward host env without updating this
file and the threat model above.
