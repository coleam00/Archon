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
import type { ProviderRegistry } from '@archon/provider-contract';
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
export { discoverAvailableCommands, validateCommand } from './validator/commands';
export { discoverAvailableScripts, validateScript } from './validator/scripts';
// Levenshtein distance and fuzzy matching live in ./utils/fuzzy-match so lean modules can
// reuse them without the validator's heavy deps. Re-exported to preserve this module's
// public surface for existing importers (e.g. the CLI's validate command).
export { levenshtein, findSimilar } from './utils/fuzzy-match';

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
  const availableCommands = await discoverAvailableCommands(cwd, config);
  const validation: ResourceValidation = {
    cwd,
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
