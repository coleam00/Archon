import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { OwnedWorktree, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { startRunLiveOwner, withRunLiveOwner } from '../../services/run-live-owner';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import type { CapturedSource, DispatchScope, PreparedAiConfiguration } from './scope';

export async function submitFreshForeground(
  scope: DispatchScope,
  input: {
    workflow: ResolvedWorkflow;
    freshCaptured: CapturedSource | undefined;
    cwd: string;
    cutFromCommit: string | undefined;
    ownedWorktree: OwnedWorktree | undefined;
    preparedAiConfiguration: PreparedAiConfiguration | undefined;
    setupRun: WorkflowRun | undefined;
    setupOwner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined;
    resolvedInputs: Record<string, string> | undefined;
    /** Called as the submit starts: from then on the engine owns the run's failure. */
    onSubmitted: () => void;
  }
): Promise<void> {
  const {
    owner,
    platform,
    conversationId,
    conversation,
    codebase,
    userId,
    source,
    options,
    userMessage,
    parseWarnings,
    codebaseBaseBranch,
    resolveChildIsolation,
  } = scope;
  const {
    workflow,
    freshCaptured,
    cwd,
    cutFromCommit,
    ownedWorktree,
    preparedAiConfiguration,
    setupRun,
    setupOwner,
    resolvedInputs,
    onSubmitted,
  } = input;
  // Fresh foreground execution for foreground-default adapters.
  // Reaching this means `resumableRun?.working_path` is falsy, which implies
  // `willContinueExistingRun` was false and the source capture ran. `freshCaptured` is
  // invariantly defined here — the capture-flow helper ran before this.
  if (!freshCaptured) {
    // Should never trigger; the reasoning above is the invariant. If it does, the
    // dispatch would hand a `preparedSource: undefined` to the executor and we are
    // about to fall into the executor's `source_unprepared_live` branch — the
    // mixed-vintage shape #2660 exists to remove — so refuse loudly rather than
    // ship that regression silently.
    throw new Error(
      'orchestrator invariant violated: fresh-foreground dispatch reached without a captured source'
    );
  }
  const freshDeps = createWorkflowDeps();
  const freshEngine = new InProcessWorkflowEngine(freshDeps);
  const captured = freshCaptured;
  const submitFresh = async (): Promise<void> => {
    onSubmitted();
    await freshEngine.submit({
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      origin: {
        conversationId: conversation.id,
        parentConversationId: conversation.id,
        userId,
      },
      options: {
        codebaseId: codebase.id,
        source,
        preparedSource: captured.preparedSource,
        preparedAiConfiguration,
        preCreatedRun: setupRun,
        parseWarnings,
        baseBranch: codebaseBaseBranch,
        resolveChildIsolation,
        capturedSourceOwner: owner,
        inputs: resolvedInputs,
        ...(cutFromCommit !== undefined ? { cutFromCommit } : {}),
        ownedWorktree,
        ...(options?.adoptRunId
          ? { adoptedFromRunId: options.adoptRunId, continuationMode: 'adopt' as const }
          : options?.supersedesRunId
            ? {
                adoptedFromRunId: options.supersedesRunId,
                continuationMode: 'supersede' as const,
              }
            : {}),
        ...(options?.modelOverrides
          ? {
              modelOverrideLayer: { kind: 'raw' as const, overrides: options.modelOverrides },
            }
          : {}),
        ...(options?.runConfig ? { runConfig: options.runConfig } : {}),
      },
    });
  };
  if (setupOwner) await submitFresh();
  else await withRunLiveOwner(captured.preparedSource.runId, {}, submitFresh);
}
