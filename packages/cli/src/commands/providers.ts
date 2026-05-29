/**
 * Providers command — list registered AI providers.
 *
 * Reads the provider registry directly (no server). Built-in and community
 * providers are registered at CLI startup (see cli.ts), so the registry is
 * already populated by the time this runs.
 */
import { getProviderInfoList } from '@archon/providers';

export function providersListCommand(json?: boolean): void {
  const providers = getProviderInfoList();

  if (json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  for (const p of providers) {
    const capabilities = Object.entries(p.capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
    console.log(`\n${p.id}${p.builtIn ? '' : ' (community)'}`);
    console.log(`  Name:         ${p.displayName}`);
    console.log(`  Capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  }
  console.log(`\nTotal: ${String(providers.length)} provider(s)`);
}
