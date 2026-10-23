/**
 * `archon plugin add | update | remove | list | copy`.
 *
 * GitHub is the registry: a plugin is `owner/repo[/path]` (where its
 * `archon-plugin.json` lives) and a version is a tag. Resolution uses
 * `git ls-remote`, the `releases/latest` redirect, raw file downloads and
 * `git fetch`, never the GitHub API, so it needs no token and has no API rate
 * limit. Git's own credential setup applies to its calls; the raw manifest read
 * is unauthenticated, so a private repository cannot be installed.
 *
 * - `kind: forge`, `provider`, or `chat`: the executable comes from the release assets and lands in
 *   the plugins directory (`plugin-binary.ts`). No `@tag` means the latest release.
 * - `kind: workflow-pack`: the tag, or the default branch head, is fetched with
 *   git at depth 1 and the plugin directory of that commit becomes one installed
 *   tree that workflow discovery reads (`plugin-pack.ts`).
 */
import { attachmentUsage, isAttachmentVerb } from '../attachment-commands';
import { parsePluginRef } from './plugin-source';
import type { PluginEnvironment } from './plugin-common';
import { installPlugin } from './plugin-install';
import { copyPlugin, listPlugins, removePlugin } from './plugin-installed';
import { withPluginMutationLock } from './plugin-mutation-lock';

const USAGE = attachmentUsage('plugin');

export async function pluginCommand(
  subcommand: string | undefined,
  args: readonly string[],
  env: PluginEnvironment
): Promise<number> {
  try {
    if (!isAttachmentVerb('plugin', subcommand)) {
      console.error(USAGE);
      return 1;
    }
    // Exact arity: an ignored extra argument would install something the
    // operator did not ask for, or silently drop a second plugin.
    if (subcommand === 'list' && args.length === 0) {
      await listPlugins(env);
      return 0;
    }
    const [target] = args;
    if (!target || args.length !== 1 || subcommand === 'list') {
      console.error(USAGE);
      return 1;
    }
    if (subcommand === 'install') {
      console.warn('Warning: archon plugin install is deprecated. Use archon plugin add instead.');
    }
    const ref = parsePluginRef(target);
    switch (subcommand) {
      case 'remove':
      case 'copy':
        if (ref.tag) throw new Error(`${subcommand} takes a plugin id without @tag: ${ref.id}`);
        await withPluginMutationLock(env.pluginsDir, () =>
          subcommand === 'remove' ? removePlugin(ref, env) : copyPlugin(ref, env)
        );
        break;
      case 'add':
      case 'install':
      case 'update':
        await withPluginMutationLock(env.pluginsDir, () =>
          installPlugin(ref, subcommand === 'update' ? 'update' : 'install', env)
        );
        break;
      default:
        throw new Error(`Unhandled plugin subcommand: ${subcommand satisfies never}`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
}
