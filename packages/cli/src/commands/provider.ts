import { FIRST_PARTY_PLUGIN_REPO } from '@archon/plugin-manifest';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { isMaintainedProvider, MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { replacePlugin, type PluginEnvironment } from './plugin';

export async function providerCommand(
  subcommand: string | undefined,
  ids: readonly string[],
  env: PluginEnvironment
): Promise<number> {
  try {
    if (subcommand !== 'install' || ids.length === 0) {
      throw new Error('Usage: archon provider install <id...>');
    }
    for (const id of ids) {
      if (!isMaintainedProvider(id))
        throw new Error(
          `Unknown maintained provider '${id}'. Choose: ${MAINTAINED_PROVIDER_IDS.join(', ')}`
        );
    }
    if (!BUNDLED_IS_BINARY)
      throw new Error('Source checkouts run maintained providers from source.');
    for (const id of ids)
      await replacePlugin(
        `${FIRST_PARTY_PLUGIN_REPO}/plugins/provider-${id}@v${env.archonVersion}`,
        env
      );
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
