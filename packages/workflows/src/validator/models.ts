import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import { isIncludeDirective, isLoopGroupNode } from '../schemas';
import { buildAiProfile, isAliasRef, isLiteralSpec, resolveModelRef } from '../model-validation';
import type { ResolvedAiProfile } from '../model-validation';
import type { ResourceValidation } from './context';
import type { ValidationConfig, ValidationIssue } from './types';

const MODEL_CONFIG_HINT =
  'Fix tiers/aliases in .archon/config.yaml, with `archon ai tier set`, or in the console AI Settings panel';

type ValidatedWorkflow = Omit<WorkflowDefinition, 'nodes'> & {
  readonly nodes: readonly (DagNode | IncludeDirective)[];
};

/** The tiers/aliases profile model refs resolve against; a broken config is an issue. */
export function buildValidationAiProfile(
  config: ValidationConfig | undefined,
  defaultProvider: string | undefined,
  issues: ValidationIssue[]
): ResolvedAiProfile | undefined {
  try {
    return buildAiProfile(config?.assistant ?? defaultProvider, {
      repoTiers: config?.tiers,
      repoAliases: config?.aliases,
    });
  } catch (error) {
    issues.push({
      level: 'error',
      field: 'model',
      message: (error as Error).message,
      hint: `${MODEL_CONFIG_HINT} — or use literal provider model strings.`,
    });
    return undefined;
  }
}

function validateModelRef(
  validation: ResourceValidation,
  ref: NonNullable<DagNode['model']>,
  nodeId?: string
): void {
  if (!validation.aiProfile) return;
  try {
    resolveModelRef(validation.aiProfile, ref);
  } catch (error) {
    validation.issues.push({
      level: 'error',
      ...(nodeId !== undefined ? { nodeId } : {}),
      field: 'model',
      message: (error as Error).message,
      hint: `${MODEL_CONFIG_HINT} — or use a literal provider model string.`,
    });
  }
}

/** A tier or alias names its provider; a literal model string does not. */
function modelProvider(
  aiProfile: ResolvedAiProfile | undefined,
  model: DagNode['model']
): string | undefined {
  if (!aiProfile || !model) return undefined;
  try {
    const modelSpec = resolveModelRef(aiProfile, model);
    return isLiteralSpec(modelSpec) ? undefined : modelSpec.provider;
  } catch {
    // validateModelRef reports the actionable model error separately.
    return undefined;
  }
}

/** Check the workflow-level model; returns the provider its nodes inherit. */
export function validateWorkflowModel(
  validation: ResourceValidation,
  workflow: ValidatedWorkflow
): string | undefined {
  const { config } = validation;
  if (validation.requiresPortableModelRefs && isAliasRef(workflow.model)) {
    validation.issues.push({
      level: 'error',
      field: 'model',
      message: `Workflow '${workflow.name}' uses custom model alias '${workflow.model}', which is not portable for ${config?.workflowSource} workflows`,
      hint: "Use small, medium, large, a literal provider model string, or a preference list that ends in one, such as ['@reviewer', medium].",
    });
  }
  if (workflow.model) validateModelRef(validation, workflow.model);
  return (
    modelProvider(validation.aiProfile, workflow.model) ??
    workflow.provider ??
    validation.defaultProvider
  );
}

export function validateNodeModel(validation: ResourceValidation, node: DagNode): void {
  if (!('model' in node) || !node.model) return;
  if (validation.requiresPortableModelRefs && isAliasRef(node.model)) {
    validation.issues.push({
      level: 'error',
      nodeId: node.id,
      field: 'model',
      message: `Node '${node.id}' uses custom model alias '${node.model}', which is not portable for ${validation.config?.workflowSource} workflows`,
      hint: "Use small, medium, large, a literal provider model string, or a preference list that ends in one, such as ['@reviewer', medium].",
    });
  }
  validateModelRef(validation, node.model, node.id);
}

/** Get the resolved provider for a node (node-level > workflow-level > config default).
 *  Returns undefined only when no provider is set at any level. */
function resolveProvider(
  node: DagNode,
  workflowProvider?: string,
  defaultProvider?: string
): string | undefined {
  if ('provider' in node && node.provider) return node.provider;
  return workflowProvider ?? defaultProvider;
}

function resolveValidationProvider(
  node: DagNode,
  workflowProvider: string | undefined,
  validation: ResourceValidation
): string | undefined {
  const provider = resolveProvider(node, workflowProvider, validation.defaultProvider);
  if (!('model' in node)) return provider;
  return modelProvider(validation.aiProfile, node.model) ?? provider;
}

/**
 * Flatten top-level nodes plus every loop_group body while carrying the provider
 * scope execution gives each group. Body nodes inherit the group's resolved
 * provider/model unless they override it themselves.
 */
export function collectNodeProviders(
  validation: ResourceValidation,
  nodes: readonly (DagNode | IncludeDirective)[],
  inheritedProvider: string | undefined
): { node: DagNode | IncludeDirective; provider: string | undefined }[] {
  return nodes.flatMap(node => {
    if (isIncludeDirective(node)) return [{ node, provider: inheritedProvider }];
    const provider = resolveValidationProvider(node, inheritedProvider, validation);
    return [
      { node, provider },
      ...(isLoopGroupNode(node)
        ? collectNodeProviders(validation, node.loop_group.nodes, provider)
        : []),
    ];
  });
}
