import {
  installedProviders,
  noDefaultProviderMessage,
  MAINTAINED_PROVIDER_IDS,
  isMaintainedProvider,
  type ProviderRegistry,
} from '@archon/provider-contract';
import { getRegistration, providerRegistry } from '@archon/providers';
import type { IAgentProvider } from '@archon/providers';
import { PluginRemoteError } from '@archon/provider-contract/plugin';
import { isProviderReceipt } from '@archon/plugin-manifest';
import { readReceipts } from '@archon/plugin-manifest/store';
import { getPluginsPath, BUNDLED_VERSION, BUNDLED_IS_BINARY } from '@archon/paths';
import type { MergedConfig } from '@archon/core';
import { loadMergedConfig, type CheckResult } from './doctor-check';

export async function checkInstalledProviders(
  registry: ProviderRegistry = providerRegistry,
  loadVersions: () => Promise<ReadonlyMap<string, string>> = async () =>
    new Map(
      (await readReceipts(getPluginsPath()))
        .filter(isProviderReceipt)
        .map(receipt => [receipt.descriptor.id, receipt.descriptor.version])
    )
): Promise<CheckResult> {
  const label = 'Installed providers';
  try {
    const versions = await loadVersions();
    const installed = installedProviders(registry);
    const unavailable = [...new Set([...MAINTAINED_PROVIDER_IDS, ...versions.keys()])]
      .map(id => registry.unavailable?.(id))
      .filter((reason): reason is string => reason !== undefined);
    const lines = installed.map(provider => {
      const version =
        !BUNDLED_IS_BINARY && isMaintainedProvider(provider.id)
          ? BUNDLED_VERSION
          : (versions.get(provider.id) ??
            (provider.builtIn ? BUNDLED_VERSION : 'version not reported'));
      return `${provider.id} (${version})`;
    });
    // Only deprecated bundled providers remain: they can still run when configured, so
    // the missing selection is a warning rather than a failure.
    const status =
      registry.list().length === 0 || unavailable.length > 0
        ? 'fail'
        : installed.length > 0
          ? 'pass'
          : 'warn';
    return {
      label,
      status,
      message: [
        installed.length > 0 ? lines.join(', ') : noDefaultProviderMessage(registry),
        ...unavailable,
        ...(installed.length > 0 && unavailable.length === 0
          ? []
          : [
              'Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI.',
            ]),
      ].join('\n    '),
    };
  } catch (error) {
    return {
      label,
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type ProviderSelection = Pick<MergedConfig, 'assistants'> &
  Partial<Pick<MergedConfig, 'assistant'>>;

/** The default assistant, or an `assistants.<id>` entry with settings in it. */
function selectsProvider(config: ProviderSelection, id: string): boolean {
  return config.assistant === id || Object.keys(config.assistants[id] ?? {}).length > 0;
}

export async function checkProviderDiagnostics(
  id: string,
  provider?: Pick<IAgentProvider, 'diagnose'>,
  load: () => Promise<ProviderSelection> = () => loadMergedConfig(process.cwd()),
  signal: AbortSignal = AbortSignal.timeout(20_000)
): Promise<CheckResult[]> {
  const label = `${id} diagnostics`;
  try {
    let config: ProviderSelection | undefined;
    if (!provider) {
      const registration = getRegistration(id);
      // A deprecated provider stays bundled whether or not anyone uses it, so its
      // runtime is only worth checking for a user who selected or configured it.
      // A config that fails to load selects nothing; the Config files check reports it.
      if (registration.deprecationNotice) {
        config = await load().catch(() => undefined);
        if (!config || !selectsProvider(config, id)) return [];
      }
      // The factory, not getAgentProvider: a diagnostic is not a run, so it must not
      // report the deprecation notice the Provider support check already shows.
      provider = registration.factory();
    }
    if (!provider.diagnose) return [{ label, status: 'skip', message: 'no diagnostics hook' }];
    config ??= await load();
    const diagnostics = await provider.diagnose({ assistantConfig: config.assistants[id], signal });
    return diagnostics.checks.map(check => ({
      label: `${id}: ${check.label}`,
      status: check.status === 'ok' ? 'pass' : check.status,
      message: `${check.message}${check.remedy ? ` Remedy: ${check.remedy}` : ''}`,
    }));
  } catch (error) {
    if (error instanceof PluginRemoteError && error.code === -32601)
      return [{ label, status: 'skip', message: 'no diagnostics hook' }];
    return [
      { label, status: 'fail', message: error instanceof Error ? error.message : String(error) },
    ];
  }
}
