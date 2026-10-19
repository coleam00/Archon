import { recordWorktreeAdoption } from '@archon/isolation';
import {
  requireTerminalStatusWrite,
  TerminalStatusWriteError,
} from '@archon/workflows/terminal-status-write';
import {
  configureWorktreeIsolation,
  createRunWorktreeSetupExecutor,
  recordSetupRunSource,
  retainSetupRunSource,
} from '@archon/core/workflows/worktree-setup';
import { checkoutSharedEventDataSchema } from '@archon/workflows/schemas/workflow-event';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import { withBranchLaunchSource } from '@archon/core/workflows/branch-launch-source';
import {
  createRegisteredWorktree,
  type RegisteredWorktree,
} from '@archon/core/workflows/registered-worktree';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  type PreparedRunAiConfiguration,
} from '@archon/workflows/run-preflight';
/**
 * Workflow command - list and run workflows
 */

import { getTerminalRecord } from '@archon/workflows/terminal-record';
import { loadConfig } from '@archon/core/config/config-loader';
import { toPersistedMessageMetadata } from '@archon/core/types';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { resolveLaunchRunConfig } from './workflow-run-config';
import type { OverlayMode } from '@archon/workflows/container-context';
import type { IWorkflowEngine, WorkflowRunSubscription } from '@archon/workflows/engine-port';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import type { DashboardWorkflowRun } from '@archon/workflows/schemas/workflow-run-listing';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import {
  WORKFLOW_EVENT_TYPES,
  isDurableWorkflowEventType,
  type WorkflowEventType,
} from '@archon/workflows/store';
import { parseRunModelAssignments } from '@archon/workflows/model-validation';
import { getIsolationProvider } from '@archon/isolation';
import type { ExecutionContext, ContainerBackend } from '@archon/isolation';
import type { TaskBranchSelection } from '@archon/isolation';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import { rmSync } from 'node:fs';
import { createCodebaseChildResolver } from '@archon/core/workflows/child-isolation-resolver';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { waitForRunAttention } from '@archon/core/services/run-attention-watch';
import type { RunWaitResult } from '@archon/core/services/run-attention-watch';
import { startRunLiveOwner } from '@archon/core/services/run-live-owner';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  disposeWorkflowSource,
  prepareWorkflowSource,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
  workflowSourceConfigFrom,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
  type ResolvedContinuation,
} from '@archon/workflows/run-source';
import { resolveTopLevelInputs } from '@archon/workflows/utils/workflow-requirements';
import { parseInputAssignments } from '@archon/workflows/workflow-inputs';
import { formatFixtureReport, runFixtures } from '@archon/workflows/fixture-runner';
import {
  findWorkflowLoadError,
  type WorkflowLoadError,
  type WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import {
  workflowRunStatusSchema,
  runAttention,
  SUBRUN_METADATA_KEYS,
  CONTINUATION_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  ContinuationMode,
} from '@archon/workflows/schemas/workflow-run';
import {
  TERMINAL_WORKFLOW_STATUSES,
  isTerminalRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import {
  CancelRefusedError,
  type CancelWorkflowResult,
  describeAbandonOwner,
  describeReleasedWorktrees,
  assertAnswerAdmissible,
  assertResponseAccepted,
  expectedGateForOccurrence,
  type ApprovalOperationResult,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import { adoptRegisteredWorktree } from '@archon/core/operations/workflow-adoption';
import { attentionQueueSource } from '@archon/core/operations/attention-queue';
import {
  countAttentionQueue,
  listAttentionQueue,
  parseAttentionLabelPairs,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
} from '@archon/workflows/attention-queue';
import * as git from '@archon/git';
import { CLIAdapter } from '../adapters/cli-adapter';
import {
  loadWorkflows,
  projectWorkflowDescription,
  WORKFLOW_DESCRIPTION_TRUNCATION_MARKER,
  type WorkflowJsonEntry,
} from './workflow-list';
import {
  buildNodeSummaries,
  fetchVerboseEvents,
  listRunEvents,
  printVerboseNodes,
  withRunDetail,
} from './workflow-node-summaries';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import { registerOwnedRunTermination } from '../utils/owned-run-termination';
import {
  assertDetachedRunProcessOwner,
  DETACHED_RUN_OWNER_ENV,
} from '../utils/detached-run-control';
import {
  destinationCorrelationId,
  formatAge,
  getLog,
  printJsonWriteError,
  resolveDiscoveryCwdForCodebase,
  resolveRunDestination,
  resolveRunIdArg,
  resolveRunTranscriptPath,
  spelledForCli,
  type WorkflowRunOptions,
} from './workflow-shared';

import { consumeDetachedResumeReceiptRequest } from '../utils/detached-resume-receipt';
import { type OpenToolCalls, presentRunResult, workflowEventLine } from './workflow-run-output';
import {
  TRANSCRIPT_POLL_INTERVAL_MS,
  type TranscriptFormat,
  type TranscriptReadState,
  transcriptOutput,
  drainTranscript,
  finishTranscriptDecode,
  transcriptUnavailableMessage,
} from './workflow-transcript';
import {
  usageLimitWaitLine,
  formatToolAttention,
  formatWaitOutcome,
  announceWaitAttached,
  type LeaveBehind,
  buildLeaveBehind,
  readParseWarningEvents,
  printRunDetail,
} from './workflow-inspect';
import {
  type WorkflowAttentionOptions,
  resolveAttentionRunId,
  attentionScope,
  printAttentionItem,
  workflowAttentionWatch,
} from './workflow-attention';
import {
  recordDetachedChildStartupFailure,
  launchDetachedRun,
  runDetachedControlCommand,
} from './workflow-detach';
import {
  warnBaseOverrideOnReuse,
  assertCodebaseResolvedForIsolation,
  assertNoWorktreeOptionsForFolder,
  assertWorkflowNotWorktreePinnedForFolder,
  resolveRunCodebase,
  assertResumeWorkingPathExists,
  prepareFolderExecution,
  warnOnReusedWorktree,
  readUnresolvedWriteback,
  warnPreservedContainer,
  destroyRunContainer,
} from './workflow-isolation';
import {
  buildNoResumableRunError,
  buildResumeLookupFailureError,
  resolveContinuationDeclaration,
  assertInvocationFlags,
  assertExecutionFlags,
  assertWorktreePolicy,
  resolveCliUserRecordId,
  assertCliWorkflowRequirementsMet,
  maybePrintTierNotice,
  emitParseWarnings,
  emitDeprecationNotice,
  countWorkflowSources,
} from './workflow-run-preflight';
import { runDryRun } from './workflow-dry-run';
import {
  type PendingWaitContinuation,
  type WaitResumeAttempt,
  awaitDurableWaitDeadline,
  buildWaitResumeAttempt,
  isResumeSuperseded,
} from './workflow-wait-continuation';

export interface WorkflowListOptions {
  json?: boolean;
  name?: string;
  full?: boolean;
}

export class WorkflowListLookupError extends Error {
  readonly loadErrors: readonly WorkflowLoadError[];

  constructor(message: string, loadErrors: readonly WorkflowLoadError[]) {
    super(message);
    this.name = 'WorkflowListLookupError';
    this.loadErrors = loadErrors;
  }
}

/**
 * Run every declared dry-run fixture and report per-fixture pass/fail (#2772).
 *
 * Read-only by construction — the only execution path is `dryRunWorkflow`, so no
 * run state is created and no provider is contacted. Returns the process exit code:
 * 0 when everything passes (including the nothing-declared case), 1 when any fixture
 * fails, a workflow cannot load, or an explicitly named target has none.
 */
export async function workflowTestCommand(
  invokingCwd: string,
  target: string | undefined,
  options: { json?: boolean } = {}
): Promise<number> {
  const { resolveDiscoveryCwd } = await import('../utils/project-cwd');
  const cwd = await resolveDiscoveryCwd(invokingCwd);
  const { workflows, errors } = await loadWorkflows(cwd);
  // The fixture runner freezes this repo's source before executing anything, exactly as
  // `workflow run` does, and this config decides which directories get frozen. A malformed
  // one would silently narrow that set, so it fails here instead; `loadConfig` returns
  // defaults when there is simply no config file.
  const config = await loadConfig(cwd).catch((error: unknown) => {
    throw new Error(
      `Cannot read the workflow source configuration in ${cwd}: ${(error as Error).message}`
    );
  });
  let report: Awaited<ReturnType<typeof runFixtures>>;
  try {
    report = await runFixtures({
      workflows,
      cwd,
      targetCwd: invokingCwd,
      sourceConfig: workflowSourceConfigFrom(config),
      ...(target !== undefined ? { target } : {}),
    });
  } catch (error) {
    if (errors.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      await writeJsonLine({
        ok: false,
        error: message,
        errors: errors.map(e => ({
          filename: e.filename,
          error: e.error,
          errorType: e.errorType,
        })),
      });
    } else {
      let output = `Error: ${message}\n`;
      if (errors.length > 0) {
        output += `\n${errors.length} workflow(s) failed to load:\n\n`;
        for (const loadError of errors) {
          output += `  ${loadError.filename}: ${loadError.error}\n`;
        }
      }
      await writeStdout(output);
    }
    return 1;
  }

  if (options.json) {
    await writeJsonLine({
      results: report.results.map(r => ({
        ...r,
        missingStubs: [...r.missingStubs],
        toleratedMissingStubs: [...r.toleratedMissingStubs],
        unusedStubs: [...r.unusedStubs],
      })),
      passed: report.passed,
      failed: report.failed,
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    });
  } else {
    let output = `${formatFixtureReport(report)}\n`;
    if (errors.length > 0) {
      output += `\n${errors.length} workflow(s) failed to load:\n\n`;
      for (const error of errors) {
        output += `  ${error.filename}: ${error.error}\n`;
      }
    }
    await writeStdout(output);
  }

  if (
    errors.length > 0 ||
    report.failed > 0 ||
    (target !== undefined && report.results.length === 0)
  ) {
    return 1;
  }
  return 0;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(
  cwd: string,
  options: WorkflowListOptions = {}
): Promise<void> {
  const { workflows: workflowEntries, errors } = await loadWorkflows(cwd);
  let listedEntries = workflowEntries;
  if (options.name !== undefined) {
    let workflow: WorkflowWithSource['workflow'] | undefined;
    try {
      workflow = resolveWorkflowName(
        options.name,
        workflowEntries.map(entry => entry.workflow)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowListLookupError(message, errors);
    }
    if (workflow === undefined) {
      const availableWorkflows = workflowEntries
        .map(entry => `  - ${entry.workflow.name}`)
        .join('\n');
      throw new WorkflowListLookupError(
        `Workflow '${options.name}' not found.\n\nAvailable workflows:\n${availableWorkflows || '  (none)'}`,
        errors
      );
    }
    listedEntries = workflowEntries.filter(entry => entry.workflow.name === workflow.name);
  }

  if (options.json) {
    const output = {
      // `declared` rather than the expanded workflow: composition collapses these fields
      // onto the nodes and removes them (#1764), so the listing reports what the author
      // wrote. `webSearchMode` is the one that stays on the definition — it has no
      // per-node form to collapse onto.
      workflows: listedEntries.map(
        ({ workflow: w, parseWarnings, declared }): WorkflowJsonEntry => {
          const description = projectWorkflowDescription(w.description, options.full === true);
          const entry: WorkflowJsonEntry = {
            name: w.name,
            description: description.description,
            descriptionTruncated: description.truncated,
          };
          if (declared?.provider !== undefined) entry.provider = declared.provider;
          if (declared?.model !== undefined) entry.model = declared.model;
          if (declared?.effort !== undefined) entry.effort = declared.effort;
          if (w.webSearchMode !== undefined) entry.webSearchMode = w.webSearchMode;
          if (parseWarnings && parseWarnings.length > 0) entry.parseWarnings = [...parseWarnings];
          return entry;
        }
      ),
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    };
    await writeJsonLine(output);
    return;
  }

  console.log(`Discovering workflows in: ${cwd}`);

  if (listedEntries.length === 0 && errors.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  if (listedEntries.length > 0) {
    console.log(`\nFound ${listedEntries.length} workflow(s):\n`);

    for (const { workflow, parseWarnings, declared } of listedEntries) {
      const description = projectWorkflowDescription(workflow.description, options.full === true);
      console.log(`  ${workflow.name}`);
      console.log(
        `    ${description.description}${description.truncated ? WORKFLOW_DESCRIPTION_TRUNCATION_MARKER : ''}`
      );
      if (declared?.provider) {
        console.log(`    Provider: ${declared.provider}`);
      }
      for (const warning of parseWarnings ?? []) {
        console.log(`    Warning: ${warning}`);
      }
      console.log('');
    }
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} workflow(s) failed to load:\n`);
    for (const e of errors) {
      console.log(`  ${e.filename}: ${e.error}`);
    }
    console.log('');
  }
}

/**
 * Run a specific workflow
 */
async function runWorkflowWithOwnedSource(
  host: WorkflowHost,
  owner: CapturedSourceOwner,
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {},
  detachedProcessOwner: boolean,
  notifyResumeAccepted?: (runId: string) => void
): Promise<PendingWaitContinuation | undefined> {
  const effectiveDiscoveryCwd = options.discoveryCwd ?? cwd;
  const modelOverrides = options.modelAssignments
    ? parseRunModelAssignments(options.modelAssignments)
    : undefined;

  // Freeze the source BEFORE discovering, then discover from the frozen copy. Discovering
  // first and capturing after would leave a window where the YAML this run executes and
  // the commands and scripts it calls come from two different moments — the drift the
  // capture exists to remove, reintroduced at the one place nobody would look for it.
  //
  // A dry run creates no run and no artifacts, so it has nothing to freeze into and reads
  // live, exactly as it did before captures existed.
  // Continuing an existing run: discover from the source it recorded, and take no new
  // capture. The MANIFEST supplies the settings those roots resolve under — building them
  // from defaults instead re-discovered a different DAG on any repo with a non-default
  // `commands.folder`, confidently rather than degraded, because a defined-but-default
  // config also suppresses discovery's live-config fallback.
  // Continuation goes through the shared entry point, like chat and web. The CLI used to
  // hand-roll the same load/rebuild/discover sequence: correct at the time, which is the
  // risk — a change to the shared path would silently not reach CLI resume, and that is
  // exactly the shape that produced the mixed-vintage and default-settings bugs.
  //
  // `run <name> --resume` is a continuation too, but it arrives as a flag rather than as a
  // run: its row is only located much further down, where it binds the worktree. That is
  // too late to choose the graph. Resolving it here is what makes every resume form — this
  // flag, `resume <id>`, approve, reject, parent auto-resume — reach the shared entry point
  // with a run in hand, and it also stops the id-based forms re-finding by name a run they
  // already identified exactly (#2645).
  let resumeLookupError: Error | undefined;
  let continuationRun = options.continuationRun;
  if (continuationRun === undefined && options.resume === true) {
    try {
      continuationRun = (await host.deps.store.findResumableRun(workflowName, cwd)) ?? undefined;
    } catch (error) {
      // The resume block below owns the actionable message for a database that cannot
      // answer, and reports the codebase failure first. Nothing executes before it.
      resumeLookupError = error as Error;
    }
  }

  // Before anything reads the run's checkout: codebase resolution on a removed
  // worktree fails with a raw git error that reads as a database fault.
  if (options.resume === true && continuationRun?.working_path) {
    assertResumeWorkingPathExists(continuationRun.working_path);
  }

  let continuation: ResolvedContinuation | undefined;
  if (continuationRun !== undefined) {
    continuation = await resolveContinuationWorkflow(host.deps, continuationRun, cwd);
  }

  // A continuation never captures. With a record it reads that record (above); without
  // one it is a run created before captures existed, and reads live source — the same
  // legacy path the executor takes for it. Capturing here would freeze bytes the run
  // never agreed to and still not make it deterministic.
  const isContinuation = options.resume === true || continuationRun !== undefined;

  const runConfig = await resolveLaunchRunConfig(host, options, cwd, isContinuation);

  // The row a detached parent created before forking (#2872). Loaded up front because
  // it decides the run's identity: the capture is filed under its id, the signal
  // handlers own it, and `executeWorkflow` executes it instead of creating a second
  // row.
  //
  // The flag names a run row this process will execute AS, so three things are checked.
  // Be precise about which one carries the weight, because it is not the first.
  //
  // The owner marker plus `assertDetachedRunProcessOwner` (called by `workflowRunCommand`
  // before it reaches this function) raise the bar, they do not prove provenance: a plain
  // scripted process is not its own process-group leader,
  // so cron, CI, and wrapper scripts are blocked — but a foreground command under a real
  // pseudo-tty IS one by default, so a person setting the env var at their own terminal
  // satisfies it. Treat it as a barrier to automated misuse, not as proof that an Archon
  // parent launched this process.
  //
  // The catastrophic outcomes are closed by the other two, which hold no matter how the
  // first is satisfied. `status === 'pending'` is what stops a stale or mistyped id from
  // loading a TERMINAL row, whose DAG the executor would re-run, appending events onto
  // closed evidence. The `workflow_name` match (checked once the workflow resolves,
  // below) is what stops one launch's row being executed as another workflow. Neither is
  // redundant with the process-group check, and removing either reopens its own outcome.
  let detachedPreCreatedRun: WorkflowRun | undefined;
  if (options.detachedRunId !== undefined) {
    if (!detachedProcessOwner) {
      throw new Error(
        '--internal-detached-run-id is set by a detached launch for its own child. ' +
          'Use `archon workflow run <name> --detach`.'
      );
    }
    detachedPreCreatedRun =
      (await host.deps.store.getWorkflowRun(options.detachedRunId)) ?? undefined;
    if (!detachedPreCreatedRun) {
      throw new Error(
        `Detached workflow child cannot find the run '${options.detachedRunId}' its launcher created.`
      );
    }
    if (detachedPreCreatedRun.status !== 'pending') {
      throw new Error(
        `Cannot execute run '${detachedPreCreatedRun.id}': it is ${detachedPreCreatedRun.status}, ` +
          'not a run awaiting its first execution. Resume it with `archon workflow resume` instead.'
      );
    }
  }

  let preparedSource: PreparedWorkflowSource | undefined;
  // Pinned at the moment of prepare so the SIGINT/SIGTERM cleanup never rm's a
  // path a live run is reading from. For `--container` folder-codebase runs,
  // `finalizeWorkflowSource` (in `prepareFolderExecution`) reassigns `preparedSource` to a
  // new object whose anchor points at the LIVE source directory the run
  // executes from — rm-ing `preparedSource.anchor.root` on Ctrl-C mid-run would
  // destroy the run's source. The original staged path is renamed away by
  // either `finalizeWorkflowSource` (container) or `executeWorkflow`'s rename
  // (everything else), so an `rm` against it is a no-op once prep has moved it.
  let originalStagedRoot: string | undefined;
  if (!isContinuation && !options.dryRun && !options.stubsInitPath) {
    try {
      preparedSource = await prepareWorkflowSource(host.deps, {
        sourceRoot: effectiveDiscoveryCwd,
        // Keep the capture filed under the run it belongs to when the row already exists.
        ...(detachedPreCreatedRun ? { runId: detachedPreCreatedRun.id } : {}),
      });
      // From here the owner reclaims it unless a run adopts it, whichever way we leave.
      owner.hold(preparedSource);
      originalStagedRoot = preparedSource.anchor.root;
    } catch (error) {
      throw new Error(
        `Failed to capture workflow source from ${effectiveDiscoveryCwd}: ${(error as Error).message}`
      );
    }
  }

  // A resolved continuation already discovered over its own roots; reusing that result is
  // what keeps a resume from paying digest verification and full discovery twice.
  // Mutable: without an explicit source, an adopt lane re-freezes and re-discovers
  // from the adopted checkout once its path is known (see recaptureForLane).
  let { workflows: workflowEntries, errors } = continuation
    ? { workflows: continuation.workflows, errors: continuation.errors }
    : preparedSource
      ? await discoverWorkflowsWithConfig(
          cwd,
          host.deps.loadConfig,
          host.deps.providers,
          preparedSource.roots
        )
      : await loadWorkflows(effectiveDiscoveryCwd);
  const sourceCounts = countWorkflowSources(workflowEntries);

  if (!options.json && !options.quiet) {
    console.log(
      `Discovery: root=${effectiveDiscoveryCwd} workflows=${String(workflowEntries.length)} ` +
        `bundled=${String(sourceCounts.bundled)} global=${String(sourceCounts.global)} ` +
        `project=${String(sourceCounts.project)} installed=${String(sourceCounts.installed)}`
    );
  }

  if (workflowEntries.length === 0 && errors.length === 0) {
    // No manual cleanup here or anywhere else in this function: the owner reclaims
    // anything unadopted on the way out, which is the point of having one.
    throw new Error('No workflows found in .archon/workflows/');
  }

  const workflows = workflowEntries.map(ws => ws.workflow);

  // A continuation executes the graph it froze; only a fresh invocation resolves by name.
  let workflow = continuation?.workflow ?? resolveWorkflowName(workflowName, workflows);
  // Recover the discovery entry (dropped by the .map above) for telemetry —
  // bundled workflows report their real name, custom ones report "custom" —
  // and for the parse warnings surfaced just below.
  let workflowEntry = workflow ? workflowEntries.find(ws => ws.workflow === workflow) : undefined;
  let workflowSource = workflowEntry?.source;

  // By default, adoption reads the inherited or freshly cut worktree's `.archon`:
  // the branch may carry a different workflow than the invoking checkout (#2660/#2747).
  // An explicit source instead owns the graph, commands, and scripts for the new run;
  // adoption changes only its execution target. The caller recaptures only the default.
  const recaptureForLane = async (sourceRoot: string): Promise<void> => {
    try {
      const replacement = await prepareWorkflowSource(host.deps, {
        sourceRoot,
        ...(detachedPreCreatedRun ? { runId: detachedPreCreatedRun.id } : {}),
      });
      owner.hold(replacement);
      originalStagedRoot = replacement.anchor.root;
      const stale = preparedSource;
      preparedSource = replacement;
      // Detached recapture replaces the same run directory in place.
      // Remove only a distinct capture so the replacement manifest survives.
      if (stale && stale.anchor.root !== replacement.anchor.root) {
        rmSync(stale.anchor.root, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error(
        `Failed to capture workflow source from ${sourceRoot}: ${(error as Error).message}`
      );
    }
    const rediscovered = await discoverWorkflowsWithConfig(
      sourceRoot,
      host.deps.loadConfig,
      host.deps.providers,
      preparedSource.roots
    );
    workflowEntries = rediscovered.workflows;
    errors = rediscovered.errors;
    workflow = resolveWorkflowName(
      workflowName,
      workflowEntries.map(ws => ws.workflow)
    );
    workflowEntry = workflow ? workflowEntries.find(ws => ws.workflow === workflow) : undefined;
    workflowSource = workflowEntry?.source;
    if (!workflow) {
      const availableWorkflows = workflowEntries.map(ws => `  - ${ws.workflow.name}`).join('\n');
      throw new Error(
        `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
      );
    }
    await recordSelectedWorkflow(preparedSource.anchor.root, workflow.name);
    emitParseWarnings(workflowEntry?.parseWarnings, workflow.name);
    emitDeprecationNotice(workflow);
    // The gates above ran against the parent checkout's YAML; this lane executes the
    // branch's graph, so judge the same signature gates against the branch vintage
    // (mirrors the orchestrator's deferred runSignatureGates).
    if (!options.resume) {
      resolvedInputs = resolveTopLevelInputs(
        workflow,
        options.inputs ? parseInputAssignments(options.inputs) : undefined
      );
    }
    await assertCliWorkflowRequirementsMet(host, workflow);
  };

  // Name the selection in the capture's manifest, now that it is known. The manifest is
  // outside the digest, so this records provenance without disturbing what was frozen.
  if (workflow && preparedSource) {
    await recordSelectedWorkflow(preparedSource.anchor.root, workflow.name);
  }

  if (!workflow) {
    // Check if the requested workflow had a load error
    const loadError = findWorkflowLoadError(errors, workflowName);
    if (loadError) {
      throw new Error(
        `Workflow '${workflowName}' failed to load: ${loadError.error}\n\nFix the YAML file and try again.`
      );
    }
    const availableWorkflows = workflows.map(w => `  - ${w.name}`).join('\n');
    throw new Error(
      `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
    );
  }

  // Second half of the handed-over row's claim check (#2872): the row must belong to the
  // workflow being invoked. Checked here rather than at load because the row carries the
  // RESOLVED name its launcher selected, and resolution needs discovery. It catches an
  // id crossed between two concurrent detached launches, and the narrow window where the
  // child's re-capture resolves a different workflow than the parent did.
  if (detachedPreCreatedRun && detachedPreCreatedRun.workflow_name !== workflow.name) {
    throw new Error(
      `Cannot execute run '${detachedPreCreatedRun.id}': it belongs to workflow ` +
        `'${detachedPreCreatedRun.workflow_name}', not '${workflow.name}'.`
    );
  }

  // Keys this workflow's YAML declares that the engine drops (#2213). Written to
  // stderr, never stdout: in --json mode Pino is silenced and stdout must stay
  // exactly the machine-readable payload, so this is the ONLY channel that
  // reaches an agent driving runs through `--json`. Not gated on --quiet — a
  // dropped key can be a gate the author believes is protecting the run.
  emitParseWarnings(workflowEntry?.parseWarnings, workflow.name);
  emitDeprecationNotice(workflow);

  assertInvocationFlags(options, isContinuation);

  if (options.dryRun) {
    await runDryRun(host, workflow, cwd, userMessage, options, runConfig, modelOverrides);
    return undefined;
  }

  assertExecutionFlags(options);

  // Per-dispatch --base override, normalized once. Wins over repo config + the
  // codebase default for both the worktree cut-from (the provider request's
  // `baseOverride` below) and the PR target / $BASE_BRANCH (executeWorkflow's
  // `baseOverride` opt). Both halves need their own channel: the `baseBranch`
  // field on either side is the codebase-default FALLBACK and ranks below repo
  // config, so routing the flag through it would silently lose to a repo that
  // sets `worktree.baseBranch`.
  const flagBase = options.baseBranch?.trim() || undefined;

  const pinnedEnabled = workflow.worktree?.enabled;
  assertWorktreePolicy(workflow, options);

  // Default to worktree isolation unless --no-worktree or --resume. Workflow YAML
  // `worktree.enabled` pins the decision — mismatches with CLI flags are rejected
  // above, so by this point policy (if set) and flags agree. `--resume` reuses an
  // existing worktree and takes precedence over the pinned policy. Computed here
  // (not at the worktree block below) because --detach also needs it to decide
  // whether to pin a generated branch on the child.
  const flagWantsIsolation = !options.resume && !options.noWorktree;
  // Reassigned by adoption resolution (#2747): adopting a branch whose worktree
  // is gone forces isolation ON to cut a fresh worktree FROM that branch.
  let wantsIsolation =
    !options.resume && pinnedEnabled !== undefined ? pinnedEnabled : flagWantsIsolation;

  // Worktree options require a git repo. When the caller explicitly declares
  // folder intent via --folder, reject --branch/--from and worktree-pinned
  // workflows synchronously (no DB needed). The authoritative kind-based guard
  // for ALREADY-registered folder projects (no --folder flag) lives after the
  // codebase lookup below. Fail fast — never silently ignore the flags.
  assertNoWorktreeOptionsForFolder(options.folder === true, options);
  assertWorkflowNotWorktreePinnedForFolder(options.folder === true, pinnedEnabled, workflow.name);

  // Signature gate (#2470, #2554): resolve this invocation's declared inputs from the
  // `--input name=value` flags against the workflow's `inputs:` block, here — before the
  // --detach fork and any worktree/clone/AI cost — so a bad name, a missing required
  // input, or a malformed assignment costs nothing.
  //
  // Skipped on --resume: the resumable run is not resolved until later in this function,
  // and its inputs were validated when its row was created. Re-gating with nothing
  // supplied would make every resume of a required-input run impossible.
  let resolvedInputs: Record<string, string> | undefined;
  if (!options.resume) {
    resolvedInputs = resolveTopLevelInputs(
      workflow,
      options.inputs ? parseInputAssignments(options.inputs) : undefined
    );
  }

  // Capability gate: hard-fail before the --detach fork and any worktree/clone/
  // AI cost if the workflow declares `requires: [github]` and the acting CLI
  // user hasn't connected. No-op on solo PAT installs. Mirrors the orchestrator
  // gate (dispatchOrchestratorWorkflow) so CLI, REST (via orchestrator), and
  // chat dispatch enforce `requires: [github]` identically.
  await assertCliWorkflowRequirementsMet(host, workflow);

  const cliUserId = await resolveCliUserRecordId(host);
  let aiConfigurationRun: typeof continuationRun;
  const prepareCredentialPreflight = async (
    configCwd: string,
    codebaseId?: string
  ): Promise<PreparedRunAiConfiguration> => {
    if (!workflow) throw new Error('Workflow disappeared before credential preflight');
    const prepared = await prepareRunAiConfiguration(host.deps, workflow, configCwd, {
      codebaseId,
      aiConfigurationRun: detachedPreCreatedRun ?? aiConfigurationRun,
      ...(detachedPreCreatedRun ? { inheritAiConfiguration: true } : {}),
      userId: detachedPreCreatedRun ? (detachedPreCreatedRun.user_id ?? undefined) : cliUserId,
      ...(isContinuation && continuationRun
        ? { continuationRun }
        : {
            runConfig,
            ...(modelOverrides
              ? { modelOverrideLayer: { kind: 'raw' as const, overrides: modelOverrides } }
              : {}),
          }),
    });
    await assertRunCredentials(host.deps, prepared);
    return prepared;
  };

  // --detach: hand the whole run to a detached background child and return now.
  // Done AFTER workflow resolution + flag validation above (so unknown-workflow /
  // bad-flag errors surface synchronously to the caller, not lost in the child)
  // and before any *worktree* work (the child creates the worktree). A read-only
  // codebase lookup does happen here — see the folder-detection probe below —
  // to decide folder-vs-repo branch pinning before forking.
  if (options.detach) {
    const childDestination = await resolveRunDestination(host, options, continuationRun);

    // Everything from here to the fork is the pre-flight (#2872). It exists because
    // a detached launch used to print `Started` before anything that can be refused
    // deterministically had been checked: the child then died on adoption resolution,
    // no run row was ever written, and the only trace was a line inside the child's
    // log. A launch either produces a run id somebody can query, or it fails right
    // here with a non-zero exit. The fork itself has not moved — no worktree, clone,
    // or AI cost happens in this process.
    //
    // The project lookup was a best-effort folder probe; it is now the same resolution
    // the run path performs, because the run row needs `codebase_id` and adoption
    // cannot be judged without it. Registration is idempotent, so the child's own call
    // finds what this one registered.
    const detachResolved = await resolveRunCodebase(host, cwd, options);
    const detachCodebase = detachResolved.codebase;
    // Never on `--json`: stdout carries one machine-readable document and nothing else.
    if (detachResolved.registeredFolder && !options.json) {
      console.log(
        `Registered folder project "${detachResolved.registeredFolder.name}" ` +
          `(${detachResolved.registeredFolder.defaultCwd})`
      );
    }
    // The refusal the plain `run <name> --detach` launch was still missing: an isolating
    // run with no project to isolate. The isolation block enforces it in whichever
    // process reaches it, which for a detached launch is the child — after the parent has
    // already printed `Started` (#2872). `options.noWorktree` first, mirroring the
    // isolation block's own branch order.
    if (!options.noWorktree && wantsIsolation) {
      assertCodebaseResolvedForIsolation(detachResolved);
    }
    // Never pin a worktree branch on the child for a folder project. The --folder flag
    // declares it; an already-registered folder project is read off the resolution.
    const detachIsFolder = options.folder === true || detachCodebase?.kind === 'folder';
    // Surface worktree-option conflicts synchronously in the parent rather than
    // letting the child fail after fork.
    assertNoWorktreeOptionsForFolder(detachIsFolder, options);

    // Between-run continuation (#2747): refuse an unresolvable declaration HERE — this
    // is the exact failure that vanished into a child log. `resolveWorkflowAdoption` is
    // pure resolution with no filesystem or database mutation, so running it as a
    // pre-flight costs nothing and the child still re-resolves it against the live
    // checkout when it starts (its lane binds a worktree this process never touches).
    const declaration = await resolveContinuationDeclaration(host, cwd, options, detachCodebase);
    const detachedAdoptionLane = declaration?.mode === 'adopt' ? declaration.lane : undefined;
    if (declaration?.mode === 'adopt') aiConfigurationRun = declaration.adoptedRun;

    let detachedPrepared: PreparedRunAiConfiguration;
    if (detachedAdoptionLane?.kind === 'checkout-branch' && detachCodebase) {
      detachedPrepared = await withBranchLaunchSource(
        detachCodebase.default_cwd,
        detachedAdoptionLane.taskBranch.branch,
        async snapshot => {
          if (options.discoveryCwd === undefined) await recaptureForLane(snapshot);
          return prepareCredentialPreflight(snapshot, detachCodebase.id);
        }
      );
    } else {
      // A fresh launch reads repo config from the launch checkout, not from a worktree
      // --branch would reuse; the child inherits what this records before the fork.
      const configCwd =
        detachedAdoptionLane?.kind === 'reuse-worktree'
          ? detachedAdoptionLane.environment.working_path
          : (continuationRun?.working_path ?? cwd);
      if (detachedAdoptionLane?.kind === 'reuse-worktree' && options.discoveryCwd === undefined)
        await recaptureForLane(configCwd);
      detachedPrepared = await prepareCredentialPreflight(configCwd, detachCodebase?.id);
    }

    await launchDetachedRun({
      host,
      cwd,
      workflowName,
      userMessage,
      options,
      workflow,
      isContinuation,
      continuationRun,
      resumeLookupError,
      cliUserId,
      codebase: detachCodebase,
      isFolder: detachIsFolder,
      wantsIsolation,
      destination: childDestination,
      declaration,
      prepared: detachedPrepared,
      resolvedInputs,
      runConfig,
    });
    return undefined;
  }

  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  const destination = await resolveRunDestination(host, options, continuationRun);
  const conversationId = destinationCorrelationId(destination);
  const conversation = destination.kind === 'conversation' ? destination.conversation : undefined;
  const adapter = new CLIAdapter({
    recordMessage: conversation
      ? async (_id, message, metadata): Promise<void> => {
          await host.records.messages.addMessage(
            conversation.id,
            'assistant',
            message,
            toPersistedMessageMetadata(metadata)
          );
        }
      : undefined,
  });

  const { codebase, registeredFolder } = await resolveRunCodebase(host, cwd, options);
  if (registeredFolder) {
    console.log(
      `Registered folder project "${registeredFolder.name}" (${registeredFolder.defaultCwd})`
    );
  }

  // Handle isolation (worktree creation)
  let workingCwd = cwd;
  let isolationEnvId: string | undefined;
  // Set only when this invocation created the run's branch (#3305).
  let cutFromCommit: string | undefined;
  let ownedWorktree: import('@archon/workflows/schemas/workflow-run').OwnedWorktree | undefined;
  // Execution context for the run. Repo/worktree and folder-in-place both run on
  // the host; the folder-backend seam sets this and is where `--container` flips
  // it to a container context.
  let execContext: ExecutionContext = { kind: 'host' };
  // Container backend handle for a folder-project container run — held so the CLI
  // tears it down after a TERMINAL run (a PAUSED run keeps its suspended container
  // for resume). The engine drives suspend + the write-back gate through the same
  // backend via `opts.container`; the CLI only prepares/resumes and destroys.
  let containerBackend: ContainerBackend | undefined;
  let containerEnvId: string | undefined;
  // Overlay mode the backend actually mounted (fuse = unprivileged; native =
  // CAP_SYS_ADMIN, gate-bypassable). Threaded to the engine for the H4 run-start warning.
  let containerOverlayMode: OverlayMode | undefined;

  // Between-run continuation (#2747): resolve the declared adoption BEFORE any
  // lane decision — it dictates the lane, fail-loud (never a silent fresh
  // start). Supersede validates existence/terminality only; it deliberately
  // inherits nothing.
  let adoptedFromRunId: string | undefined;
  let adoptedTaskBranch: Extract<TaskBranchSelection, { kind: 'existing' }> | undefined;
  let continuationMode: ContinuationMode | undefined;
  // Set when the adopt lane executes inside a checkout whose `.archon` may differ from
  // this process's cwd — the trigger for recaptureForLane once the path is final.
  let adoptLaneRunsIsolatedCheckout = false;
  const declaration = await resolveContinuationDeclaration(host, cwd, options, codebase);
  if (declaration !== undefined) {
    continuationMode = declaration.mode;
    adoptedFromRunId = declaration.runId;
  }
  if (declaration?.mode === 'adopt' && codebase) {
    const { adoptedRun, lane } = declaration;
    aiConfigurationRun = adoptedRun;
    if (lane.kind === 'reuse-worktree') {
      const env = await adoptRegisteredWorktree(host.records.isolation, lane, codebase.default_cwd);
      workingCwd = env.working_path;
      isolationEnvId = env.id;
      adoptLaneRunsIsolatedCheckout = true;
      // The reuse lane IS the isolation: run in the inherited worktree as-is.
      // Leaving wantsIsolation set would fall through to worktree creation below
      // and silently cut a fresh worktree from base over the inherited one.
      wantsIsolation = false;
      console.log(
        `Adopting run ${adoptedRun.id} — reusing its worktree at ${lane.environment.working_path} (dirty state inherited as-is).`
      );
    } else if (lane.kind === 'checkout-branch') {
      adoptedTaskBranch = lane.taskBranch;
      wantsIsolation = true;
      adoptLaneRunsIsolatedCheckout = true;
      console.log(
        `Adopting run ${adoptedRun.id} — its worktree is gone; checking out its existing branch '${lane.taskBranch.branch}'.`
      );
    } else {
      console.log(
        `Adopting run ${adoptedRun.id} — folder projects run in place; adoption carries provenance and $ADOPTED_RUN_DIR access only.`
      );
    }
  } else if (declaration?.mode === 'supersede') {
    console.log(`Superseding run ${declaration.superseded.id} — fresh lane, provenance recorded.`);
  }

  // Handle --resume: locate the prior failed run, reuse its worktree, and hand
  // the resumed-run handle to executeWorkflow below via opts. The executor no
  // longer performs implicit resume detection on its own.
  let resumable: WorkflowRun | null = null;
  // Branch of the prior run's worktree, from the isolation record the resume path
  // matches. Only a worktree-isolated run has one; the no-completed-nodes refusal
  // names it in the relaunch command it suggests (#3154).
  let resumeBranch: string | undefined;
  if (options.resume) {
    if (!codebase) {
      throw new Error(
        'Cannot resume: Not in a git repository.\n' +
          'Either run from a git repo or use /clone first.'
      );
    }

    if (resumeLookupError) {
      throw buildResumeLookupFailureError(resumeLookupError);
    }
    // Resolved before discovery (top of this function), because the graph this run
    // executes had to be chosen from it.
    resumable = continuationRun ?? null;

    if (!resumable) {
      throw buildNoResumableRunError(workflowName, cwd);
    }

    getLog().info(
      {
        workflowRunId: resumable.id,
        workflowName,
        workingPath: resumable.working_path,
      },
      'workflow.resume_found_resumable'
    );

    // A container run IS resumable (Phase C): the overlay lives on a persisted
    // volume the resume rediscovers and restarts (see the folder branch below,
    // which calls backend.resumeEnv when `resumable.metadata.isolation` is
    // 'container'). Nothing to reject here anymore.

    // Reuse the working path from the resumable run (checked to exist above).
    if (resumable.working_path) {
      workingCwd = resumable.working_path;
    }

    // Look up the isolation environment that owns this working path (if any)
    const allEnvs = await host.records.isolation.listByCodebase(codebase.id);
    const matchingEnv = allEnvs.find(e => e.working_path === workingCwd);
    if (matchingEnv) {
      await recordWorktreeAdoption(host.records.isolation, matchingEnv, codebase.default_cwd);
      isolationEnvId = matchingEnv.id;
      resumeBranch = matchingEnv.branch_name;
      getLog().info(
        { envId: isolationEnvId, workingPath: workingCwd },
        'workflow.resume_env_found'
      );
    }

    console.log(`Resuming workflow run: ${resumable.id}`);
    console.log(`Working path: ${workingCwd}`);
    console.log('');

    // --resume adopts the prior run's worktree, so --base is half-applied here
    // exactly as it is on --branch reuse above: the cut-from is already fixed,
    // but flagBase still rides opts.baseOverride into $BASE_BRANCH.
    if (flagBase) {
      warnBaseOverrideOnReuse(workingCwd, flagBase);
    }
  }

  const existingBranchEnv =
    wantsIsolation && codebase && options.branchName
      ? await host.records.isolation.findActiveByWorkflow(codebase.id, 'task', options.branchName)
      : undefined;
  const preparedAiConfiguration =
    adoptedTaskBranch && codebase
      ? await withBranchLaunchSource(
          codebase.default_cwd,
          adoptedTaskBranch.branch,
          async snapshot => {
            if (options.discoveryCwd === undefined) await recaptureForLane(snapshot);
            return prepareCredentialPreflight(snapshot, codebase.id);
          }
        )
      : await (async (): Promise<PreparedRunAiConfiguration> => {
          if (adoptLaneRunsIsolatedCheckout && options.discoveryCwd === undefined)
            await recaptureForLane(workingCwd);
          // Still the launch checkout (or an adopted run's worktree): repo config comes
          // from where the operator launched, including uncommitted and gitignored edits,
          // even when --branch reuses an existing worktree for the code.
          return prepareCredentialPreflight(workingCwd, codebase?.id);
        })();

  const isFolderCodebase = codebase?.kind === 'folder';

  // Container isolation is folder-project-only in v1. A repo-kind project (or a
  // bare git repo / unregistered non-git cwd) with --container fails fast rather
  // than silently running a worktree/in-place — no surprising isolation downgrade.
  if (options.container && !isFolderCodebase) {
    throw new Error(
      'Container isolation is folder-project-only for now. Run --container against a ' +
        'registered folder project (or add --folder to register this directory as one). ' +
        'Repo projects use worktree isolation.'
    );
  }

  // The codebase's stored default branch, used as the base-branch fallback when
  // repo config sets no worktree.baseBranch (reuse validation, worktree
  // creation, and $BASE_BRANCH resolution all derive from this one value).
  const codebaseDefaultBranch = codebase?.default_branch?.trim() || undefined;

  // Authoritative folder guards for an already-registered folder project run
  // WITHOUT the --folder flag (the flag-based guards above only fire when the
  // caller declared intent). Fail fast before any worktree work.
  assertNoWorktreeOptionsForFolder(isFolderCodebase, options);
  assertWorkflowNotWorktreePinnedForFolder(isFolderCodebase, pinnedEnabled, workflow.name);

  let setupPreparedRun: WorkflowRun | undefined;
  let executionSubmitted = false;
  let runLiveOwner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined = undefined;
  let runLiveOwnerClose: Promise<void> | undefined;
  const closeRunLiveOwner = (): Promise<void> => {
    if (!runLiveOwner) return Promise.resolve();
    runLiveOwnerClose ??= runLiveOwner.close();
    return runLiveOwnerClose;
  };
  try {
    if (isFolderCodebase && codebase) {
      const folder = await prepareFolderExecution({
        host,
        codebase,
        options,
        workflow,
        resumable,
        preparedSource,
        owner,
        workingCwd,
      });
      workingCwd = folder.workingCwd;
      execContext = folder.execContext;
      preparedSource = folder.preparedSource;
      if (folder.container) {
        containerBackend = folder.container.backend;
        containerEnvId = folder.container.envId;
        containerOverlayMode = folder.container.overlayMode;
        isolationEnvId = folder.container.envId;
      }
    } else if (wantsIsolation && codebase) {
      // Auto-generate branch identifier from workflow name + timestamp when --branch not provided
      const branchIdentifier = options.branchName ?? `${workflowName}-${Date.now()}`;

      // Configure isolation with repo config loader (same as orchestrator)
      configureWorktreeIsolation();

      // Check for existing worktree (only when explicit --branch)
      const existingEnv = existingBranchEnv;

      if (existingEnv && (await getIsolationProvider().healthCheck(existingEnv.working_path))) {
        await warnOnReusedWorktree(existingEnv, codebase, options, flagBase, codebaseDefaultBranch);
        await recordWorktreeAdoption(host.records.isolation, existingEnv, codebase.default_cwd);
        workingCwd = existingEnv.working_path;
        isolationEnvId = existingEnv.id;
      } else {
        // Create new worktree
        getLog().info(
          { branch: branchIdentifier, fromBranch: options.fromBranch },
          'worktree_creating'
        );

        let created: RegisteredWorktree;
        try {
          if (!preparedSource)
            throw new Error('Worktree setup requires a captured workflow source');
          runLiveOwner = await startRunLiveOwner(
            detachedPreCreatedRun?.id ?? preparedSource.runId,
            {
              ...(detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
            }
          );
          const setupRun =
            detachedPreCreatedRun ??
            (await host.deps.store.createWorkflowRun({
              id: preparedSource.runId,
              workflow_name: workflow.name,
              origin: {
                ...(conversation ? { conversationId: conversation.id } : {}),
                userId: cliUserId,
              },
              codebase_id: codebase.id,
              user_message: userMessage,
              metadata: {
                [RUN_AI_CONFIGURATION_METADATA_KEY]:
                  preparedAiConfiguration.aiConfigurationSnapshot,
                ...(preparedAiConfiguration.runConfigMetadata
                  ? {
                      [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAiConfiguration.runConfigMetadata,
                    }
                  : {}),
                ...(resolvedInputs ? { [SUBRUN_METADATA_KEYS.inputs]: resolvedInputs } : {}),
                ...(adoptedFromRunId
                  ? { [CONTINUATION_METADATA_KEY]: { mode: continuationMode } }
                  : {}),
              },
              ...(adoptedFromRunId ? { adopted_from_run_id: adoptedFromRunId } : {}),
            }));
          detachedPreCreatedRun = setupRun;
          setupPreparedRun = setupRun;
          preparedSource = await retainSetupRunSource(
            host.deps,
            setupRun,
            preparedSource,
            owner,
            codebase.default_cwd,
            codebase.id
          );
          created = await createRegisteredWorktree(host.records.isolation, {
            request: {
              workflowType: 'task',
              identifier: branchIdentifier,
              taskBranch: adoptedTaskBranch
                ? adoptedTaskBranch
                : options.branchName
                  ? {
                      kind: 'new',
                      branch: git.toBranchName(options.branchName),
                      ...(options.fromBranch?.trim()
                        ? { fromBranch: git.toBranchName(options.fromBranch.trim()) }
                        : {}),
                    }
                  : options.fromBranch?.trim()
                    ? { kind: 'new', fromBranch: git.toBranchName(options.fromBranch.trim()) }
                    : undefined,
              baseBranch: codebaseDefaultBranch
                ? git.toBranchName(codebaseDefaultBranch)
                : undefined,
              baseOverride: flagBase ? git.toBranchName(flagBase) : undefined,
              codebaseId: codebase.id,
              // owner/repo name lets resolveOwnerRepo use the registered identity
              // instead of the _local/<basename> path fallback (#2022, #2227)
              codebaseName: codebase.name,
              canonicalRepoPath: git.toRepoPath(codebase.default_cwd),
              description: `CLI workflow: ${workflowName}`,
            },
            setupExecutor: createRunWorktreeSetupExecutor(
              host.deps,
              setupRun,
              preparedAiConfiguration.config
            ),
            createdByPlatform: 'cli',
          });
        } catch (createError) {
          getLog().error({ err: createError, branch: branchIdentifier }, 'worktree.create_failed');
          throw createError;
        }

        workingCwd = created.env.workingPath;
        isolationEnvId = created.envId;
        ownedWorktree = created.ownedWorktree;
        cutFromCommit = created.cutFromCommit;
        getLog().info({ path: workingCwd }, 'worktree_created');
      }
    } else if (options.noWorktree) {
      getLog().info({ cwd }, 'workflow.running_without_isolation');
    } else if (wantsIsolation) {
      // Isolation was expected (default) but codebase is unavailable — fail fast. The
      // `--detach` pre-flight enforces the same refusal before the fork.
      assertCodebaseResolvedForIsolation({ codebase });
    }

    if (adoptLaneRunsIsolatedCheckout && options.discoveryCwd === undefined && preparedSource) {
      preparedSource = { ...preparedSource, origin: workingCwd };
      if (setupPreparedRun) await recordSetupRunSource(host.deps, setupPreparedRun, preparedSource);
    }

    // Chat-origin runs keep their history; a fresh CLI invocation has no chat record.
    if (conversation !== undefined) {
      // Update conversation with cwd and isolation info
      try {
        await host.records.conversations.updateConversation(conversation.id, {
          cwd: workingCwd,
          codebase_id: codebase?.id ?? null,
          isolation_env_id: isolationEnvId ?? null,
        });
      } catch (error) {
        const err = error as Error;
        throw new Error(`Failed to update conversation: ${err.message}`);
      }

      // Persist user message for Web UI history.
      try {
        await host.records.messages.addMessage(
          conversation.id,
          'user',
          userMessage,
          undefined,
          cliUserId
        );
      } catch (error) {
        getLog().warn(
          { err: error as Error, conversationId: conversation.id },
          'cli_user_message_persist_failed'
        );
      }
    }

    // Graceful-termination guard rails (#1123) settle only THE run this process is
    // driving. The run id is reserved by source capture before a fresh execution and
    // already exists on resume or a detached handoff — never from a conversation-wide
    // "active run" query, which can match a run driven by another process (children
    // share parent_conversation_id).
    const ownedRunId = resumable?.id ?? detachedPreCreatedRun?.id ?? preparedSource?.runId;
    if (ownedRunId === undefined) throw new Error('Workflow execution has no resolved run ID');
    // Set once the settled run's container is kept (paused, or an un-applied write-back),
    // so a signal during the final progress drain does not destroy it.
    let containerPreserved = false;
    const deregisterTermination = registerOwnedRunTermination({
      store: host.deps.store,
      runId: ownedRunId,
      logModule: 'cli.workflow',
      liveOwner: {
        isStopRequested: () => runLiveOwner?.isStopRequested() ?? false,
        close: closeRunLiveOwner,
      },
      endNodeProcessTrees: !detachedProcessOwner,
      teardown: async signal => {
        // Destroy the isolation container so Ctrl-C / SIGTERM doesn't orphan a
        // PRIVILEGED container — the forced exit bypasses the teardown `finally`.
        if (containerBackend && containerEnvId && !containerPreserved) {
          try {
            await containerBackend.destroy(containerEnvId);
          } catch (destroyErr) {
            console.error(
              `\nWARNING: could not remove the isolation container on ${signal}: ` +
                `${(destroyErr as Error).message}. Remove it manually: ` +
                'docker ps -a --filter label=diy.archon.managed=true'
            );
          }
        }
        // Reclaim the staged capture for the same reason: the ownership `finally` —
        // whose whole premise is "whichever way we leave" — never runs. Ctrl-C during
        // isolation resolution or worktree creation would otherwise strand a complete
        // frozen tree.
        //
        // The rm targets the ORIGINAL staged path pinned at prepare time, not
        // `preparedSource.anchor.root` (see `originalStagedRoot`'s note above).
        // For container runs that path was renamed away by `finalizeWorkflowSource`
        // and `preparedSource.anchor.root` is now the LIVE source directory —
        // rm-ing it mid-execution would destroy the run's source.
        if (originalStagedRoot) {
          await disposeWorkflowSource({ captureRoot: originalStagedRoot });
        }
      },
    });

    // One-time-per-version notice when the workflow uses unconfigured tier keywords.
    await maybePrintTierNotice(host, workflow, workingCwd, cliUserId, options.quiet);

    // Notify Web UI that a workflow is dispatching.
    // Mirrors the orchestrator dispatch message structure (category/segment/workflowDispatch),
    // but omits the rocket emoji and "(background)" qualifier since the CLI runs synchronously.
    // In the CLI path there is no separate worker conversation — the CLI itself
    // is both the dispatcher and the executor, so workerConversationId === conversationId.
    try {
      await adapter.sendMessage(conversationId, `Dispatching workflow: **${workflow.name}**`, {
        category: 'workflow_dispatch_status',
        segment: 'new',
        workflowDispatch: { workerConversationId: conversationId, workflowName: workflow.name },
      });
    } catch (dispatchError) {
      getLog().warn(
        { err: dispatchError as Error, conversationId },
        'cli.workflow_dispatch_surface_failed'
      );
    }

    // The lookup-by-(workflowName, cwd) was already done above for worktree-path
    // resolution; reuse that result rather than querying twice.
    const deps = host.deps;
    const engine = host.engine;
    let result: Awaited<ReturnType<IWorkflowEngine['submit']>> | undefined;
    // A genuine container-teardown failure captured in the finally, rethrown AFTER
    // the finally when the run itself succeeded — so a leaked privileged container
    // fails the CLI instead of reporting success + exit 0.
    let containerTeardownError: Error | undefined;
    let progress: WorkflowRunSubscription | undefined;
    try {
      // Progress lines render from the run's committed rows, its sub-runs' included.
      // Subscribed before submit or resume so the run's first row cannot be missed.
      // Progress is output only: a subscription that cannot start never stops the run.
      if (!options.quiet) {
        const openToolCalls: OpenToolCalls = new Map();
        const verbose = options.verbose ?? false;
        try {
          progress = await engine.subscribe(ownedRunId, ({ event }) => {
            const line = workflowEventLine(event, verbose, openToolCalls);
            if (line !== undefined) process.stderr.write(`${line}\n`);
          });
        } catch (subscribeErr) {
          getLog().warn(
            { err: subscribeErr as Error, runId: ownedRunId },
            'cli.workflow_progress_subscribe_failed'
          );
          process.stderr.write(
            `[workflow] Progress output unavailable: ${(subscribeErr as Error).message}\n`
          );
        }
      }
      runLiveOwner ??= await startRunLiveOwner(ownedRunId, {
        ...(detachedProcessOwner ? { detachedProcessPid: process.pid } : {}),
      });
      // Container run context for the engine (Phase C): the write-back backend port +
      // env id + policy. The executor drives suspend-on-pause and the write-back gate
      // through this. Absent for host/in-place runs.
      const containerRunCtx =
        containerBackend && containerEnvId
          ? {
              envId: containerEnvId,
              writeBack: workflow.container?.write_back ?? ('approve' as const),
              backend: containerBackend,
              ...(containerOverlayMode ? { overlayMode: containerOverlayMode } : {}),
            }
          : undefined;
      const resolveChildIsolation = codebase
        ? createCodebaseChildResolver(
            host.records.isolation,
            codebase,
            {
              baseBranch: codebaseDefaultBranch,
              createdByPlatform: 'cli',
              createdByUserId: cliUserId,
            },
            host.deps
          )
        : undefined;
      const commonOptions = {
        codebaseId: codebase?.id,
        source: workflowSource,
        parseWarnings: workflowEntry?.parseWarnings,
        baseBranch: codebaseDefaultBranch,
        baseOverride: flagBase,
        execContext,
        container: containerRunCtx,
        resolveChildIsolation,
      };
      if (options.resume && resumable) {
        let admission: Awaited<ReturnType<IWorkflowEngine['resume']>>;
        try {
          admission = await engine.resume({
            platform: adapter,
            conversationId,
            cwd: workingCwd,
            legacyWorkflow: workflow,
            userMessage,
            run: resumable,
            cursor: options.continuationCursor,
            options: commonOptions,
          });
        } catch (error) {
          // The run is intact; only its resource is busy, so say that and nothing else.
          if (error instanceof WorkflowResourceBusyError)
            throw new Error(`Cannot resume workflow '${workflowName}' now: ${error.message}`, {
              cause: error,
            });
          const err = error as Error;
          getLog().error(
            { err, workflowName, runId: resumable.id },
            'cli.workflow_hydrate_resume_failed'
          );
          throw new Error(
            `Cannot resume workflow '${workflowName}': failed to load prior run state — ${err.message}`,
            { cause: err }
          );
        }
        if (!admission.accepted) {
          // `--branch` is only runnable when the prior run used worktree isolation:
          // folder projects reject worktree options outright, and an in-place repo run
          // cannot be relaunched onto the branch its own checkout holds. A stale-running
          // orphan cannot be superseded until it is released, so name that step first.
          const worktreeBranch = isFolderCodebase ? undefined : resumeBranch;
          const unblock = isTerminalRunStatus(resumable.status)
            ? ''
            : `The run is still marked ${resumable.status}; release it before relaunching:\n` +
              `  archon workflow abandon ${resumable.id}\n`;
          const relaunch = [
            'archon workflow run',
            workflowName,
            ...(worktreeBranch ? ['--branch', worktreeBranch] : []),
            '--supersedes',
            resumable.id,
          ].join(' ');
          throw new Error(
            `Cannot resume: the prior run for '${workflowName}' has no completed nodes and no interactive-loop state.\n` +
              unblock +
              (worktreeBranch
                ? 'Nothing can be skipped, so relaunch on the same branch instead:\n'
                : 'Nothing can be skipped, so start a fresh run instead:\n') +
              `  ${relaunch}`
          );
        }
        notifyResumeAccepted?.(admission.runId);
        result = await admission.settled;
      } else {
        const opts = {
          ...commonOptions,
          // A resume replays the inputs already on its row.
          inputs: resolvedInputs,
          ...(modelOverrides
            ? { modelOverrideLayer: { kind: 'raw' as const, overrides: modelOverrides } }
            : {}),
          ...(runConfig ? { runConfig } : {}),
          preparedAiConfiguration,
          // The frozen source this run executes, captured before the workflow was even
          // selected. A resume ignores it and loads the source recorded on its own row.
          preparedSource,
          capturedSourceOwner: owner,
          // Between-run continuation (#2747): written once onto the fresh row.
          ...(adoptedFromRunId !== undefined ? { adoptedFromRunId, continuationMode } : {}),
          ...(detachedPreCreatedRun ? { preCreatedRun: detachedPreCreatedRun } : {}),
          ...(cutFromCommit !== undefined ? { cutFromCommit } : {}),
          ownedWorktree,
        };
        executionSubmitted = true;
        result = await engine.submit({
          platform: adapter,
          conversationId,
          cwd: workingCwd,
          workflow,
          userMessage,
          origin: {
            ...(conversation ? { conversationId: conversation.id } : {}),
            userId: cliUserId,
          },
          options: opts,
        });
      }
    } finally {
      // Container teardown (Phase C) — in `finally` so a throw from executeWorkflow
      // BEFORE its own try/catch (malformed config, env resolvers, unknown provider)
      // can't orphan a privileged container+volume. A PAUSED run keeps its (already
      // suspended, by the engine) container + volume for resume — destroying it would
      // discard the overlay the resume needs. Every OTHER outcome (completed / failed /
      // cancelled, or a pre-result throw) is terminal for this process → destroy. The
      // write-back apply already ran inside the engine before completion, so a
      // completed run's live-root changes are safe before this teardown removes the
      // volume.
      const runPaused = Boolean(result?.success && 'paused' in result && result.paused);
      // H2 — preserve the container+volume whenever the un-applied overlay is still the
      // only copy of the run's changes: a PAUSED run (awaiting the decision) OR a
      // TERMINAL run whose write-back never resolved (e.g. a partial applyChanges threw
      // → run failed with pending_writeback still un-applied). Destroying then would
      // silently discard the changes despite the "reconcile manually" message. A failed
      // run stays resumable, so `archon workflow resume <id>` re-runs the apply.
      let unresolvedWriteback = false;
      // Kept until the lookup below proves it may go: a signal mid-lookup must not
      // destroy an overlay that may be the only copy of the changes.
      containerPreserved = true;
      if (containerBackend && containerEnvId && !runPaused && result?.workflowRunId) {
        unresolvedWriteback = await readUnresolvedWriteback(
          deps.store,
          result.workflowRunId,
          containerEnvId
        );
      }
      containerPreserved = runPaused || unresolvedWriteback;

      // Renders the rows the run committed since the last poll, up to its settled state.
      // The signal handlers stay registered through it, so a Ctrl-C here still destroys
      // a container this process would destroy below.
      await progress?.close().catch((drainErr: unknown) => {
        getLog().warn(
          { err: drainErr as Error, runId: ownedRunId },
          'cli.workflow_progress_drain_failed'
        );
        process.stderr.write(
          `[workflow] Progress output may be incomplete: ${(drainErr as Error).message}\n`
        );
      });

      // Deregister the signal handlers now that the run's lifecycle is settled
      // (paused / completed / failed, or the throw propagating out of this
      // finally). A signal from here on gets default handling — the destructive
      // failWorkflowRun cleanup must never fire against a settled run (#1123),
      // and removal keeps repeated workflowRunCommand calls in one process from
      // stacking handlers.
      deregisterTermination();

      if (containerBackend && containerEnvId && unresolvedWriteback) {
        warnPreservedContainer(containerEnvId, result?.workflowRunId);
      }
      if (containerBackend && containerEnvId && !containerPreserved) {
        containerTeardownError = await destroyRunContainer(
          deps.store,
          containerBackend,
          containerEnvId,
          result?.workflowRunId
        );
      }
    }

    // A container teardown failure on an otherwise-SUCCESSFUL run must fail the CLI
    // (non-zero exit) — a leaked privileged container is not a success. On a failed
    // run the workflow-failed error below already exits non-zero (the leak was
    // logged loudly above), so don't mask it.
    if (containerTeardownError && result?.success) {
      throw containerTeardownError;
    }

    if (!result) {
      // executeWorkflow threw and it was re-thrown out of the try; this line is
      // unreachable in practice (the throw propagates), but it satisfies the
      // narrowing for the terminal-result checks below.
      throw new Error('Workflow did not produce a result.');
    }

    return await presentRunResult({
      host,
      workflow,
      result,
      adapter,
      conversationId,
      destination,
      detachedProcessOwner,
    });
  } catch (error) {
    if (setupPreparedRun && !executionSubmitted && !(error instanceof TerminalStatusWriteError))
      await requireTerminalStatusWrite(
        host.deps.store.failWorkflowRun(setupPreparedRun.id, (error as Error).message, {
          exitReason: 'launch_failed',
        }),
        { workflowRunId: setupPreparedRun.id, site: 'cli.worktree_setup_failed' }
      );
    throw error;
  } finally {
    await closeRunLiveOwner();
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

  const notifyResumeAccepted = consumeDetachedResumeReceiptRequest((runId, error) => {
    getLog().warn({ err: error, runId }, 'cli.detached_resume_receipt_failed');
  });

  let attempt: WaitResumeAttempt = { cwd, workflowName, userMessage, options };
  for (;;) {
    let pending: PendingWaitContinuation | undefined;
    try {
      // Inside the try so a refused process-group claim still records the `pending` row
      // the launcher handed over (#2872) instead of stranding it.
      if (detachedProcessOwner) assertDetachedRunProcessOwner();
      pending = await withCapturedSource(owner =>
        runWorkflowWithOwnedSource(
          host,
          owner,
          attempt.cwd,
          attempt.workflowName,
          attempt.userMessage,
          attempt.options,
          detachedProcessOwner,
          notifyResumeAccepted
        )
      );
    } catch (error) {
      await recordDetachedChildStartupFailure(host, options.detachedRunId, error as Error);
      if (isResumeSuperseded(error)) {
        getLog().info(
          { runId: attempt.options.continuationRun?.id, workflowName: attempt.workflowName },
          'cli.wait_continuation_superseded'
        );
        // Without this line an approve that lost the claim to `archon serve` reads as a
        // resume that stopped mid-dispatch. The --json contract owns its own stdout.
        const runId = attempt.options.continuationRun?.id;
        if (runId !== undefined && !options.json) {
          console.log(`Run ${runId} is already continuing in another process.`);
        }
        return;
      }
      throw error;
    }
    if (pending === undefined) return;
    if ((await awaitDurableWaitDeadline(host, pending.run.id, pending.wait)) === 'stop') return;
    attempt = await buildWaitResumeAttempt(host, pending.run, pending.destination, pending.wait);
  }
}

/** Show active workflow runs for the current project, or every project with `--all`. */
export async function workflowStatusCommand(
  host: WorkflowHost,
  cwd: string,
  opts: { json?: boolean; verbose?: boolean; rawEvents?: boolean; all?: boolean } = {}
): Promise<void> {
  const { getWorkflowStatus } = host.operations;

  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, cwd }, 'cli.workflow_status_codebase_lookup_failed');
      throw new Error(`Failed to resolve workflow status project: ${err.message}`, { cause: err });
    }
  }

  let runs: DashboardWorkflowRun[];
  try {
    const result = await getWorkflowStatus(codebase ? { codebaseId: codebase.id } : undefined);
    runs = result.runs;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_status_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  const scopeFallback = !opts.all && !codebase;

  if (opts.json) {
    if (!opts.verbose) {
      await writeJsonLine({
        runs: runs.map(run => ({ ...run, attention: runAttention(run) })),
        scopeFallback,
      });
      return;
    }

    const fetchedPerRun = await Promise.all(
      runs.map(run => fetchVerboseEvents(host, run.id, opts.rawEvents ?? false))
    );
    const runsOutput = runs.map((run, i) => {
      const runEvents = fetchedPerRun[i]?.events ?? [];
      return opts.rawEvents
        ? { ...run, attention: runAttention(run), events: runEvents }
        : { ...run, attention: runAttention(run), nodes: buildNodeSummaries(runEvents) };
    });
    await writeJsonLine({ runs: runsOutput, scopeFallback });
    return;
  }

  if (scopeFallback) {
    console.log('(not a registered project — showing all runs)');
  }

  if (runs.length === 0) {
    console.log('No active workflows.');
    return;
  }

  console.log(`\nActive workflows (${runs.length}):\n`);
  for (const run of runs) {
    const age = formatAge(run.started_at);
    console.log(`  ID:     ${run.id}`);
    console.log(`  Name:   ${run.workflow_name}`);
    console.log(`  Path:   ${run.working_path ?? '(none)'}`);
    console.log(`  Status: ${run.status}`);
    const attention = runAttention(run);
    if (attention?.kind === 'stalled_tool_calls') console.log(formatToolAttention(attention));
    if (attention?.kind === 'usage_limit')
      console.log(usageLimitWaitLine(attention.nodeId, attention.resumeAt));
    if (run.outcome) console.log(`  Authored outcome: ${run.outcome}`);
    console.log(`  Age:    ${age}`);
    if (run.active_nodes.length > 0) {
      console.log(
        `  Active node${run.active_nodes.length === 1 ? '' : 's'}: ${run.active_nodes.join(', ')}`
      );
    }

    if (opts.verbose) {
      const { events, failed } = await fetchVerboseEvents(host, run.id, false);
      if (failed) {
        console.log('  (node events unavailable — see logs)');
      }
      printVerboseNodes(events);
    }

    console.log('');
  }
}

/**
 * Block until a run needs attention, loses its owner, or reaches the caller's deadline.
 *
 * The point of the verb: a host that launched a run with `--detach` waits on one
 * command instead of polling `workflow get`. Exit codes describe the COMMAND, not the
 * run — 0 the run said something, 3 the deadline passed with the run still live, 1 the
 * wait itself failed. A `failed` or `cancelled` run is still exit 0 with its status on
 * stdout; mapping run state onto the process exit code would make a legitimately
 * cancelled run look like a broken command.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowWaitCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string,
  timeoutSeconds?: number
): Promise<number> {
  let result: RunWaitResult;
  let resolvedId: string;
  try {
    resolvedId = await resolveRunIdArg(host, runId, cwd);
    result = await waitForRunAttention(host.deps.store, resolvedId, {
      doorbell: host.doorbell,
      // No timeout by default: a wait that ends on its own clock would answer a
      // question only the run can answer.
      ...(timeoutSeconds === undefined ? {} : { deadlineMs: timeoutSeconds * 1000 }),
      onAttached: (observedStatus, ownerLiveness) =>
        announceWaitAttached(resolvedId, observedStatus, json, ownerLiveness),
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_wait_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same contract
    // as `get` and the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: err.message });
      return 1;
    }
    throw new Error(`Failed to wait for workflow run: ${err.message}`);
  }

  if (result.kind === 'not_found') {
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: 'not_found' });
    } else {
      console.log(formatWaitOutcome(resolvedId, result));
    }
    return 1;
  }

  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'wait',
      runId: resolvedId,
      result: result.kind,
      ...(result.kind === 'attention' ? { attention: result.attention } : {}),
      ...(result.kind === 'deadline' || result.kind === 'owner_lost'
        ? { observedStatus: result.observedStatus }
        : {}),
    });
  } else {
    console.log(formatWaitOutcome(resolvedId, result));
  }

  // 3 keeps "the run is still live" distinguishable from both a real answer (0) and a
  // broken wait (1).
  return result.kind === 'deadline' ? 3 : 0;
}

/**
 * The attention queue as typed JSON for answerers outside Archon: the items in scope,
 * how many fall under each project or label value, or the one item a run stands for.
 * Read-only; answering goes through `answer`, `approve`, `reject` or `respond`.
 */
export async function workflowAttentionCommand(
  host: WorkflowHost,
  cwd: string,
  runId: string | undefined,
  opts: WorkflowAttentionOptions
): Promise<number> {
  try {
    if (opts.after !== undefined && !opts.watch)
      throw new Error('workflow attention --after needs --watch');
    if (opts.watch) {
      if (runId !== undefined || opts.sort !== undefined || opts.countBy !== undefined)
        throw new Error('workflow attention --watch takes no run id, --sort or --count-by');
      return await workflowAttentionWatch(host, cwd, opts);
    }
    const source = attentionQueueSource(host.deps.store, host.records.isolation);
    if (runId !== undefined) {
      if (
        opts.project !== undefined ||
        opts.all ||
        opts.labels.length > 0 ||
        opts.sort !== undefined ||
        opts.countBy !== undefined
      )
        throw new Error(
          'workflow attention <run-id> takes no --project, --all, --label, --sort or --count-by'
        );
      const resolvedId = await resolveAttentionRunId(host, runId, cwd);
      const item = await readAttentionQueueItem(source, resolvedId);
      if (item === undefined) {
        if (opts.json)
          await writeJsonLine({ ok: false, runId, action: 'attention', error: 'not_found' });
        else console.log(`Workflow run not found: ${runId}`);
        return 1;
      }
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', runId: resolvedId, item });
      } else if (item === null) {
        console.log(`Run ${resolvedId} needs no attention now.`);
      } else {
        printAttentionItem(item);
      }
      return 0;
    }

    const { labels, order, countBy } = parseAttentionQueueRequest(opts);
    const scope = await attentionScope(host, cwd, opts);
    const items = await listAttentionQueue(source);

    if (countBy !== undefined) {
      const counts = countAttentionQueue(items, { scope, labels, countBy });
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', scope, counts });
        return 0;
      }
      const rows =
        counts.by === 'project'
          ? counts.counts.map(
              entry => [entry.count, entry.project?.name ?? '(no project)'] as const
            )
          : counts.counts.map(
              entry => [entry.count, entry.value ?? `(no '${counts.key}' label)`] as const
            );
      for (const [count, name] of rows) console.log(`  ${String(count).padStart(4)}  ${name}`);
      if (rows.length === 0) console.log('No runs need attention.');
      return 0;
    }

    const selected = selectAttentionQueue(items, { scope, labels, order });
    if (opts.json) {
      await writeJsonLine({ ok: true, action: 'attention', scope, items: selected });
      return 0;
    }
    const where = scope.kind === 'all' ? 'this install' : `project ${scope.project.name}`;
    if (selected.length === 0) {
      console.log(`No runs need attention in ${where}.`);
      return 0;
    }
    console.log(`\n${String(selected.length)} run(s) need attention in ${where}:\n`);
    for (const item of selected) {
      printAttentionItem(item);
      console.log('');
    }
    return 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_attention_failed');
    if (opts.json) {
      await writeJsonLine({
        ok: false,
        ...(runId ? { runId } : {}),
        action: 'attention',
        error: err.message,
      });
      return 1;
    }
    throw new Error(`Failed to read the attention queue: ${err.message}`, { cause: err });
  }
}

/**
 * Merge a label write into the attention wait a run is paused at: `set` pairs replace
 * the same keys, `unset` keys are removed, nothing else changes. Refused when the run is
 * no longer at `occurrence`.
 */
export async function workflowAttentionLabelCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  set: readonly string[],
  unset: readonly string[],
  json: boolean | undefined,
  cwd: string
): Promise<number> {
  try {
    const resolvedId = await resolveAttentionRunId(host, runId, cwd);
    const result = await host.operations.labelAttentionWait(
      resolvedId,
      { occurrence, set: parseAttentionLabelPairs(set), unset },
      { kind: 'operator' },
      'cli'
    );
    if (json) {
      await writeJsonLine({ ok: true, action: 'attention_label', ...result });
    } else {
      const labels = Object.entries(result.labels).map(([key, value]) => `${key}=${value}`);
      console.log(
        `Labeled run ${result.runId} at revision ${String(result.revision)}: ${
          labels.length > 0 ? labels.join(', ') : 'no labels'
        }`
      );
    }
    return 0;
  } catch (error) {
    if (!json) throw error;
    await printJsonWriteError(runId, 'attention_label', error);
    return 1;
  }
}

/** Print or follow one run's append-only JSONL transcript, verbatim or as text, without mutating the run. */
export async function workflowLogsCommand(
  host: WorkflowHost,
  runId: string,
  follow: boolean,
  cwd?: string,
  format: TranscriptFormat = 'jsonl'
): Promise<number> {
  let resolvedId = runId;
  try {
    resolvedId = await resolveRunIdArg(host, runId, cwd);
    let run = await host.deps.store.getWorkflowRun(resolvedId);
    if (!run) {
      await writeStderr(`Workflow run not found: ${runId}\n`);
      return 1;
    }

    const transcriptPath = await resolveRunTranscriptPath(host, run);
    if (!transcriptPath) {
      await writeStderr(`Transcript path is unavailable for workflow run ${run.id}.\n`);
      return 1;
    }

    const state: TranscriptReadState = {
      offset: 0,
      decoder: new TextDecoder(),
      output: transcriptOutput(format),
    };

    if (!follow) {
      const exists = await drainTranscript(transcriptPath, state);
      if (!exists || state.offset === 0) {
        await writeStderr(`${transcriptUnavailableMessage(run, transcriptPath, false)}\n`);
        return 1;
      }
      await finishTranscriptDecode(state);
      return 0;
    }

    await writeStderr(`Following transcript: ${transcriptPath}\n`);
    while (true) {
      await drainTranscript(transcriptPath, state);
      run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) throw new Error(`Workflow run disappeared while following it: ${resolvedId}`);

      if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        await drainTranscript(transcriptPath, state);
        if (state.offset === 0) {
          await writeStderr(`${transcriptUnavailableMessage(run, transcriptPath, true)}\n`);
          return 1;
        }
        await finishTranscriptDecode(state);
        return 0;
      }

      await new Promise<void>(resolvePoll => setTimeout(resolvePoll, TRANSCRIPT_POLL_INTERVAL_MS));
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId: resolvedId }, 'cli.workflow_logs_failed');
    await writeStderr(`Failed to read workflow transcript: ${err.message}\n`);
    return 1;
  }
}

/**
 * Show detail for a single workflow run by ID (any status).
 *
 * Unlike `status` (active runs only), this resolves one run regardless of
 * status — so an agent can answer "did the review pass?" for a completed/failed
 * run. `--verbose` adds the per-node summary; `--json` emits the raw run plus a
 * `nodes` array when verbose (`--events` selects raw event rows instead).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowGetCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  verbose?: boolean,
  cwd?: string,
  rawEvents?: boolean
): Promise<number> {
  let run: WorkflowRun | null;
  try {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    run = await host.deps.store.getWorkflowRun(resolvedId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_get_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same
    // contract as the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, error: err.message });
      return 1;
    }
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }

  if (!run) {
    // Not-found exits non-zero so `get <id> && ...` and CI checks see the
    // failure (the JSON envelope already carries ok:false for parsers).
    if (json) {
      await writeJsonLine({ ok: false, runId, error: 'not_found' });
    } else {
      console.log(`Workflow run not found: ${runId}`);
    }
    return 1;
  }

  // The terminal record is persisted in the event log, including for default get.
  let events: WorkflowEventRow[];
  let terminalRecord;
  try {
    events = await listRunEvents(host, run.id, rawEvents ?? false);
    terminalRecord = getTerminalRecord(run.status, events);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_events_failed');
    if (json) {
      await writeJsonLine({ ok: false, runId: run.id, error: 'workflow_events_unavailable' });
    } else {
      console.log(`Workflow run events unavailable: ${run.id} (see logs)`);
    }
    return 1;
  }

  // Leave-behind view (#2747): what did this run leave, and where. Assembled
  // from existing data — status/outcome, adoption chain, and its artifact file
  // list resolved through the persisted output_root (read-only by contract).
  let leaveBehind: LeaveBehind | undefined;
  try {
    leaveBehind = await buildLeaveBehind(host, run);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_leave_behind_failed');
  }

  let transcriptPath: string | null = null;
  try {
    transcriptPath = await resolveRunTranscriptPath(host, run);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_transcript_failed');
  }

  if (json) {
    if (!verbose) {
      await writeJsonLine({
        ...run,
        transcript_path: transcriptPath,
        terminal_record: terminalRecord,
        ...(leaveBehind ? { leave_behind: leaveBehind } : {}),
      });
      return 0;
    }

    const parseWarnings = readParseWarningEvents(events);
    const output = rawEvents
      ? {
          ...run,
          transcript_path: transcriptPath,
          terminal_record: terminalRecord,
          events,
        }
      : {
          ...run,
          transcript_path: transcriptPath,
          terminal_record: terminalRecord,
          nodes: buildNodeSummaries(events),
          // Keys the engine dropped from this run's YAML (#2213). Surfaced as a
          // named field rather than leaving the caller to scan raw events.
          ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
        };
    await writeJsonLine(output);
    return 0;
  }

  printRunDetail(run, { transcriptPath, terminalRecord, leaveBehind, events, verbose });
  return 0;
}

/**
 * List recent workflow runs for the current project (all statuses, cwd-scoped).
 *
 * Complements `status` (active-only): resolves the codebase from `cwd` the same
 * way `workflow run` does, then lists that project's recent runs of every
 * status. `--all` drops the project scope (lists across all projects);
 * `--status` filters to one status; `--limit` caps the count (default 20).
 * `--json --verbose` adds each run's `nodes` and `attention` (see `withRunDetail`).
 */
export async function workflowRunsCommand(
  host: WorkflowHost,
  cwd: string,
  opts: {
    json?: boolean;
    all?: boolean;
    status?: string;
    limit?: number;
    open?: boolean;
    verbose?: boolean;
  } = {}
): Promise<number> {
  // Open-work inbox (#2747): terminal failed runs nothing has adopted or
  // superseded — the operator's "what ended with work on the table" query.
  // Status-derived v1 semantics; --status/--open are mutually exclusive shapes.
  if (opts.open) {
    if (opts.status) {
      const msg = '--open and --status are mutually exclusive: the inbox is failed runs only.';
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return 1;
      }
      throw new Error(msg);
    }
    let codebase = null;
    if (!opts.all) {
      try {
        codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
      } catch (error) {
        getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
      }
    }
    const runs = await host.deps.store.findOpenWorkRuns({
      codebaseId: opts.all ? undefined : (codebase?.id ?? undefined),
      limit: opts.limit ?? 20,
    });
    if (opts.json) {
      await writeJsonLine({
        runs: opts.verbose ? await withRunDetail(host, runs) : runs,
        total: runs.length,
        scopeFallback: !opts.all && !codebase,
      });
      return 0;
    }
    if (runs.length === 0) {
      console.log('No open workflow runs — nothing ended with work on the table.');
      return 0;
    }
    console.log(`\nOpen work (${String(runs.length)}):\n`);
    for (const run of runs) {
      const outcome = run.outcome ? ` · authored outcome: ${run.outcome}` : '';
      console.log(
        `  ${run.id.slice(0, 8)}  ${run.workflow_name}${outcome}  (${formatAge(run.started_at)})  adopt: workflow run <name> --adopt ${run.id}`
      );
    }
    console.log('');
    return 0;
  }

  let statusFilter: WorkflowRunStatus | undefined;
  if (opts.status) {
    const parsed = workflowRunStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      const msg = `Invalid --status '${opts.status}'. Valid: ${workflowRunStatusSchema.options.join(', ')}.`;
      // --json never throws — emit one parseable {ok:false} line (write-command contract).
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return 1;
      }
      throw new Error(msg);
    }
    statusFilter = parsed.data;
  }

  // Scope to this project by exact registration first, then through the
  // checkout's canonical repository path. This preserves an explicitly
  // registered linked worktree while allowing another linked worktree to share
  // its registered primary checkout. Ordinary clones remain unchanged (#2613).
  // --all opts out of scoping. A lookup failure or an unregistered cwd both
  // fall back to the global list — never a silent wrong-scope (the human path
  // prints an explicit note below).
  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await findCodebaseForCheckoutPath(cwd, host.records.codebases);
    } catch (error) {
      getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
    }
  }
  // listDashboardRuns ignores undefined filters (truthy-guarded WHERE clauses),
  // so pass codebaseId/status straight through — no conditional spread needed.
  const codebaseId = opts.all ? undefined : codebase?.id;

  let result;
  try {
    result = await host.deps.store.listWorkflowRuns({
      codebaseId,
      status: statusFilter,
      limit: opts.limit ?? 20,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_runs_failed');
    if (opts.json) {
      await writeJsonLine({ ok: false, error: err.message });
      return 1;
    }
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  // True when project scoping was requested but fell back to the global list
  // (unregistered cwd or a lookup failure). The human path prints a note below;
  // surface the same signal in --json so an agent isn't handed a global result
  // it silently mistakes for a project-scoped one.
  const scopeFallback = !opts.all && !codebase;

  if (opts.json) {
    if (!opts.verbose) {
      await writeJsonLine({ ...result, scopeFallback });
      return 0;
    }
    // An events-query failure propagates to the CLI's `{ok:false}` handler, as it does
    // on the `--open` path: runs with silently empty `nodes` would read as unstarted.
    await writeJsonLine({ ...result, runs: await withRunDetail(host, result.runs), scopeFallback });
    return 0;
  }

  if (scopeFallback) {
    console.log('(not a registered project — showing all runs)');
  }

  if (result.runs.length === 0) {
    console.log('No workflow runs found.');
    return 0;
  }

  console.log(`\nRecent runs (${result.runs.length} of ${result.total}):\n`);
  for (const run of result.runs) {
    const activeNodes =
      run.active_nodes.length > 0 ? ` · active node(s): ${run.active_nodes.join(', ')}` : '';
    const outcome = run.outcome ? ` · authored outcome: ${run.outcome}` : '';
    console.log(
      `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow_name}${activeNodes}${outcome}  (${formatAge(run.started_at)})`
    );
  }
  console.log('');
  return 0;
}

/**
 * Resume a failed workflow run by ID.
 *
 * Re-executes the workflow with --resume semantics: `workflowRunCommand` locates
 * the prior failed run via findResumableRun and hands it to the executor, which
 * skips already-completed nodes (the executor no longer auto-detects on its own).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowResumeCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<number> {
  const { resumeWorkflow: resumeWorkflowOp } = host.operations;

  // --detach: validate read-only (resumeWorkflowOp checks the run is resumable),
  // then let a detached child re-invoke the blocking resume and own all mutation
  // + execution, so a reaped launching shell can't wedge the run mid-resume.
  // Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'resume', json, cwd, async () => {
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      // The inline path below refuses a run with no recorded working path, or one
      // whose checkout is gone. Check both here too, on the run the precheck already
      // holds: otherwise the parent acks success and the child throws where nobody
      // reads it.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume. The run may be too old.'
        );
      }
      assertResumeWorkingPathExists(run.working_path);
      return run;
    });
  }

  // JSON mode is a non-blocking control-plane ack: validate the run is resumable
  // and report its state, but do NOT re-execute the workflow inline (execution
  // streams workflow output to stdout, which would corrupt the JSON contract).
  // To actually execute a resumable run, use the blocking `resume` (no --json,
  // run as a background task) or `resume <run-id> --detach`. Prefer that exact-id
  // form over `run <name> --resume --detach`, which selects the newest resumable
  // run of that workflow in the CURRENT checkout — a different question, and the
  // wrong one when the caller already holds a run id (#2645).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'resume',
        executed: false,
        status: run.status,
        workflowName: run.workflow_name,
        workingPath: run.working_path,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'resume', error);
      return 1;
    }
    return 0;
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const run = await resumeWorkflowOp(resolvedId, { kind: 'operator' });
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  console.log(`Resuming workflow: ${run.workflow_name}`);
  console.log(`Path: ${run.working_path}`);
  console.log('');

  // Use the codebase's source path for workflow YAML discovery so the file is
  // found even when working_path is a worktree or workspace clone that does
  // not contain the user's local (often untracked) workflow YAML.
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(host, resolvedId, run.codebase_id, 'resume')
    : undefined;

  // Re-execute via workflowRunCommand with --resume: it locates the prior failed
  // run via findResumableRun and skips already-completed nodes (the executor
  // itself no longer auto-detects resumable runs).
  try {
    await workflowRunCommand(host, run.working_path, run.workflow_name, run.user_message ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: run,
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: run.workflow_name },
      'cli.workflow_resume_run_failed'
    );
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`, {
      cause: err,
    });
  }
  return 0;
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 *
 * `--json` emits a structured result instead of human text. In JSON mode the
 * command never throws — lookup/state errors are reported as `{ ok: false }` so
 * a parsing agent always gets one clean JSON line.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowAbandonCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { abandonWorkflow } = host.operations;

  // The container reclaim (M2) and the live-owner stop both live in the shared
  // `abandonWorkflow` op, so EVERY surface does them — the CLI reports the outcome.
  // Keeps `--json` a clean one-line contract (no reclaim text before the payload).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const {
        run,
        cascadeFailures,
        cleanupWarnings,
        releasedWorktrees,
        blockedParentRunId,
        owner,
      } = await abandonWorkflow(resolvedId, { kind: 'operator' });
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'abandon',
        status: 'cancelled',
        workflowName: run.workflow_name,
        owner:
          owner.kind === 'stopped'
            ? { outcome: 'stopped', pid: owner.pid }
            : {
                outcome: 'no_owner_answered',
                thisHost: owner.thisHost,
                recordedHost: owner.recordedOwner?.host ?? null,
                recordedPid: owner.recordedOwner?.pid ?? null,
                recordedUid: owner.recordedOwner?.uid ?? null,
                lastActivityAt: owner.lastActivityAt?.toISOString() ?? null,
              },
        ...(releasedWorktrees ? { releasedWorktrees } : {}),
        ...(cleanupWarnings ? { cleanupWarnings } : {}),
        ...(cascadeFailures > 0 ? { cascadeFailures } : {}),
        ...(blockedParentRunId ? { blockedParentRunId } : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'abandon', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const { run, cascadeFailures, cleanupWarnings, releasedWorktrees, blockedParentRunId, owner } =
    await abandonWorkflow(resolvedId, { kind: 'operator' });
  for (const line of describeAbandonOwner(owner)) console.log(line);
  console.log(`Abandoned workflow run: ${resolvedId}`);
  console.log(`Workflow: ${run.workflow_name}`);
  for (const line of describeReleasedWorktrees(releasedWorktrees)) console.log(line);
  for (const warning of cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(cascadeFailures, blockedParentRunId);
  return 0;
}

function printRunTreeCancellationWarnings(
  cascadeFailures: number,
  blockedParentRunId: string | null
): void {
  if (cascadeFailures > 0) {
    console.log(
      `Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`archon workflow status\`.`
    );
  }
  if (blockedParentRunId) {
    console.log(
      `Warning: parent run ${blockedParentRunId} was blocked on this sub-run and stays paused.`
    );
    console.log(
      `  Resume it so it reads this sub-run's outcome (archon workflow resume ${blockedParentRunId}) or abandon it too.`
    );
  }
}

/**
 * Cancel a running run through the shared `cancelWorkflow` op.
 *
 * Ordering is the contract: prove the live exact-run owner, terminate its process
 * tree, then record `cancelled`. An unreachable owner never falls back to a DB-only
 * transition — the refusal points at `abandon` for an orphan the operator has verified.
 */
export async function workflowCancelCommand(
  host: WorkflowHost,
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const { cancelWorkflow } = host.operations;

  const cancel = async (): Promise<{ resolvedId: string; result: CancelWorkflowResult }> => {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    try {
      const result = await cancelWorkflow(resolvedId, { kind: 'operator' });
      if (result.kind === 'cooperative' && !result.cancelled) {
        throw new Error(`Workflow run ${resolvedId} already finished; nothing to cancel.`);
      }
      return { resolvedId, result };
    } catch (error) {
      if (error instanceof CancelRefusedError && error.reason === 'no_owner_answered') {
        throw new Error(`${error.message}\nAbandon it: archon workflow abandon ${resolvedId}`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  if (json) {
    try {
      const { resolvedId, result } = await cancel();
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'cancel',
        status: 'cancelled',
        processStopped: result.kind === 'stopped',
        workflowName: result.run.workflow_name,
        ...(result.kind === 'stopped' && result.cleanupWarnings
          ? { cleanupWarnings: result.cleanupWarnings }
          : {}),
        ...(result.kind === 'stopped' && result.cascadeFailures > 0
          ? { cascadeFailures: result.cascadeFailures }
          : {}),
        ...(result.kind === 'stopped' && result.blockedParentRunId
          ? { blockedParentRunId: result.blockedParentRunId }
          : {}),
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'cancel', error);
      return 1;
    }
  }

  const { resolvedId, result } = await cancel();
  if (result.kind === 'cooperative') {
    console.log(`Cancelled workflow run: ${resolvedId}`);
    console.log(`Workflow: ${result.run.workflow_name}`);
    console.log("It runs inside its parent run's process and stops at its next status check.");
    return 0;
  }
  console.log(`Cancelled detached workflow run: ${resolvedId}`);
  console.log(`Workflow: ${result.run.workflow_name}`);
  console.log('Host process tree stopped before run state was changed.');
  for (const warning of result.cleanupWarnings ?? []) console.log(`Warning: ${warning}`);
  printRunTreeCancellationWarnings(result.cascadeFailures, result.blockedParentRunId);
  return 0;
}

/**
 * The origin a CLI answer records. `--occurrence` refuses the answer unless the run is
 * still paused at that occurrence, read the way run-attention reports it.
 */
async function cliAnswerOrigin(
  host: WorkflowHost,
  runId: string,
  occurrence: string | undefined
): Promise<GateAnswerOrigin> {
  if (occurrence === undefined) return { via: 'cli' };
  const run = await host.deps.store.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}`);
  return cliOriginForRun(run, occurrence);
}

function cliOriginForRun(run: WorkflowRun, occurrence: string | undefined): GateAnswerOrigin {
  return occurrence === undefined
    ? { via: 'cli' }
    : { via: 'cli', expectedGate: expectedGateForOccurrence(run, occurrence) };
}

/**
 * Continue a run in this process right after this process recorded its answer, the way
 * the CLI's answering commands do outside `--json`. A continuation host may claim the
 * answer first; `workflowRunCommand` reports that and returns.
 */
async function continueAnsweredRun(
  host: WorkflowHost,
  resolvedId: string,
  result: Pick<
    ApprovalOperationResult,
    'workflowName' | 'userMessage' | 'codebaseId' | 'conversationId'
  >,
  workingPath: string,
  action: 'approve' | 'reject' | 'respond' | 'answer',
  failure: { failurePrefix: string; recorded: string }
): Promise<void> {
  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = result.conversationId
      ? await host.records.conversations.getConversationById(result.conversationId)
      : null;
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        `cli.workflow_${action}_conversation_not_found`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      `cli.workflow_${action}_conversation_lookup_failed`
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(host, resolvedId, result.codebaseId, action)
      : undefined;

    await workflowRunCommand(host, workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await host.deps.store.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.cause instanceof WorkflowResourceBusyError &&
      error.cause.refusal === 'waiting'
    ) {
      console.log(
        `The answer was recorded. Workflow '${result.workflowName}' is waiting for capacity and continues when a slot frees.\n` +
          error.cause.message
      );
      return;
    }
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      `cli.workflow_${action}_resume_failed`
    );
    throw new Error(
      `${failure.failurePrefix} failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The ${failure.recorded} was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Answer a paused attention wait in its declared form: `choose` holds declared option ids,
 * `text` the free text. `occurrence` is required, so an answer prepared for an earlier
 * pause is refused. Like approve, `--json` records the answer for a continuation host;
 * otherwise this process continues the run inline.
 */
export async function workflowAnswerCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  choose: readonly string[],
  text: string | undefined,
  json?: boolean,
  cwd?: string
): Promise<number> {
  const request = { choose, ...(text !== undefined ? { text } : {}) };
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await host.operations.answerWorkflow(
        resolvedId,
        request,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'answer',
        answer: result.answer,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'answer', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    host.operations.answerWorkflow(
      resolvedId,
      request,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );
  const { workingPath } = result;
  if (!workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Answered workflow: ${result.workflowName}`);
  console.log(`Path: ${workingPath}`);
  console.log('');
  console.log('Resuming workflow...');
  await continueAnsweredRun(host, resolvedId, result, workingPath, 'answer', {
    failurePrefix: 'Answer recorded but',
    recorded: 'answer',
  });
  return 0;
}

/**
 * Approve a paused workflow run by ID.
 *
 * Human mode records the approval on the still-'paused' run (the resolution
 * lives in metadata.approval.resolved, #2075) and then auto-resumes the run
 * inline. `--json` mode records the approval and returns a structured ack
 * WITHOUT resuming (inline resume would stream output and break the JSON); the
 * answered gate is then a due continuation that `archon serve` or `workflow wake`
 * continues.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowApproveCommand(
  host: WorkflowHost,
  runId: string,
  comment?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { approveWorkflow } = host.operations;

  // --detach: hand the approve AND its inline auto-resume to a detached child
  // (same argv minus --detach/--json). Handled BEFORE any state change — the
  // parent only validates read-only, so the approval is recorded exactly once,
  // in the child. Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'approve', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates approveWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'approve', comment);
      // The child always auto-resumes after approving, and the inline path below
      // refuses a run with no recorded working path. Same check here (message
      // copied verbatim) so the refusal is synchronous instead of buried in a log.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the approval and returns a structured ack WITHOUT the
  // inline auto-resume (resuming executes the workflow and streams output to
  // stdout, which would corrupt the JSON contract). The answered gate is a due
  // continuation, so a continuation host (`archon serve`, `workflow wake`) continues it.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await approveWorkflow(
        resolvedId,
        comment,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'approve',
        type: result.type,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'approve', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    approveWorkflow(
      resolvedId,
      comment,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  // CLI auto-resumes after approval, as chat does since #2565. `--json` (handled
  // above) is the one surface that records the decision without continuing.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Approved workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'approve', {
    failurePrefix: 'Approved but',
    recorded: 'approval',
  });
  return 0;
}

/**
 * Reject a paused workflow run by ID.
 * If the workflow has an on_reject prompt, auto-resumes with the rejection feedback;
 * otherwise marks the run as cancelled.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRejectCommand(
  host: WorkflowHost,
  runId: string,
  reason?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { rejectWorkflow } = host.operations;

  // --detach: hand the reject AND its inline on_reject rework to a detached child,
  // exactly as approve does. Without it, reject hosts the executor in the calling
  // shell — a reaped shell (harness task, closed terminal) leaves the run wedged
  // mid-rework. The parent only validates read-only. Composes with --json.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'reject', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gates rejectWorkflow enforces, in the same order — not a copy of
      // one branch of them. A partial copy acks { ok: true } and lets the child die unseen.
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, 'reject', reason);
      return run;
    });
  }

  // JSON mode records the rejection and returns a structured ack WITHOUT the
  // inline auto-resume (an on_reject rework executes the workflow and streams
  // to stdout, corrupting the JSON contract). When `cancelled` is false the answered
  // gate is a due continuation that a continuation host picks up, except on a container
  // run (including its write-back gate), which needs a manual `resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await rejectWorkflow(
        resolvedId,
        reason,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'reject',
        cancelled: result.cancelled,
        maxAttemptsReached: result.maxAttemptsReached,
        workflowName: result.workflowName,
        resumable: !result.cancelled,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'reject', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    rejectWorkflow(
      resolvedId,
      reason,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return 0;
  }

  // Not cancelled = a legacy on_reject rework, a #2707 step-1 new-mode
  // resolution, or a container write-back reject (discard the overlay). All
  // three auto-resume; the resume drives the rework / continuation / the
  // overlay discard + completion.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Rejected workflow: ${result.workflowName}`);
  console.log(
    result.writeBack
      ? 'Discarding container changes (live folder left untouched)...'
      : result.newMode
        ? 'Resuming...'
        : 'Resuming with on_reject prompt...'
  );

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'reject', {
    failurePrefix: 'Rejected but',
    recorded: 'rejection',
  });
  return 0;
}

/**
 * Resolve a paused workflow run with any of its gate's declared decisions (#2707 step 2).
 * `approve`/`reject` delegate to the existing commands' exact behavior (the general-purpose
 * function underneath is the same `respondToWorkflow`, which is sugar over
 * `approveWorkflow`/`rejectWorkflow` for those two ids); any other declared decision always
 * resolves immediately and auto-resumes, mirroring `approve`'s shape.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRespondCommand(
  host: WorkflowHost,
  runId: string,
  decision: string,
  text?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean,
  occurrence?: string
): Promise<number> {
  const { respondToWorkflow } = host.operations;

  if (decision === 'approve')
    return workflowApproveCommand(host, runId, text, json, cwd, detach, occurrence);
  if (decision === 'reject')
    return workflowRejectCommand(host, runId, text, json, cwd, detach, occurrence);

  // --detach: same shape as approve/reject — the parent validates read-only via the
  // SAME gate respondToWorkflow enforces, then hands the whole command to a detached
  // child. See runDetachedControlCommand's doc comment.
  if (detach) {
    const resolvedId = await resolveRunIdArg(host, runId, cwd);
    return runDetachedControlCommand(resolvedId, 'respond', json, cwd, async () => {
      const run = await host.deps.store.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      assertAnswerAdmissible(run, cliOriginForRun(run, occurrence));
      assertResponseAccepted(run, decision, text);
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
  }

  // JSON mode records the decision and returns a structured ack WITHOUT the inline
  // auto-resume, mirroring approve/reject; a continuation host continues the answered gate.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(host, runId, cwd);
      const result = await respondToWorkflow(
        resolvedId,
        decision,
        text,
        { kind: 'operator' },
        await cliAnswerOrigin(host, resolvedId, occurrence)
      );
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'respond',
        decision,
        workflowName: result.workflowName,
        resumable: true,
      });
      return 0;
    } catch (error) {
      await printJsonWriteError(runId, 'respond', error);
      return 1;
    }
  }

  const resolvedId = await resolveRunIdArg(host, runId, cwd);
  const result = await spelledForCli(async () =>
    respondToWorkflow(
      resolvedId,
      decision,
      text,
      { kind: 'operator' },
      await cliAnswerOrigin(host, resolvedId, occurrence)
    )
  );

  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Responded '${decision}' to workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  await continueAnsweredRun(host, resolvedId, result, result.workingPath, 'respond', {
    failurePrefix: 'Response recorded but',
    recorded: 'response',
  });
  return 0;
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter rules:
 *   - workflow-name required (positional)
 *   - --scope <key>: restrict to one scope (e.g. a conversation UUID); when
 *     omitted, deletes across ALL scopes (use --yes to skip the confirmation)
 *   - --node <id>: restrict to one node within the scope
 *   - --json: machine-readable output
 */
export async function workflowResetSessionsCommand(
  host: WorkflowHost,
  workflowName: string,
  options: { scope?: string; node?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const { resetWorkflowNodeSessions } = host.operations;

  if (!options.scope && !options.yes) {
    throw new Error(
      `Refusing to delete every persisted session for workflow '${workflowName}' across all scopes without confirmation.\n` +
        'Pass --scope <key> to narrow, or --yes to confirm cross-scope reset.'
    );
  }
  try {
    const { deleted } = await resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: options.scope,
      node_id: options.node,
    });
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })}\n`
      );
    } else if (deleted === 0) {
      console.log(`No persisted sessions matched for workflow '${workflowName}'.`);
    } else {
      const scope = options.scope ? ` in scope '${options.scope}'` : ' across all scopes';
      const node = options.node ? ` for node '${options.node}'` : '';
      console.log(
        `Deleted ${deleted} persisted session(s) for workflow '${workflowName}'${node}${scope}.`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, ...options }, 'cli.workflow_reset_sessions_failed');
    throw new Error(`Failed to reset workflow sessions: ${err.message}`);
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(host: WorkflowHost, days: number): Promise<void> {
  let deleted: number | undefined;
  try {
    const { count } = await host.deps.store.deleteOldWorkflowRuns(days);
    deleted = count;
    const { count: revisions } = await host.deps.store.pruneStateRevisions(days);
    console.log(`Pruned ${revisions} state revision(s) older than ${days} days.`);
    if (count === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      console.log(`Deleted ${count} workflow run(s) older than ${days} days.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days, deleted }, 'cli.workflow_cleanup_failed');
    if (deleted !== undefined)
      throw new Error(
        `Deleted ${deleted} workflow run(s) older than ${days} days, but failed to prune state revisions: ${err.message}`,
        { cause: error }
      );
    throw new Error(`Failed to clean up workflow history: ${err.message}`, { cause: error });
  }
}

export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Emit a workflow event directly to the database.
 * Required event writes propagate storage failures; ordinary observability remains best-effort.
 */
export async function workflowEventEmitCommand(
  host: WorkflowHost,
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  const resolvedId = await resolveRunIdArg(host, runId, cwd, true);
  const store = host.deps.store;
  if (eventType === 'workflow.checkout_shared') {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data: checkoutSharedEventDataSchema.parse(data),
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  if (isDurableWorkflowEventType(eventType)) {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data,
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  await store.createWorkflowEvent({
    workflow_run_id: resolvedId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${resolvedId}`);
}
