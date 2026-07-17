/**
 * Container run context shared by the executor and dag-executor (Phase C).
 *
 * Lives in its own module so both `executor.ts` (which threads it in from the
 * caller) and `dag-executor.ts` (which drives suspend + the write-back gate) can
 * import it without an import cycle between those two large files.
 */

import type { WriteBackFinalizeResult, WriteBackApplySummary } from '@archon/providers/types';

/**
 * The container-backend methods the engine drives directly for the write-back
 * gate + pause economics. A STRUCTURAL port: the container backend from
 * `@archon/isolation` implements exactly these (plus prepare/resumeEnv/destroy the
 * CALLER drives across process boundaries), so the engine consumes them without
 * importing that package — mirroring the `ExecutionContext` contract split.
 */
export interface ContainerWriteBackBackend {
  /** `docker stop` on pause; the upper volume persists for resume. */
  suspend(envId: string): Promise<void>;
  /** Inspect the overlay diff → whether a write-back gate is warranted + summary. */
  finalize(envId: string): Promise<WriteBackFinalizeResult>;
  /** Apply the overlay diff to the live root (the ONE live-root write). */
  applyChanges(envId: string): Promise<WriteBackApplySummary>;
  /** Discard the overlay diff (live root untouched). */
  discardChanges(envId: string): Promise<void>;
}

/**
 * Container run context threaded from the caller (CLI/orchestrator) into the
 * engine. Present only for folder-project container runs; absent for host runs.
 * `envId` is the prepared `isolation_environments` row the write-back methods act
 * on; the executor also stamps it into the run metadata so a later resume (a
 * separate process) can rediscover the container.
 */
export interface ContainerRunContext {
  envId: string;
  /** `approve` (default) pauses at the write-back gate; `auto` applies without pausing. */
  writeBack: 'approve' | 'auto';
  backend: ContainerWriteBackBackend;
  /**
   * Overlay mount mode in effect. `native` (CAP_SYS_ADMIN — the common fallback on
   * stock daemons) lets in-container root remount the read-only lower read-write, so
   * an adversarial agent could bypass the write-back gate. The engine emits a loud
   * run-start warning when this is `native` (H4; see SECURITY.md).
   */
  overlayMode?: 'fuse' | 'native';
}

/** Synthetic node id for the engine-level write-back gate (there is no DAG node). */
export const WRITEBACK_GATE_NODE_ID = '__writeback__';
