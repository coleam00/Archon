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

    // 2. Create + start the container. Native overlay needs CAP_SYS_ADMIN +
    //    apparmor=unconfined; the fuse-overlayfs fallback needs /dev/fuse, which
    //    we attach best-effort (retried without it when the host has no fuse).
    let containerId: string;
    try {
      containerId = await this.runContainer(containerName, volume, hostRoot, req.codebase.id);
    } catch (runErr) {
      // Volume would leak if the container never started — best-effort remove.
      await this.docker(['volume', 'rm', '-f', volume]).catch(() => undefined);
      throw runErr;
    }

    // 3. Wait for the entrypoint to signal the overlay is mounted.
    try {
      await this.waitForReady(containerId);
    } catch (readyErr) {
      await this.forceRemove(containerName, volume);
      throw readyErr;
    }

    // 4. Track the environment. `branch_name` is NOT NULL in both dialects and
    //    is worktree-only — a sentinel '' avoids a schema migration (per plan).
    const metadata: ContainerEnvMetadata = {
      containerId,
      containerName,
      volume,
      image,
      resourceId,
      workspacePath: hostRoot,
    };
    const row = await this.store.create({
      codebase_id: req.codebase.id,
      workflow_type: 'task',
      workflow_id: resourceId,
      provider: 'container',
      working_path: hostRoot,
      branch_name: NO_BRANCH_SENTINEL,
      metadata,
    });

    log.info({ envId: row.id, containerId, resourceId }, 'isolation.container_prepare_completed');

    return {
      cwd: hostRoot,
      execContext: { kind: 'container', containerId },
      envId: row.id,
    };
  }

  /**
   * Remove the container + upper volume for a prepared environment and mark the
   * tracking row destroyed. Best-effort per resource — a missing container or
   * volume is not an error (idempotent teardown), but genuine docker failures
   * are logged. Never throws for the not-found case.
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

    if (containerName) {
      await this.docker(['rm', '-f', containerName]).catch(err => {
        log.warn(
          { envId, containerName, detail: extractDockerError(err) },
          'isolation.container_destroy_rm_failed'
        );
      });
    }
    if (volume) {
      await this.docker(['volume', 'rm', '-f', volume]).catch(err => {
        log.warn(
          { envId, volume, detail: extractDockerError(err) },
          'isolation.container_destroy_volume_failed'
        );
      });
    }

    await this.store.updateStatus(envId, 'destroyed').catch(err => {
      log.warn({ envId, err: err as Error }, 'isolation.container_destroy_status_update_failed');
    });

    log.info({ envId, containerName, volume }, 'isolation.container_destroy_completed');
  }

  /**
   * `docker run -d` the runner image with the overlay mounts, resource caps, and
   * Archon labels. Attempts to attach `/dev/fuse` for the fuse-overlayfs
   * fallback; on hosts without fuse the device attach fails, so we retry once
   * without it (native overlay via CAP_SYS_ADMIN is the primary path anyway).
   *
   * @returns the full container id from `docker run`'s stdout.
   */
  private async runContainer(
    containerName: string,
    volume: string,
    hostRoot: string,
    codebaseId: string
  ): Promise<string> {
    const buildArgs = (withFuse: boolean): string[] => [
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
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'apparmor=unconfined',
      ...(withFuse ? ['--device', '/dev/fuse'] : []),
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
      this.config.image,
    ];

    try {
      const { stdout } = await this.docker(buildArgs(true));
      return stdout.trim();
    } catch (err) {
      const detail = extractDockerError(err).toLowerCase();
      const isFuseDeviceMiss =
        detail.includes('/dev/fuse') ||
        detail.includes('error gathering device information') ||
        detail.includes('no such file or directory');
      if (!isFuseDeviceMiss) throw err;
      // Retry without the fuse device — the host has no /dev/fuse, so the
      // container relies solely on native overlay (CAP_SYS_ADMIN). If native
      // also fails, the entrypoint reports it and the ready-poll times out.
      log.warn({ containerName }, 'isolation.container_fuse_device_unavailable');
      const { stdout } = await this.docker(buildArgs(false));
      return stdout.trim();
    }
  }

  /**
   * Poll for the entrypoint's ready sentinel. Throws with the container's tail
   * logs if the overlay never mounts within the timeout, so a mount failure
   * surfaces the entrypoint's own error rather than an opaque timeout.
   */
  private async waitForReady(containerId: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await this.docker(['exec', containerId, 'test', '-f', READY_SENTINEL], { timeout: 5_000 });
        return;
      } catch {
        // Sentinel not present yet (or exec transiently failed) — back off.
        await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
      }
    }
    let logs = '';
    try {
      const { stdout, stderr } = await this.docker(['logs', '--tail', '20', containerId]);
      logs = `${stdout}\n${stderr}`.trim();
    } catch {
      // Best-effort — the timeout is the real error.
    }
    throw new Error(
      `Container overlay did not become ready within ${READY_TIMEOUT_MS}ms. ` +
        'The overlay mount likely failed (native overlay needs CAP_SYS_ADMIN; ' +
        `fuse-overlayfs needs /dev/fuse).${logs ? ` Container logs:\n${logs}` : ''}`
    );
  }

  /** Best-effort teardown used on prepare failure (before a row exists). */
  private async forceRemove(containerName: string, volume: string): Promise<void> {
    await this.docker(['rm', '-f', containerName]).catch(() => undefined);
    await this.docker(['volume', 'rm', '-f', volume]).catch(() => undefined);
  }
}
