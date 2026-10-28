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
 * hole. `destroy()` removes the container + volume, then the run's scratch. The
 * approval-gated write-back of the overlay diff to the live root is Phase C — until then
 * a container run's changes stay in the overlay and are discarded on `destroy()`.
 *
 * Only Claude runs in-container in v1; the engine fails fast pre-dispatch for
 * any node whose provider lacks the `containerExec` capability.
 */

import { IsolationFailure } from '../errors';
import { randomUUID } from 'crypto';
import type { BranchName } from '@archon/git';
import { createLogger } from '@archon/paths';
import {
  OVERLAY_MODES,
  type OverlayMode,
  type WriteBackFinalizeResult,
  type WriteBackApplySummary,
} from '@archon/workflows/container-context';
import { removeRunScratch } from '@archon/workflows/run-scratch';
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
  type DockerExecOptions,
} from '../container/docker-exec';
import { summarizeOverlayChanges, applyOverlayChanges } from '../container/overlay';
import {
  assertMountableHostMounts,
  startContainerWithOverlay,
  waitForReady,
  type HostMounts,
} from '../container/start';

const log = createLogger('isolation.container');

/**
 * `branch_name` is NOT NULL (both dialects) and worktree-only. Container envs
 * have no branch, so we store an empty sentinel rather than migrate the column
 * to nullable (per plan Task 8 — avoid a schema change for a worktree-only field).
 */
const NO_BRANCH_SENTINEL = '' as unknown as BranchName;

export interface ContainerBackendDeps {
  store: IIsolationStore;
  config: ContainerBackendConfig;
  /** Injectable docker runner (real `dockerCli` in prod; a fake in tests). */
  dockerRunner?: DockerRunner;
}

/** A host uid/gid pair, or `undefined` where the platform has none (Windows). */
export interface HostIdentity {
  readonly uid: number;
  readonly gid: number;
}

/**
 * The host user that must end up owning files the container writes into host binds.
 * Exported so tests can pin it with `spyOn` instead of depending on the runner's uid.
 */
export function currentHostIdentity(): HostIdentity | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return undefined;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * Metadata persisted on the `isolation_environments` row for a container env.
 * `resourceId` is the stable handle used for container/volume names + the
 * `env-id` label; `destroy()` reads `containerId`/`volume` back off the row.
 */
type ContainerEnvMetadata = {
  containerId: string;
  containerName: string;
  volume: string;
  image: string;
  resourceId: string;
  workspacePath: string;
  /** Overlay mode that actually mounted (`fuse` = unprivileged; `native` = CAP_SYS_ADMIN). */
  overlayMode: OverlayMode;
  /**
   * Host path of the run's frozen workflow source, bind-mounted read-only at the SAME
   * absolute path inside the container.
   *
   * Persisted because `resumeEnv` may have to recreate a container over the surviving
   * volume, and a recreated container without this mount would resolve nothing: every
   * named script would be missing at a path the run's own metadata says is fine.
   */
  sourceMount?: string;
  /**
   * Host path of the run's artifacts directory, bind-mounted read-write at the SAME
   * absolute path. Persisted for the same reason as `sourceMount`, and so the ownership
   * hand-back on suspend and destroy knows which host tree the container wrote into, and
   * destroy which run's scratch to remove.
   */
  artifactsMount?: string;
};

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
    const mounts: HostMounts = { source: req.sourceMount, artifacts: req.artifactsMount };
    // Before any docker work: a rejected mount must not leave a volume or container.
    assertMountableHostMounts(mounts, hostRoot);

    await dockerPreflight(image, this.docker);

    const resourceId = randomUUID();
    const containerName = `archon-${resourceId}`;
    const volume = `archon-${resourceId}-upper`;

    log.info(
      { codebaseId: req.codebase.id, resourceId, image, hostRoot },
      'isolation.container_prepare_started'
    );

    // 1. Per-run upper volume (VM-local — overlay upperdir/workdir must NEVER be
    //    on a host bind mount, orbstack#1376 EACCES on macOS). Stamped with the same
    //    labels as the container so leak-detection + cleanup can discover BOTH
    //    resource types by `diy.archon.managed` label, not just the `archon-` name
    //    prefix (volumes from older builds carry no label — match the prefix there).
    await this.docker([
      'volume',
      'create',
      '--label',
      `${CONTAINER_LABELS.managed}=true`,
      '--label',
      `${CONTAINER_LABELS.codebaseId}=${req.codebase.id}`,
      '--label',
      `${CONTAINER_LABELS.envId}=${containerName}`,
      volume,
    ]);

    // Native grants CAP_SYS_ADMIN; only a confirmed runner FUSE mount failure
    // authorizes that fallback.
    let containerId: string;
    let overlayMode: OverlayMode;
    try {
      ({ containerId, mode: overlayMode } = await startContainerWithOverlay(
        this.docker,
        this.config,
        { containerName, volume, hostRoot, codebaseId: req.codebase.id, mounts }
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
      ...(mounts.source !== undefined ? { sourceMount: mounts.source } : {}),
      ...(mounts.artifacts !== undefined ? { artifactsMount: mounts.artifacts } : {}),
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
      overlayMode,
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
    const meta = row.metadata as Partial<ContainerEnvMetadata>;
    const containerName = meta.containerName ?? meta.containerId;
    const volume = meta.volume;

    if (!containerName && !volume) {
      // Metadata is present-but-unusable (e.g. an old row, or a metadata that
      // failed to parse at the store boundary and was normalized to `{}`).
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

    // Attempted unconditionally, as in `suspend`: the helper reports a stopped or gone
    // container itself, and a pre-check that could not tell would otherwise skip the
    // hand-back silently.
    if (containerName && meta.artifactsMount !== undefined) {
      await this.restoreHostOwnership(envId, containerName, meta.artifactsMount);
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

    // The run's scratch waits for this point: until the container is gone, code in it can
    // still write into, or plant links in, the artifacts directory it mounts.
    if (meta.artifactsMount !== undefined) {
      await removeRunScratch(meta.artifactsMount, { envId });
    }

    await this.store.updateStatus(envId, 'destroyed');

    log.info({ envId, containerName, volume }, 'isolation.container_destroy_completed');
  }

  /**
   * Suspend a running container on pause (`docker stop`, default grace). The upper
   * volume + container survive so `resumeEnv` can restart it; only the RAM/CPU are
   * released. Idempotent: a container that is already stopped or gone is a no-op
   * (the caller has nothing to reclaim). A GENUINE docker failure throws — a
   * container we couldn't stop is still consuming resources and the caller must know.
   */
  async suspend(envId: string): Promise<void> {
    const suspend = await this.prepareSuspend(envId);
    await suspend();
  }

  /** Resolve store metadata before entering a workflow store transition. */
  async prepareSuspend(
    envId: string,
    expectedContainerId?: string,
    dockerTimeoutMs?: number
  ): Promise<() => Promise<void>> {
    const meta = await this.loadMetadata(envId);
    if (expectedContainerId !== undefined && meta.containerId !== expectedContainerId) {
      throw new Error(
        `Environment '${envId}' does not own execution container '${expectedContainerId}'`
      );
    }
    return async () => {
      const handle = expectedContainerId ?? meta.containerName ?? meta.containerId;
      if (!handle) {
        log.warn({ envId }, 'isolation.container_suspend_no_handle');
        return;
      }
      if (meta.artifactsMount !== undefined) {
        await this.restoreHostOwnership(envId, handle, meta.artifactsMount, {
          timeout: dockerTimeoutMs,
        });
      }
      try {
        await this.docker(
          ['stop', ...(dockerTimeoutMs === undefined ? [] : ['--time', '1']), handle],
          { timeout: dockerTimeoutMs }
        );
        log.info({ envId, handle }, 'isolation.container_suspended');
      } catch (err) {
        const detail = extractDockerError(err);
        const state = await this.describeContainer(handle, { timeout: dockerTimeoutMs }).catch(
          () => 'unknown' as const
        );
        if (state === 'missing' || state === 'stopped') {
          log.debug({ envId, handle, detail }, 'isolation.container_suspend_already_stopped');
          return;
        }
        log.error({ envId, handle, detail }, 'isolation.container_suspend_failed');
        throw new IsolationFailure(
          'unclassified',
          `Failed to suspend container '${handle}' for env '${envId}': ${detail}`,
          err
        );
      }
    };
  }

  /**
   * Rediscover and restart a suspended environment for resume, returning a fresh
   * {@link PreparedEnv}. Cases, in order:
   *  - container present + running → reuse as-is,
   *  - container present + stopped → `docker start` + re-wait for the overlay,
   *  - container GONE but the upper volume survives → recreate a container over the
   *    same volume (the accumulated overlay is preserved),
   *  - volume ALSO gone → throw LOUD: the un-applied work is lost, never silently
   *    restart from an empty overlay.
   */
  async resumeEnv(envId: string): Promise<PreparedEnv> {
    const meta = await this.loadMetadata(envId);
    const { containerName, volume, workspacePath } = meta;
    if (!containerName || !volume || !workspacePath) {
      throw new Error(
        `Cannot resume container env '${envId}': its tracking row is missing the ` +
          'container name / volume / workspace path. The environment may be from an ' +
          'incompatible version; start a fresh --container run.'
      );
    }
    const row = await this.store.getById(envId);
    const codebaseId = row?.codebase_id ?? '';
    const presence = await this.describeContainer(containerName);
    if (presence === 'paused' || presence === 'restarting') {
      throw new IsolationFailure(
        'unclassified',
        `Cannot resume container env '${envId}': container '${containerName}' is ${presence}.`
      );
    }
    if (presence === 'running' || presence === 'stopped') {
      const { containerId, mode: priorMode } = await this.verifyRecordedContainer(
        envId,
        containerName,
        volume,
        meta
      );
      if (presence === 'stopped') {
        await this.docker(['start', containerId]);
        await waitForReady(this.docker, containerId);
      }
      log.info(
        { envId, containerName },
        presence === 'running'
          ? 'isolation.container_resume_reused_running'
          : 'isolation.container_resume_restarted'
      );
      return this.preparedEnvFor(containerId, workspacePath, envId, priorMode);
    }

    // Container is gone. The overlay lives on the volume — recreate over it, or
    // fail loudly if the volume is gone too (the un-applied work is unrecoverable).
    if (!(await this.volumeExists(volume))) {
      throw new Error(
        `Cannot resume container env '${envId}': both the container and its overlay ` +
          `volume '${volume}' are gone, so the un-applied changes are lost. This run ` +
          'cannot continue — start a fresh --container run. (A `docker volume rm` or ' +
          'an aggressive prune likely removed it; paused runs are never auto-pruned.)'
      );
    }
    // Re-apply the host mounts. A recreated container without them would resolve no
    // named script, and would write artifacts into a container-local directory the host
    // never sees — both at paths the run's own metadata reports as intact.
    const mounts: HostMounts = { source: meta.sourceMount, artifacts: meta.artifactsMount };
    if (mounts.source !== undefined && mounts.artifacts === undefined) {
      // A row from before the artifacts bind existed: the engine has always sent both
      // mounts together since it did. The run continues exactly as it would have before
      // the upgrade, which means `$ARTIFACTS_DIR` writes stay inside the container.
      log.warn(
        { envId, containerName, workspacePath },
        'isolation.container_resume_without_artifacts_mount'
      );
    }
    assertMountableHostMounts(mounts, workspacePath);
    const { containerId, mode } = await startContainerWithOverlay(this.docker, this.config, {
      containerName,
      volume,
      hostRoot: workspacePath,
      codebaseId,
      mounts,
    });
    await this.recordRecreatedContainer(envId, containerId, mode, volume);
    log.info({ envId, containerName, volume }, 'isolation.container_resume_recreated');
    return this.preparedEnvFor(containerId, workspacePath, envId, mode);
  }

  private async recordRecreatedContainer(
    envId: string,
    containerId: string,
    mode: OverlayMode,
    volume: string
  ): Promise<void> {
    try {
      await this.store.updateMetadata(envId, {
        containerId,
        overlayMode: mode,
        image: this.config.image,
      });
    } catch (error) {
      try {
        await this.docker(['rm', '-f', containerId]);
      } catch (cleanupError) {
        throw new IsolationFailure(
          'unclassified',
          `Failed to record recreated container '${containerId}': ${extractDockerError(error)}. ` +
            `Could not remove it: ${extractDockerError(cleanupError)}. ` +
            `Overlay volume '${volume}' is preserved.`,
          new AggregateError(
            [error, cleanupError],
            'Container recreation persistence and cleanup failed'
          )
        );
      }
      throw error;
    }
  }

  private async verifyRecordedContainer(
    envId: string,
    containerName: string,
    volume: string,
    meta: Awaited<ReturnType<ContainerBackend['loadMetadata']>>
  ): Promise<{ containerId: string; mode: OverlayMode }> {
    const priorMode =
      meta.overlayMode === undefined
        ? 'native'
        : OVERLAY_MODES.find(mode => mode === meta.overlayMode);
    if (priorMode === undefined) {
      throw new IsolationFailure(
        'unclassified',
        `Cannot resume container env '${envId}': invalid persisted overlay mode ` +
          `${JSON.stringify(meta.overlayMode)}. Expected one of: ${OVERLAY_MODES.join(', ')}.`
      );
    }
    const containerId = await this.getContainerId(containerName);
    if (containerId !== meta.containerId) {
      throw new IsolationFailure(
        'unclassified',
        `Cannot resume container env '${envId}': container '${containerName}' ID ` +
          `'${containerId}' does not match recorded ID '${meta.containerId}'. ` +
          'Its overlay mode is unknown; remove the unrecorded container before retrying, ' +
          `preserving overlay volume '${volume}'.`
      );
    }
    const { stdout } = await this.docker(['inspect', '-f', '{{json .Config.Env}}', containerId]);
    const environment: unknown = JSON.parse(stdout);
    const modeEntries = Array.isArray(environment)
      ? environment.filter(
          (entry: unknown): entry is string =>
            typeof entry === 'string' && entry.startsWith('ARCHON_OVERLAY_MODE=')
        )
      : [];
    if (modeEntries.length !== 1 || modeEntries[0] !== `ARCHON_OVERLAY_MODE=${priorMode}`) {
      throw new IsolationFailure(
        'unclassified',
        `Cannot resume container env '${envId}': container '${containerId}' overlay mode ` +
          `${JSON.stringify(modeEntries)} does not match recorded overlay mode '${priorMode}'.`
      );
    }
    return { containerId, mode: priorMode };
  }

  /**
   * Inspect the finished run's overlay diff. Runs a read-only helper against the
   * upper volume (no running container needed). Empty diff → `requiresApproval:
   * false` so the engine completes without a write-back gate.
   */
  async finalize(envId: string): Promise<WriteBackFinalizeResult> {
    const meta = await this.loadMetadata(envId);
    const { volume, workspacePath, image } = meta;
    if (!volume || !workspacePath || !image) {
      throw new Error(
        `Cannot finalize container env '${envId}': tracking row missing volume / ` +
          'workspace path / image.'
      );
    }
    const changeSummary = await summarizeOverlayChanges(this.docker, {
      volume,
      hostRoot: workspacePath,
      image,
    });
    log.info(
      { envId, totalCount: changeSummary.totalCount, truncated: changeSummary.truncated },
      'isolation.container_finalized'
    );
    return { requiresApproval: changeSummary.totalCount > 0, changeSummary };
  }

  /**
   * Apply the overlay diff to the live project root — the ONE moment the live root
   * is written. Runs the write-back helper (mounts the live root read-write). Does
   * NOT tear the environment down; the caller destroys the container + volume after
   * the run completes.
   */
  async applyChanges(envId: string): Promise<WriteBackApplySummary> {
    const meta = await this.loadMetadata(envId);
    const { volume, workspacePath, image } = meta;
    if (!volume || !workspacePath || !image) {
      throw new Error(
        `Cannot apply container env '${envId}': tracking row missing volume / ` +
          'workspace path / image.'
      );
    }
    const summary = await applyOverlayChanges(this.docker, {
      volume,
      hostRoot: workspacePath,
      image,
    });
    log.info(
      { envId, filesApplied: summary.filesApplied, filesDeleted: summary.filesDeleted },
      'isolation.container_changes_applied'
    );
    return summary;
  }

  /**
   * Discard the overlay diff (write-back rejected). The live root is never touched;
   * the volume is reclaimed by the caller's subsequent `destroy`. A no-op beyond a
   * breadcrumb — the discard IS "do nothing to the live root, then destroy".
   */
  async discardChanges(envId: string): Promise<void> {
    log.info({ envId }, 'isolation.container_changes_discarded');
  }

  /**
   * Give the host user back the files the container wrote into the artifacts bind.
   *
   * In-container work runs as root. On Docker Desktop and rootless daemons that maps to
   * the host user already; on a rootful Linux daemon it leaves root-owned files under
   * `~/.archon` that the operator cannot later remove. Best-effort by design: the files
   * are the run's real output either way, so a failed hand-back is logged, never fatal.
   * Skipped when the host user is root or the platform has no uid (Windows).
   */
  private async restoreHostOwnership(
    envId: string,
    handle: string,
    artifactsMount: string,
    options?: DockerExecOptions
  ): Promise<void> {
    const identity = currentHostIdentity();
    if (identity === undefined || identity.uid === 0) return;
    const owner = `${String(identity.uid)}:${String(identity.gid)}`;
    try {
      await this.docker(['exec', handle, 'chown', '-R', owner, artifactsMount], options);
      log.debug({ envId, handle, artifactsMount, owner }, 'isolation.container_artifacts_owned');
    } catch (err) {
      const detail = extractDockerError(err);
      log.warn(
        { envId, handle, artifactsMount, owner, detail },
        'isolation.container_artifacts_chown_failed'
      );
    }
  }

  /**
   * Load a container env's persisted metadata, or throw if the row is gone. The
   * store normalizes `metadata` to a parsed object on every dialect (SQLite returns
   * it as a JSON string otherwise), so this reads it directly.
   */
  private async loadMetadata(
    envId: string
  ): Promise<Partial<Omit<ContainerEnvMetadata, 'overlayMode'>> & { overlayMode?: unknown }> {
    const row = await this.store.getById(envId);
    if (!row) {
      throw new Error(`Container env '${envId}' not found (its tracking row is gone).`);
    }
    return row.metadata;
  }

  private preparedEnvFor(
    containerId: string,
    cwd: string,
    envId: string,
    overlayMode: OverlayMode
  ): PreparedEnv {
    return { cwd, execContext: { kind: 'container', containerId }, envId, overlayMode };
  }

  /**
   * Preserve active states that cannot execute work: paused and restarting must
   * neither resume as ready nor suppress a failed stop. Distinct from {@link containerState}
   * which folds "missing" and "inspect blip" into `unknown` — resume MUST tell
   * "gone" (→ recreate over the volume) apart from "stopped" (→ start).
   */
  private async describeContainer(
    nameOrId: string,
    options?: DockerExecOptions
  ): Promise<'running' | 'paused' | 'restarting' | 'stopped' | 'missing'> {
    const { stdout } = await this.docker(
      ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'],
      options
    );
    const match = stdout
      .trim()
      .split('\n')
      .map(line => line.split('\t'))
      .find(([id, name]) => name === nameOrId || id === nameOrId);
    if (!match) return 'missing';
    switch (match[2]) {
      case 'running':
      case 'paused':
      case 'restarting':
        return match[2];
      case 'created':
      case 'exited':
      case 'dead':
      case 'removing':
        return 'stopped';
      default:
        throw new IsolationFailure('unclassified', `Unknown Docker container state: ${match[2]}`);
    }
  }

  private async getContainerId(nameOrId: string): Promise<string> {
    const { stdout } = await this.docker(['inspect', '-f', '{{.Id}}', nameOrId]);
    return stdout.trim();
  }

  private async volumeExists(volume: string): Promise<boolean> {
    const { stdout } = await this.docker(['volume', 'ls', '--format', '{{.Name}}']);
    return stdout.trim().split('\n').includes(volume);
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
      const name = args.at(-1);
      let missing = false;
      try {
        missing =
          name !== undefined &&
          (args[0] === 'volume'
            ? !(await this.volumeExists(name))
            : (await this.describeContainer(name)) === 'missing');
      } catch (inspectionError) {
        return `${detail}; could not verify removal: ${extractDockerError(inspectionError)}`;
      }
      if (missing) {
        log.debug({ args, detail }, 'isolation.container_destroy_already_gone');
        return undefined;
      }
      return detail;
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
