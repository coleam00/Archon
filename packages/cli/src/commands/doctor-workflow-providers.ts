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

export async function checkWorkflowProviderSelection(cwd = process.cwd()): Promise<{
  check: CheckResult;
  allowEmptyProviderInventory: boolean;
}> {
  const label = 'Workflow providers';
  const result = (
    status: CheckResult['status'],
    message: string,
    allowEmptyProviderInventory = false
  ) => ({ check: { label, status, message }, allowEmptyProviderInventory });
  let config: Awaited<ReturnType<typeof loadMergedConfig>>;
  try {
    config = await loadMergedConfig(cwd);
  } catch {
    return result('skip', 'config did not load');
  }
  if (config.assistant !== undefined) return result('skip', 'default provider configured');
  try {
    const { workflows, errors } = await discoverWorkflowsWithConfig(
      cwd,
      async () => config,
      providerRegistry
    );
    if (errors.length > 0)
      return result('fail', errors.map(error => `${error.filename}: ${error.error}`).join('\n'));
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
