/**
 * Kind-routed backend selection for FOLDER-kind projects.
 *
 * This is the single seam where folder-project isolation is chosen. Repo-kind
 * projects keep the worktree path and must never reach here — calling this for a
 * repo codebase is a caller bug and throws. Folder projects select a backend:
 * `in-place` by default, `container` when opted in (Phase B).
 *
 * Consolidating selection here means Phase B's `--container` flag / config only
 * has to flip the `container` option; every folder call site (CLI, resolver)
 * routes through this one function.
 */

import type { BackendPrepareRequest, IIsolationBackend } from './types';
import { InPlaceBackend } from './backends/in-place';

export interface ResolveFolderBackendOptions {
  /**
   * Opt into the container backend. Phase A has no container implementation, so
   * a truthy value fails fast (explicit error) rather than silently downgrading
   * to in-place. Phase B replaces that throw with the container backend.
   */
  container?: boolean;
}

/**
 * Select the isolation backend for a folder-kind codebase.
 *
 * @throws if `codebase.kind !== 'folder'` — the seam is folder-only; repo
 *   projects use worktree isolation and must not be routed here.
 * @throws if `container` is requested — not implemented until Phase B; failing
 *   loudly beats a surprising in-place run when the user asked for a container.
 */
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
    throw new Error(
      'The container isolation backend is not available in this build (Phase B). ' +
        'Run without the container option to use in-place folder execution.'
    );
  }

  return new InPlaceBackend();
}
