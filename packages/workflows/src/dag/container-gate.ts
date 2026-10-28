/**
 * Container run lifecycle: the lifecycle events, suspend-on-pause, and the engine-level
 * write-back gate that runs after the last node before a container run completes.
 */
import {
  pauseGateRespectingExternalTransition,
  sendPauseNotice,
  publishContainerPause,
  type ContainerPauseBoundary,
  type ContainerPauseReceipt,
} from './pause';
import type { IWorkflowPlatform, WorkflowDeps } from '../deps';
import type { ExecutionContext } from '@archon/provider-contract';
import {
  WRITEBACK_GATE_NODE_ID,
  type ContainerRunContext,
  type OverlayChangeSummary,
} from '../container-context';
import { gateOccurrence } from '../schemas/workflow-run';
import { isApprovalContext } from '../schemas';
import { getWorkflowEventEmitter } from '../event-emitter';
import { safeSendMessage } from '../platform-messages';
import { getLog } from './log';

/**
 * Emit + persist a container-lifecycle event (fire-and-forget DB write), so the
 * create/stop/resume/write-back phases surface in all three logging layers.
 */
function emitContainerLifecycleEvent(
  deps: WorkflowDeps,
  runId: string,
  phase: ContainerLifecyclePhase,
  eventType: ContainerLifecycleDbEvent,
  containerId?: string,
  data: Record<string, unknown> = {}
): void {
  getWorkflowEventEmitter().emit({
    type: 'container_lifecycle',
    runId,
    phase,
    ...(containerId ? { containerId } : {}),
  });
  deps.store
    .createWorkflowEvent({
      workflow_run_id: runId,
      event_type: eventType,
      step_name: 'container',
      data: { ...(containerId ? { containerId } : {}), ...data },
    })
    .catch((err: Error) => {
      getLog().error({ err, workflowRunId: runId, eventType }, 'workflow_event_persist_failed');
    });
}

/** Container-lifecycle phases carried by the emitter event (superset of the DB rows). */
type ContainerLifecyclePhase =
  | 'created'
  | 'stopped'
  | 'resumed'
  | 'destroyed'
  | 'writeback_requested'
  | 'writeback_applied'
  | 'writeback_discarded';

/**
 * DB `workflow_events.event_type` values written best-effort beside the lifecycle signal.
 * `writeback_requested` is not one: it commits with the write-back pause.
 */
type ContainerLifecycleDbEvent =
  | 'container_created'
  | 'container_stopped'
  | 'container_resumed'
  | 'container_destroyed'
  | 'writeback_applied'
  | 'writeback_discarded';

/** The stop attempt must settle before the run becomes resumable. */
export async function suspendContainerForPause(
  containerCtx: ContainerRunContext
): Promise<ContainerSuspendOutcome> {
  try {
    await containerCtx.backend.suspend(containerCtx.envId);
    getLog().info({ envId: containerCtx.envId }, 'dag.container_suspend_finished');
    return { stopped: true };
  } catch (error) {
    getLog().error({ err: error, envId: containerCtx.envId }, 'dag.container_suspend_failed');
    return { stopped: false, error };
  }
}

export type ContainerSuspendOutcome = { stopped: true } | { stopped: false; error: unknown };

export async function reportContainerSuspension(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  runId: string,
  outcome: ContainerSuspendOutcome
): Promise<void> {
  if (outcome.stopped) {
    emitContainerLifecycleEvent(
      deps,
      runId,
      'stopped',
      'container_stopped',
      execContext.containerId
    );
    getLog().info({ runId, envId: containerCtx.envId }, 'dag.container_suspended_on_pause');
  } else {
    const err = outcome.error;
    getLog().error(
      { err, runId, envId: containerCtx.envId },
      'dag.container_suspend_on_pause_failed'
    );
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Run paused, but its isolation container could not be stopped: ${
        err instanceof Error ? err.message : String(err)
      }. It keeps running until resume/teardown reclaims it.`,
      { workflowId: runId }
    );
  }
}

export async function recordContainerSuspendWarning(
  deps: WorkflowDeps,
  runId: string,
  outcome: ContainerSuspendOutcome
): Promise<void> {
  if (outcome.stopped) return;
  const err = outcome.error;
  const warning = `Isolation container could not be stopped: ${err instanceof Error ? err.message : String(err)}`;
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'workflow_cleanup_warning',
      step_name: 'container',
      data: { warnings: [warning] },
    })
    .catch((persistError: unknown) => {
      getLog().error({ err: persistError, runId }, 'dag.container_suspend_warning_persist_failed');
    });
}

/**
 * Sanitize an AGENT-CONTROLLED string (a file path or symlink target) before it is
 * interpolated into the approval-gate message (R2-F3). The container agent chooses
 * these, so a raw newline could forge extra lines in the approver's view and Markdown
 * could forge formatting/links. We (1) replace every control char (C0/C1, incl.
 * newline/CR/tab) with a visible `?`, then (2) wrap the result in inline code with
 * backticks escaped, so the whole token renders literally and inertly regardless of
 * its content. Truncated to keep one entry from dominating the message.
 */
function sanitizeGateText(value: string): string {
  // Matches control characters on purpose, to neutralize them.
  const noControl = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  const capped = noControl.length > 300 ? `${noControl.slice(0, 300)}…` : noControl;
  return `\`${capped.replace(/`/g, "'")}\``;
}

/** Render the write-back change summary + approve/reject instructions for the gate message. */
function renderWriteBackSummary(summary: OverlayChangeSummary): string {
  const { added, modified, deleted, symlinks, skipped, totalCount, truncated } = summary;
  // Faithfully represent what apply will do (M1): files by kind, symlinks as
  // `path -> target` with escaping ones flagged (apply REFUSES them), and the
  // entries apply will skip. The approver sees exactly what lands and what won't.
  // Every agent-controlled path/target is sanitized (R2-F3) so it can't forge lines
  // or Markdown in the approver's view.
  const preview = [
    ...added.map(p => `+ ${sanitizeGateText(p)}`),
    ...modified.map(p => `~ ${sanitizeGateText(p)}`),
    ...deleted.map(p => `- ${sanitizeGateText(p)}`),
    ...symlinks.map(
      s =>
        `${s.escapes ? '⚠ ' : ''}@ ${sanitizeGateText(s.path)} -> ${sanitizeGateText(s.target)}${s.escapes ? '  (ESCAPES — will be refused)' : ''}`
    ),
  ].slice(0, 25);
  const lines = [
    '**Container run finished — review the changes before they touch the live folder.**',
    '',
    `${totalCount} change(s): ${added.length} added, ${modified.length} modified, ${deleted.length} deleted, ${symlinks.length} symlink(s):`,
    ...preview.map(p => `  ${p}`),
  ];
  if (truncated || totalCount > preview.length) {
    lines.push(`  … and ${totalCount - preview.length} more`);
  }
  if (skipped.length > 0) {
    lines.push(
      '',
      `${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} will be SKIPPED (special files / unsafe / escaping):`
    );
    for (const s of skipped.slice(0, 10)) {
      lines.push(`  ! ${sanitizeGateText(s.path)} (${sanitizeGateText(s.reason)})`);
    }
    if (skipped.length > 10) lines.push(`  … and ${skipped.length - 10} more`);
  }
  lines.push('', 'Approve to APPLY these changes to the live folder, or reject to discard them.');
  return lines.join('\n');
}

/**
 * The engine-level container write-back gate (Phase C). Runs after the last node
 * succeeds, and again on each resume (the DAG re-runs with every node skipped and
 * lands here). Returns:
 *  - pause receipt — pending an approval decision; suspension was attempted.
 *  - `applied`   — the overlay diff landed on the live root (auto policy, or
 *                  resume-after-approve). Fall through to complete the run.
 *  - `discarded` — the overlay was discarded (resume-after-reject). Complete.
 *  - `skipped`   — empty diff; nothing to apply. Complete normally.
 */
export async function runContainerWriteBackGate(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>
): Promise<ContainerPauseReceipt | 'applied' | 'discarded' | 'skipped'> {
  const run = await deps.store.getWorkflowRun(runId);
  const meta = run?.metadata ?? {};
  const pending = meta.pending_writeback as
    | { envId: string; summary?: OverlayChangeSummary }
    | undefined;
  // Idempotent re-entry: a resume after the decision already applied/discarded on a
  // prior invocation just completes (L2 — never re-pause a resolved gate). Return the
  // HONEST outcome (`writeback_outcome`) so a re-entered DISCARDED run isn't mislabeled
  // as applied.
  if (meta.writeback_resolved === true) {
    return meta.writeback_outcome === 'discarded' ? 'discarded' : 'applied';
  }

  const rawApproval = meta.approval;
  const approval = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isWriteBackGate = approval?.type === 'writeback';

  // RESUME after the gate was raised. Decide STRICTLY on THIS gate's own resolution
  // (`metadata.approval.resolved` for the `type:'writeback'` context) — NEVER the
  // run-wide `approval_response` (a stale value from an earlier mid-DAG approval node
  // would auto-apply) and NEVER "anything but rejected" (a plain `/workflow resume`
  // carries no decision → must not apply). Unresolved ⇒ FAIL CLOSED (re-pause).
  if (pending && isWriteBackGate) {
    if (approval.resolved === 'approved') {
      return applyApprovedWriteBack(deps, platform, conversationId, runId, containerCtx);
    }
    if (approval.resolved === 'rejected') {
      return discardWriteBack(deps, platform, conversationId, runId, containerCtx);
    }
    // FAIL CLOSED: a resume reached the still-open gate with no decision (e.g. a bare
    // `/workflow resume`). Re-raise the gate rather than touching the live root.
    getLog().warn({ runId }, 'dag.writeback_resume_unresolved_repause');
    const summary =
      pending.summary ?? (await containerCtx.backend.finalize(containerCtx.envId)).changeSummary;
    return raiseWriteBackGate(
      deps,
      platform,
      conversationId,
      runId,
      containerCtx,
      execContext,
      summary
    );
  }

  // FIRST arrival: inspect the overlay diff.
  const finalize = await containerCtx.backend.finalize(containerCtx.envId);
  const summary = finalize.changeSummary;
  if (!finalize.requiresApproval || !summary || summary.totalCount === 0) {
    getLog().info({ runId }, 'dag.writeback_empty_diff_skipped');
    return 'skipped';
  }

  // `auto` policy: apply without pausing (logged). For unattended workflows.
  if (containerCtx.writeBack === 'auto') {
    return autoApplyWriteBack(deps, platform, conversationId, runId, containerCtx);
  }

  // `approve` policy (default): suspend, then raise the write-back gate.
  return raiseWriteBackGate(
    deps,
    platform,
    conversationId,
    runId,
    containerCtx,
    execContext,
    summary
  );
}

async function applyApprovedWriteBack(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext
): Promise<'applied'> {
  // Retry-safe apply (R2-F4). CLAIM the apply atomically BEFORE mutating the live
  // root. Semantics:
  //  - `claimed` false ⇒ an earlier attempt took the claim and never recorded a
  //    resolution (a recorded one returns earlier, at the `writeback_resolved` check in
  //    `runContainerWriteBackGate`). It may have crashed before, during or after the
  //    copy, so the outcome is unknown. Fail the run without recording a resolution:
  //    `pending_writeback` stays unresolved, teardown preserves the volume, and the
  //    operator reconciles. Every later resume refuses the same way, so no path
  //    applies twice.
  //  - `claimed` true ⇒ we own the apply. On SUCCESS record `writeback_resolved`;
  //    on FAILURE release the claim so `workflow resume` can retry (H2), keep the
  //    volume, and rethrow so the run fails with the reconcile teardown message.
  const { claimed } = await deps.store.claimWriteback(runId);
  if (!claimed) {
    getLog().error({ runId, envId: containerCtx.envId }, 'dag.writeback_apply_outcome_unknown');
    throw new Error(
      'The write-back needs reconciliation: an earlier attempt claimed the apply to the ' +
        'live folder but never recorded that it finished, so the changes may be fully, ' +
        'partly or not applied. Archon will not apply them again. The container and ' +
        `overlay volume (env ${containerCtx.envId}) are preserved: compare the live folder ` +
        'with the overlay, apply any missing writes and deletions by hand, then run ' +
        `\`archon workflow abandon ${runId}\` to discard the overlay.`
    );
  }
  let applied;
  try {
    applied = await containerCtx.backend.applyChanges(containerCtx.envId);
  } catch (applyErr) {
    await deps.store.releaseWritebackClaim(runId).catch((relErr: unknown) => {
      getLog().error({ err: relErr as Error, runId }, 'dag.writeback_release_claim_failed');
    });
    throw applyErr;
  }
  await deps.store.updateWorkflowRun(runId, {
    metadata: { writeback_resolved: true, writeback_outcome: 'applied' },
  });
  emitContainerLifecycleEvent(deps, runId, 'writeback_applied', 'writeback_applied', undefined, {
    files_applied: applied.filesApplied,
    files_deleted: applied.filesDeleted,
  });
  await safeSendMessage(
    platform,
    conversationId,
    `✅ Applied to the live folder: ${applied.filesApplied} file(s) written, ${applied.filesDeleted} deleted.` +
      (applied.warnings.length > 0 ? `\n⚠️ ${applied.warnings.join('; ')}` : ''),
    { workflowId: runId }
  );
  return 'applied';
}

async function discardWriteBack(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext
): Promise<'discarded'> {
  await containerCtx.backend.discardChanges(containerCtx.envId);
  await deps.store.updateWorkflowRun(runId, {
    metadata: { writeback_resolved: true, writeback_outcome: 'discarded' },
  });
  emitContainerLifecycleEvent(deps, runId, 'writeback_discarded', 'writeback_discarded');
  await safeSendMessage(
    platform,
    conversationId,
    '🗑️ Changes discarded — the live folder was left untouched. (The run itself succeeded; artifacts remain.)',
    { workflowId: runId }
  );
  return 'discarded';
}

async function autoApplyWriteBack(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext
): Promise<'applied'> {
  // N1 — set the `pending_writeback` preserve marker BEFORE mutating the live root,
  // even in auto mode (which never pauses). If applyChanges throws partway, the run
  // fails with the marker set + unresolved, so the teardown PRESERVES the volume
  // (the un-applied remainder is recoverable) instead of destroying it. Cleared to
  // resolved on success so normal teardown cleanup proceeds. (No claim CAS here:
  // auto runs in one process; a resume of a failed auto run re-enters this first-
  // arrival path and re-applies idempotently.)
  await deps.store.updateWorkflowRun(runId, {
    metadata: { pending_writeback: { envId: containerCtx.envId } },
  });
  const applied = await containerCtx.backend.applyChanges(containerCtx.envId);
  await deps.store.updateWorkflowRun(runId, {
    metadata: { writeback_resolved: true, writeback_outcome: 'applied' },
  });
  emitContainerLifecycleEvent(deps, runId, 'writeback_applied', 'writeback_applied', undefined, {
    files_applied: applied.filesApplied,
    files_deleted: applied.filesDeleted,
    auto: true,
  });
  await safeSendMessage(
    platform,
    conversationId,
    `✅ Auto-applied ${applied.filesApplied} file(s) to the live folder (${applied.filesDeleted} deleted). ` +
      '(`container.write_back: auto` — no approval gate.)',
    { workflowId: runId }
  );
  getLog().info({ runId, filesApplied: applied.filesApplied }, 'dag.writeback_auto_applied');
  return 'applied';
}

/**
 * Raise (or re-raise) the write-back approval gate: pause the run with a synthetic
 * `type:'writeback'` ApprovalContext, persist `pending_writeback`, emit the events +
 * live pause signal, and message the user, after attempting suspension. Reused by the
 * first-arrival approve path AND the fail-closed re-pause on an unresolved resume.
 */
async function raiseWriteBackGate(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  summary: OverlayChangeSummary | undefined
): Promise<ContainerPauseReceipt> {
  const message = summary
    ? renderWriteBackSummary(summary)
    : 'Container run finished — review before applying to the live folder.';
  // Fold `pending_writeback` into the SAME pause write so there is no window where the
  // run is paused-for-writeback without the resume marker (M3): pass it via the shared
  // pause helper's `extraMetadata`, one merged write. `failClosed: true` preserves this
  // gate's existing fail-closed contract — a lost pause here must never fall through
  // toward the apply/teardown path (throwing is the safe behavior, and the H2
  // teardown-preserve logic keeps the overlay volume for a retry), so it rethrows
  // instead of tolerating the CAS miss the way the other four gate types do. This also
  // emits the `approval_pending` live pause signal on success (same event the approval
  // node emits, so the existing pause UI shows approve/reject). The `writeback_requested`
  // row commits with the pause, so the pause reaches the event feed; only the live
  // container-lifecycle signal follows it.
  const outcome = await suspendContainerForPause(containerCtx);
  const boundary: ContainerPauseBoundary = {};
  const receipt = await publishContainerPause(
    runId,
    boundary,
    async () => {
      const paused = await pauseGateRespectingExternalTransition(
        deps,
        runId,
        { nodeId: WRITEBACK_GATE_NODE_ID, message, type: 'writeback' },
        {
          event: {
            workflow_run_id: runId,
            event_type: 'writeback_requested',
            step_name: 'container',
            data: { total_count: summary?.totalCount ?? 0 },
          },
          extraMetadata: {
            pending_writeback: { envId: containerCtx.envId, ...(summary ? { summary } : {}) },
          },
          failClosed: true,
          boundary,
        }
      );
      getWorkflowEventEmitter().emit({
        type: 'container_lifecycle',
        runId,
        phase: 'writeback_requested',
      });

      // failClosed makes a lost pause throw above, so this guards the type, not a reachable state.
      if (paused === undefined) throw new Error(`Write-back gate for run ${runId} did not pause`);
      await sendPauseNotice(
        deps,
        platform,
        conversationId,
        runId,
        WRITEBACK_GATE_NODE_ID,
        gateOccurrence(paused),
        'container',
        message
      );
    },
    async () => {
      await recordContainerSuspendWarning(deps, runId, outcome);
      await reportContainerSuspension(
        deps,
        platform,
        conversationId,
        containerCtx,
        execContext,
        runId,
        outcome
      );
    }
  );
  if (receipt === undefined) throw new Error(`Write-back gate for run ${runId} did not pause`);
  return receipt;
}

/**
 * Announce a run's live container in all three logging layers. A resume (the caller
 * rediscovered and restarted the container) announces `container_resumed` rather than
 * `container_created`, so the timeline is honest.
 */
export async function announceContainerRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  containerCtx: ContainerRunContext | undefined,
  isResume: boolean
): Promise<void> {
  // H4 — native overlay mode grants CAP_SYS_ADMIN, so an adversarial in-container
  // agent can remount the read-only lower read-write and bypass the write-back
  // gate. Warn LOUDLY at run start (console/platform + the lifecycle event) so the
  // operator knows the isolation is accident-protection, not a hostile-agent
  // sandbox, in this mode. Warning-only in v1 (see SECURITY.md).
  const nativeOverlay = containerCtx?.overlayMode === 'native';
  emitContainerLifecycleEvent(
    deps,
    runId,
    isResume ? 'resumed' : 'created',
    isResume ? 'container_resumed' : 'container_created',
    execContext.containerId,
    nativeOverlay ? { overlayMode: 'native', gateBypassable: true } : {}
  );

  if (nativeOverlay) {
    await safeSendMessage(
      platform,
      conversationId,
      '⚠️ Container is running in NATIVE overlay mode (CAP_SYS_ADMIN). An adversarial ' +
        'agent could bypass the write-back review by remounting the project root — treat ' +
        'this run as accident-protection, not a sandbox against hostile code. (See SECURITY.md.)',
      { workflowId: runId }
    );
    getLog().warn({ workflowRunId: runId }, 'dag.container_native_mode_gate_bypassable');
  }
}
