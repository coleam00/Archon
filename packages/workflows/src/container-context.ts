/**
 * Container run context shared by the executor and dag-executor (Phase C).
 *
 * Lives in its own module so both `executor.ts` (which threads it in from the
 * caller) and `dag-executor.ts` (which drives suspend + the write-back gate) can
 * import it without an import cycle between those two large files.
 */

/**
 * Summary of the changes an overlay upper layer holds relative to the read-only
 * lower (the live project root). By overlayfs construction the upper layer IS the
 * diff, so this is a directory walk, not a tree comparison. File lists are capped
 * (see `truncated`); `totalCount` is the true total across all three categories.
 */
export interface OverlayChangeSummary {
  /** Regular files present in the upper but absent from the lower (new files). */
  added: string[];
  /** Regular files present in both (the run overwrote an existing file). */
  modified: string[];
  /** Paths whited-out in the upper (the run deleted a lower file). */
  deleted: string[];
  /**
   * Symlinks the run created/changed, shown as `path -> target`. `escapes` marks a
   * target that resolves outside the project root — apply REFUSES those (reproducing
   * them would be a foothold / secret-exfiltration vector); the approver sees them
   * flagged in the summary.
   */
  symlinks: { path: string; target: string; escapes: boolean }[];
  /**
   * Entries the walk refused to reproduce and apply will skip: special files
   * (block/char/fifo/socket that aren't overlay whiteouts), escaping symlinks, and
   * unsafe whiteout names. Surfaced so the summary never over-promises what apply does.
   */
  skipped: { path: string; reason: string }[];
  /** True when any list was capped — more changes exist than are listed. */
  truncated: boolean;
  /** True count of changed paths (added + modified + deleted + symlinks), pre-cap. */
  totalCount: number;
}

/**
 * Result of `finalize()` — whether the finished run needs a write-back approval
 * gate, plus the change summary to show the reviewer. `requiresApproval` is
 * false when the overlay is empty (no changes → complete without a gate).
 */
export interface WriteBackFinalizeResult {
  requiresApproval: boolean;
  changeSummary?: OverlayChangeSummary;
}

/**
 * Result of `applyChanges()` — what actually landed on the live root. Reported
 * in the completion message and the `writeback_applied` event. `warnings` carries
 * per-file issues (e.g. an opaque-directory replace overlay-native can't express)
 * without failing the whole apply.
 */
export interface WriteBackApplySummary {
  filesApplied: number;
  filesDeleted: number;
  warnings: string[];
}

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
