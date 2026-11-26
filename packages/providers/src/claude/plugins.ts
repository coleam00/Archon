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
 * fails the node when any plugin outside `@builtin`, the named set and the
 * Managed-scope set loaded.
 *
 * A plugin installed at Managed scope is enforced by the organization's managed
 * settings: it ignores the off overlay and always loads. The inventory reports it
 * with `scope: "managed"`, and the check accepts it as it accepts a builtin,
 * because no node configuration can remove it.
 *
 * A named plugin's MCP servers and skills are not wired here. They reach the node
 * through the node's own `mcp:` and `skills:` lists, like every other server or
 * skill.
 */

import { type ExecFileException, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import type { SDKMessage, Settings } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import { z } from 'zod';
import { ClassifiedProviderError } from '../shared/failure';
import type { ExecutionContext } from '../types';
import { buildDockerExecCommandArgs } from './container-spawn';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

const PLUGIN_LIST_ARGS = ['plugin', 'list', '--json'] as const;

/** Generous bound for a command that normally takes well under a second. */
const PLUGIN_LIST_TIMEOUT_MS = 60_000;

/** Only the fields Archon reads; unknown fields are ignored so an additive CLI change does not break it. */
const pluginListSchema = z.array(z.object({ id: z.string().min(1), scope: z.string().optional() }));

/** The `claude plugin list --json` scope of a plugin the organization's managed settings enforce. */
const MANAGED_SCOPE = 'managed';

/** What `claude plugin list --json` reports, reduced to the ids plugin scoping needs. */
export interface ClaudePluginInventory {
  /** Every installed plugin id, once each. */
  installed: string[];
  /** The installed ids with a Managed-scope record, which the off overlay cannot turn off. */
  managed: string[];
}

/** The plugins a workflow node's session may load besides `@builtin` ones. */
export interface PluginScope {
  /** The node's `plugins:`; each must load. */
  named: readonly string[];
  /** Managed-scope ids from the inventory; each may load whether or not the node names it. */
  managed: readonly string[];
}

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
 * lists one record per install scope), and those with a Managed-scope record. A
 * listing ended by a signal or the timeout is `transient`; any other failure is
 * `misconfigured`. Both carry the command's own output as evidence, and the node
 * fails before its session starts.
 */
export async function readClaudePluginInventory(
  cmd: PluginListCommand
): Promise<ClaudePluginInventory> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      cmd.command,
      cmd.args,
      { cwd: cmd.cwd, env: cmd.env, timeout: PLUGIN_LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => {
        if (error) {
          const signal = terminatingSignal(error);
          // Not error.message: it repeats the full argv, which for a container run
          // carries the session env (credentials included) as `-e KEY=VALUE`.
          const detail =
            err.trim() ||
            (signal
              ? `killed by ${signal}${error.killed ? ' (timed out)' : ''}`
              : typeof error.code === 'number'
                ? `exited with code ${error.code}`
                : String(error.code));
          reject(
            new ClassifiedProviderError(
              // Killed or timed out: nothing to fix, and a fresh attempt may finish.
              signal ? 'transient' : 'misconfigured',
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
  return {
    installed: [...new Set(parsed.data.map(p => p.id))],
    managed: [...new Set(parsed.data.filter(p => p.scope === MANAGED_SCOPE).map(p => p.id))],
  };
}

/**
 * The signal that ended the listing, if one did. A wrapper script or a CLI that
 * traps the signal reports it as exit status 128+N rather than as a signal, so
 * both structured channels count.
 */
function terminatingSignal(error: ExecFileException): string | undefined {
  if (error.signal) return error.signal;
  if (typeof error.code !== 'number' || error.code <= 128) return undefined;
  const signalNumber = error.code - 128;
  return Object.entries(constants.signals).find(([, n]) => n === signalNumber)?.[0];
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
 * (`@builtin`), installed at Managed scope, or named by the node, and every named
 * plugin must have loaded. Managed-scope plugins that loaded without being named
 * are logged, so a run shows what the organization added to the session.
 * A mismatch throws `misconfigured`; leaving the loop ends the SDK query, which
 * terminates the CLI before it does more work under the wrong plugin set.
 *
 * The SDK puts `system/init` "normally ahead" of the turn's other messages, not
 * always, so model output or a successful result before any init frame also
 * fails: the check must not pass by never running. Other system frames (hooks,
 * status) may precede init and pass through, and so does an error result: Claude
 * Code refusing to start (an unknown resume id, a startup failure) reports it
 * before init, and that cause must reach the caller rather than a scope error.
 */
export async function* withPluginScopeCheck(
  events: AsyncIterable<SDKMessage>,
  scope: PluginScope,
  nodeId?: string
): AsyncGenerator<SDKMessage> {
  let initSeen = false;
  for await (const event of events) {
    if (event.type === 'system' && event.subtype === 'init') {
      const managedLoaded = checkInitPlugins(event.plugins, scope);
      // A session can send init more than once; the plugins a node did not name are
      // reported once, with the node that received them.
      if (!initSeen && managedLoaded.length > 0) {
        getLog().info({ nodeId, plugins: managedLoaded }, 'claude.managed_plugins_loaded');
      }
      initSeen = true;
    } else if (
      !initSeen &&
      MODEL_OUTPUT_TYPES.has(event.type) &&
      !(event.type === 'result' && event.is_error)
    ) {
      throw new ClassifiedProviderError(
        'misconfigured',
        `Cannot verify the node's plugin scope: Claude Code sent a ${event.type} message before reporting its loaded plugins (system/init).`
      );
    }
    yield event;
  }
}

/** Messages that mean the model is working or the turn is over. */
const MODEL_OUTPUT_TYPES: ReadonlySet<SDKMessage['type']> = new Set([
  'assistant',
  'stream_event',
  'result',
]);

/** Fails on a plugin outside the node's scope; returns the Managed-scope ids that loaded unnamed. */
function checkInitPlugins(plugins: unknown, scope: PluginScope): string[] {
  const parsed = initPluginsSchema.safeParse(plugins);
  if (!parsed.success) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Cannot verify the node's plugin scope: Claude Code reported an unexpected plugin list: ${parsed.error.message}`
    );
  }
  const named = new Set(scope.named);
  const managed = new Set(scope.managed);
  const loaded = new Set<string>();
  const unexpected: string[] = [];
  const managedLoaded: string[] = [];
  for (const plugin of parsed.data) {
    // A row without its id cannot be matched to the named set, so it fails closed.
    const id = plugin.source ?? `${plugin.name} (no source id)`;
    loaded.add(id);
    if (id.endsWith('@builtin') || named.has(id)) continue;
    if (managed.has(id)) managedLoaded.push(id);
    else unexpected.push(id);
  }
  const missing = scope.named.filter(id => !loaded.has(id));
  if (unexpected.length === 0 && missing.length === 0) return managedLoaded;
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
