import { isWorkflowExecutionInterruption } from './execution-interruption';
import { existsSync } from 'fs';
import type { ChildIsolationResolver, ChildIsolationResult } from './child-isolation';
import type { ChildWorkflowOutcome, RunChildWorkflowArgs } from './dag/child-run';
import { childOutcomeFromRun } from './dag/child-run';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { executeWorkflow, type ExecuteWorkflowOptions } from './executor';
import type { ResolvedRunModelOverrides } from './model-validation';
import { canonicalValueText, type JsonValue } from './output-ref';
import { resolveWorkflowName } from './router';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from './run-ai-configuration';
import {
  assertRunCredentials,
  prepareRunAiConfiguration,
  type PreparedRunAiConfiguration,
} from './run-preflight';
import { hydrateResumableRun, inspectResumableRun } from './run-resume';
import {
  prepareWorkflowSource,
  withCapturedSource,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
} from './run-source';
import type { ResolvedWorkflow, WorkflowRun } from './schemas';
import { SUBRUN_METADATA_KEYS } from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { resolveDeclaredInputs } from './workflow-inputs';
import {
  WorkflowSourceUnavailableError,
  isSourceReadFailure,
  isSystemError,
  recordSelectedWorkflow,
  resolveChildDiscoveryRoot,
  resolveChildInstalledPacks,
  type InstalledPacksRoot,
} from './workflow-source';

/** Depth cap on the `workflow:` sub-run tree (D9). A node nested deeper fails fast. */
const CHILD_WORKFLOW_DEPTH_CAP = 5;

/** Safety bound on the descendant walk (guards a corrupted run tree). */
const MAX_DESCENDANT_RUNS = 64;

/**
 * Collect the transitive descendant run ids of `rootId` via a bounded downward walk
 * of `parent_run_id` (#2121 Phase 2). Used to exclude a run's own sub-run children
 * from its path-lock: they share the checkout by design, so a parent resumed while
 * still blocked on a paused child must not self-cancel against that child. Throws
 * are the caller's to handle (it fails closed).
 */
export async function gatherDescendantRunIds(
  deps: WorkflowDeps,
  rootId: string
): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let processed = 0;
  while (queue.length > 0 && processed < MAX_DESCENDANT_RUNS) {
    const id = queue.shift();
    if (id === undefined) break;
    processed++;
    const children = await deps.store.findChildRuns(id);
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c.id);
      queue.push(c.id);
    }
  }
  return out;
}

/**
 * A child launch reads its parent's source before the child runs. The parent releases
 * itself only for this typed error; anything else escaping the launch is the child's
 * fault, and the parent's `workflow:` node fails with it.
 */
function parentSourceUnreadable(root: string, error: unknown): unknown {
  if (error instanceof WorkflowSourceUnavailableError || !isSourceReadFailure(error)) return error;
  return new WorkflowSourceUnavailableError(
    isSystemError(error) && typeof error.path === 'string' ? error.path : root,
    error
  );
}

/**
 * A shared-checkout child inherits its parent's base; an isolated child reports the base
 * its worktree was cut from. An unknown cut-from base stays unresolved (`''`) rather than
 * falling through to config that may not describe the reused branch.
 */
function childBaseBranch(
  isolation: ChildIsolationResult | undefined,
  parentBaseBranch: string
): string {
  if (!isolation) return parentBaseBranch;
  return isolation.baseBranch ?? '';
}

/** A phase of a child launch either hands its value on or ends the launch with an outcome. */
type ChildPhase<T> =
  | { stopped: false; value: T }
  | { stopped: true; outcome: ChildWorkflowOutcome };

const proceed = <T>(value: T): ChildPhase<T> => ({ stopped: false, value });

// Ordinary refusals return a failed outcome; failures before a child row exists
// carry an empty childRunId. Lifecycle interruptions escape to the run owner.
function failedOutcome(error: string, childRunId = ''): ChildWorkflowOutcome {
  return { childRunId, status: 'failed', error };
}

function refuse(
  error: string,
  childRunId?: string
): { stopped: true; outcome: ChildWorkflowOutcome } {
  return { stopped: true, outcome: failedOutcome(error, childRunId) };
}

/** Everything one child launch reads, fixed before its first phase runs. */
interface ChildLaunch {
  readonly deps: WorkflowDeps;
  readonly platform: IWorkflowPlatform;
  readonly args: RunChildWorkflowArgs;
  readonly resolvedModelOverrides: ResolvedRunModelOverrides;
  readonly runConfig: WorkflowRunConfigInput | undefined;
  readonly parentBaseBranch: string;
  readonly resolveChildIsolation: ChildIsolationResolver | undefined;
}

interface ChildRunStart {
  readonly opts: ExecuteWorkflowOptions;
  readonly runId: string;
}

/**
 * Start (or resume a failed) child workflow run in-process for a `workflow:` node
 * (#2121 Phase 2). Reuses the FULL executeWorkflow lifecycle for the child —
 * run-record creation, path-lock, artifacts, credential/model resolution, resume,
 * terminal output — and returns the child's node-facing outcome.
 *
 * The runtime cycle guard + depth cap live here (include:'s guard is load-time and
 * does not cover runtime targets). The child shares the parent's checkout;
 * executeWorkflow derives the ancestor chain from the child's own parent_run_id
 * to exclude it from the path-lock.
 * Ordinary failures return a `{ status: 'failed' }` outcome so the calling node
 * fails cleanly rather than the whole DAG throwing. Lifecycle interruptions
 * propagate because the child has no trustworthy terminal outcome to return.
 */
export async function runChildWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  args: RunChildWorkflowArgs,
  resolvedModelOverrides: ResolvedRunModelOverrides,
  runConfig: WorkflowRunConfigInput | undefined,
  parentBaseBranch: string,
  resolveChildIsolation?: ChildIsolationResolver
): Promise<ChildWorkflowOutcome> {
  const launch: ChildLaunch = {
    deps,
    platform,
    args,
    resolvedModelOverrides,
    runConfig,
    parentBaseBranch,
    resolveChildIsolation,
  };
  const parentSource = await readParentSource(launch);
  // Refusals and recursive execution share one owner until adoption or disposal.
  return withCapturedSource(async owner => {
    const source = await captureChildSource(launch, parentSource, owner);
    if (source.stopped) return source.outcome;
    const workflow = await resolveChildWorkflow(launch, source.value);
    if (workflow.stopped) return workflow.outcome;
    const guard = await guardChildAncestry(launch, workflow.value);
    if (guard.stopped) return guard.outcome;
    const inputs = resolveChildInputs(args, workflow.value);
    if (inputs.stopped) return inputs.outcome;
    const prepared = await prepareChildAiConfiguration(launch, workflow.value);
    if (prepared.stopped) return prepared.outcome;
    const placement = await resolveChildPlacement(launch, prepared.value);
    if (placement.stopped) return placement.outcome;
    const start = await startChildRun(launch, {
      source: source.value,
      workflow: workflow.value,
      inputs: inputs.value,
      prepared: prepared.value,
      placement: placement.value,
    });
    if (start.stopped) return start.outcome;
    return executeChildRun(launch, owner, {
      workflow: workflow.value,
      prepared: prepared.value,
      cwd: placement.value.cwd,
      start: start.value,
    });
  });
}

interface ParentSource {
  readonly root: string | undefined;
  readonly installedFrom: InstalledPacksRoot | undefined;
}

// A `workflow:` child freezes its own source AT ITS OWN START, from the parent's
// AUTHORING directory rather than the parent's frozen copy of it. Both halves matter:
// taking the bytes now (not at parent start) is what lets an author fix a child
// workflow — removing a gate, say — and have a resumed parent pick the fix up; and
// discovering from the capture rather than from the live directory is what stops the
// child executing one moment's YAML against another moment's scripts.
// Installed packs are the exception: the child takes them from the parent's capture.
async function readParentSource({ args }: ChildLaunch): Promise<ParentSource> {
  try {
    return {
      root: await resolveChildDiscoveryRoot(args.parentRun.metadata),
      installedFrom: await resolveChildInstalledPacks(args.parentRun.metadata),
    };
  } catch (err) {
    throw parentSourceUnreadable(args.cwd, err);
  }
}

async function captureChildSource(
  { deps, args }: ChildLaunch,
  parentSource: ParentSource,
  owner: CapturedSourceOwner
): Promise<ChildPhase<PreparedWorkflowSource>> {
  const sourceRoot = parentSource.root ?? args.cwd;
  try {
    const childSource = await prepareWorkflowSource(deps, {
      sourceRoot,
      ...(parentSource.installedFrom !== undefined
        ? { installedFrom: parentSource.installedFrom }
        : {}),
    });
    owner.hold(childSource);
    return proceed(childSource);
  } catch (err) {
    if (isSourceReadFailure(err)) throw parentSourceUnreadable(sourceRoot, err);
    return refuse(
      `Failed to capture workflow source for sub-run '${args.childWorkflowName}': ${(err as Error).message}`
    );
  }
}

// Resolve the child workflow by NAME (static target — constitution guardrail).
// Resolution runs BEFORE the cycle check so a case-variant / suffix / substring
// reference to an ancestor (e.g. `workflow: SELFIE` naming its own run) is caught
// as a cycle by canonical name, not left to the less-informative depth cap.
async function resolveChildWorkflow(
  { deps, args }: ChildLaunch,
  childSource: PreparedWorkflowSource
): Promise<ChildPhase<ResolvedWorkflow>> {
  const { childWorkflowName } = args;
  let childWorkflow: ResolvedWorkflow | undefined;
  try {
    // DELIBERATE AFFORDANCE — do not "fix" this by adding a load-time existence
    // check for `workflow:` targets. Discovery runs HERE, when the node executes,
    // so a run can author a workflow mid-flight and then execute it as a governed
    // child run; a load-time check would compile, pass every existing test, and
    // silently delete that capability. Recorded in the constitution's case-law
    // table (.archon/workflow-language-constitution.md) and locked by
    // `describe('workflow: late resolution is a deliberate affordance')` in
    // child-runs.late-resolution.test.ts.
    const { workflows } = await discoverWorkflowsWithConfig(
      args.cwd,
      deps.loadConfig,
      deps.providers,
      childSource.roots
    );
    childWorkflow = resolveWorkflowName(
      childWorkflowName,
      workflows.map(w => w.workflow)
    );
    if (childWorkflow) await recordSelectedWorkflow(childSource.anchor.root, childWorkflow.name);
  } catch (err) {
    if (isSourceReadFailure(err)) throw parentSourceUnreadable(childSource.anchor.root, err);
    return refuse(`Failed to resolve sub-run '${childWorkflowName}': ${(err as Error).message}`);
  }
  if (!childWorkflow) return refuse(`Unknown sub-run workflow '${childWorkflowName}'.`);
  return proceed(childWorkflow);
}

// Cycle guard + depth cap (D9), compared against the RESOLVED canonical name.
// The child's ancestor chain is the parent plus the parent's ancestors; a
// resolved target already in the chain is a cycle.
async function guardChildAncestry(
  { deps, args }: ChildLaunch,
  childWorkflow: ResolvedWorkflow
): Promise<ChildPhase<undefined>> {
  let ancestry: WorkflowRun[];
  try {
    ancestry = [args.parentRun, ...(await deps.store.getRunAncestry(args.parentRun.id))];
  } catch (err) {
    return refuse(`Failed to resolve run ancestry for sub-run guard: ${(err as Error).message}`);
  }
  if (ancestry.some(a => a.workflow_name === childWorkflow.name)) {
    return refuse(
      `Sub-run cycle detected: '${childWorkflow.name}' is already an ancestor of this run.`
    );
  }
  if (ancestry.length >= CHILD_WORKFLOW_DEPTH_CAP) {
    return refuse(
      `Sub-run depth cap (${String(CHILD_WORKFLOW_DEPTH_CAP)}) exceeded nesting '${childWorkflow.name}'.`
    );
  }
  return proceed(undefined);
}

// Enforce the RESOLVED child's declared `inputs:` contract (#2470) — the exact
// same resolution `include:` performs at load time, through the same shared
// implementation, so a `with:` map accepted by one surface is accepted by the
// other. It can only run here (not at load time) because the target is resolved
// late by design, so it sits before isolation/worktree creation and before the
// child run row exists: a contract violation must never leave an orphan worktree
// or a doomed child row behind.
function resolveChildInputs(
  { nodeId, inputs }: RunChildWorkflowArgs,
  childWorkflow: ResolvedWorkflow
): ChildPhase<Record<string, JsonValue> | undefined> {
  try {
    const resolved = resolveDeclaredInputs(
      inputs ?? {},
      childWorkflow.inputs,
      `Node '${nodeId}'`,
      `sub-run workflow '${childWorkflow.name}'`
    );
    return proceed(Object.keys(resolved).length > 0 ? resolved : undefined);
  } catch (err) {
    return refuse((err as Error).message);
  }
}

async function prepareChildAiConfiguration(
  { deps, args, resolvedModelOverrides, runConfig }: ChildLaunch,
  childWorkflow: ResolvedWorkflow
): Promise<ChildPhase<PreparedRunAiConfiguration>> {
  const { resumeChild } = args;
  const configCwd = resumeChild?.run.working_path ?? args.cwd;
  try {
    const childPrepared = await prepareRunAiConfiguration(deps, childWorkflow, configCwd, {
      codebaseId: args.codebaseId,
      userId: args.userId,
      ...(resumeChild
        ? { continuationRun: resumeChild.run }
        : { aiConfigurationRun: args.parentRun, inheritAiConfiguration: true }),
      modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
      ...(runConfig ? { runConfig } : {}),
    });
    await assertRunCredentials(deps, childPrepared, { cwd: configCwd });
    return proceed(childPrepared);
  } catch (error) {
    return refuse((error as Error).message, resumeChild?.run.id);
  }
}

interface ChildPlacement {
  readonly cwd: string;
  /** Present only when THIS spawn created a fresh isolated worktree — its env id +
   * branch are stamped into the child's metadata (S3; PR-E console grouping reads it). */
  readonly isolationEnv?: ChildIsolationResult;
}

// Resolve the child's execution cwd (slice 2, PR-A). `isolation: 'worktree'`
// runs the child in its own git worktree obtained from the injected resolver.
// A resume whose child run row still exists reuses that row's recorded path
// instead of resolving again; a resume whose child row is GONE (never written,
// or deleted) falls through to the fresh-spawn path and does re-resolve —
// safely, because the identifier is deterministic per (parent, node, index)
// and the env-row write is an upsert (see child-isolation-resolver.ts).
// `inherit` (or undefined) shares the parent's checkout — slice-1 behavior.
// Resolving AFTER the name + cycle guards means a bad reference never leaves an
// orphan worktree behind. The resolver throwing surfaces as a failed outcome
// (never a silent shared-checkout fallback — a parallel write into the shared
// checkout is the exact collision worktree isolation prevents).
async function resolveChildPlacement(
  launch: ChildLaunch,
  childPrepared: PreparedRunAiConfiguration
): Promise<ChildPhase<ChildPlacement>> {
  const { resumeChild, isolation, cwd } = launch.args;
  if (resumeChild) return resumedChildPlacement(launch.args.childWorkflowName, resumeChild.run);
  if (isolation === 'worktree') return isolatedChildPlacement(launch, childPrepared);
  return proceed({ cwd });
}

// Reuse the child's own recorded working_path: its worktree for an isolated
// child, the shared parent checkout for `inherit`. Reaching this branch at all
// means the child row survived, so there is nothing to re-resolve.
function resumedChildPlacement(
  childWorkflowName: string,
  childRun: WorkflowRun
): ChildPhase<ChildPlacement> {
  const priorPath = childRun.working_path;
  // An isolated child's worktree can be pruned by `isolation cleanup`/`complete`
  // between its failure and this resume. Reusing a vanished path would surface as a
  // deep ENOENT mid-run; fail fast with the same guidance the top-level CLI resume
  // gives (`assertResumeWorkingPathExists` in the CLI's workflow-isolation.ts).
  if (priorPath && !existsSync(priorPath)) {
    return refuse(
      `Cannot resume sub-run '${childWorkflowName}': its working path no longer exists ` +
        `(${priorPath}). The worktree may have been cleaned up — start a fresh run.`,
      childRun.id
    );
  }
  // `working_path` is nullable in the schema, and falling back to the parent's
  // `cwd` here would be the one silent shared-checkout fallback in this launch —
  // for an ISOLATED child that is exactly the concurrent-write collision the
  // isolation was requested to prevent. Unreachable today (every child row is
  // created with a real path, see createChildRun), so this is defense-in-depth:
  // fail loudly rather than resume somewhere the author didn't ask for.
  if (!priorPath) {
    return refuse(
      `Cannot resume sub-run '${childWorkflowName}': its run row has no recorded working ` +
        'path, so the checkout it ran in is unknown — start a fresh run.',
      childRun.id
    );
  }
  return proceed({ cwd: priorPath });
}

async function isolatedChildPlacement(
  { args, resolveChildIsolation }: ChildLaunch,
  childPrepared: PreparedRunAiConfiguration
): Promise<ChildPhase<ChildPlacement>> {
  const { childWorkflowName } = args;
  if (!resolveChildIsolation) {
    return refuse(
      `isolation: 'worktree' on sub-run '${childWorkflowName}' requires an injected ` +
        'child-isolation resolver (available for git-repo codebases run via the CLI or ' +
        "orchestrator). Remove the isolation or use 'inherit' (shared checkout)."
    );
  }
  try {
    const isolationEnv = await resolveChildIsolation.resolve({
      setupEnvironment: childPrepared.config,
      parentRun: args.parentRun,
      nodeId: args.nodeId,
      childIndex: args.childIndex,
      codebaseId: args.codebaseId,
    });
    return proceed({ cwd: isolationEnv.cwd, isolationEnv });
  } catch (err) {
    // The resolver already classified + logged the failure (child-isolation-resolver);
    // prepend the sub-run context for the node-facing outcome.
    return refuse(
      `Failed to create isolated worktree for sub-run '${childWorkflowName}': ${(err as Error).message}`
    );
  }
}

interface ChildRunPlan {
  readonly source: PreparedWorkflowSource;
  readonly workflow: ResolvedWorkflow;
  readonly inputs: Record<string, JsonValue> | undefined;
  readonly prepared: PreparedRunAiConfiguration;
  readonly placement: ChildPlacement;
}

// Create the child run row (fresh) or hydrate the failed one (resume path).
// Every child receives the resolver so a NESTED grandchild `workflow:` node can
// also request its own worktree (nesting is first-class up to the depth cap) — the
// recursive executeWorkflow otherwise has no resolver and would fail-fast. (The
// sibling `container:` context has the same non-propagation gap today; out of scope
// for this PR, but noted so it isn't mistaken for intentional.)
async function startChildRun(
  launch: ChildLaunch,
  plan: ChildRunPlan
): Promise<ChildPhase<ChildRunStart>> {
  const { resumeChild } = launch.args;
  try {
    if (!resumeChild) return proceed(await createChildRun(launch, plan));
    if (resumeChild.kind === 'failed') {
      return proceed(await resumeFailedChildRun(launch, resumeChild.run, plan.source));
    }
    return proceed(await recoverCancelledChildRun(launch, resumeChild.run, plan.source));
  } catch (err) {
    return refuse(
      `Failed to create sub-run '${launch.args.childWorkflowName}': ${(err as Error).message}`
    );
  }
}

function inheritedChildOptions(
  { args, resolveChildIsolation }: ChildLaunch,
  childSource: PreparedWorkflowSource
): Pick<ExecuteWorkflowOptions, 'codebaseId' | 'resolveChildIsolation' | 'preparedSource'> {
  return { codebaseId: args.codebaseId, resolveChildIsolation, preparedSource: childSource };
}

async function resumeFailedChildRun(
  launch: ChildLaunch,
  childRun: WorkflowRun,
  childSource: PreparedWorkflowSource
): Promise<ChildRunStart> {
  const hydrated = await hydrateResumableRun(launch.deps, childRun);
  if (hydrated) {
    return {
      opts: { ...hydrated, ...inheritedChildOptions(launch, childSource) },
      runId: hydrated.preCreatedRun.id,
    };
  }
  const preCreatedRun = await launch.deps.store.resumeWorkflowRun(childRun.id);
  return {
    opts: { preCreatedRun, ...inheritedChildOptions(launch, childSource) },
    runId: preCreatedRun.id,
  };
}

async function recoverCancelledChildRun(
  launch: ChildLaunch,
  childRun: WorkflowRun,
  childSource: PreparedWorkflowSource
): Promise<ChildRunStart> {
  const { deps } = launch;
  const inspection = await inspectResumableRun(deps, childRun);
  const completedNodeIds = new Set(inspection?.priorCompletedNodes.keys() ?? []);
  const priorNodeSessions = (await deps.store.listWorkflowRunNodeSessions(childRun.id)).filter(
    row => completedNodeIds.has(row.node_id)
  );
  const preCreatedRun = await deps.store.recoverCancelledFanOutRun(childRun.id);
  return {
    opts: {
      preCreatedRun,
      ...(inspection
        ? {
            priorCompletedNodes: inspection.priorCompletedNodes,
            priorUsage: inspection.priorUsage,
            priorNodeSessions,
          }
        : {}),
      ...inheritedChildOptions(launch, childSource),
    },
    runId: preCreatedRun.id,
  };
}

async function createChildRun(launch: ChildLaunch, plan: ChildRunPlan): Promise<ChildRunStart> {
  const { deps, args, runConfig, parentBaseBranch } = launch;
  const { isolationEnv } = plan.placement;
  const childRun = await deps.store.createWorkflowRun({
    // The id its capture is already filed under (see prepareWorkflowSource).
    id: plan.source.runId,
    workflow_name: plan.workflow.name,
    origin: args.parentRun.origin ?? undefined,
    codebase_id: args.codebaseId,
    user_message: args.input,
    working_path: plan.placement.cwd,
    parent_run_id: args.parentRun.id,
    metadata: childRunMetadata(args, plan),
  });
  return {
    opts: {
      preCreatedRun: childRun,
      ...inheritedChildOptions(launch, plan.source),
      ...(runConfig ? { runConfig } : {}),
      resolvedBaseBranch: childBaseBranch(isolationEnv, parentBaseBranch),
      ...(isolationEnv?.cutFromCommit !== undefined
        ? { cutFromCommit: isolationEnv.cutFromCommit }
        : {}),
    },
    runId: childRun.id,
  };
}

function childRunMetadata(
  { nodeId, childIndex, itemHash }: RunChildWorkflowArgs,
  { prepared, inputs, placement }: ChildRunPlan
): Record<string, unknown> {
  return {
    [RUN_AI_CONFIGURATION_METADATA_KEY]: prepared.aiConfigurationSnapshot,
    [SUBRUN_METADATA_KEYS.parentNodeId]: nodeId,
    // Fan-out instance index (slice 2, PR-C) — stamped only for a fan-out child so
    // parent resume can re-key the ordered instance set by index (findChildRuns is
    // started_at-ordered, which ≠ items order under max_parallel concurrency). A
    // single (non-fan-out) child carries no child_index. The item-content hash rides
    // alongside so resume can WARN on a non-deterministic producer (same index, new item).
    ...(childIndex !== undefined ? { [SUBRUN_METADATA_KEYS.childIndex]: childIndex } : {}),
    ...(itemHash !== undefined ? { [SUBRUN_METADATA_KEYS.fanOutItemHash]: itemHash } : {}),
    ...(inputs !== undefined ? childInputsMetadata(inputs) : {}),
    ...(placement.isolationEnv ? childIsolationMetadata(placement.isolationEnv) : {}),
  };
}

// Named inputs (#2470) — persisted at spawn so the child's `$INPUTS.<name>`
// resolves from metadata at runtime (resolveRunInputs) and survives a COLD
// resume: both resume paths (hydrateResumableRun and the zero-completed-node
// resumeWorkflowRun fallback) reload THIS run row, so the map is intact without
// re-resolving parent refs that may be out of scope. Stamped only when non-empty.
// This is the CONTRACT-RESOLVED map (declared defaults applied), not the raw
// caller map — the child must see exactly what its `inputs:` block promises.
// `inputs` stays canonical TEXT forever (shipped binaries read a non-string map
// as corrupt/unset); the logical map rides the additive `inputs_values` sibling
// (#2637), written only when a value is actually non-string.
function childInputsMetadata(inputs: Record<string, JsonValue>): Record<string, unknown> {
  return {
    [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [k, canonicalValueText(v)])
    ),
    ...(Object.values(inputs).some(v => typeof v !== 'string')
      ? { [SUBRUN_METADATA_KEYS.inputsValues]: inputs }
      : {}),
  };
}

// Record the child's own worktree env + branch (mirrors the container path's
// isolation_env_id) so `isolation list` correlation + PR-E console grouping
// can find it. Absent for `inherit`/shared-checkout children.
function childIsolationMetadata(isolationEnv: ChildIsolationResult): Record<string, unknown> {
  return {
    isolation_env_id: isolationEnv.envId,
    ...(isolationEnv.ownedWorktree ? { owned_worktree: isolationEnv.ownedWorktree } : {}),
    branch_name: isolationEnv.branchName,
  };
}

interface ChildExecution {
  readonly workflow: ResolvedWorkflow;
  readonly prepared: PreparedRunAiConfiguration;
  readonly cwd: string;
  readonly start: ChildRunStart;
}

// Run the child in-process (reuses the whole lifecycle) in its resolved cwd
// (its own worktree when isolated, else the parent's checkout). Its terminal
// output + cost + tokens land in the child run metadata on completion.
async function executeChildRun(
  { deps, platform, args, resolvedModelOverrides }: ChildLaunch,
  owner: CapturedSourceOwner,
  { workflow, prepared, cwd, start }: ChildExecution
): Promise<ChildWorkflowOutcome> {
  const { resumeChild, childWorkflowName } = args;
  try {
    await executeWorkflow(
      deps,
      platform,
      args.conversationId,
      cwd,
      workflow,
      args.input,
      args.parentRun.origin ?? undefined,
      {
        ...start.opts,
        ...(resumeChild ? {} : { preparedAiConfiguration: prepared }),
        capturedSourceOwner: owner,
        modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
      }
    );

    // Read the child back for the node-facing outcome (status + summary + cost +
    // tokens). Works for synchronous completion AND a child paused at its gate.
    const finalChild = await deps.store.getWorkflowRun(start.runId);
    if (!finalChild) {
      return failedOutcome('Child run row disappeared after execution.', start.runId);
    }
    return childOutcomeFromRun(finalChild);
  } catch (err) {
    if (isWorkflowExecutionInterruption(err)) throw err;

    // Ordinary setup/read-back failures become failed child outcomes after cleanup.
    // Lifecycle interruptions escape: compensation cannot establish a terminal outcome.
    //
    // Wedge guard (symmetric to continueBlockedRun's post-CAS handler): a throw in
    // executeWorkflow's EARLY setup (config load, getCodebaseEnvVars, token
    // resolution) fires BEFORE the status→running flip and BEFORE its own catch-all,
    // stranding the pre-created child at 'pending' (or 'running' on a later window) —
    // a non-terminal row that holds the working-path lock. `cancelWorkflowRun` (NOT
    // failWorkflowRun, whose `WHERE status='running'` would miss the 'pending' case)
    // flips any non-terminal child to 'cancelled' and no-ops on a child that reached
    // completed/cancelled on its own.
    await requireTerminalStatusWrite(
      deps.store.cancelWorkflowRun(start.runId, { cancel_reason: 'precondition_failed' }),
      {
        workflowRunId: start.runId,
        site: 'executor.child_setup_cancel',
      }
    );
    return failedOutcome(
      `Sub-run '${childWorkflowName}' errored: ${(err as Error).message}`,
      start.runId
    );
  }
}
