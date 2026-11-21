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
import {
  readWorkflowSourceState,
  type WorkflowItem,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { Codebase } from '../schemas/codebase';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { selectStartedWorkflow } from './binding-workflow';
import {
  bindingDefinitionsPlan,
  DefinitionSourceError,
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
    if (!(error instanceof DefinitionSourceError) || !(await pinnedInPlace(host, intent, cwd)))
      throw error;
    return prepareWorkflowSource(host.deps, {
      sourceRoot: cwd,
      definitions: { from: 'checkout', checkout: cwd },
    });
  }
}

/** Whether the workflow the binding starts, as the checkout holds it, pins itself in place. */
async function pinnedInPlace(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  cwd: string
): Promise<boolean> {
  const discovered = await discoverWorkflowsWithConfig(
    cwd,
    host.deps.loadConfig,
    host.deps.providers
  );
  const started = selectStartedWorkflow(intent.launch, discovered);
  return 'workflow' in started && started.workflow.worktree?.enabled === false;
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
 * now takes is another branch than its definitions came from (the item's landing branch
 * changed while it waited), since the run would then propose against one branch with the
 * definitions of another.
 */
export function definitionsStartCommit(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  baseOverride: string | undefined
): { commit: string; branch: BranchName } | undefined {
  const state = readWorkflowSourceState(run.metadata);
  const definitions = state.kind === 'recorded' ? state.record.definitions : undefined;
  if (definitions?.from !== 'base') return undefined;
  if (baseOverride !== undefined && baseOverride !== definitions.branch)
    throw new Error(
      `Run '${run.id}' read its definitions from ${definitions.remote}/${definitions.branch}, ` +
        `but now starts on base '${baseOverride}'. Start it again so both come from one branch.`
    );
  return { commit: definitions.commit, branch: toBranchName(definitions.branch) };
}
