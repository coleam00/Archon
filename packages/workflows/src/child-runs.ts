import { createLogger } from '@archon/paths';
import { existsSync } from 'fs';
import type { ChildIsolationResolver, ChildIsolationResult } from './child-isolation';
import type { ChildWorkflowOutcome, RunChildWorkflowArgs } from './dag/child-run';
import { childOutcomeFromRun } from './dag/child-run';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { spellWorkflowCommand } from './deps';
import { executeWorkflow, type ExecuteWorkflowOptions } from './executor';
import { safeSendMessage } from './executor-shared';
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
  RunSourceReleaseError,
  prepareWorkflowSource,
  resolveContinuationWorkflow,
  withCapturedSource,
  type PreparedWorkflowSource,
} from './run-source';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowRun,
  WorkflowRunStatus,
} from './schemas';
import {
  SUBRUN_METADATA_KEYS,
  isApprovalContext,
  isFanOutBlockReleased,
  isRunBlockedOnChild,
} from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { continuablePauseCursor } from './store';
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

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

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
 * fails cleanly rather than the whole DAG throwing. Terminal status-write failures
 * propagate because the child has no trustworthy terminal outcome to return.
 */
export async function runChildWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  args: RunChildWorkflowArgs,
  resolvedModelOverrides: ResolvedRunModelOverrides,
  runConfig: WorkflowRunConfigInput | undefined,
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
  const failOutcome = (error: string, childRunId = ''): ChildWorkflowOutcome => {
    return { childRunId, status: 'failed', error };
  };

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
    try {
      childPrepared = await prepareRunAiConfiguration(
        deps,
        childWorkflow,
        resumeChild?.run.working_path ?? cwd,
        {
          codebaseId,
          userId,
          ...(resumeChild
            ? { continuationRun: resumeChild.run }
            : { aiConfigurationRun: parentRun, inheritAiConfiguration: true }),
          modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
          ...(runConfig ? { runConfig } : {}),
        }
      );
      await assertRunCredentials(deps, childPrepared);
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
      // gives (workflow.ts resume precedent).
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
      const finalChild = await deps.store.getWorkflowRun(childRunId);
      if (!finalChild) {
        return failOutcome('Child run row disappeared after execution.', childRunId);
      }
      return childOutcomeFromRun(finalChild);
    } catch (err) {
      if (err instanceof TerminalStatusWriteError || err instanceof RunSourceReleaseError)
        throw err;

      // Ordinary setup/read-back failures become failed child outcomes after cleanup.
      // A terminal write rejection or unconfirmed source release escapes: cleanup
      // cannot establish an outcome, and a successor may now own the child.
      //
      // Wedge guard (symmetric to maybeResumeParentRun's post-CAS handler): a throw in
      // executeWorkflow's EARLY setup (config load, getCodebaseEnvVars, token
      // resolution) fires BEFORE the status→running flip and BEFORE its own catch-all,
      // stranding the pre-created child at 'pending' (or 'running' on a later window) —
      // a non-terminal row that holds the working-path lock. `cancelWorkflowRun` (NOT
      // failWorkflowRun, whose `WHERE status='running'` would miss the 'pending' case)
      // flips any non-terminal child to 'cancelled' and no-ops on a child that reached
      // completed/cancelled on its own. childRunId is always assigned once step 3 ran.
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
  });
}

/**
 * After a `workflow:` sub-run reaches a terminal state, re-enter its PARENT run if
 * the parent is paused blocked on THIS child (#2121 Phase 2). This is the D5 hook
 * that turns a child's completion into a parent resume — the cross-run analogue of
 * a human approve, driven in the same process.
 *
 * No-op (guarded) when:
 *  - the parent is not 'paused' (synchronous first-run path: the parent is still
 *    'running' on the call stack — output threads directly from the returned outcome),
 *  - the parent's gate isn't a `child_workflow` or `fan_out` gate,
 *  - a DIFFERENT child of the same parent terminated (childRunId mismatch), or
 *  - the parent is a fan-out still waiting on other children (`isFanOutBlockReleased`).
 *
 * Failures before the parent resumes leave the child result intact. Once the parent
 * has resumed, a rejected terminal status write propagates because the child cannot
 * report an ordinary result while the parent remains running.
 *
 * `resolveChildIsolation` is a plain parameter rather than part of the resume state:
 * `executeWorkflow`'s resume state carries what was RECORDED about the prior run, and a resolver
 * is a live capability of the surface driving this process — it cannot be rehydrated
 * from a run row. It has to be forwarded because the parent picks up here *mid-DAG*:
 * a parent whose gated child just finished may still have `isolation: 'worktree'`
 * nodes ahead of it, and re-entering without the resolver fails them with
 * "requires an injected child-isolation resolver" even though the surface wired one.
 * The child's resolver is the right one to pass: a child inherits the parent's
 * `codebase_id`, and the resolver is codebase-bound and rejects a mismatch loudly.
 */
export async function maybeResumeParentRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  childRun: WorkflowRun,
  resolveChildIsolation?: ChildIsolationResolver
): Promise<void> {
  const parentRunId = childRun.parent_run_id;
  if (!parentRunId) return;

  // Surface a reconciliation failure to the user with a manual-recovery pointer
  // (per the repo's surface-ambiguous-state principle): the child terminated but the
  // parent stayed paused, so a log-only return leaves a stale "blocked on sub-run"
  // gate with no signal. Guarded (safeSendMessage never throws) so it honors the
  // never-throws contract. Only called once we've confirmed the parent IS blocked on
  // THIS child — never for the synchronous no-op or a different-child terminal.
  const notifyStuck = async (reason: string): Promise<void> => {
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Sub-run \`${childRun.id.slice(0, 8)}\` finished, but its parent run ` +
        `\`${parentRunId.slice(0, 8)}\` couldn't auto-resume (${reason}). ` +
        `Resume it manually: \`${spellWorkflowCommand(platform, `resume ${parentRunId}`)}\``
    );
  };

  let parent: WorkflowRun | null;
  try {
    parent = await deps.store.getWorkflowRun(parentRunId);
  } catch (err) {
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_lookup_failed'
    );
    await notifyStuck('the parent run could not be looked up');
    return;
  }
  if (parent?.status !== 'paused') return; // synchronous no-op, or already resumed

  // The core "parent blocked on THIS child" invariant lives in one shared predicate
  // (isRunBlockedOnChild) so this hook and the abandon-strand detector can't drift.
  if (!isRunBlockedOnChild(parent, childRun.id)) {
    // Paused but not blocked on this child. Distinguish a MALFORMED child_workflow
    // gate (missing childRunId — an invariant violation that would wedge the parent
    // forever; make it loud) from a normal different-child / non-child gate (silent).
    const approval = isApprovalContext(parent.metadata?.approval)
      ? parent.metadata.approval
      : undefined;
    if (approval?.type === 'child_workflow' && !approval.childRunId) {
      getLog().error(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_resume_malformed_gate_missing_child_run_id'
      );
    }
    return;
  }

  // A fan-out parent waits on several children. Continuing it on every child's finish
  // would only re-pause it and send another "waiting" notice.
  try {
    if (!(await isFanOutParentReleased(deps, parent))) {
      getLog().info(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_resume_waiting_on_children'
      );
      return;
    }
  } catch (err) {
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_children_lookup_failed'
    );
    await notifyStuck("the parent's sub-runs could not be looked up");
    return;
  }

  await continueBlockedRun(
    deps,
    platform,
    conversationId,
    parent,
    notifyStuck,
    { childRunId: childRun.id, childStatus: childRun.status },
    resolveChildIsolation
  );
}

/**
 * True unless `run` is paused on a `fan_out` gate whose children have not released it
 * (`isFanOutBlockReleased`). Every other gate is released by its single child.
 */
export async function isFanOutParentReleased(
  deps: WorkflowDeps,
  run: WorkflowRun
): Promise<boolean> {
  const approval = run.metadata?.approval;
  if (!isApprovalContext(approval) || approval.type !== 'fan_out') return true;
  const statusById = new Map(
    (await deps.store.findChildRuns(run.id)).map(child => [child.id, child.status])
  );
  return isFanOutBlockReleased(approval, id => statusById.get(id));
}

/**
 * Continue a paused run whose blocking child (or children) released it: resolve its
 * workflow from the source it started with, claim the resume, and execute it. Returns
 * the execution result, or undefined when it stood down (the run stays paused and
 * resumable, and `notifyStuck` has told the user, unless another resume won the claim).
 * `trigger` is log context only.
 */
export async function continueBlockedRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  parent: WorkflowRun,
  notifyStuck: (reason: string) => Promise<void>,
  trigger: { childRunId?: string; childStatus?: WorkflowRunStatus },
  resolveChildIsolation?: ChildIsolationResolver
): Promise<WorkflowExecutionResult | undefined> {
  const parentRunId = parent.id;
  const parentCwd = parent.working_path;
  if (!parentCwd) {
    getLog().warn(
      { parentRunId, childRunId: trigger.childRunId },
      'workflow.parent_resume_no_working_path'
    );
    await notifyStuck('the parent has no recorded working path');
    return undefined;
  }

  let parentWorkflow: ResolvedWorkflow | undefined;
  try {
    // Reload the parent's graph from the source IT started with. Rediscovering from
    // `parentCwd` is how a mid-run authoring edit used to change an already-running
    // parent's DAG, so stored node output could be reinterpreted by a different node.
    //
    // Through the shared entry point like every other continuation surface. This spot
    // hand-rolled the same sequence and read the capture twice for it, which is how the
    // fifth surface quietly ends up behaving differently from the other four. Throws when
    // the recorded capture no longer verifies; the catch below leaves the parent resumable
    // rather than silently running other source.
    const continuation = await resolveContinuationWorkflow(deps, parent, parentCwd);
    if (continuation) {
      parentWorkflow = continuation.workflow;
    } else {
      // No recorded source: a parent predating capture, which resumes live as it always did.
      const { workflows } = await discoverWorkflowsWithConfig(
        parentCwd,
        deps.loadConfig,
        deps.providers
      );
      parentWorkflow = resolveWorkflowName(
        parent.workflow_name,
        workflows.map(w => w.workflow)
      );
    }
  } catch (err) {
    getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_discovery_failed');
    await notifyStuck('workflow discovery failed');
    return undefined;
  }
  if (!parentWorkflow) {
    getLog().warn(
      { parentRunId, workflowName: parent.workflow_name },
      'workflow.parent_resume_workflow_not_found'
    );
    await notifyStuck(`the parent workflow '${parent.workflow_name}' could not be found`);
    return undefined;
  }

  let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
  try {
    hydrated = await hydrateResumableRun(deps, parent);
  } catch (err) {
    // Nothing has been mutated yet on a pre-CAS throw (resumeWorkflowRun's CAS is
    // hydrate's last step; a lost CAS throws WorkflowNotResumableError instead) —
    // the parent stays 'paused' and manually resumable, so log and stand down.
    if (err instanceof Error && err.name === 'WorkflowNotResumableError') {
      // Benign race: a concurrent (manual or duplicate) resume won the CAS and
      // now owns the parent. Not an error — no user-facing message (it IS resuming).
      getLog().info(
        { parentRunId, childRunId: trigger.childRunId },
        'workflow.parent_auto_resume_lost_race'
      );
    } else {
      getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_hydrate_failed');
      await notifyStuck('preparing the parent for resume failed');
    }
    return undefined;
  }
  if (!hydrated) {
    // A parent paused on a child_workflow or fan_out gate is always resumable (see
    // reRunsOwnNodeOnResume), so null here is unexpected.
    getLog().warn({ parentRunId }, 'workflow.parent_resume_nothing_to_resume');
    await notifyStuck('the parent had no resumable state');
    return undefined;
  }

  getLog().info(
    { parentRunId, childRunId: trigger.childRunId, childStatus: trigger.childStatus },
    'workflow.parent_auto_resume_started'
  );
  try {
    return await executeWorkflow(
      deps,
      platform,
      conversationId,
      parentCwd,
      parentWorkflow,
      parent.user_message ?? '',
      parent.origin ?? undefined,
      {
        ...hydrated,
        codebaseId: parent.codebase_id ?? undefined,
        resolveChildIsolation,
      }
    );
  } catch (err) {
    if (err instanceof TerminalStatusWriteError || err instanceof RunSourceReleaseError) throw err;

    // The hydrate CAS above already flipped the parent paused→running, and
    // executeWorkflow's own failWorkflowRun catch-all doesn't cover its early
    // setup (config load, env/credential resolution). Without this handler a
    // throw there would strand the parent at 'running' — a non-terminal status
    // resumeWorkflow refuses, leaving destructive abandon as the only exit.
    // Land it in 'failed' instead so it stays resumable.
    getLog().error(
      { err: err as Error, parentRunId, childRunId: trigger.childRunId },
      'workflow.parent_auto_resume_execute_failed'
    );
    const error = `Auto-resume after sub-run failed: ${(err as Error).message}`;
    await requireTerminalStatusWrite(deps.store.failWorkflowRun(parentRunId, error), {
      workflowRunId: parentRunId,
      site: 'workflow.parent_auto_resume_fail_mark_failed',
    });
    return { success: false, workflowRunId: parentRunId, error };
  }
}

/**
 * A run that stopped executing while paused where the continuation host continues it gives
 * back its resource slot (`releasePausedRunSlot`); its continuation takes one again. Called
 * only once every node of this execution has settled, so nothing of the run still runs.
 */
export async function releaseContinuablePauseSlot(
  deps: WorkflowDeps,
  run: WorkflowRun
): Promise<void> {
  const cursor = continuablePauseCursor(run);
  if (!cursor) return;
  try {
    await deps.store.releasePausedRunSlot(run.id, cursor);
  } catch (err) {
    // Holding the slot is the safe direction: the run stays paused and correct, and its
    // resume takes the slot it still holds.
    getLog().warn(
      { err: err as Error, workflowRunId: run.id },
      'workflow.paused_slot_release_failed'
    );
  }
}
