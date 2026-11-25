/**
 * Workflow and command validation — Level 3 (resource resolution).
 *
 * Levels 1-2 (syntax + structure) are handled by parseWorkflow() in loader.ts.
 * This module adds Level 3: checking that referenced resources actually exist
 * on disk (command files, MCP configs, skill directories).
 *
 * Lives in @archon/workflows (no @archon/core dependency) so both CLI and
 * REST API can use it. This module is the public entry; each resource kind has its own
 * validator in `validator/`.
 */
import { NoDefaultProviderError, type ProviderRegistry } from '@archon/provider-contract';
import { providerInvocation } from './dag/capability-preflight';
import { TierResolutionError } from './model-validation';
import {
  assistantModelDefaults,
  resolveNodeModel,
  resolveNodeModelScope,
  resolveWorkflowModelScope,
  type WorkflowModelScope,
} from './node-model-resolution';
import type { DagNode, IncludeDirective, WorkflowDefinition } from './schemas';
import { isIncludeDirective } from './schemas';
import { validateProviderCapabilities } from './validator/capabilities';
import { discoverAvailableCommands, validateCommandReferences } from './validator/commands';
import type { NodeValidation, ResourceValidation } from './validator/context';
import { validateMcp } from './validator/mcp';
import {
  buildValidationAiProfile,
  collectNodeProviders,
  validateNodeModel,
  validateWorkflowModel,
} from './validator/models';
import { validateOutputFormat } from './validator/output-format';
import { validateScriptNode } from './validator/scripts';
import { validateShellOutputRefs } from './validator/shell-output-refs';
import { validateSkills } from './validator/skills';
import type { ValidationConfig, ValidationIssue } from './validator/types';
import { validateBundledWorkflowTarget } from './validator/workflow-targets';

export {
  makeWorkflowResult,
  type CommandValidationResult,
  type ScriptValidationResult,
  type ValidationConfig,
  type ValidationIssue,
  type WorkflowValidationResult,
} from './validator/types';
export { validateProjectPackSettings } from './pack-settings';
export { discoverAvailableCommands, validateCommand } from './validator/commands';
export { discoverAvailableScripts, validateScript } from './validator/scripts';

/**
 * Validate a workflow's external resource references (Level 3).
 *
 * Checks that command files, MCP configs, and skill directories actually exist.
 * Call this AFTER parseWorkflow() has passed (Levels 1-2 are prerequisites).
 */
export async function validateWorkflowResources(
  workflow: Omit<WorkflowDefinition, 'nodes'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  },
  cwd: string,
  providers: ProviderRegistry,
  config?: ValidationConfig,
  defaultProvider?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const sourceRoot = config?.sourceRoot ?? cwd;
  const availableCommands = await discoverAvailableCommands(sourceRoot, config);
  const validation: ResourceValidation = {
    cwd,
    sourceRoot,
    providers,
    config,
    defaultProvider,
    aiProfile: buildValidationAiProfile(config, defaultProvider, issues),
    requiresPortableModelRefs:
      config?.workflowSource === 'bundled' ||
      config?.workflowSource === 'global' ||
      config?.workflowSource === 'installed',
    availableCommands,
    issues,
  };
  const workflowProvider = validateWorkflowModel(validation, workflow);
  validateProviderSelection(validation, workflow);

  for (const { node, provider } of collectNodeProviders(
    validation,
    workflow.nodes,
    workflowProvider
  )) {
    // Include directives carry no resources to check — the target workflow is resolved
    // and inlined at DISCOVERY time (see include-expander.ts), so discovery-fed
    // validation (CLI `validate workflows`) sees the already-expanded nodes and checks
    // their commands/mcp/skills normally. This skip is DEFENSIVE-ONLY: no current
    // caller reaches it with an unexpanded include (POST /api/workflows/validate only
    // runs parseWorkflow, not this resource pass). Kept so a future raw caller can't
    // crash here.
    if (isIncludeDirective(node)) continue;
    await validateNodeResources(validation, nodeValidation(validation, node, provider));
  }

  return issues;
}

const PROVIDER_HINT =
  'Run `archon ai default <provider>`, or set `provider:`, a tier, or `@alias`.';

function unsetModelScope(effort: WorkflowModelScope['effort']): WorkflowModelScope {
  return {
    provider: undefined,
    model: undefined,
    preset: undefined,
    tier: undefined,
    effort,
    providerOrigin: 'unset',
  };
}

function recordedModelRefError(error: unknown): boolean {
  return (
    error instanceof TierResolutionError ||
    (error instanceof Error && error.message.startsWith('Unknown alias '))
  );
}

function validateProviderSelection(
  validation: ResourceValidation,
  workflow: Omit<WorkflowDefinition, 'nodes'> & {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }
): void {
  const assistant = validation.config?.assistant ?? validation.defaultProvider;
  const models = assistantModelDefaults({ assistants: validation.config?.assistants ?? {} });
  let scope: WorkflowModelScope;
  try {
    scope = resolveWorkflowModelScope(workflow, assistant, models, validation.aiProfile);
  } catch (error) {
    if (!(error instanceof NoDefaultProviderError)) {
      if (!recordedModelRefError(error)) throw error;
      scope = resolveWorkflowModelScope(
        { provider: workflow.provider, effort: workflow.effort },
        assistant,
        models,
        validation.aiProfile
      );
    } else {
      scope = unsetModelScope(workflow.effort);
    }
  }

  const visit = (
    nodes: readonly (DagNode | IncludeDirective)[],
    current: WorkflowModelScope
  ): void => {
    for (const node of nodes) {
      const invocation = providerInvocation(node);
      if (invocation.kind === 'none') continue;
      if (invocation.kind === 'group') {
        visit(
          invocation.node.loop_group.nodes,
          groupScope(validation, invocation.node, current, models)
        );
        continue;
      }
      const invoked = invocation.kind === 'gate_rework' ? invocation.rework : invocation.node;
      recordResolvedProvider(validation, invoked, current, models);
    }
  };
  visit(workflow.nodes, scope);
}

function groupScope(
  validation: ResourceValidation,
  group: DagNode,
  current: WorkflowModelScope,
  models: Readonly<Record<string, string | undefined>>
): WorkflowModelScope {
  try {
    const resolved = resolveNodeModelScope(group, current, models, validation.aiProfile);
    return {
      ...current,
      provider: resolved.provider,
      model: resolved.model,
      preset: resolved.preset,
      tier: resolved.tier,
      providerOrigin: resolved.providerOrigin,
    };
  } catch (error) {
    if (error instanceof NoDefaultProviderError) {
      validation.issues.push(missingProviderIssue(group.id, error));
    } else if (!recordedModelRefError(error)) {
      throw error;
    }
    return current;
  }
}

function recordResolvedProvider(
  validation: ResourceValidation,
  node: DagNode,
  current: WorkflowModelScope,
  models: Readonly<Record<string, string | undefined>>
): void {
  try {
    resolveNodeModel(node, current, models, validation.aiProfile);
  } catch (error) {
    if (!(error instanceof NoDefaultProviderError)) {
      if (!recordedModelRefError(error)) throw error;
      return;
    }
    validation.issues.push(missingProviderIssue(node.id, error));
  }
}

function missingProviderIssue(nodeId: string, error: NoDefaultProviderError): ValidationIssue {
  return {
    level: 'error',
    field: 'provider',
    nodeId,
    message: error.message,
    hint: PROVIDER_HINT,
  };
}

function nodeValidation(
  validation: ResourceValidation,
  node: DagNode,
  provider: string | undefined
): NodeValidation {
  const descriptor = provider ? validation.providers.get(provider) : undefined;
  return { node, provider, descriptor, capabilities: descriptor?.capabilities };
}

/** One node's checks, in the order their issues are reported. */
async function validateNodeResources(
  validation: ResourceValidation,
  scope: NodeValidation
): Promise<void> {
  const { node } = scope;
  validateOutputFormat(validation, scope);
  validateNodeModel(validation, node);
  validateBundledWorkflowTarget(validation, node);
  if (!(await validateCommandReferences(validation, node))) return;
  await validateMcp(validation, scope);
  await validateSkills(validation, scope);
  validateProviderCapabilities(validation, scope);
  await validateScriptNode(validation, node);
  validateShellOutputRefs(validation, node);
}
