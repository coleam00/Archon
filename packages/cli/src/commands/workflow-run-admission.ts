import { rmSync } from 'node:fs';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import { withBranchLaunchSource } from '@archon/core/workflows/branch-launch-source';
import {
  parseRunModelAssignments,
  type RunModelOverrides,
} from '@archon/workflows/model-validation';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  type PreparedRunAiConfiguration,
} from '@archon/workflows/run-preflight';
import {
  prepareWorkflowSource,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
  type ResolvedContinuation,
} from '@archon/workflows/run-source';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { resolveTopLevelInputs } from '@archon/workflows/utils/workflow-requirements';
import { parseInputAssignments } from '@archon/workflows/workflow-inputs';
import {
  findWorkflowLoadError,
  type ResolvedWorkflow,
  type WorkflowLoadError,
  type WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { DETACHED_LAUNCH_METADATA_KEY } from '@archon/workflows/store';
import { loadWorkflows } from './workflow-list';
import { resolveLaunchRunConfig } from './workflow-run-config';
import { assertInheritedWorkflowCodebase, type WorkflowRunOptions } from './workflow-shared';
import {
  assertNoWorktreeOptionsForFolder,
  assertResumeWorkingPathExists,
  assertWorkflowNotWorktreePinnedForFolder,
} from './workflow-isolation';
import {
  assertCliWorkflowRequirementsMet,
  assertExecutionFlags,
  assertInvocationFlags,
  assertWorktreePolicy,
  countWorkflowSources,
  emitDeprecationNotice,
  emitParseWarnings,
  resolveCliUserRecordId,
} from './workflow-run-preflight';

/** One attempt of `workflowRunCommand`, with the owner that reclaims its captured source. */
export interface OwnedRunRequest {
  readonly host: WorkflowHost;
  readonly owner: CapturedSourceOwner;
  readonly cwd: string;
  readonly workflowName: string;
  readonly userMessage: string;
  readonly options: WorkflowRunOptions;
  readonly detachedProcessOwner: boolean;
  readonly launchToken?: string;
  readonly notifyResumeAccepted?: (runId: string) => void;
}

interface RunSourceSlot {
  preparedSource: PreparedWorkflowSource | undefined;
  /**
   * Pinned at the moment of prepare so the SIGINT/SIGTERM cleanup never rm's a
   * path a live run is reading from. For `--container` folder-codebase runs,
   * `finalizeWorkflowSource` (in `prepareFolderExecution`) reassigns `preparedSource` to a
   * new object whose anchor points at the LIVE source directory the run
   * executes from — rm-ing `preparedSource.anchor.root` on Ctrl-C mid-run would
   * destroy the run's source. The original staged path is renamed away by
   * either `finalizeWorkflowSource` (container) or `executeWorkflow`'s rename
   * (everything else), so an `rm` against it is a no-op once prep has moved it.
   */
  originalStagedRoot: string | undefined;
}

/** The workflow a run selected, the source it reads, and how it was invoked. */
export interface RunSelection extends RunSourceSlot {
  readonly modelOverrides: RunModelOverrides | undefined;
  readonly runConfig: WorkflowRunConfigInput | undefined;
  /**
   * A continuation never captures. With a record it reads that record; without one it is
   * a run created before captures existed, and reads live source — the same legacy path
   * the executor takes for it. Capturing would freeze bytes the run never agreed to and
   * still not make it deterministic.
   */
  readonly isContinuation: boolean;
  readonly continuationRun: WorkflowRun | undefined;
  /**
   * The resume path owns the actionable message for a database that cannot answer, and
   * reports the codebase failure first. Nothing executes before it.
   */
  readonly resumeLookupError: Error | undefined;
  /** The row this process executes as: a detached launcher's pending row, later the setup run. */
  preCreatedRun: WorkflowRun | undefined;
  workflow: ResolvedWorkflow;
  /** The discovery entry, for telemetry (its source) and parse warnings. */
  workflowEntry: WorkflowWithSource | undefined;
}

/**
 * A run admitted to execute. Fields stay mutable where a later phase changes them: an
 * adopt lane recaptures its checkout's source, replacing the graph and the inputs resolved
 * against it, and adoption names the run whose AI configuration the launch inherits.
 */
export interface OwnedRunAdmission extends RunSelection {
  readonly cliUserId: string | undefined;
  /**
   * Per-dispatch --base override, normalized once. Wins over repo config + the
   * codebase default for both the worktree cut-from (the provider request's
   * `baseOverride`) and the PR target / $BASE_BRANCH (executeWorkflow's
   * `baseOverride` opt). Both halves need their own channel: the `baseBranch`
   * field on either side is the codebase-default FALLBACK and ranks below repo
   * config, so routing the flag through it would silently lose to a repo that
   * sets `worktree.baseBranch`.
   */
  readonly flagBase: string | undefined;
  readonly pinnedEnabled: boolean | undefined;
  /** Reassigned by adoption resolution (#2747), which picks the lane. */
  wantsIsolation: boolean;
  resolvedInputs: Record<string, string> | undefined;
  aiConfigurationRun: WorkflowRun | undefined;
}

/**
 * Select the workflow a run executes, from source frozen before discovery.
 *
 * Freeze the source BEFORE discovering, then discover from the frozen copy. Discovering
 * first and capturing after would leave a window where the YAML this run executes and
 * the commands and scripts it calls come from two different moments — the drift the
 * capture exists to remove, reintroduced at the one place nobody would look for it.
 *
 * A dry run creates no run and no artifacts, so it has nothing to freeze into and reads
 * live, exactly as it did before captures existed.
 */
export async function selectRunWorkflow(request: OwnedRunRequest): Promise<RunSelection> {
  const { host, cwd, workflowName, options } = request;
  const modelOverrides = options.modelAssignments
    ? parseRunModelAssignments(options.modelAssignments)
    : undefined;
  const { continuationRun, resumeLookupError, continuation } = await locateContinuation(request);
  const isContinuation = options.resume === true || continuationRun !== undefined;
  const runConfig = await resolveLaunchRunConfig(host, options, cwd, isContinuation);
  const preCreatedRun = await claimDetachedRunRow(request);

  const source: RunSourceSlot = { preparedSource: undefined, originalStagedRoot: undefined };
  if (!isContinuation && !options.dryRun && !options.stubsInitPath) {
    await captureRunSource(request, source, options.discoveryCwd ?? cwd, preCreatedRun);
  }
  const { workflowEntries, errors } = await discoverRunWorkflows(
    request,
    continuation,
    source.preparedSource
  );

  // A continuation executes the graph it froze; only a fresh invocation resolves by name.
  const workflow =
    continuation?.workflow ??
    resolveWorkflowName(
      workflowName,
      workflowEntries.map(ws => ws.workflow)
    );
  if (!workflow) throw workflowNotFoundError(workflowName, workflowEntries, errors);
  // Name the selection in the capture's manifest, now that it is known. The manifest is
  // outside the digest, so this records provenance without disturbing what was frozen.
  if (source.preparedSource) {
    await recordSelectedWorkflow(source.preparedSource.anchor.root, workflow.name);
  }
  assertDetachedRowWorkflow(preCreatedRun, workflow);
  const workflowEntry = workflowEntries.find(ws => ws.workflow === workflow);

  // Keys this workflow's YAML declares that the engine drops (#2213). Written to
  // stderr, never stdout: in --json mode Pino is silenced and stdout must stay
  // exactly the machine-readable payload, so this is the ONLY channel that
  // reaches an agent driving runs through `--json`. Not gated on --quiet — a
  // dropped key can be a gate the author believes is protecting the run.
  emitParseWarnings(workflowEntry?.parseWarnings, workflow.name);
  emitDeprecationNotice(workflow);
  assertInvocationFlags(options, isContinuation);

  return {
    ...source,
    modelOverrides,
    runConfig,
    isContinuation,
    continuationRun,
    resumeLookupError,
    preCreatedRun,
    workflow,
    workflowEntry,
  };
}

/**
 * Continuing an existing run: discover from the source it recorded, and take no new
 * capture. The MANIFEST supplies the settings those roots resolve under — building them
 * from defaults instead re-discovered a different DAG on any repo with a non-default
 * `commands.folder`, confidently rather than degraded, because a defined-but-default
 * config also suppresses discovery's live-config fallback.
 * Continuation goes through the shared entry point, like chat and web. The CLI used to
 * hand-roll the same load/rebuild/discover sequence: correct at the time, which is the
 * risk — a change to the shared path would silently not reach CLI resume, and that is
 * exactly the shape that produced the mixed-vintage and default-settings bugs.
 *
 * `run <name> --resume` is a continuation too, but it arrives as a flag rather than as a
 * run: its row is only located much further down, where it binds the worktree. That is
 * too late to choose the graph. Resolving it here is what makes every resume form — this
 * flag, `resume <id>`, approve, reject, parent auto-resume — reach the shared entry point
 * with a run in hand, and it also stops the id-based forms re-finding by name a run they
 * already identified exactly (#2645).
 */
async function locateContinuation(request: OwnedRunRequest): Promise<{
  continuationRun: WorkflowRun | undefined;
  resumeLookupError: Error | undefined;
  continuation: ResolvedContinuation | undefined;
}> {
  const { host, cwd, workflowName, options } = request;
  let resumeLookupError: Error | undefined;
  let continuationRun = options.continuationRun;
  if (continuationRun === undefined && options.resume === true) {
    try {
      continuationRun = (await host.deps.store.findResumableRun(workflowName, cwd)) ?? undefined;
    } catch (error) {
      resumeLookupError = error as Error;
    }
  }

  if (continuationRun) {
    await assertInheritedWorkflowCodebase(host, continuationRun.codebase_id);
  }

  // Before anything reads the run's checkout: codebase resolution on a removed
  // worktree fails with a raw git error that reads as a database fault.
  if (options.resume === true && continuationRun?.working_path) {
    assertResumeWorkingPathExists(continuationRun.working_path);
  }

  const continuation =
    continuationRun !== undefined
      ? await resolveContinuationWorkflow(host.deps, continuationRun, cwd)
      : undefined;
  return { continuationRun, resumeLookupError, continuation };
}

function matchesDetachedLaunch(
  metadata: Record<string, unknown> | null | undefined,
  token: string | undefined
): boolean {
  return (
    token !== undefined && token.length > 0 && metadata?.[DETACHED_LAUNCH_METADATA_KEY] === token
  );
}

async function claimDetachedRunRow(request: OwnedRunRequest): Promise<WorkflowRun | undefined> {
  const { host, options } = request;
  if (options.detachedRunId === undefined) return undefined;
  if (!request.detachedProcessOwner) {
    throw new Error(
      '--internal-detached-run-id is set by a detached launch for its own child. ' +
        'Use `archon workflow run <name> --detach`.'
    );
  }
  const row = (await host.deps.store.getWorkflowRun(options.detachedRunId)) ?? undefined;
  if (!row) {
    throw new Error(
      `Detached workflow child cannot find the run '${options.detachedRunId}' its launcher created.`
    );
  }
  if (!matchesDetachedLaunch(row.metadata, request.launchToken)) {
    throw new Error(`Cannot execute run '${row.id}': detached launch identity does not match.`);
  }
  if (row.status !== 'pending') {
    throw new Error(
      `Cannot execute run '${row.id}': it is ${row.status}, ` +
        'not a run awaiting its first execution. Resume it with `archon workflow resume` instead.'
    );
  }
  return row;
}

/**
 * Second half of the handed-over row's claim check (#2872): the row must belong to the
 * workflow being invoked. Checked after discovery because the row carries the RESOLVED
 * name its launcher selected. The child's re-capture may resolve a different workflow
 * than the parent did.
 */
function assertDetachedRowWorkflow(row: WorkflowRun | undefined, workflow: ResolvedWorkflow): void {
  if (row && row.workflow_name !== workflow.name) {
    throw new Error(
      `Cannot execute run '${row.id}': it belongs to workflow ` +
        `'${row.workflow_name}', not '${workflow.name}'.`
    );
  }
}

/**
 * Capture `sourceRoot` into `slot`, filed under the pre-created run when one exists. A
 * capture it replaces is removed unless the replacement reused its directory.
 */
async function captureRunSource(
  request: OwnedRunRequest,
  slot: RunSourceSlot,
  sourceRoot: string,
  preCreatedRun: WorkflowRun | undefined
): Promise<PreparedWorkflowSource> {
  try {
    const replacement = await prepareWorkflowSource(request.host.deps, {
      sourceRoot,
      // Keep the capture filed under the run it belongs to when the row already exists.
      ...(preCreatedRun ? { runId: preCreatedRun.id } : {}),
    });
    // From here the owner reclaims it unless a run adopts it, whichever way we leave.
    request.owner.hold(replacement);
    const stale = slot.preparedSource;
    slot.preparedSource = replacement;
    slot.originalStagedRoot = replacement.anchor.root;
    // Detached recapture replaces the same run directory in place.
    // Remove only a distinct capture so the replacement manifest survives.
    if (stale && stale.anchor.root !== replacement.anchor.root) {
      rmSync(stale.anchor.root, { recursive: true, force: true });
    }
    return replacement;
  } catch (error) {
    throw new Error(
      `Failed to capture workflow source from ${sourceRoot}: ${(error as Error).message}`
    );
  }
}

/**
 * A resolved continuation already discovered over its own roots; reusing that result is
 * what keeps a resume from paying digest verification and full discovery twice.
 */
async function discoverRunWorkflows(
  request: OwnedRunRequest,
  continuation: ResolvedContinuation | undefined,
  preparedSource: PreparedWorkflowSource | undefined
): Promise<{
  workflowEntries: readonly WorkflowWithSource[];
  errors: readonly WorkflowLoadError[];
}> {
  const { host, cwd, options } = request;
  const discoveryCwd = options.discoveryCwd ?? cwd;
  const { workflows: workflowEntries, errors } = continuation
    ? { workflows: continuation.workflows, errors: continuation.errors }
    : preparedSource
      ? await discoverWorkflowsWithConfig(
          cwd,
          host.deps.loadConfig,
          host.deps.providers,
          preparedSource.roots
        )
      : await loadWorkflows(discoveryCwd);
  const sourceCounts = countWorkflowSources(workflowEntries);

  if (!options.json && !options.quiet) {
    console.log(
      `Discovery: root=${discoveryCwd} workflows=${String(workflowEntries.length)} ` +
        `bundled=${String(sourceCounts.bundled)} global=${String(sourceCounts.global)} ` +
        `project=${String(sourceCounts.project)} installed=${String(sourceCounts.installed)}`
    );
  }

  if (workflowEntries.length === 0 && errors.length === 0) {
    // No manual cleanup here or anywhere else in this run: the owner reclaims
    // anything unadopted on the way out, which is the point of having one.
    throw new Error('No workflows found in .archon/workflows/');
  }
  return { workflowEntries, errors };
}

function workflowNotFoundError(
  workflowName: string,
  workflowEntries: readonly WorkflowWithSource[],
  errors: readonly WorkflowLoadError[]
): Error {
  const loadError = findWorkflowLoadError(errors, workflowName);
  if (loadError) {
    return new Error(
      `Workflow '${workflowName}' failed to load: ${loadError.error}\n\nFix the YAML file and try again.`
    );
  }
  return availableWorkflowsError(workflowName, workflowEntries);
}

function availableWorkflowsError(
  workflowName: string,
  workflowEntries: readonly WorkflowWithSource[]
): Error {
  const availableWorkflows = workflowEntries.map(ws => `  - ${ws.workflow.name}`).join('\n');
  return new Error(
    `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
  );
}

/**
 * Admit a selected workflow to execute: the gates that must refuse before the --detach
 * fork and any worktree, clone, or AI cost.
 */
export async function admitRunExecution(
  request: OwnedRunRequest,
  selection: RunSelection
): Promise<OwnedRunAdmission> {
  const { host, options } = request;
  const { workflow } = selection;
  assertExecutionFlags(options);

  const flagBase = options.baseBranch?.trim() || undefined;
  const pinnedEnabled = workflow.worktree?.enabled;
  assertWorktreePolicy(workflow, options);

  // Default to worktree isolation unless --no-worktree or --resume. Workflow YAML
  // `worktree.enabled` pins the decision — mismatches with CLI flags are rejected
  // above, so by this point policy (if set) and flags agree. `--resume` reuses an
  // existing worktree and takes precedence over the pinned policy. Decided here
  // (not at the worktree step) because --detach also needs it to decide whether to
  // pin a generated branch on the child.
  const flagWantsIsolation = !options.resume && !options.noWorktree;
  const wantsIsolation =
    !options.resume && pinnedEnabled !== undefined ? pinnedEnabled : flagWantsIsolation;

  // Worktree options require a git repo. When the caller explicitly declares
  // folder intent via --folder, reject --branch/--from and worktree-pinned
  // workflows synchronously (no DB needed). The authoritative kind-based guard
  // for ALREADY-registered folder projects (no --folder flag) runs after the
  // codebase lookup. Fail fast — never silently ignore the flags.
  assertNoWorktreeOptionsForFolder(options.folder === true, options);
  assertWorkflowNotWorktreePinnedForFolder(options.folder === true, pinnedEnabled, workflow.name);

  // Signature gate (#2470, #2554): resolve this invocation's declared inputs from the
  // `--input name=value` flags against the workflow's `inputs:` block, here — before the
  // --detach fork and any worktree/clone/AI cost — so a bad name, a missing required
  // input, or a malformed assignment costs nothing.
  //
  // Skipped on --resume: the resumable run is not bound until the launch, and its inputs
  // were validated when its row was created. Re-gating with nothing supplied would make
  // every resume of a required-input run impossible.
  const resolvedInputs = options.resume ? undefined : resolveDeclaredInputs(workflow, options);

  // Capability gate: hard-fail before the --detach fork and any worktree/clone/
  // AI cost if the workflow declares `requires: [github]` and the acting CLI
  // user hasn't connected. No-op on solo PAT installs. Mirrors the orchestrator
  // gate (dispatchOrchestratorWorkflow) so CLI, REST (via orchestrator), and
  // chat dispatch enforce `requires: [github]` identically.
  await assertCliWorkflowRequirementsMet(host, workflow);

  const cliUserId = await resolveCliUserRecordId(host);
  return {
    ...selection,
    cliUserId,
    flagBase,
    pinnedEnabled,
    wantsIsolation,
    resolvedInputs,
    aiConfigurationRun: undefined,
  };
}

function resolveDeclaredInputs(
  workflow: ResolvedWorkflow,
  options: WorkflowRunOptions
): Record<string, string> | undefined {
  return resolveTopLevelInputs(
    workflow,
    options.inputs ? parseInputAssignments(options.inputs) : undefined
  );
}

/**
 * By default, adoption reads the inherited or freshly cut worktree's `.archon`:
 * the branch may carry a different workflow than the invoking checkout (#2660/#2747).
 * An explicit source instead owns the graph, commands, and scripts for the new run;
 * adoption changes only its execution target. Callers recapture only the default.
 */
export async function recaptureForLane(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  sourceRoot: string
): Promise<void> {
  const { host, workflowName, options } = request;
  const preparedSource = await captureRunSource(
    request,
    admission,
    sourceRoot,
    admission.preCreatedRun
  );
  const rediscovered = await discoverWorkflowsWithConfig(
    sourceRoot,
    host.deps.loadConfig,
    host.deps.providers,
    preparedSource.roots
  );
  const workflow = resolveWorkflowName(
    workflowName,
    rediscovered.workflows.map(ws => ws.workflow)
  );
  if (!workflow) throw availableWorkflowsError(workflowName, rediscovered.workflows);
  admission.workflow = workflow;
  admission.workflowEntry = rediscovered.workflows.find(ws => ws.workflow === workflow);
  await recordSelectedWorkflow(preparedSource.anchor.root, workflow.name);
  emitParseWarnings(admission.workflowEntry?.parseWarnings, workflow.name);
  emitDeprecationNotice(workflow);
  // The gates above ran against the parent checkout's YAML; this lane executes the
  // branch's graph, so judge the same signature gates against the branch vintage
  // (mirrors the orchestrator's deferred runSignatureGates).
  if (!options.resume) admission.resolvedInputs = resolveDeclaredInputs(workflow, options);
  await assertCliWorkflowRequirementsMet(host, workflow);
}

/** Where a launch reads its AI configuration from, given the lane it executes in. */
export type LaneConfigSource =
  /** An adopted run's branch whose worktree is gone, read from a snapshot of the branch. */
  | { kind: 'branch'; codebase: Codebase; branch: string }
  | { kind: 'checkout'; cwd: string; recapture: boolean; codebaseId: string | undefined };

/**
 * Prepare and preflight the run's AI configuration from the checkout its lane executes.
 * Without an explicit source, an adopted lane's own `.archon` is recaptured first.
 */
export async function prepareLaneAiConfiguration(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  lane: LaneConfigSource,
  executesInContainer: boolean
): Promise<PreparedRunAiConfiguration> {
  const recaptures = request.options.discoveryCwd === undefined;
  if (lane.kind === 'branch') {
    return withBranchLaunchSource(lane.codebase.default_cwd, lane.branch, async snapshot => {
      if (recaptures) await recaptureForLane(request, admission, snapshot);
      return prepareCredentialPreflight(
        request,
        admission,
        snapshot,
        lane.codebase.id,
        executesInContainer
      );
    });
  }
  if (lane.recapture && recaptures) await recaptureForLane(request, admission, lane.cwd);
  return prepareCredentialPreflight(
    request,
    admission,
    lane.cwd,
    lane.codebaseId,
    executesInContainer
  );
}

async function prepareCredentialPreflight(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  configCwd: string,
  codebaseId: string | undefined,
  executesInContainer: boolean
): Promise<PreparedRunAiConfiguration> {
  const { host } = request;
  const { preCreatedRun, continuationRun, modelOverrides } = admission;
  const prepared = await prepareRunAiConfiguration(host.deps, admission.workflow, configCwd, {
    codebaseId,
    aiConfigurationRun: preCreatedRun ?? admission.aiConfigurationRun,
    ...(preCreatedRun ? { inheritAiConfiguration: true } : {}),
    userId: preCreatedRun ? (preCreatedRun.user_id ?? undefined) : admission.cliUserId,
    ...(admission.isContinuation && continuationRun
      ? { continuationRun }
      : {
          runConfig: admission.runConfig,
          ...(modelOverrides
            ? { modelOverrideLayer: { kind: 'raw' as const, overrides: modelOverrides } }
            : {}),
        }),
  });
  await assertRunCredentials(
    host.deps,
    prepared,
    executesInContainer ? 'pending-container' : { cwd: configCwd }
  );
  return prepared;
}
