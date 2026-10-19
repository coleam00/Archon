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
  mid-run. The approval-gated **write-back** (Phase C) lets changes land on the
  live root only after review — and the apply is hardened against an adversarial
  overlay even though the review itself assumes a cooperative agent (see
  **Write-back apply hardening** below).
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

- **New environments separate artifact storage.** The main container has a private
  writable output volume at the logical `$ARTIFACTS_DIR`; it has no canonical
  artifacts bind, even read-only, in either overlay mode. Canonical storage must
  not overlap another project/source bind. Trusted helpers publish engine-owned
  `nodes/`, `.archon/` inputs and managed credential leaves as byte copies, then
  collect container-authored output after every invocation, including errors and
  cancellation. Host creation/update/deletion visibility is delayed until collection.
  Engine namespaces stay host-authoritative; container copies never write back.

  Transfers freeze the producer and serialize against suspension/destruction.
  Helpers have no network, workspace/source mounts, SYS_ADMIN or privilege escalation.
  Publish mounts canonical storage read-only; collect mounts output read-only.
  Collection produces real directories and independent regular bytes with ordinary
  modes and canonical-root ownership, dropping source modes, hardlinks, xattrs and
  ownership. Contained regular-file leaf links are materialized; linked directory
  components, escaping/dangling/cyclic links and special files fail visibly. Engine
  leaf links are replaced by temporary-file rename, never written through.

  The output volume and version 1 exchange metadata survive pause/recreation.
  Missing storage refuses resume. Destruction removes the producer, collects, then
  checkpoints final collection before deleting volumes. Collection failure preserves
  volumes and the environment record; teardown retries after the checkpoint do not
  require deleted output storage, and resume is refused.
  An interrupted helper or unexplained paused producer requires explicit ownership
  inspection using the identifiers in the error, before removing the helper or
  unpausing. Ambiguous helper completion never authorizes unfreezing the producer.

  **Legacy environments without `artifactExchange` metadata retain the writable
  canonical bind and its symlink-write exposure until they end.** Resume does not
  migrate them. Legacy rootful ownership hand-back remains best-effort and logged
  (`isolation.container_artifacts_chown_failed`). Continue new environments using
  a binary that understands version 1; downgrade continuation is not promised.
  This artifact boundary does not fix native mode's project-root remount escape.

- **Captured-source integrity is checkpoint detection, not containment.** Archon
  hashes the host capture against the run's pinned identity before dispatching each
  capture-backed read. It refuses a mismatch present then, but a same-UID host process
  can still change files after the check. The check does not cancel parallel nodes,
  close a check-to-exec race, or make native mode safe against a hostile agent.

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

The backend starts with `fuse` and permits native fallback only after the runner
reports a failed FUSE mount through its dedicated exit status (78):

| Mode                | Flags                                                    | Remount escape?                                          | Where it mounts                                                                                         |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fuse` (preferred)  | `--device /dev/fuse`, **no** CAP_SYS_ADMIN               | **Closed** — no CAP_SYS_ADMIN, so `remount,rw` is denied | Only where the daemon grants unprivileged FUSE mounts: **rootless Docker** or a **userns-remap** daemon |
| `native` (fallback) | `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` | **Open** — see above                                     | Everywhere (standard rootful daemon)                                                                    |

On a **standard rootful daemon** (e.g. default Docker Desktop, default Docker
Engine), unprivileged FUSE mounts are denied. If the runner starts and reports
that mount failure with exit status 78, the backend falls back to `native` —
meaning the remount escape is present. Startup failures such as a missing
`/dev/fuse` stop preparation instead. To get
the hardened boundary (no CAP_SYS_ADMIN), run the daemon **rootless** or with
**userns-remap**, where the `fuse` mode succeeds and the container never holds
CAP_SYS_ADMIN.

The mode that actually mounted is recorded on the `isolation_environments` row
(`metadata.overlayMode`) and logged (`isolation.container_overlay_fallback` warns
when native is attempted, including the original FUSE failure).

Docker startup failures (including a missing `/dev/fuse`) and readiness timeouts
reject preparation without trying native. Failed Docker inspect or log checks
never authorize native fallback.
Older runner images that report a generic exit status also fail without fallback;
rebuild existing and custom runner images after upgrading Archon to use the
current entrypoint and its dedicated FUSE mount status.

## Write-back apply hardening

The overlay's upper layer is **attacker-controlled** (a compromised in-container
agent chooses the filenames, whiteouts, symlink targets, and modes). The diff/apply
scripts (`container/overlay.ts`) therefore treat it as hostile input even though the
_approval_ step assumes a cooperative run. Both the summary and apply helpers run in
throwaway containers with `--cap-drop ALL --network none --security-opt
no-new-privileges` (defense-in-depth around the script logic), and the apply:

- decodes whiteout names and **rejects** empty / `.` / `..` / slash-containing names
  (a `.wh.` marker whose decoded name is empty would otherwise `rm -rf` the parent);
- **confines** every write/delete under the destination with a parent-directory
  symlink guard (blocks traversal through a pre-existing dest symlink), and runs
  with `set -f` (noglob) so malicious filenames can't glob-expand;
- reproduces **only** regular files, real directories, and **in-project** symlinks —
  block/char/fifo/socket **special files** are skipped entirely (a planted device
  never lands on the host), and a `(0,0)` overlay-whiteout char device is
  distinguished from a planted real device by its major/minor;
- a regular **setuid/setgid binary DOES land** as a normal file, but its
  setuid/setgid/sticky bits are **stripped** (`chmod u-s,g-s,o-t`) and it is copied by
  **contents only** (no `cp -a`), dropping ownership and xattrs (incl. `security.*`
  capability xattrs) — so the file arrives inert, not privilege-escalating;
- **refuses** symlinks whose target escapes the project root (absolute-outside-root
  or a `..`-escaping relative target) — a secret-exfiltration / foothold vector —
  and flags them in the change summary so the approver sees the refusal.

The change summary is derived from the same classification so it faithfully
predicts what apply will do (escaping symlinks and skipped specials are shown).

> **Note on native mode:** these guards protect the **write-back apply path**. They
> do **not** re-close the `native`-mode remount escape — an agent with CAP_SYS_ADMIN
> can still write the live root directly during the run, before write-back. The
> engine emits a loud run-start warning when a run lands in native mode.

## Known limitations (not silently wrong)

- **Opaque directory markers** on native overlay use a `trusted.overlay.opaque`
  xattr with no on-disk marker file, so a "replace an entire directory" operation
  may not fully apply in native mode (the walk can't see the xattr). Rare for
  folder-ops file add/modify/delete changes.
- **Hardlinks** in the upper layer are copied as independent files (content
  amplification), not re-linked — a correctness-preserving divergence, not a bug.
- The **SIGKILL grace** on `docker stop` (suspend) means a container killed at the
  grace deadline can under-report; the volume (the overlay) is unaffected.
- **Applied file ownership.** The write-back apply runs as root in the helper
  container, so, on a Linux rootful daemon, files it writes to the live root land
  root-owned (usability caveat — the operator may need to `chown` them back). On
  Docker Desktop (macOS/Windows) the VM maps writes to the host user, so this does
  not arise there.

## Concurrency caveat

Multiple Claude nodes in the same DAG layer share one run container. The
in-container kill targets a per-invocation PID file (not a broad `pkill`), so an
abort of one node does not kill its siblings — but any hostile-agent caveat above
applies per node.

## Review gate

Because native mode is an opt-in feature whose isolation depends on the daemon's
configuration, **any change to the mount strategy, the granted capabilities, the
env-delivery mechanism, the bind topology, or the write-back diff/apply scripts must
be re-reviewed against this document.** Do not widen capabilities, forward host env,
or relax the apply guards (whiteout-name rejection, dest confinement, special-file
skip, setuid/xattr stripping, symlink-escape refusal) without updating this file and
the threat model above.
