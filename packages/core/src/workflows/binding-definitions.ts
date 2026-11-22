/**
 * Where a binding start reads its definitions, and the commit its worktree is cut from.
 * See `withLayeredDefinitions` for the rule.
 */
import { toBranchName, type BranchName } from '@archon/git';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  disposeWorkflowSource,
  prepareWorkflowSource,
  type PreparedWorkflowSource,
} from '@archon/workflows/run-source';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import {
  readWorkflowSourceState,
  type WorkflowItem,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { Codebase } from '../schemas/codebase';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  bindingDefinitionsPlan,
  baseRefName,
  DefinitionSourceError,
  resolveDefinitionsBase,
  startsPinnedInPlace,
  withLayeredDefinitions,
} from './definition-source';
import type { WorkflowHost } from './host-store';
import { LandingBranchRefusedError, resolveRunLanding } from './item-landing';

/** Capture a binding's definitions by the rule in `bindingDefinitionsPlan`. */
export async function captureBindingDefinitions(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  cwd: string,
  codebase: Codebase,
  item: WorkflowItem | null
): Promise<PreparedWorkflowSource> {
  const landing = item ? await preparedLanding(host.deps.store, codebase, item) : undefined;
  const plan = bindingDefinitionsPlan(intent.launch, cwd, codebase, landing);
  if (plan.kind === 'directory')
    return prepareWorkflowSource(host.deps, {
      sourceRoot: plan.root,
      definitions: plan.definitions,
    });
  try {
    return await withLayeredDefinitions(plan.input, composed =>
      prepareWorkflowSource(host.deps, {
        sourceRoot: composed.root,
        origin: cwd,
        includeProjectConfig: true,
        definitions: composed.definitions,
      })
    );
  } catch (error) {
    // An in-place workflow reads its checkout as it is, so it never needs the base.
    if (
      !(error instanceof DefinitionSourceError) ||
      !startsPinnedInPlace(
        intent.launch,
        await discoverWorkflowsWithConfig(cwd, host.deps.loadConfig, host.deps.providers)
      )
    )
      throw error;
    return prepareWorkflowSource(host.deps, {
      sourceRoot: cwd,
      definitions: { from: 'checkout', checkout: cwd },
    });
  }
}

/**
 * The item's landing branch, for the base its definitions are read from. A branch that
 * cannot be used is refused when the run starts (`landingLane`), on the run with its
 * reason, so here it only leaves the base to the binding.
 */
export async function preparedLanding(
  store: Parameters<typeof resolveRunLanding>[0],
  project: Parameters<typeof resolveRunLanding>[1],
  item: WorkflowItem
): Promise<string | undefined> {
  try {
    return (await resolveRunLanding(store, project, item))?.branch;
  } catch (error) {
    if (error instanceof LandingBranchRefusedError) return undefined;
    throw error;
  }
}

/**
 * The checkout's own copy of a workflow the base pins in place must run in place too:
 * its isolation is decided from this copy, and a worktree run must not read checkout-only
 * definitions. A copy that does not pin itself in place refuses the start.
 */
export function refuseWorktreeAfterInPlace(workflow: ResolvedWorkflow): ResolvedWorkflow {
  if (workflow.worktree?.enabled === false) return workflow;
  throw new Error(
    `Workflow '${workflow.name}' runs in place on the base branch, but the checkout's copy does ` +
      'not; its start is refused. Bring the checkout up to date with the base branch, or name ' +
      'a source with launch.discoveryCwd.'
  );
}

/**
 * An in-place run's checkout is its one commit, so a start planned on the base branch
 * whose workflow runs in place reads its definitions there instead.
 */
export async function recaptureInPlace(
  host: WorkflowHost,
  layered: PreparedWorkflowSource,
  cwd: string
): Promise<PreparedWorkflowSource> {
  const source = await prepareWorkflowSource(host.deps, {
    sourceRoot: cwd,
    definitions: { from: 'checkout', checkout: cwd },
  });
  await disposeWorkflowSource({ captureRoot: layered.anchor.root });
  return source;
}

/**
 * The item a binding start is on: the one admission's `namedItem` writes the run onto,
 * the binding's key, else the receipt's, in the project of the launch cwd, with its runs.
 * Null for a start on no item or an item not written yet.
 */
export async function bindingItem(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  receiptId: string
): Promise<Awaited<ReturnType<WorkflowHost['deps']['store']['getItemRuns']>>> {
  const itemKey = intent.itemKey ?? (await host.deps.store.getStartReceipt(receiptId))?.itemKey;
  if (!itemKey) return null;
  // No registered project means no item yet: admission registers it and writes the item new.
  const { codebase } = await resolveCodebaseForPath(intent.launch.cwd, host.records.codebases);
  if (!codebase) return null;
  return await host.deps.store.getItemRuns(
    projectKeyForCodebase(codebase, codebase.default_cwd),
    itemKey
  );
}

/**
 * The commit a run's worktree is cut from when its definitions came from the base branch:
 * the one they were captured at, so code and definitions are one commit. A start that
 * waited in the queue runs on a base as old as its wait. Refused when the base the run
 * now takes is another branch than its definitions came from, since the run would then
 * propose against one branch with the definitions of another. That base is resolved as
 * worktree creation resolves it, so an item that lost its landing branch while it waited
 * (an inherited `part_of` link ended) is compared with the project default, not waved on.
 */
export async function definitionsStartCommit(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  codebase: Pick<Codebase, 'default_cwd' | 'default_branch'>,
  baseOverride: string | undefined
): Promise<{ commit: string; branch: BranchName } | undefined> {
  const state = readWorkflowSourceState(run.metadata);
  const definitions = state.kind === 'recorded' ? state.record.definitions : undefined;
  if (definitions?.from !== 'base') return undefined;
  const { branch } = await resolveDefinitionsBase({
    checkout: codebase.default_cwd,
    baseOverride,
    defaultBranch: codebase.default_branch?.trim() || undefined,
  });
  if (branch !== definitions.branch)
    throw new Error(
      `Run '${run.id}' read its definitions from ${baseRefName(definitions)}, ` +
        `but now starts on base '${branch}'. Start it again so both come from one branch.`
    );
  return { commit: definitions.commit, branch: toBranchName(definitions.branch) };
}
