import { NoDefaultProviderError } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { buildAiProfile } from '@archon/workflows/model-validation';
import {
  assistantModelDefaults,
  collectRunCredentialRequirements,
  resolveWorkflowModelScope,
} from '@archon/workflows/run-preflight';
import { loadMergedConfig, type CheckResult } from './doctor-check';

interface WorkflowChecks {
  /** Whether every discoverable workflow file loads, regardless of provider configuration. */
  files: CheckResult;
  /** Whether workflows can select a provider; only asked when no default provider resolves. */
  providers: CheckResult;
  allowEmptyProviderInventory: boolean;
}

const providers = (status: CheckResult['status'], message: string): CheckResult => ({
  label: 'Workflow providers',
  status,
  message,
});

/** Discovers workflows once so the file and provider checks cannot disagree about what loaded. */
export async function checkWorkflows(cwd = process.cwd()): Promise<WorkflowChecks> {
  const files = (status: CheckResult['status'], message: string): CheckResult => ({
    label: 'Workflow files',
    status,
    message,
  });
  let config: MergedConfig;
  try {
    config = await loadMergedConfig(cwd);
  } catch {
    return {
      files: files('skip', 'config did not load'),
      providers: providers('skip', 'config did not load'),
      allowEmptyProviderInventory: false,
    };
  }
  let discovered: Discovered;
  try {
    discovered = await discoverWorkflowsWithConfig(cwd, async () => config, providerRegistry);
  } catch (error) {
    return {
      files: files('fail', error instanceof Error ? error.message : String(error)),
      providers: providers('skip', 'workflows were not discovered'),
      allowEmptyProviderInventory: false,
    };
  }
  const { workflows, errors } = discovered;
  const filesCheck =
    errors.length > 0
      ? files('fail', errors.map(error => `${error.filename}: ${error.error}`).join('\n'))
      : files('pass', `${workflows.length} workflow(s) load`);
  const withProviders = (check: CheckResult, allowEmptyProviderInventory = false) => ({
    files: filesCheck,
    providers: check,
    allowEmptyProviderInventory,
  });
  if (config.assistant !== undefined)
    return withProviders(providers('skip', 'default provider configured'));
  const selection = checkProviderSelection(config, workflows);
  if (selection.check.status === 'pass' && errors.length > 0)
    // A file that did not load may still need a provider, so do not vouch for an empty inventory.
    return withProviders(providers('skip', 'not every workflow file loaded; see Workflow files'));
  return withProviders(selection.check, selection.allowEmptyProviderInventory);
}

type MergedConfig = Awaited<ReturnType<typeof loadMergedConfig>>;
type Discovered = Awaited<ReturnType<typeof discoverWorkflowsWithConfig>>;

/** Without a default provider, fails on the first workflow that needs one. */
function checkProviderSelection(
  config: MergedConfig,
  workflows: Discovered['workflows']
): { check: CheckResult; allowEmptyProviderInventory: boolean } {
  const result = (
    status: CheckResult['status'],
    message: string,
    allowEmptyProviderInventory = false
  ) => ({ check: providers(status, message), allowEmptyProviderInventory });
  try {
    const aiProfile = buildAiProfile(config.assistant, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
    });
    let needsProvider = false;
    for (const { workflow } of workflows) {
      try {
        const scope = resolveWorkflowModelScope(
          workflow,
          config.assistant,
          assistantModelDefaults(config),
          aiProfile
        );
        needsProvider =
          collectRunCredentialRequirements(providerRegistry, workflow, {
            config,
            aiProfile,
            scope,
          }).length > 0 || needsProvider;
      } catch (error) {
        if (error instanceof NoDefaultProviderError)
          return result(
            'fail',
            `${workflow.name} needs a default provider. Run \`archon ai default <provider>\` or \`archon setup\`.`
          );
        throw error;
      }
    }
    return result(
      'pass',
      needsProvider
        ? 'Workflows select their providers explicitly'
        : 'Discovered workflows need no provider',
      !needsProvider
    );
  } catch (error) {
    return result('fail', error instanceof Error ? error.message : String(error));
  }
}
