/**
 * Plugin scoping for Claude workflow nodes.
 *
 * A workflow node loads only the plugins it names. Claude Code has no switch for
 * "no plugins", so the node's options carry a flag-tier settings overlay that
 * sets every installed plugin id to `false` and each named id to `true`. The ids
 * come from Claude Code's own structured inventory, `claude plugin list --json`,
 * run with the session's binary, cwd and env.
 *
 * The inventory is the off mechanism, not the guarantee: plugins can also arrive
 * through routes the inventory does not list. The guarantee is
 * {@link withPluginScopeCheck}, which reads the session's `system/init` frame and
 * fails the node when any plugin outside `@builtin` and the named set loaded.
 *
 * A named plugin's MCP servers and skills are not wired here. They reach the node
 * through the node's own `mcp:` and `skills:` lists, like every other server or
 * skill.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SDKMessage, Settings } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClassifiedProviderError } from '../shared/failure';
import type { ExecutionContext } from '../types';
import { buildDockerExecCommandArgs } from './container-spawn';

const PLUGIN_LIST_ARGS = ['plugin', 'list', '--json'] as const;

/** Generous bound for a command that normally takes well under a second. */
const PLUGIN_LIST_TIMEOUT_MS = 60_000;

/** Only the field Archon reads; unknown fields are ignored so an additive CLI change does not break it. */
const pluginListSchema = z.array(z.object({ id: z.string().min(1) }));

/** How to run `claude plugin list --json` in the same place the session will run. */
export interface PluginListCommand {
  command: string;
  args: string[];
  /** Host directory to spawn in; undefined for a container run, whose cwd is a path inside the container. */
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * The SDK's bundled per-platform native binary, which the session runs in dev
 * mode when no path is pinned. The SDK does not export its resolver, so this
 * follows the package naming it uses (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 * with a musl variant on Linux). On a Linux host with both variants installed it
 * may pick the other libc build than the session; both read the same plugin
 * configuration. The real-CLI test in `plugins.test.ts` fails when this stops
 * finding the binary.
 */
export function resolveBundledClaudeBinary(): string | undefined {
  const sdkRequire = createRequire(
    join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')), 'x')
  );
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  for (const pkg of candidates) {
    try {
      const path = sdkRequire.resolve(`${pkg}/${exe}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this platform variant; try the next one.
    }
  }
  return undefined;
}

/**
 * Build the inventory command for the binary and place the session uses. A
 * container run asks the in-container `claude`; a host run uses the resolved
 * path, or the SDK's bundled binary when nothing is pinned. A legacy npm `cli.js`
 * runs through its own shebang, which is enough for this read-only command.
 */
export function buildPluginListCommand(input: {
  cliPath: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  execContext: ExecutionContext | undefined;
}): PluginListCommand {
  const { cliPath, cwd, env, execContext } = input;
  if (execContext?.kind === 'container') {
    return {
      command: 'docker',
      args: buildDockerExecCommandArgs(execContext, cwd, env, PLUGIN_LIST_ARGS),
      cwd: undefined,
      env: process.env,
    };
  }
  const executable = cliPath ?? resolveBundledClaudeBinary();
  if (executable === undefined) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Cannot list Claude plugins: no Claude Code binary found for ${process.platform}-${process.arch}. Set CLAUDE_BIN_PATH to a Claude Code executable.`
    );
  }
  return { command: executable, args: [...PLUGIN_LIST_ARGS], cwd, env };
}

/**
 * Every installed plugin id `claude plugin list --json` reports, deduplicated (it
 * lists one record per install scope). Any failure is `misconfigured` with the
 * command's own output as evidence, so the node fails before its session starts.
 */
export async function readClaudePluginIds(cmd: PluginListCommand): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      cmd.command,
      cmd.args,
      { cwd: cmd.cwd, env: cmd.env, timeout: PLUGIN_LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => {
        if (error) {
          const detail = err.trim() || error.message;
          reject(
            new ClassifiedProviderError(
              'misconfigured',
              `Cannot list Claude plugins (\`claude plugin list --json\` via ${cmd.command} failed): ${detail}`
            )
          );
          return;
        }
        resolve(out);
      }
    );
  });

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Cannot list Claude plugins: \`claude plugin list --json\` printed invalid JSON: ${stdout.slice(0, 200)}`
    );
  }
  const parsed = pluginListSchema.safeParse(json);
  if (!parsed.success) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Cannot list Claude plugins: unexpected \`claude plugin list --json\` shape: ${parsed.error.message}`
    );
  }
  return [...new Set(parsed.data.map(p => p.id))];
}

/**
 * The flag-tier settings that turn off every installed plugin except the named
 * ones. Fails when a named id is not installed, because Claude Code would skip it
 * silently and the node would run without it.
 */
export function buildClaudePluginSettings(
  installedIds: readonly string[],
  namedIds: readonly string[]
): Pick<Settings, 'enabledPlugins' | 'syncClaudeAiPlugins'> {
  const installed = new Set(installedIds);
  const missing = namedIds.filter(id => !installed.has(id));
  if (missing.length > 0) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Claude plugin${missing.length === 1 ? '' : 's'} not installed: ${missing.join(', ')}. ` +
        `Installed: ${installedIds.length > 0 ? installedIds.join(', ') : 'none'}. ` +
        'Name plugins by their exact `name@marketplace` id from `claude plugin list`.'
    );
  }
  const enabledPlugins: Record<string, boolean> = {};
  for (const id of installedIds) enabledPlugins[id] = false;
  for (const id of namedIds) enabledPlugins[id] = true;
  // Plugins synced from claude.ai are not in the inventory; this hides them.
  return { enabledPlugins, syncClaudeAiPlugins: false };
}

/**
 * `system/init` plugin rows. `source` is the `name@marketplace` id; the SDK's
 * type does not declare it yet, so it is read through this schema.
 */
const initPluginsSchema = z.array(z.object({ name: z.string(), source: z.string().optional() }));

/**
 * Pass the session's messages through unchanged, after checking each
 * `system/init` frame: every loaded plugin must be built into Claude Code
 * (`@builtin`) or named by the node, and every named plugin must have loaded.
 * A mismatch throws `misconfigured`; leaving the loop ends the SDK query, which
 * terminates the CLI before it does more work under the wrong plugin set.
 */
export async function* withPluginScopeCheck(
  events: AsyncIterable<SDKMessage>,
  namedIds: readonly string[]
): AsyncGenerator<SDKMessage> {
  for await (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') {
      checkInitPlugins(event.plugins, namedIds);
    }
    yield event;
  }
}

function checkInitPlugins(plugins: unknown, namedIds: readonly string[]): void {
  const parsed = initPluginsSchema.safeParse(plugins);
  if (!parsed.success) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Cannot verify the node's plugin scope: Claude Code reported an unexpected plugin list: ${parsed.error.message}`
    );
  }
  const named = new Set(namedIds);
  const loaded = new Set<string>();
  const unexpected: string[] = [];
  for (const plugin of parsed.data) {
    // A row without its id cannot be matched to the named set, so it fails closed.
    const id = plugin.source ?? `${plugin.name} (no source id)`;
    loaded.add(id);
    if (!id.endsWith('@builtin') && !named.has(id)) unexpected.push(id);
  }
  const missing = namedIds.filter(id => !loaded.has(id));
  if (unexpected.length === 0 && missing.length === 0) return;
  const problems = [
    ...(unexpected.length > 0
      ? [`loaded plugins the node does not name: ${unexpected.join(', ')}`]
      : []),
    ...(missing.length > 0 ? [`named plugins did not load: ${missing.join(', ')}`] : []),
  ];
  throw new ClassifiedProviderError(
    'misconfigured',
    `Claude Code's plugin set does not match the node's plugins: ${problems.join('; ')}.`
  );
}
