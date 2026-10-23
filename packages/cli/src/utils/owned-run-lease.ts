import { startRunLiveOwner, type RunLiveOwner } from '@archon/core/services/run-live-owner';
import {
  requireTerminalStatusWrite,
  TerminalStatusWriteError,
} from '@archon/workflows/terminal-status-write';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowHost } from '@archon/core/workflows/host-store';

/** Worktree setup or execution starts the exact-run lease, whichever comes first. */
export class OwnedRunLease {
  private liveOwner: RunLiveOwner | undefined;
  private closing: Promise<void> | undefined;
  private prepareTermination:
    | Parameters<RunLiveOwner['registerTerminationPreparation']>[0]
    | undefined;
  private unregisterPreparation: (() => void) | undefined;
  private readonly detachedProcessOwner: boolean;
  /** The row worktree setup created; failed as `launch_failed` if execution never takes it. */
  setupRun: WorkflowRun | undefined;
  executionSubmitted = false;

  constructor(detachedProcessOwner: boolean) {
    this.detachedProcessOwner = detachedProcessOwner;
  }

  async start(runId: string): Promise<void> {
    if (this.liveOwner) return;
    this.liveOwner = await startRunLiveOwner(runId, {
      ...(this.detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
    });
    if (this.prepareTermination)
      this.unregisterPreparation = this.liveOwner.registerTerminationPreparation(
        this.prepareTermination
      );
  }

  registerTerminationPreparation(
    prepare: Parameters<RunLiveOwner['registerTerminationPreparation']>[0]
  ): () => void {
    if (this.prepareTermination)
      throw new Error('Run lease already has a termination preparation hook');
    this.prepareTermination = prepare;
    this.unregisterPreparation = this.liveOwner?.registerTerminationPreparation(prepare);
    return () => {
      if (this.prepareTermination !== prepare) return;
      this.unregisterPreparation?.();
      this.unregisterPreparation = undefined;
      this.prepareTermination = undefined;
    };
  }

  isStopRequested(): boolean {
    return this.liveOwner?.isStopRequested() ?? false;
  }

  close(): Promise<void> {
    if (!this.liveOwner) return Promise.resolve();
    this.closing ??= this.liveOwner.close();
    return this.closing;
  }

  /** A setup run nothing executed would otherwise stay `pending` forever. */
  async failUnsubmittedSetupRun(host: WorkflowHost, error: unknown): Promise<void> {
    const setupRun = this.setupRun;
    if (!setupRun || this.executionSubmitted || error instanceof TerminalStatusWriteError) return;
    await requireTerminalStatusWrite(
      host.deps.store.failWorkflowRun(setupRun.id, (error as Error).message, {
        exitReason: 'launch_failed',
      }),
      { workflowRunId: setupRun.id, site: 'cli.worktree_setup_failed' }
    );
  }
}
