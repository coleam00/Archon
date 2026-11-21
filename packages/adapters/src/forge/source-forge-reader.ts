import { randomUUID } from 'node:crypto';
import { getPluginsPath } from '@archon/paths';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import type { ForgeRequest, ForgeResponse } from '@archon/forge';
import { dispatchForge } from '@archon/forge/dispatch';
import { readForgeConfig, sourceForgePlugins } from '@archon/forge/host-plugins';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import type { SourceForgeReader } from '@archon/workflows/webhook-source-plugin';

/** A forge read that failed, with the forge's error kind. */
export class SourceForgeReadError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(message);
    this.name = 'SourceForgeReadError';
  }
}

type DispatchOptions = NonNullable<Parameters<typeof dispatchForge>[1]>;

/**
 * The forge reads a source plugin makes while it observes waits, through the forge as
 * `archon forge` reaches it: the `forge:` block of the Archon config, the installed plugins
 * and, from a source checkout, the bundled GitHub plugin. The plugin holds no credential;
 * the operator's forge plugin does. The config is read once, on first use.
 */
export function hostSourceForgeReader(
  env: NodeJS.ProcessEnv = process.env,
  credentialEnv: NodeJS.ProcessEnv = env
): SourceForgeReader {
  let options: Promise<DispatchOptions> | undefined;
  const discovery = (): Promise<DispatchOptions> => {
    options ??= (async () => {
      const archonHome = getArchonHome(env);
      return {
        config: forgePluginConfigSchema.parse(
          await readForgeConfig(getArchonConfigPath(archonHome))
        ),
        env,
        credentialEnv,
        pluginsDir: getPluginsPath(archonHome),
        sourcePlugins: sourceForgePlugins(),
      };
    })();
    return options;
  };
  const read = async (request: ForgeRequest): Promise<ForgeResponse & { ok: true }> => {
    const { response } = await dispatchForge(request, await discovery());
    if (!response.ok) throw new SourceForgeReadError(response.error.kind, response.error.message);
    return response;
  };
  return {
    async commitChecks({ remote, revision }) {
      const resolved = await read({ operationId: randomUUID(), op: 'resolve', remote });
      if (resolved.result.op !== 'resolve' || resolved.result.value.kind !== 'resolved')
        throw new SourceForgeReadError('no_plugin_for_host', 'The remote names no forge');
      const checks = await read({
        operationId: randomUUID(),
        op: 'checks.commit',
        repo: resolved.result.value.repo,
        at: { kind: 'revision', revision },
      });
      if (checks.result.op !== 'checks.commit')
        throw new SourceForgeReadError('invalid_response', 'The forge answered another operation');
      return checks.result.value;
    },
  };
}
