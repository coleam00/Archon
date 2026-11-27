/**
 * The run config and model rebindings a prepared start runs on.
 *
 * It sits beside the host's preparation rather than inside it because the decision is about
 * the start's own choices, and it is the one place that answers "which config applies".
 */
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { RunModelOverrides } from '@archon/workflows/schemas/model-binding';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import { itemRunConfig, loadWorkflowRunConfigFile } from '../config/run-config';

/** The item a start is on and its runs, as `bindingItem` reads them. */
export interface StartItemRuns {
  item: WorkflowItem;
  runs: readonly AttentionRead<{ id: string; metadata?: Record<string, unknown> }>[];
}

/**
 * The run config and model rebindings a start runs on.
 *
 * A fire's `--config` replaces the config this start would otherwise inherit, as `--config`
 * does for `workflow run`; its `--model` rebinds tiers and `@alias`es over whichever config
 * applies. Without either, the item's own config wins over `configSource`: a binding file's
 * config is written once for the install (`pack bindings --config`), a default for an item's
 * first run, not a change to this item's config.
 *
 * A file is read only for the branch that uses it, so a config a start does not use cannot
 * fail it: a binding whose `configSource` has gone still starts on the item's own config, or
 * on a fire's `--config`.
 */
export async function startConfiguration(
  intent: ResourceStartBindingIntent,
  found: StartItemRuns | null
): Promise<{
  runConfig: WorkflowRunConfigInput | undefined;
  models: RunModelOverrides | undefined;
}> {
  const overrides = intent.startOverrides;
  const models = overrides?.models;
  if (overrides?.config !== undefined) {
    return {
      runConfig: await loadWorkflowRunConfigFile(overrides.config.path),
      models,
    };
  }
  const inherited = (): WorkflowRunConfigInput | undefined =>
    found ? itemRunConfig(found.item.key, found.runs) : undefined;
  const declared = async (): Promise<WorkflowRunConfigInput | undefined> =>
    intent.launch.configSource
      ? await loadWorkflowRunConfigFile(intent.launch.configSource)
      : undefined;
  return { runConfig: inherited() ?? (await declared()), models };
}
