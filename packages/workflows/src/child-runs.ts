import { readWorkflowLifecycle, WorkflowStatusReadError } from './workflow-status-read';
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
  type PreparedWorkflowSource,
} from './run-source';
import type { ResolvedWorkflow, WorkflowRun } from './schemas';
import { SUBRUN_METADATA_KEYS } from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';
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

function failOutcome(error: string, childRunId = ''): ChildWorkflowOutcome {
  return { childRunId, status: 'failed', error };
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
 * fails cleanly rather than the whole DAG throwing. Lifecycle read and terminal
 * status-write failures propagate because the child has no trustworthy outcome.
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
  const {
    parentRun,
    nodeId,
    childWorkflowName,
    input,
    cwd,
    conversationId,
    userId,
    codebaseId,
    isolation,
    childIndex,
    itemHash,
    resumeChild,
    inputs,
  } = args;

  // Ordinary refusals return a failed outcome; failures before a child row exists
  // carry an empty childRunId. Terminal-write rejection escapes to the run owner.
  // A `workflow:` child freezes its own source AT ITS OWN START, from the parent's
  // AUTHORING directory rather than the parent's frozen copy of it. Both halves matter:
  // taking the bytes now (not at parent start) is what lets an author fix a child
  // workflow — removing a gate, say — and have a resumed parent pick the fix up; and
  // discovering from the capture rather than from the live directory is what stops the
  // child executing one moment's YAML against another moment's scripts.
  // Installed packs are the exception: the child takes them from the parent's capture.
  let parentSourceRoot: string | undefined;
  let installedFrom: InstalledPacksRoot | undefined;
  try {
    parentSourceRoot = await resolveChildDiscoveryRoot(parentRun.metadata);
    installedFrom = await resolveChildInstalledPacks(parentRun.metadata);
  } catch (err) {
    throw parentSourceUnreadable(cwd, err);
  }
  // Refusals and recursive execution share one owner until adoption or disposal.
  return withCapturedSource(async owner => {
    let childSource: PreparedWorkflowSource | undefined;
    try {
      childSource = await prepareWorkflowSource(deps, {
        sourceRoot: parentSourceRoot ?? cwd,
        ...(installedFrom !== undefined ? { installedFrom } : {}),
      });
      owner.hold(childSource);
    } catch (err) {
      if (isSourceReadFailure(err)) throw parentSourceUnreadable(parentSourceRoot ?? cwd, err);
      return failOutcome(
        `Failed to capture workflow source for sub-run '${childWorkflowName}': ${(err as Error).message}`
      );
    }

    // 1. Resolve the child workflow by NAME (static target — constitution guardrail).
    //    Resolution runs BEFORE the cycle check so a case-variant / suffix / substring
    //    reference to an ancestor (e.g. `workflow: SELFIE` naming its own run) is caught
    //    as a cycle by canonical name, not left to the less-informative depth cap.
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
        cwd,
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
      return failOutcome(
        `Failed to resolve sub-run '${childWorkflowName}': ${(err as Error).message}`
      );
    }
    if (!childWorkflow) {
      return failOutcome(`Unknown sub-run workflow '${childWorkflowName}'.`);
    }

    // 2. Cycle guard + depth cap (D9), compared against the RESOLVED canonical name.
    //    The child's ancestor chain is the parent plus the parent's ancestors; a
    //    resolved target already in the chain is a cycle.
    let ancestry: WorkflowRun[];
    try {
      ancestry = [parentRun, ...(await deps.store.getRunAncestry(parentRun.id))];
    } catch (err) {
      return failOutcome(
        `Failed to resolve run ancestry for sub-run guard: ${(err as Error).message}`
      );
    }
    if (ancestry.some(a => a.workflow_name === childWorkflow.name)) {
      return failOutcome(
        `Sub-run cycle detected: '${childWorkflow.name}' is already an ancestor of this run.`
      );
    }
    if (ancestry.length >= CHILD_WORKFLOW_DEPTH_CAP) {
      return failOutcome(
        `Sub-run depth cap (${String(CHILD_WORKFLOW_DEPTH_CAP)}) exceeded nesting '${childWorkflow.name}'.`
      );
    }

    // 2b. Enforce the RESOLVED child's declared `inputs:` contract (#2470) — the exact
    //     same resolution `include:` performs at load time, through the same shared
    //     implementation, so a `with:` map accepted by one surface is accepted by the
    //     other. It can only run here (not at load time) because the target is resolved
    //     late by design, so it sits before isolation/worktree creation and before the
    //     child run row exists: a contract violation must never leave an orphan worktree
    //     or a doomed child row behind.
    let childInputs: Record<string, JsonValue> | undefined;
    try {
      const resolved = resolveDeclaredInputs(
        inputs ?? {},
        childWorkflow.inputs,
        `Node '${nodeId}'`,
        `sub-run workflow '${childWorkflow.name}'`
      );
      childInputs = Object.keys(resolved).length > 0 ? resolved : undefined;
    } catch (err) {
      return failOutcome((err as Error).message);
    }

    let childPrepared: PreparedRunAiConfiguration;
    const configCwd = resumeChild?.run.working_path ?? cwd;
    try {
      childPrepared = await prepareRunAiConfiguration(deps, childWorkflow, configCwd, {
        codebaseId,
        userId,
        ...(resumeChild
          ? { continuationRun: resumeChild.run }
          : { aiConfigurationRun: parentRun, inheritAiConfiguration: true }),
        modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
        ...(runConfig ? { runConfig } : {}),
      });
      await assertRunCredentials(deps, childPrepared, { cwd: configCwd });
    } catch (error) {
      return failOutcome((error as Error).message, resumeChild?.run.id);
    }

    // 3. Resolve the child's execution cwd (slice 2, PR-A). `isolation: 'worktree'`
    //    runs the child in its own git worktree obtained from the injected resolver.
    //    A resume whose child run row still exists reuses that row's recorded path
    //    instead of resolving again; a resume whose child row is GONE (never written,
    //    or deleted) falls through to the fresh-spawn path and does re-resolve —
    //    safely, because the identifier is deterministic per (parent, node, index)
    //    and the env-row write is an upsert (see child-isolation-resolver.ts).
    //    `inherit` (or undefined) shares the parent's checkout — slice-1 behavior.
    //    Resolving AFTER the name + cycle guards means a bad reference never leaves an
    //    orphan worktree behind. The resolver throwing surfaces as a failed outcome
    //    (never a silent shared-checkout fallback — a parallel write into the shared
    //    checkout is the exact collision worktree isolation prevents).
    let childCwd: string;
    // Populated only when THIS spawn created a fresh isolated worktree — its env id +
    // branch are stamped into the child's metadata (S3; PR-E console grouping reads it).
    let childIsolationEnv: ChildIsolationResult | undefined;
    if (resumeChild) {
      // Reuse the child's own recorded working_path: its worktree for an isolated
      // child, the shared parent checkout for `inherit`. Reaching this branch at all
      // means the child row survived, so there is nothing to re-resolve.
      const priorPath = resumeChild.run.working_path;
      // An isolated child's worktree can be pruned by `isolation cleanup`/`complete`
      // between its failure and this resume. Reusing a vanished path would surface as a
      // deep ENOENT mid-run; fail fast with the same guidance the top-level CLI resume
      // gives (`assertResumeWorkingPathExists` in the CLI's workflow-isolation.ts).
      if (priorPath && !existsSync(priorPath)) {
        return failOutcome(
          `Cannot resume sub-run '${childWorkflowName}': its working path no longer exists ` +
            `(${priorPath}). The worktree may have been cleaned up — start a fresh run.`,
          resumeChild.run.id
        );
      }
      // `working_path` is nullable in the schema, and falling back to the parent's
      // `cwd` here would be the one silent shared-checkout fallback in this function —
      // for an ISOLATED child that is exactly the concurrent-write collision the
      // isolation was requested to prevent. Unreachable today (every child row is
      // created with a real path, see the createWorkflowRun call below), so this is
      // defense-in-depth: fail loudly rather than resume somewhere the author didn't ask for.
      if (!priorPath) {
        return failOutcome(
          `Cannot resume sub-run '${childWorkflowName}': its run row has no recorded working ` +
            'path, so the checkout it ran in is unknown — start a fresh run.',
          resumeChild.run.id
        );
      }
      childCwd = priorPath;
    } else if (isolation === 'worktree') {
      if (!resolveChildIsolation) {
        return failOutcome(
          `isolation: 'worktree' on sub-run '${childWorkflowName}' requires an injected ` +
            'child-isolation resolver (available for git-repo codebases run via the CLI or ' +
            "orchestrator). Remove the isolation or use 'inherit' (shared checkout)."
        );
      }
      try {
        childIsolationEnv = await resolveChildIsolation.resolve({
          setupEnvironment: childPrepared.config,
          parentRun,
          nodeId,
          childIndex,
          codebaseId,
        });
        childCwd = childIsolationEnv.cwd;
      } catch (err) {
        // The resolver already classified + logged the failure (child-isolation-resolver);
        // prepend the sub-run context for the node-facing outcome.
        return failOutcome(
          `Failed to create isolated worktree for sub-run '${childWorkflowName}': ${(err as Error).message}`
        );
      }
    } else {
      childCwd = cwd;
    }

    // 4. Create the child run row (fresh) or hydrate the failed one (resume path).
    let childOpts: ExecuteWorkflowOptions;
    let childRunId: string;
    // Thread the resolver into every child so a NESTED grandchild `workflow:` node can
    // also request its own worktree (nesting is first-class up to the depth cap) — the
    // recursive executeWorkflow otherwise has no resolver and would fail-fast. (The
    // sibling `container:` context has the same non-propagation gap today; out of scope
    // for this PR, but noted so it isn't mistaken for intentional.)
    try {
      if (resumeChild) {
        if (resumeChild.kind === 'failed') {
          const hydrated = await hydrateResumableRun(deps, resumeChild.run);
          if (hydrated) {
            childOpts = {
              ...hydrated,
              codebaseId,
              resolveChildIsolation,
              preparedSource: childSource,
            };
            childRunId = hydrated.preCreatedRun.id;
          } else {
            const preCreatedRun = await deps.store.resumeWorkflowRun(resumeChild.run.id);
            childOpts = {
              preCreatedRun,
              codebaseId,
              resolveChildIsolation,
              preparedSource: childSource,
            };
            childRunId = preCreatedRun.id;
          }
        } else {
          const inspection = await inspectResumableRun(deps, resumeChild.run);
          const completedNodeIds = new Set(inspection?.priorCompletedNodes.keys() ?? []);
          const priorNodeSessions = (
            await deps.store.listWorkflowRunNodeSessions(resumeChild.run.id)
          ).filter(row => completedNodeIds.has(row.node_id));
          const preCreatedRun = await deps.store.recoverCancelledFanOutRun(resumeChild.run.id);
          childOpts = {
            preCreatedRun,
            ...(inspection
              ? {
                  priorCompletedNodes: inspection.priorCompletedNodes,
                  priorUsage: inspection.priorUsage,
                  priorNodeSessions,
                }
              : {}),
            codebaseId,
            resolveChildIsolation,
            preparedSource: childSource,
          };
          childRunId = preCreatedRun.id;
        }
      } else {
        const childRun = await deps.store.createWorkflowRun({
          // The id its capture is already filed under (see prepareWorkflowSource).
          id: childSource.runId,
          workflow_name: childWorkflow.name,
          origin: parentRun.origin ?? undefined,
          codebase_id: codebaseId,
          user_message: input,
          working_path: childCwd,
          parent_run_id: parentRun.id,
          metadata: {
            [RUN_AI_CONFIGURATION_METADATA_KEY]: childPrepared.aiConfigurationSnapshot,
            [SUBRUN_METADATA_KEYS.parentNodeId]: nodeId,
            // Fan-out instance index (slice 2, PR-C) — stamped only for a fan-out child so
            // parent resume can re-key the ordered instance set by index (findChildRuns is
            // started_at-ordered, which ≠ items order under max_parallel concurrency). A
            // single (non-fan-out) child carries no child_index. The item-content hash rides
            // alongside so resume can WARN on a non-deterministic producer (same index, new item).
            ...(childIndex !== undefined ? { [SUBRUN_METADATA_KEYS.childIndex]: childIndex } : {}),
            ...(itemHash !== undefined ? { [SUBRUN_METADATA_KEYS.fanOutItemHash]: itemHash } : {}),
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
            ...(childInputs !== undefined
              ? {
                  [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
                    Object.entries(childInputs).map(([k, v]) => [k, canonicalValueText(v)])
                  ),
                  ...(Object.values(childInputs).some(v => typeof v !== 'string')
                    ? { [SUBRUN_METADATA_KEYS.inputsValues]: childInputs }
                    : {}),
                }
              : {}),
            // Record the child's own worktree env + branch (mirrors the container path's
            // isolation_env_id) so `isolation list` correlation + PR-E console grouping
            // can find it. Absent for `inherit`/shared-checkout children.
            ...(childIsolationEnv
              ? {
                  isolation_env_id: childIsolationEnv.envId,
                  ...(childIsolationEnv.ownedWorktree
                    ? { owned_worktree: childIsolationEnv.ownedWorktree }
                    : {}),
                  branch_name: childIsolationEnv.branchName,
                }
              : {}),
          },
        });
        childOpts = {
          preCreatedRun: childRun,
          codebaseId,
          resolveChildIsolation,
          preparedSource: childSource,
          ...(runConfig ? { runConfig } : {}),
          resolvedBaseBranch: childBaseBranch(childIsolationEnv, parentBaseBranch),
          ...(childIsolationEnv?.cutFromCommit !== undefined
            ? { cutFromCommit: childIsolationEnv.cutFromCommit }
            : {}),
        };
        childRunId = childRun.id;
      }
    } catch (err) {
      return failOutcome(
        `Failed to create sub-run '${childWorkflowName}': ${(err as Error).message}`
      );
    }

    // 5. Run the child in-process (reuses the whole lifecycle) in its resolved cwd
    //    (its own worktree when isolated, else the parent's checkout). Its terminal
    //    output + cost + tokens land in the child run metadata on completion.
    try {
      await executeWorkflow(
        deps,
        platform,
        conversationId,
        childCwd,
        childWorkflow,
        input,
        parentRun.origin ?? undefined,
        {
          ...childOpts,
          ...(resumeChild ? {} : { preparedAiConfiguration: childPrepared }),
          capturedSourceOwner: owner,
          modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
        }
      );

      // 6. Read the child back for the node-facing outcome (status + summary + cost +
      //    tokens). Works for synchronous completion AND a child paused at its gate.
      const finalChild = await readWorkflowLifecycle(childRunId, () =>
        deps.store.getWorkflowRun(childRunId)
      );
      if (!finalChild) {
        return failOutcome('Child run row disappeared after execution.', childRunId);
      }
      return childOutcomeFromRun(finalChild);
    } catch (err) {
      return recoverChildSetupFailure(deps, childRunId, childWorkflowName, err);
    }
  });
}

async function recoverChildSetupFailure(
  deps: WorkflowDeps,
  childRunId: string,
  childWorkflowName: string,
  err: unknown
): Promise<ChildWorkflowOutcome> {
  if (err instanceof TerminalStatusWriteError || err instanceof WorkflowStatusReadError) throw err;

  // Early setup may leave a child pending, so failWorkflowRun's running-only CAS
  // cannot release it. Cancellation covers both pending and running children.
  await requireTerminalStatusWrite(
    deps.store.cancelWorkflowRun(childRunId, { cancel_reason: 'precondition_failed' }),
    {
      workflowRunId: childRunId,
      site: 'executor.child_setup_cancel',
    }
  );
  return failOutcome(
    `Sub-run '${childWorkflowName}' errored: ${(err as Error).message}`,
    childRunId
  );
}
