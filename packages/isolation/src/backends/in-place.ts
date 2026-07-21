/**
 * In-place isolation backend for folder projects.
 *
 * Formalizes the pre-seam behavior: a folder project runs directly at its root
 * on the host, with no worktree and no tracked environment row. Introduced by
 * the kind-routed seam (Phase A) as the default folder backend; the container
 * backend (Phase B) is the opt-in alternative selected by `resolveFolderBackend`.
 */

import type { BackendPrepareRequest, IIsolationBackend, PreparedEnv } from '../types';

export class InPlaceBackend implements IIsolationBackend {
  readonly id = 'in-place' as const;

  /**
   * Run in place at the folder root on the host. Returns the same cwd the
   * resolver's folder early-return produced before the seam existed, so the
   * result is byte-identical to today's in-place behavior.
   */
  async prepare(req: BackendPrepareRequest): Promise<PreparedEnv> {
    return { cwd: req.codebase.defaultCwd, execContext: { kind: 'host' } };
  }

  /**
   * No-op: in-place runs create no tracked environment (no container, no
   * volume, no `isolation_environments` row), so there is nothing to tear down.
   */
  async destroy(_envId: string): Promise<void> {
    // Intentionally empty — see method doc.
  }
}
