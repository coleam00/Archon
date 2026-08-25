import type { WorkflowConfig } from './deps';
import {
  workflowRunConfigMetadataSchema,
  type WorkflowRunConfigLayer,
  type WorkflowRunConfigMetadata,
} from './schemas/run-config';

export const WORKFLOW_RUN_CONFIG_METADATA_KEY = 'run_config';

function mergeAssistantDefaults(
  base: WorkflowConfig['assistants'],
  layer: WorkflowRunConfigLayer['assistants']
): WorkflowConfig['assistants'] {
  if (!layer) return base;
  const merged: WorkflowConfig['assistants'] = { ...base };
  for (const [provider, defaults] of Object.entries(layer)) {
    merged[provider] = { ...(base[provider] ?? {}), ...defaults };
  }
  return merged;
}

/** Apply only the supplied run-owned values, leaving every omitted value untouched. */
export function applyWorkflowRunConfigLayer(
  base: WorkflowConfig,
  layer: WorkflowRunConfigLayer | undefined
): WorkflowConfig {
  if (!layer) return base;
  if (layer.workflows !== undefined && base.workflows === undefined) {
    throw new Error('Workflow config is missing quota policy defaults required by run config.');
  }
  const workflows =
    layer.workflows !== undefined && base.workflows !== undefined
      ? { ...base.workflows, ...layer.workflows }
      : undefined;
  return {
    ...base,
    ...(layer.assistant !== undefined ? { assistant: layer.assistant } : {}),
    assistants: mergeAssistantDefaults(base.assistants, layer.assistants),
    ...(workflows !== undefined ? { workflows } : {}),
    ...(layer.docsPath !== undefined ? { docsPath: layer.docsPath } : {}),
    ...(layer.envVars !== undefined ? { envVars: { ...base.envVars, ...layer.envVars } } : {}),
  };
}

export function readWorkflowRunConfigMetadata(
  metadata: Record<string, unknown> | undefined
): WorkflowRunConfigMetadata | undefined {
  const value = metadata?.[WORKFLOW_RUN_CONFIG_METADATA_KEY];
  if (value === undefined) return undefined;
  const parsed = workflowRunConfigMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Workflow run has invalid run_config metadata.');
  }
  return parsed.data;
}
