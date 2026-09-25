import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { PluginMetadata } from './operations';
import { pluginMetadataSchema } from './operations';
import {
  forgePluginConfigSchema,
  normalizeHost,
  type ForgeHostPlugin,
  type ForgePluginConfig,
} from './plugin-config';
import { runPluginProcess, type PluginArgv } from './plugin-process';

export interface PluginCandidate extends PluginArgv {
  source: string;
  configured: boolean;
  expectedName?: string;
}

export interface DiscoveredPlugin extends PluginCandidate {
  metadata: PluginMetadata;
}

export interface PluginDiscovery {
  plugins: readonly DiscoveredPlugin[];
  unavailable: readonly PluginDiscoveryError[];
  byHost: ReadonlyMap<string, DiscoveredPlugin>;
  hostConfig: ReadonlyMap<string, Exclude<ForgeHostPlugin, string>>;
  pluginTokenEnv: ReadonlyMap<string, string>;
}

export class PluginDiscoveryError extends Error {
  constructor(
    readonly kind: 'duplicate_host' | 'process_failed' | 'invalid_response',
    message: string
  ) {
    super(message);
    this.name = 'PluginDiscoveryError';
  }
}

function executableName(entry: string): string | undefined {
  const match = /^archon-forge-([a-z0-9-]+)(?:\.exe)?$/i.exec(entry);
  if (!match) return undefined;
  if (process.platform === 'win32' && extname(entry).toLowerCase() !== '.exe') return undefined;
  return match[1].toLowerCase();
}

async function scanDirectory(directory: string, source: string): Promise<PluginCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: PluginCandidate[] = [];
  for (const entry of entries.sort()) {
    const name = executableName(entry);
    if (!name) {
      if (/^archon-forge-/i.test(entry)) {
        process.stderr.write(`Skipping forge plugin ${entry}: unsupported executable format\n`);
      }
      continue;
    }
    const command = resolve(directory, entry);
    try {
      const details = await stat(command);
      if (!details.isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Retain a broken link as an unavailable candidate, so selecting it
      // cannot silently turn into an unclaimed (no-forge) result.
      candidates.push({
        source: `${source}:${name}`,
        configured: false,
        command,
        args: [],
        expectedName: name,
      });
      continue;
    }
    if (process.platform !== 'win32') {
      try {
        await access(command, constants.X_OK);
      } catch {
        process.stderr.write(`Skipping forge plugin ${entry}: file is not executable\n`);
        continue;
      }
    }
    candidates.push({
      source: `${source}:${name}`,
      configured: false,
      command,
      args: [],
      expectedName: name,
    });
  }
  return candidates;
}

function configuredCandidates(
  config: ReturnType<typeof forgePluginConfigSchema.parse>
): PluginCandidate[] {
  const candidates: PluginCandidate[] = config.plugins.map(plugin => ({
    source: `config:${plugin.plugin}`,
    configured: true,
    command: plugin.command,
    args: plugin.args,
    expectedName: plugin.plugin,
  }));
  for (const [host, value] of Object.entries(config.hosts)) {
    if (typeof value !== 'string' && value.command) {
      candidates.push({
        source: `config:${host}`,
        configured: true,
        command: value.command,
        args: value.args,
        expectedName: value.plugin,
      });
    }
  }
  return candidates;
}

async function readMetadata(
  candidate: PluginCandidate,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<PluginMetadata> {
  const outcome = await runPluginProcess(candidate, ['metadata'], {
    env,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (outcome.spawnError || outcome.timedOut || outcome.outputExceeded || outcome.exitCode !== 0) {
    throw new PluginDiscoveryError(
      'process_failed',
      `${candidate.source}: metadata handshake failed`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(outcome.stdout) as unknown;
  } catch {
    throw new PluginDiscoveryError('invalid_response', `${candidate.source}: metadata is not JSON`);
  }
  const parsed = pluginMetadataSchema.safeParse(raw);
  if (!parsed.success || parsed.data.protocol !== 1) {
    throw new PluginDiscoveryError(
      'invalid_response',
      `${candidate.source}: incompatible plugin metadata`
    );
  }
  if (candidate.expectedName && parsed.data.name !== candidate.expectedName) {
    throw new PluginDiscoveryError(
      'invalid_response',
      `${candidate.source}: metadata name does not match configuration`
    );
  }
  return parsed.data;
}

/** `ARCHON_HOME/plugins`: scanned by discovery, written by `archon plugin install`. */
export function defaultPluginDir(env: NodeJS.ProcessEnv): string {
  return join(env.ARCHON_HOME ?? join(homedir(), '.archon'), 'plugins');
}

export async function discoverPlugins(
  options: {
    config?: ForgePluginConfig;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    includeDefaultDir?: boolean;
  } = {}
): Promise<PluginDiscovery> {
  const config = forgePluginConfigSchema.parse(options.config ?? {});
  const env = options.env ?? process.env;
  const dirs = [
    ...(options.includeDefaultDir === false ? [] : [defaultPluginDir(env)]),
    ...config.pluginDirs,
    ...(config.scanPath ? (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean) : []),
  ];
  const configuredDirs = new Set(config.pluginDirs.map(dir => resolve(dir)));
  const scanned = (
    await Promise.all(
      [...new Set(dirs.map(dir => resolve(dir)))].map(dir =>
        scanDirectory(dir, configuredDirs.has(dir) ? 'plugin-dir' : 'discovery')
      )
    )
  ).flat();
  const candidates = [...configuredCandidates(config), ...scanned].filter(
    (candidate, index, all) =>
      all.findIndex(
        other =>
          other.command === candidate.command &&
          JSON.stringify(other.args) === JSON.stringify(candidate.args)
      ) === index
  );
  const plugins: DiscoveredPlugin[] = [];
  const names = new Set<string>();
  const unavailable: PluginDiscoveryError[] = [];
  const unavailableNames = new Set<string>();
  const selectedNames = new Set(
    Object.values(config.hosts).map(value => (typeof value === 'string' ? value : value.plugin))
  );
  for (const candidate of candidates) {
    let metadata: PluginMetadata;
    try {
      metadata = await readMetadata(candidate, env, options);
    } catch (error) {
      if (
        !(error instanceof PluginDiscoveryError) ||
        candidate.configured ||
        (candidate.expectedName && selectedNames.has(candidate.expectedName))
      )
        throw error;
      unavailable.push(error);
      if (candidate.expectedName) unavailableNames.add(candidate.expectedName);
      process.stderr.write(`Skipping forge plugin ${candidate.command}: ${error.message}\n`);
      continue;
    }
    if (names.has(metadata.name)) {
      throw new PluginDiscoveryError(
        'duplicate_host',
        `duplicate forge plugin name: ${metadata.name}`
      );
    }
    names.add(metadata.name);
    plugins.push({ ...candidate, metadata });
  }

  for (const name of unavailableNames) {
    if (names.has(name))
      throw new PluginDiscoveryError(
        'duplicate_host',
        `forge plugin ${name} has both available and failed candidates`
      );
  }
  const byName = new Map(plugins.map(plugin => [plugin.metadata.name, plugin]));
  const byHost = new Map<string, DiscoveredPlugin>();
  const claim = (host: string, plugin: DiscoveredPlugin): void => {
    const normalized = normalizeHost(host);
    const existing = byHost.get(normalized);
    if (existing && existing !== plugin)
      throw new PluginDiscoveryError(
        'duplicate_host',
        `duplicate forge plugin claim for ${normalized}`
      );
    byHost.set(normalized, plugin);
  };
  for (const plugin of plugins) for (const host of plugin.metadata.hosts) claim(host, plugin);

  const hostConfig = new Map<string, Exclude<ForgeHostPlugin, string>>();
  const pluginTokenEnv = new Map(
    config.plugins.flatMap(plugin =>
      plugin.token_env ? ([[plugin.plugin, plugin.token_env]] as const) : []
    )
  );
  for (const [host, raw] of Object.entries(config.hosts)) {
    const value = typeof raw === 'string' ? { plugin: raw, args: [] } : raw;
    const plugin = byName.get(value.plugin);
    if (!plugin)
      throw new PluginDiscoveryError(
        'process_failed',
        `configured forge plugin ${value.plugin} was not discovered`
      );
    claim(host, plugin);
    hostConfig.set(normalizeHost(host), value);
  }
  return { plugins, unavailable, byHost, hostConfig, pluginTokenEnv };
}
