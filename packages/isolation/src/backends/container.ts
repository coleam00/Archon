/**
 * Container isolation backend for FOLDER-kind projects (Phase B).
 *
 * Runs a folder-project workflow inside a Docker container over a **read-only
 * bind mount of the project root** (`/mnt/lower`) plus a **writable overlayfs
 * upper layer** on a per-run named volume (`/mnt/upper`), merged at the SAME
 * absolute path as the host cwd (so `working_path`, `$ARTIFACTS_DIR`, and every
 * path substitution stay unchanged — no translation layer anywhere).
 *
 * Lifecycle in Phase B: `prepare()` creates the volume + container and returns a
 * `{ kind: 'container', containerId }` execution context; the engine threads
 * that to the Claude provider (spawns its CLI via `docker exec`) and to
 * `bash:`/`script:` nodes (also `docker exec`), so isolation has no host-escape
 * hole. `destroy()` removes the container + volume. The approval-gated
 * write-back of the overlay diff to the live root is Phase C — until then a
 * container run's changes stay in the overlay and are discarded on `destroy()`.
 *
 * Only Claude runs in-container in v1; the engine fails fast pre-dispatch for
 * any node whose provider lacks the `containerExec` capability.
 */

import { randomUUID } from 'crypto';
import type { BranchName } from '@archon/git';
import { createLogger } from '@archon/paths';
import type {
  BackendPrepareRequest,
  ContainerBackendConfig,
  IIsolationBackend,
  PreparedEnv,
} from '../types';
import { CONTAINER_LABELS } from '../types';
import type { IIsolationStore } from '../store';
import {
  dockerCli,
  dockerPreflight,
  extractDockerError,
  type DockerRunner,
} from '../container/docker-exec';

const log = createLogger('isolation.container');

/**
 * `branch_name` is NOT NULL (both dialects) and worktree-only. Container envs
 * have no branch, so we store an empty sentinel rather than migrate the column
 * to nullable (per plan Task 8 — avoid a schema change for a worktree-only field).
 */
const NO_BRANCH_SENTINEL = '' as unknown as BranchName;

/** Overlay-ready sentinel the entrypoint touches once the merged mount is up. */
const READY_SENTINEL = '/mnt/upper/.ready';
/** Max time to wait for the container's overlay mount to come up. */
const READY_TIMEOUT_MS = 20_000;
/** Poll interval while waiting for the ready sentinel. */
const READY_POLL_INTERVAL_MS = 250;

/**
 * Overlay mount modes, in PREFERENCE order (least-privileged first). `fuse` runs
 * with only `--device /dev/fuse` (no CAP_SYS_ADMIN — closes the remount escape,
 * but only mounts on rootless/userns daemons); `native` grants CAP_SYS_ADMIN
 * (works everywhere, grants the escape — see SECURITY.md). The backend tries them
 * in this order and keeps the first that mounts.
 */
const OVERLAY_MODES = ['fuse', 'native'] as const;
type OverlayMode = (typeof OVERLAY_MODES)[number];

export interface ContainerBackendDeps {
  store: IIsolationStore;
  config: ContainerBackendConfig;
  /** Injectable docker runner (real `dockerCli` in prod; a fake in tests). */
  dockerRunner?: DockerRunner;
}

/**
 * Metadata persisted on the `isolation_environments` row for a container env.
 * `resourceId` is the stable handle used for container/volume names + the
 * `env-id` label; `destroy()` reads `containerId`/`volume` back off the row.
 */
interface ContainerEnvMetadata {
  containerId: string;
  containerName: string;
  volume: string;
  image: string;
  resourceId: string;
  workspacePath: string;
  /** Overlay mode that actually mounted (`fuse` = unprivileged; `native` = CAP_SYS_ADMIN). */
  overlayMode: OverlayMode;
  [key: string]: unknown;
}

/**
 * Normalize a persisted `metadata` value into an object. The store returns JSONB
 * as a parsed object on Postgres but a raw JSON STRING on SQLite (the column is
 * TEXT, `JSON.stringify`'d on write) — reading it as an object works on Postgres
 * and silently yields `undefined` fields on SQLite, which would make `destroy()`
 * skip the `docker rm` and leak the container. Parse the string form here so both
 * dialects behave identically. A parse failure returns `{}` (destroy then throws
 * loudly rather than leaking silently).
 */
function readContainerMetadata(metadata: unknown): Partial<ContainerEnvMetadata> {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Partial<ContainerEnvMetadata>;
    } catch {
      return {};
    }
  }
  if (metadata && typeof metadata === 'object') {
    return metadata as Partial<ContainerEnvMetadata>;
  }
  return {};
}

export class ContainerBackend implements IIsolationBackend {
  readonly id = 'container' as const;

  private readonly store: IIsolationStore;
  private readonly config: ContainerBackendConfig;
  private readonly docker: DockerRunner;

  constructor(deps: ContainerBackendDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.docker = deps.dockerRunner ?? dockerCli;
  }

  /**
   * Create the per-run upper volume + container and wait for the overlay mount.
   * Returns the host root as cwd (same-absolute-path invariant) and a container
   * execution context. Inserts a tracking `isolation_environments` row so
   * `destroy()` and (Phase C) resume/cleanup can find the container by label.
   *
   * Fails fast (no half-created state): preflight runs before any resource is
   * created; if the container never signals ready, it is removed before throwing.
   */
  async prepare(req: BackendPrepareRequest): Promise<PreparedEnv> {
    const hostRoot = req.codebase.defaultCwd;
    const { image } = this.config;

    await dockerPreflight(image, this.docker);

    const resourceId = randomUUID();
    const containerName = `archon-${resourceId}`;
    const volume = `archon-${resourceId}-upper`;

    log.info(
      { codebaseId: req.codebase.id, resourceId, image, hostRoot },
      'isolation.container_prepare_started'
    );

    // 1. Per-run upper volume (VM-local — overlay upperdir/workdir must NEVER be
    //    on a host bind mount, orbstack#1376 EACCES on macOS).
    await this.docker(['volume', 'create', volume]);

    // 2. Create + start the container, mounting the overlay with the
    //    least-privileged mode that works (fuse without CAP_SYS_ADMIN first,
    //    native + CAP_SYS_ADMIN fallback). Fails only after both modes fail.
    let containerId: string;
    let overlayMode: OverlayMode;
    try {
      ({ containerId, mode: overlayMode } = await this.startContainerWithOverlay(
        containerName,
        volume,
        hostRoot,
        req.codebase.id
      ));
    } catch (startErr) {
      // The container(s) are already removed inside startContainerWithOverlay;
      // only the volume can leak here — remove it (with a breadcrumb on failure).
      await this.docker(['volume', 'rm', '-f', volume]).catch(rmErr => {
        log.warn(
          { volume, detail: extractDockerError(rmErr) },
          'isolation.container_prepare_volume_cleanup_failed'
        );
      });
      throw startErr;
    }

    // 3. Track the environment. `branch_name` is NOT NULL in both dialects and
    //    is worktree-only — a sentinel '' avoids a schema migration (per plan).
    const metadata: ContainerEnvMetadata = {
      containerId,
      containerName,
      volume,
      image,
      resourceId,
      overlayMode,
      workspacePath: hostRoot,
    };
    let row;
    try {
      row = await this.store.create({
        codebase_id: req.codebase.id,
        workflow_type: 'task',
        workflow_id: resourceId,
        provider: 'container',
        working_path: hostRoot,
        branch_name: NO_BRANCH_SENTINEL,
        metadata,
      });
    } catch (createErr) {
      // The container + volume exist but there's no tracking row → they'd be
      // orphaned. Remove both (best-effort, with breadcrumbs) before rethrowing.
      await this.removeContainerAndVolume(containerName, volume);
      throw createErr;
    }

    log.info({ envId: row.id, containerId, resourceId }, 'isolation.container_prepare_completed');

    return {
      cwd: hostRoot,
      execContext: { kind: 'container', containerId },
      envId: row.id,
    };
  }

  /**
   * Remove the container + upper volume for a prepared environment and mark the
   * tracking row destroyed. A missing container/volume is idempotent-OK (already
   * gone), but a GENUINE docker failure (daemon down, volume in use, permission)
   * does NOT mark the row destroyed and THROWS — so the caller surfaces a loud
   * "clean up manually" message and a later cleanup/resume can retry. A missing
   * DB row is a no-op; unusable metadata throws (would otherwise leak silently).
   */
  async destroy(envId: string): Promise<void> {
    const row = await this.store.getById(envId);
    if (!row) {
      log.warn({ envId }, 'isolation.container_destroy_row_missing');
      return;
    }
    const meta = readContainerMetadata(row.metadata);
    const containerName = meta.containerName ?? meta.containerId;
    const volume = meta.volume;

    if (!containerName && !volume) {
      // Metadata is present-but-unusable (e.g. an old row, or a parse failure).
      // Fail LOUDLY rather than silently "destroy" nothing and leak the container.
      log.error(
        { envId, rawMetadataType: typeof row.metadata },
        'isolation.container_destroy_metadata_unusable'
      );
      throw new Error(
        `Cannot destroy container env '${envId}': its metadata has no containerName/volume. ` +
          'The container/volume may be orphaned — remove it via `docker ps -a ' +
          '--filter label=diy.archon.managed=true` and `docker rm -f`.'
      );
    }

    const failures: string[] = [];
    if (containerName) {
      const err = await this.removeIgnoringNotFound(['rm', '-f', containerName]);
      if (err) failures.push(`container ${containerName}: ${err}`);
    }
    if (volume) {
      const err = await this.removeIgnoringNotFound(['volume', 'rm', '-f', volume]);
      if (err) failures.push(`volume ${volume}: ${err}`);
    }

    if (failures.length > 0) {
      // Real docker failure — the resources may still exist, so leave the row
      // `active` (a cleanup/resume can retry) and throw so the caller is loud.
      log.error({ envId, failures }, 'isolation.container_destroy_failed');
      throw new Error(
        `Failed to remove the isolation container/volume for env '${envId}': ` + failures.join('; ')
      );
    }

    await this.store.updateStatus(envId, 'destroyed').catch(err => {
      log.warn({ envId, err: err as Error }, 'isolation.container_destroy_status_update_failed');
    });

    log.info({ envId, containerName, volume }, 'isolation.container_destroy_completed');
  }

  /**
   * Run a `docker rm`/`volume rm` and swallow ONLY the idempotent not-found case
   * (the resource is already gone). Returns `undefined` on success or not-found,
   * or the error detail string on a genuine failure the caller must surface.
   */
  private async removeIgnoringNotFound(args: string[]): Promise<string | undefined> {
    try {
      await this.docker(args);
      return undefined;
    } catch (err) {
      const detail = extractDockerError(err);
      if (/no such (container|volume)/i.test(detail)) {
        log.debug({ args, detail }, 'isolation.container_destroy_already_gone');
        return undefined;
      }
      return detail;
    }
  }

  /**
   * Start the container with the least-privileged overlay mount that works, and
   * wait for it to become ready. Tries `fuse` FIRST — fuse-overlayfs runs with
   * only `--device /dev/fuse` and NO `CAP_SYS_ADMIN`, closing the
   * `mount -o remount,rw /mnt/lower` escape (see SECURITY.md). That path only
   * succeeds where the daemon grants unprivileged FUSE mounts (rootless /
   * userns-remap); on a standard rootful daemon it fails fast and we fall back to
   * `native` (kernel overlay + `CAP_SYS_ADMIN`), which works everywhere but grants
   * that escape. The failed attempt's container is removed before the next try so
   * the name is free.
   *
   * @returns the ready container id + the mode that succeeded.
   */
  private async startContainerWithOverlay(
    containerName: string,
    volume: string,
    hostRoot: string,
    codebaseId: string
  ): Promise<{ containerId: string; mode: OverlayMode }> {
    const failures: string[] = [];
    for (const mode of OVERLAY_MODES) {
      let containerId: string;
      try {
        containerId = await this.runContainerInMode(
          containerName,
          volume,
          hostRoot,
          codebaseId,
          mode
        );
      } catch (runErr) {
        // `docker run` itself refused (e.g. `--device /dev/fuse` on a host with no
        // fuse device) — record and try the next mode. Nothing to remove.
        failures.push(`${mode}: ${extractDockerError(runErr)}`);
        continue;
      }
      try {
        await this.waitForReady(containerId);
        if (mode !== OVERLAY_MODES[0]) {
          log.warn({ containerName, mode }, 'isolation.container_overlay_fallback');
        }
        return { containerId, mode };
      } catch (readyErr) {
        // Container started but the mount failed (entrypoint exits fast) — remove
        // it so the name is free for the next mode, then continue.
        failures.push(`${mode}: ${(readyErr as Error).message}`);
        await this.docker(['rm', '-f', containerName]).catch(rmErr => {
          log.warn(
            { containerName, mode, detail: extractDockerError(rmErr) },
            'isolation.container_fallback_cleanup_failed'
          );
        });
      }
    }
    throw new Error(
      'Could not mount the overlay in any mode. Native overlay needs CAP_SYS_ADMIN; ' +
        'fuse-overlayfs needs /dev/fuse AND an unprivileged-mount daemon ' +
        `(rootless / userns-remap). Attempts:\n${failures.join('\n')}`
    );
  }

  /**
   * `docker run -d` the runner image in the given overlay mode. `fuse` grants
   * only `--device /dev/fuse` (no CAP_SYS_ADMIN); `native` grants
   * `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` (no device). The
   * entrypoint mounts per `ARCHON_OVERLAY_MODE`.
   *
   * @returns the full container id from `docker run`'s stdout.
   */
  private async runContainerInMode(
    containerName: string,
    volume: string,
    hostRoot: string,
    codebaseId: string,
    mode: OverlayMode
  ): Promise<string> {
    // Least-privilege per mode: fuse gets ONLY the device; native gets the caps.
    const privilegeArgs =
      mode === 'fuse'
        ? ['--device', '/dev/fuse']
        : ['--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined'];

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `${CONTAINER_LABELS.managed}=true`,
      '--label',
      `${CONTAINER_LABELS.codebaseId}=${codebaseId}`,
      '--label',
      `${CONTAINER_LABELS.envId}=${containerName}`,
      // Explicit: an auto-restart would resurrect a deliberately-stopped
      // (paused, Phase C) container and re-run work — never what we want.
      '--restart',
      'no',
      ...privilegeArgs,
      '--memory',
      `${this.config.memoryMb}m`,
      '--pids-limit',
      String(this.config.pidsLimit),
      '--network',
      this.config.network,
      '-v',
      `${hostRoot}:/mnt/lower:ro`,
      '-v',
      `${volume}:/mnt/upper`,
      '-e',
      `ARCHON_WORKSPACE_PATH=${hostRoot}`,
      '-e',
      `ARCHON_OVERLAY_MODE=${mode}`,
      this.config.image,
    ];
    const { stdout } = await this.docker(args);
    return stdout.trim();
  }

  /**
   * Poll for the entrypoint's ready sentinel. Fails FAST if the container has
   * exited (the entrypoint exits 1 on a mount failure) rather than waiting out the
   * full timeout, so the mode fallback is quick. Throws with the container's tail
   * logs so a mount failure surfaces the entrypoint's own error.
   */
  private async waitForReady(containerId: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.docker(['exec', containerId, 'test', '-f', READY_SENTINEL], { timeout: 5_000 });
        return;
      } catch {
        // Not ready yet. ONLY fast-fail when the container has DEFINITELY exited
        // (`Running=false`) — a transient inspect error/timeout must NOT be read
        // as "stopped", or an infra blip would silently trigger the native +
        // CAP_SYS_ADMIN fallback (privilege broadening). On 'unknown' keep polling
        // until the deadline (a real exit still surfaces via the timeout).
        if ((await this.containerState(containerId)) === 'stopped') break;
        await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
      }
    }
    let logs = '';
    try {
      const { stdout, stderr } = await this.docker(['logs', '--tail', '20', containerId]);
      logs = `${stdout}\n${stderr}`.trim();
    } catch {
      // Best-effort — the timeout / exit is the real error.
    }
    throw new Error(
      `Container overlay did not become ready.${logs ? ` Container logs:\n${logs}` : ''}`
    );
  }

  /**
   * Container running state as three distinct outcomes. Crucially, an inspect
   * ERROR (daemon timeout, transient failure) is `unknown`, NOT `stopped` — the
   * caller must not treat "couldn't tell" as "exited" (see waitForReady: only an
   * explicit `stopped` may fast-fail into the privileged native fallback).
   */
  private async containerState(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const { stdout } = await this.docker(['inspect', '-f', '{{.State.Running}}', containerId], {
        timeout: 5_000,
      });
      const value = stdout.trim();
      if (value === 'true') return 'running';
      if (value === 'false') return 'stopped';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Best-effort removal of a container + its upper volume, used to unwind a
   * partially-prepared environment (e.g. after `store.create()` rejects) before
   * a tracking row exists. Failures are logged (breadcrumbs) but never thrown —
   * the caller is already rethrowing the original error.
   */
  private async removeContainerAndVolume(containerName: string, volume: string): Promise<void> {
    await this.docker(['rm', '-f', containerName]).catch(err => {
      log.warn(
        { containerName, detail: extractDockerError(err) },
        'isolation.container_unwind_rm_failed'
      );
    });
    await this.docker(['volume', 'rm', '-f', volume]).catch(err => {
      log.warn(
        { volume, detail: extractDockerError(err) },
        'isolation.container_unwind_volume_failed'
      );
    });
  }
}
