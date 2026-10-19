/**
 * Starting a run's container over its overlay: the host mounts it may carry, the
 * FUSE-first start with its one authorized fallback to native overlay, and the
 * wait for the entrypoint's ready sentinel.
 */

import { isAbsolute, sep } from 'path';
import { createLogger, isInsideArchonHome } from '@archon/paths';
import type { OverlayMode } from '@archon/workflows/container-context';
import { IsolationFailure } from '../errors';
import type { ContainerBackendConfig } from '../types';
import { CONTAINER_LABELS } from '../types';
import { extractDockerError, type DockerRunner } from './docker-exec';

const log = createLogger('isolation.container');

/** Overlay-ready sentinel the entrypoint touches once the merged mount is up. */
const READY_SENTINEL = '/mnt/upper/.ready';
/** Max time to wait for the container's overlay mount to come up. */
const READY_TIMEOUT_MS = 20_000;
/** Poll interval while waiting for the ready sentinel. */
const READY_POLL_INTERVAL_MS = 250;

// The runner reserves this exit status for a failed fuse-overlayfs mount.
// Older runner images have no such signal and fail without escalating privileges.
const FUSE_MOUNT_FAILED_EXIT_CODE = 78;
class FuseMountFailure extends IsolationFailure {}

/** Archon-owned host directories bound into the container at their host paths. */
export interface HostMounts {
  /** Frozen workflow source, read-only. */
  readonly source?: string;
  /** Run artifacts directory, read-write. */
  readonly artifacts?: string;
}

/** What a run's container is started from, whichever overlay mode mounts. */
export interface ContainerStart {
  containerName: string;
  volume: string;
  hostRoot: string;
  codebaseId: string;
  mounts: HostMounts;
}

/**
 * Reject a host mount that is not Archon's to mount.
 *
 * The paths are engine-internal — never YAML, never `archon.config` — so this guards
 * against a bug or a hand-edited row, not a hostile author. It still matters: mounting an
 * arbitrary host path into a container that runs agent code, or shadowing the project
 * root the overlay depends on, are both far worse than failing the run.
 */
function assertMountableHostPath(
  kind: 'source' | 'artifacts',
  mountPath: string,
  workspacePath: string
): void {
  if (!isAbsolute(mountPath)) {
    throw new Error(`Container ${kind} mount must be an absolute path, got '${mountPath}'.`);
  }
  if (!isInsideArchonHome(mountPath)) {
    throw new Error(
      `Container ${kind} mount '${mountPath}' is outside ARCHON_HOME. Only Archon-owned ` +
        `run ${kind} may be mounted into a container.`
    );
  }
  const workspace = workspacePath.endsWith(sep) ? workspacePath : workspacePath + sep;
  const mount = mountPath.endsWith(sep) ? mountPath : mountPath + sep;
  if (mount.startsWith(workspace) || workspace.startsWith(mount)) {
    throw new Error(
      `Container ${kind} mount '${mountPath}' overlaps the workspace root ` +
        `'${workspacePath}'. Mounting it would shadow the overlay.`
    );
  }
}

export function assertMountableHostMounts(mounts: HostMounts, workspacePath: string): void {
  if (mounts.source !== undefined) assertMountableHostPath('source', mounts.source, workspacePath);
  if (mounts.artifacts !== undefined) {
    assertMountableHostPath('artifacts', mounts.artifacts, workspacePath);
  }
}

/**
 * Try FUSE without CAP_SYS_ADMIN first. Only the runner's dedicated FUSE
 * mount failure status (78) permits native overlay with CAP_SYS_ADMIN, which
 * allows in-container root to remount the lower directory (see SECURITY.md).
 * Docker startup failures and other readiness failures stop preparation.
 * The failed FUSE container must be removed before trying native.
 *
 * @returns the ready container id + the mode that succeeded.
 */
export async function startContainerWithOverlay(
  docker: DockerRunner,
  config: ContainerBackendConfig,
  target: ContainerStart
): Promise<{ containerId: string; mode: OverlayMode }> {
  try {
    return await startInMode(docker, config, target, 'fuse');
  } catch (error) {
    if (!(error instanceof FuseMountFailure)) throw error;
    log.warn(
      { containerName: target.containerName, mode: 'native', detail: extractDockerError(error) },
      'isolation.container_overlay_fallback'
    );
    return startInMode(docker, config, target, 'native');
  }
}

async function startInMode(
  docker: DockerRunner,
  config: ContainerBackendConfig,
  target: ContainerStart,
  mode: OverlayMode
): Promise<{ containerId: string; mode: OverlayMode }> {
  const { containerName } = target;
  const containerId = await runContainerInMode(docker, config, target, mode);
  try {
    await waitForReady(docker, containerId);
    return { containerId, mode };
  } catch (error) {
    await docker(['rm', '-f', containerName]).catch(rmErr => {
      log.warn(
        { containerName, mode, detail: extractDockerError(rmErr) },
        'isolation.container_fallback_cleanup_failed'
      );
      if (error instanceof FuseMountFailure) {
        if (!(rmErr instanceof IsolationFailure)) throw rmErr;
        throw new IsolationFailure(
          'unclassified',
          `Could not remove failed FUSE container: ${extractDockerError(rmErr)}`,
          new AggregateError([error, rmErr], 'FUSE cleanup failed')
        );
      }
    });
    throw error;
  }
}

/**
 * `docker run -d` the runner image in the given overlay mode. `fuse` grants
 * only `--device /dev/fuse` (no CAP_SYS_ADMIN); `native` grants
 * `--cap-add SYS_ADMIN --security-opt apparmor=unconfined` (no device). The
 * entrypoint mounts per `ARCHON_OVERLAY_MODE`.
 *
 * @returns the full container id from `docker run`'s stdout.
 */
async function runContainerInMode(
  docker: DockerRunner,
  config: ContainerBackendConfig,
  { containerName, volume, hostRoot, codebaseId, mounts }: ContainerStart,
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
    `${config.memoryMb}m`,
    '--pids-limit',
    String(config.pidsLimit),
    '--network',
    config.network,
    '-v',
    `${hostRoot}:/mnt/lower:ro`,
    '-v',
    `${volume}:/mnt/upper`,
    // The run's artifacts directory, read-write at the SAME absolute path: `$ARTIFACTS_DIR`
    // is the run's output channel on both sides of the boundary, so a screenshot or the
    // evidence marker written here lands on the host where the engine and the operator
    // read it. Root inside the container writes root-owned files on a rootful Linux
    // daemon; `restoreHostOwnership` hands them back on suspend and destroy.
    ...(mounts.artifacts ? ['-v', `${mounts.artifacts}:${mounts.artifacts}`] : []),
    // The run's frozen workflow source, at the SAME absolute path it has on the host.
    // Identical paths are what let the engine hold one source-roots value that means
    // the same thing whether a node executes here or on the host. Read-only: the run
    // reads its own commands and scripts, it never writes them.
    ...(mounts.source ? ['-v', `${mounts.source}:${mounts.source}:ro`] : []),
    '-e',
    `ARCHON_WORKSPACE_PATH=${hostRoot}`,
    '-e',
    `ARCHON_OVERLAY_MODE=${mode}`,
    config.image,
  ];
  const { stdout } = await docker(args);
  return stdout.trim();
}

type ReadinessFailures = Map<'exec' | 'inspect' | 'logs', IsolationFailure>;
type ReadyOutcome = 'ready' | 'exited' | 'fuse_mount_failed' | 'timed_out';

/**
 * Poll for the entrypoint's ready sentinel, stopping early if the container exits.
 * Only the runner's dedicated FUSE mount exit status permits native fallback.
 * Failures retain the container's tail logs and Docker diagnostics.
 */
export async function waitForReady(docker: DockerRunner, containerId: string): Promise<void> {
  const failures: ReadinessFailures = new Map();
  const outcome = await pollReady(docker, containerId, failures);
  if (outcome === 'ready') return;

  let logs = '';
  try {
    const { stdout, stderr } = await docker(['logs', '--tail', '20', containerId]);
    logs = `${stdout}\n${stderr}`.trim();
  } catch (error) {
    if (!(error instanceof IsolationFailure)) throw error;
    failures.set('logs', error);
  }
  const errors = [...failures.values()];
  const Failure =
    outcome === 'fuse_mount_failed' && !failures.has('logs') ? FuseMountFailure : IsolationFailure;
  throw new Failure(
    'unclassified',
    `Container overlay did not become ready.${logs ? ` Container logs:\n${logs}` : ''}` +
      (errors.length ? ` Docker failures:\n${errors.map(extractDockerError).join('\n')}` : ''),
    new AggregateError(errors, 'Docker readiness checks failed')
  );
}

async function pollReady(
  docker: DockerRunner,
  containerId: string,
  failures: ReadinessFailures
): Promise<ReadyOutcome> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await docker(['exec', containerId, 'test', '-f', READY_SENTINEL], { timeout: 5_000 });
      return 'ready';
    } catch (error) {
      if (!(error instanceof IsolationFailure)) throw error;
      failures.set('exec', error);
    }
    const exitCode = await exitCodeOnceStopped(docker, containerId, failures);
    if (exitCode !== undefined) {
      return exitCode === String(FUSE_MOUNT_FAILED_EXIT_CODE) ? 'fuse_mount_failed' : 'exited';
    }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return 'timed_out';
}

/**
 * The container's exit code once it has stopped, or undefined while it runs.
 * An inspect failure is not evidence of exit: polling continues rather than
 * broadening privileges to native overlay on a transient daemon failure.
 */
async function exitCodeOnceStopped(
  docker: DockerRunner,
  containerId: string,
  failures: ReadinessFailures
): Promise<string | undefined> {
  try {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', containerId], {
      timeout: 5_000,
    });
    if (stdout.trim() !== 'false') return undefined;
    const { stdout: exitCode } = await docker(
      ['inspect', '-f', '{{.State.ExitCode}}', containerId],
      { timeout: 5_000 }
    );
    return exitCode.trim();
  } catch (error) {
    if (!(error instanceof IsolationFailure)) throw error;
    failures.set('inspect', error);
    return undefined;
  }
}
