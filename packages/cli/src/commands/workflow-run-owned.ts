import { OwnedRunLease } from '../utils/owned-run-lease';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { withCapturedSource } from '@archon/workflows/run-source';
import {
  claimDetachedRunProcessOwner,
  DETACHED_RUN_OWNER_ENV,
  DETACHED_LAUNCH_TOKEN_ENV,
} from '../utils/detached-run-control';
import { consumeDetachedResumeReceiptRequest } from '../utils/detached-resume-receipt';
import { getLog, type WorkflowRunOptions } from './workflow-shared';
import { recordDetachedChildStartupFailure } from './workflow-detach';
import { runDryRun } from './workflow-dry-run';
import {
  type PendingWaitContinuation,
  type WaitResumeAttempt,
  awaitDurableWaitDeadline,
  buildWaitResumeAttempt,
  isResumeSuperseded,
} from './workflow-wait-continuation';
import {
  admitRunExecution,
  selectRunWorkflow,
  type OwnedRunRequest,
} from './workflow-run-admission';
import {
  defersContainerResume,
  launchDetachedOwnedRun,
  prepareForegroundLaunch,
  provisionWorkspace,
  recordConversationLaunch,
} from './workflow-run-launch';
import { executeOwnedRun } from './workflow-run-execution';
import { pinnedInPlace, runDefinitionsPlan } from './workflow-run-definitions';
import {
  DefinitionSourceError,
  withLayeredDefinitions,
} from '@archon/core/workflows/definition-source';

/**
 * A dry run reads the definitions the real run would: the base branch with the checkout's
 * uncommitted changes on top, composed for the length of the dry run, unless the run reads
 * a directory as it is (an explicit source, an in-place or folder run) or its workflow
 * pins itself in place. It refuses what the real start refuses.
 */
async function previewRun(request: OwnedRunRequest): Promise<void> {
  const { host, cwd, userMessage, options, workflowName } = request;
  const preview = async (previewRoot: string | undefined): Promise<'done' | 'in-place'> => {
    const selection = await selectRunWorkflow({ ...request, previewRoot });
    const { workflow, runConfig, modelOverrides } = selection;
    if (previewRoot !== undefined && workflow.worktree?.enabled === false) return 'in-place';
    await runDryRun(
      host,
      workflow,
      cwd,
      userMessage,
      options,
      runConfig,
      modelOverrides,
      previewRoot
    );
    return 'done';
  };
  // The same selection as the real start: registered project, item landing branch, and
  // the same refusals. `--workflow-source` is the way to preview without them.
  const plan = await runDefinitionsPlan(host, cwd, options);
  if (plan.kind === 'directory') {
    await preview(undefined);
    return;
  }
  let outcome: 'done' | 'in-place';
  try {
    outcome = await withLayeredDefinitions(plan, composed => preview(composed.root));
  } catch (error) {
    if (
      !(error instanceof DefinitionSourceError) ||
      !(await pinnedInPlace(host, cwd, workflowName))
    )
      throw error;
    outcome = 'in-place';
  }
  if (outcome === 'in-place') await preview(undefined);
}

/**
 * One attempt of a run, under an owner that reclaims its captured source unless the run
 * adopts it: select the workflow from frozen source, admit it, then either fork a detached
 * child or launch, provision, and execute here.
 */
async function runWorkflowWithOwnedSource(
  request: OwnedRunRequest
): Promise<PendingWaitContinuation | undefined> {
  const { host, options } = request;
  if (options.dryRun) {
    await previewRun(request);
    return undefined;
  }
  const selection = await selectRunWorkflow(request);
  const admission = await admitRunExecution(request, selection);
  if (options.detach) {
    await launchDetachedOwnedRun(request, admission);
    return undefined;
  }

  const launch = await prepareForegroundLaunch(request, admission);
  const lease = new OwnedRunLease(request.detachedProcessOwner);
  try {
    // A detached launcher's row is pending with no owner until this lease starts. Read it
    // again under the lease: `workflow cancel` holds the same lock while it records a
    // pending run cancelled, so a run cancelled before this point gets no checkout.
    if (admission.preCreatedRun) {
      await lease.start(admission.preCreatedRun.id);
      const row = await host.deps.store.getWorkflowRun(admission.preCreatedRun.id);
      if (row?.status !== 'pending') {
        throw new Error(
          `Cannot execute run '${admission.preCreatedRun.id}': it is ${row?.status ?? 'missing'}, ` +
            'not a run awaiting its first execution.'
        );
      }
    }
    if (!defersContainerResume(launch)) {
      await provisionWorkspace(launch, lease);
      await recordConversationLaunch(launch);
    }
    return await executeOwnedRun(launch, lease);
  } catch (error) {
    await lease.failUnsubmittedSetupRun(host, error);
    throw error;
  } finally {
    await lease.close();
  }
}

/**
 * Run a specific workflow.
 *
 * A thin owner around the implementation: whatever the run does with its captured source,
 * the capture is either adopted by a run or reclaimed. The implementation has a dozen
 * ordinary ways out — unknown workflow, refused inputs, flag conflicts, a detached
 * dispatch — and asking each to remember a disposal call is how most of them did not.
 *
 * When the attempt pauses on a durable `time`/`event` wait, this command owns the
 * run's deadline: it sleeps until `metadata.wait.resumeAt` and re-executes through
 * the same continuation path `archon workflow resume` uses. That is what makes a
 * CLI-only install able to finish a wait without `archon serve`. The pause itself is
 * unchanged — the row stays `paused` and the live owner is released between segments
 * — so another host can still take the run and this loop then stops.
 */
export async function workflowRunCommand(
  host: WorkflowHost,
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void> {
  // Read the marker once, before any provider or bash subprocess can inherit it: every
  // attempt in this process is the detached owner, and a resumed segment must keep its
  // active-stop lease (`archon workflow cancel`) and detached failure exit code.
  const detachedProcessOwner = process.env[DETACHED_RUN_OWNER_ENV] === '1';
  if (detachedProcessOwner) Reflect.deleteProperty(process.env, DETACHED_RUN_OWNER_ENV);

  const launchToken = process.env[DETACHED_LAUNCH_TOKEN_ENV];
  Reflect.deleteProperty(process.env, DETACHED_LAUNCH_TOKEN_ENV);

  const notifyResumeAccepted = consumeDetachedResumeReceiptRequest((runId, error) => {
    getLog().warn({ err: error, runId }, 'cli.detached_resume_receipt_failed');
  });

  const processClaim = detachedProcessOwner ? claimDetachedRunProcessOwner() : undefined;
  let attempt: WaitResumeAttempt = { cwd, workflowName, userMessage, options };
  for (;;) {
    let pending: PendingWaitContinuation | undefined;
    try {
      await processClaim;
      pending = await withCapturedSource(owner =>
        runWorkflowWithOwnedSource({
          host,
          owner,
          ...attempt,
          detachedProcessOwner,
          launchToken,
          notifyResumeAccepted,
        })
      );
    } catch (error) {
      await recordDetachedChildStartupFailure(
        host,
        {
          detachedRunId: options.detachedRunId,
          detachedProcessOwner,
          launchToken,
        },
        error as Error
      );
      if (isResumeSuperseded(error)) {
        reportSupersededResume(attempt, options.json);
        return;
      }
      throw error;
    }
    if (pending === undefined) return;
    if ((await awaitDurableWaitDeadline(host, pending.run.id, pending.wait)) === 'stop') return;
    attempt = await buildWaitResumeAttempt(host, pending.run, pending.destination, pending.wait);
  }
}

function reportSupersededResume(attempt: WaitResumeAttempt, json: boolean | undefined): void {
  getLog().info(
    { runId: attempt.options.continuationRun?.id, workflowName: attempt.workflowName },
    'cli.wait_continuation_superseded'
  );
  // Without this line an approve that lost the claim to `archon serve` reads as a
  // resume that stopped mid-dispatch. The --json contract owns its own stdout.
  const runId = attempt.options.continuationRun?.id;
  if (runId !== undefined && !json) {
    console.log(`Run ${runId} is already continuing in another process.`);
  }
}
