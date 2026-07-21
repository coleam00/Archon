/**
 * Kind-routed backend selection for FOLDER-kind projects.
 *
 * This is the single seam where folder-project isolation is chosen. Repo-kind
 * projects keep the worktree path and must never reach here — calling this for a
 * repo codebase is a caller bug and throws. Folder projects select a backend:
 * `in-place` by default, `container` when opted in (`--container` / config).
 *
 * Consolidating selection here means the `--container` flag / config only has to
 * flip the `container` option; every folder call site (CLI, resolver) routes
 * through this one function.
 */

import type { BackendPrepareRequest, ContainerBackendConfig, IIsolationBackend } from './types';
import type { IIsolationStore } from './store';
import { InPlaceBackend } from './backends/in-place';
import { ContainerBackend } from './backends/container';
import type { DockerRunner } from './container/docker-exec';

export type { ContainerBackend };

export interface ResolveFolderBackendOptions {
  /**
   * Opt into the container backend. When true, `store` and `containerConfig`
   * are REQUIRED — the container backend tracks an `isolation_environments`
   * row and reads its runner image / caps from config. A truthy `container`
   * with either missing throws (fail-fast, never a silent in-place downgrade).
   */
  container?: boolean;
  /** Isolation store — required when `container` is true (env-row tracking). */
  store?: IIsolationStore;
  /** Resolved `container.*` config — required when `container` is true. */
  containerConfig?: ContainerBackendConfig;
  /** Injectable docker runner (tests substitute a fake; prod uses the default). */
  dockerRunner?: DockerRunner;
}

/**
 * Select the isolation backend for a folder-kind codebase.
 *
 * @throws if `codebase.kind !== 'folder'` — the seam is folder-only; repo
 *   projects use worktree isolation and must not be routed here.
 * @throws if `container` is requested without a `store` + `containerConfig` —
 *   failing loudly beats a surprising in-place run when the user asked for a
 *   container (no silent container→host downgrade).
 */
// Overloads: a `container: true` selection returns the CONCRETE ContainerBackend
// (its Phase C write-back methods are required on that type), so the CLI can pass
// it straight into the engine's write-back port without a runtime narrowing.
export function resolveFolderBackend(
  codebase: BackendPrepareRequest['codebase'],
  opts: ResolveFolderBackendOptions & { container: true }
): ContainerBackend;
export function resolveFolderBackend(
  codebase: BackendPrepareRequest['codebase'],
  opts?: ResolveFolderBackendOptions
): IIsolationBackend;
export function resolveFolderBackend(
  codebase: BackendPrepareRequest['codebase'],
  opts: ResolveFolderBackendOptions = {}
): IIsolationBackend {
  if (codebase.kind !== 'folder') {
    throw new Error(
      `resolveFolderBackend called for non-folder codebase '${codebase.name}' ` +
        `(kind: ${codebase.kind}). The backend seam is folder-only; repo projects ` +
        'use worktree isolation.'
    );
  }

  if (opts.container) {
    if (!opts.store || !opts.containerConfig) {
      throw new Error(
        'Container isolation was requested but is not wired up: the container ' +
          'backend needs an isolation store and container config. This is a caller ' +
          'bug — pass `store` and `containerConfig`, or run without `--container`.'
      );
    }
    return new ContainerBackend({
      store: opts.store,
      config: opts.containerConfig,
      ...(opts.dockerRunner ? { dockerRunner: opts.dockerRunner } : {}),
    });
  }

  return new InPlaceBackend();
}
