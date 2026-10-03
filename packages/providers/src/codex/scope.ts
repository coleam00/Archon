/**
 * Capability scoping for Codex workflow nodes.
 *
 * A workflow node loads only the plugins and MCP servers it names. Codex already has
 * the switches, per thread: `features.plugins`, `plugins."<id>".enabled`, a plugin's
 * `mcp_servers.<name>.enabled`, `features.apps`, and `mcp_servers.<name>.enabled` for a
 * user or project server. They ride in the thread's `config`, which Codex merges over
 * the user's own config.toml without replacing it, so the user's AGENTS.md, hooks and
 * other settings keep loading. The thread config is not stored with the thread: every
 * `thread/start`, `thread/resume` and `thread/fork` must carry it again.
 *
 * {@link readCodexInventory} reads what the switches must name from Codex itself, over
 * the same app-server connection. {@link applyNodeScope} turns that into the switches.
 * Those are the mechanism, not the guarantee: {@link checkThreadMcpScope} reads the MCP
 * servers the thread actually loaded and fails the node before its turn starts when one
 * is not declared. Plugin skills and hooks have no per-thread listing; the real-binary
 * test in `scope.boundary.test.ts` pins the switches that turn them off.
 *
 * A named plugin keeps its skills and hooks but not its MCP servers. A node that wants
 * one declares it in its `mcp:` file under the same name; Codex's own precedence makes
 * the declared definition replace the plugin's. ChatGPT apps stay off for every node.
 */
import { z } from 'zod';
import { ClassifiedProviderError } from '../shared/failure';
import { JsonRpcError, type AppServerConnection, type ParamsOf } from './app-server';
import type { JsonValue } from './protocol/serde_json/JsonValue';
import type { ListMcpServerStatusResponse } from './protocol/v2/ListMcpServerStatusResponse';
import type { McpServerConnectionStatus } from './protocol/v2/McpServerConnectionStatus';
import type { McpServerStatus } from './protocol/v2/McpServerStatus';
import type { PluginDetail } from './protocol/v2/PluginDetail';
import type { PluginMarketplaceEntry } from './protocol/v2/PluginMarketplaceEntry';
import type { PluginSummary } from './protocol/v2/PluginSummary';

/** A thread's `config` overrides, as `thread/start` and `thread/resume` take them. */
type ThreadConfig = NonNullable<ParamsOf<'thread/start'>['config']>;
type JsonObject = Partial<Record<string, JsonValue>>;

/** What Codex has installed and configured, as far as scoping needs it. */
export interface CodexInventory {
  /** The Codex home the app-server uses, for error messages. */
  codexHome: string;
  /** MCP server names the user's and the project's config.toml define. */
  configuredServers: string[];
  /** Installed plugin ids. Read only when the node names plugins; empty otherwise. */
  installedPlugins: string[];
  /** MCP server names of each named plugin, by id. */
  namedPluginServers: Record<string, string[]>;
}

// Only the fields Archon reads; Codex adds fields freely, and they are ignored. Each schema
// is typed against the response Codex generates (`scripts/generate-codex-protocol.ts`), so a
// renamed or retyped field fails the build when the protocol is regenerated. Codex types its
// config as an open map, so `mcp_servers` has no generated shape to bind to.
const configReadSchema = z.object({
  config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).nullish() }),
});
const pluginInstalledSchema: z.ZodType<{
  marketplaces: (Pick<PluginMarketplaceEntry, 'name' | 'path'> & {
    plugins: Pick<PluginSummary, 'id' | 'name' | 'installed'>[];
  })[];
}> = z.object({
  marketplaces: z.array(
    z.object({
      name: z.string(),
      path: z.string().nullable(),
      plugins: z.array(z.object({ id: z.string(), name: z.string(), installed: z.boolean() })),
    })
  ),
});
type Marketplace = z.infer<typeof pluginInstalledSchema>['marketplaces'][number];
const pluginReadSchema: z.ZodType<{ plugin: Pick<PluginDetail, 'mcpServers'> }> = z.object({
  plugin: z.object({ mcpServers: z.array(z.string()) }),
});

/** Every status Codex reports; the record makes a regenerated union fail the build until listed. */
const CONNECTION_STATUSES: Record<McpServerConnectionStatus, true> = {
  notStarted: true,
  starting: true,
  connected: true,
  authenticationRequired: true,
  failed: true,
  cancelled: true,
  disabled: true,
};
type McpStatusPage = Pick<ListMcpServerStatusResponse, 'nextCursor'> & {
  data: Pick<McpServerStatus, 'name' | 'pluginId' | 'runtimeStatus'>[];
};
const mcpStatusSchema: z.ZodType<McpStatusPage> = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      pluginId: z.string().nullable(),
      // A status this Codex version does not list reads as unknown (null), which the check
      // treats as live: it can pass only for a declared server.
      runtimeStatus: z
        .enum(Object.keys(CONNECTION_STATUSES) as [McpServerConnectionStatus])
        .nullable()
        .catch(null),
    })
  ),
  nextCursor: z.string().nullable(),
});

/**
 * One scoping request, read through `schema`. A JSON-RPC error or an unexpected shape is
 * `misconfigured`: the node's scope cannot be established, so it must not run. A process
 * that ends mid-request is rethrown as it is, for the provider to classify.
 */
async function requestScoped<
  M extends 'config/read' | 'plugin/installed' | 'plugin/read' | 'mcpServerStatus/list',
  T,
>(
  connection: AppServerConnection,
  method: M,
  params: ParamsOf<M>,
  schema: z.ZodType<T>
): Promise<T> {
  const context = "Cannot scope the node's Codex plugins and MCP servers";
  let response: unknown;
  try {
    response = await connection.request(method, params);
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    throw new ClassifiedProviderError('misconfigured', `${context}: ${error.message}`);
  }
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `${context}: unexpected \`${method}\` response: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

/**
 * Reads the configured MCP server names and, when the node names plugins, the installed
 * plugin ids and each named plugin's MCP servers. A named plugin that is not installed
 * fails `misconfigured`: Codex would skip it silently and the node would run without it.
 */
export async function readCodexInventory(
  connection: AppServerConnection,
  input: { cwd: string; plugins: readonly string[]; codexHome: string }
): Promise<CodexInventory> {
  const { cwd, plugins, codexHome } = input;
  const config = await requestScoped(connection, 'config/read', { cwd }, configReadSchema);
  const inventory: CodexInventory = {
    codexHome,
    configuredServers: Object.keys(config.config.mcp_servers ?? {}),
    installedPlugins: [],
    namedPluginServers: {},
  };
  if (plugins.length === 0) return inventory;

  const { marketplaces } = await requestScoped(
    connection,
    'plugin/installed',
    { cwds: [cwd] },
    pluginInstalledSchema
  );
  const installed = new Map<string, { pluginName: string; marketplace: Marketplace }>();
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (plugin.installed) installed.set(plugin.id, { pluginName: plugin.name, marketplace });
    }
  }
  inventory.installedPlugins = [...installed.keys()];

  const missing = plugins.filter(id => !installed.has(id));
  if (missing.length > 0) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Codex plugin${missing.length === 1 ? '' : 's'} not installed in ${codexHome}: ${missing.join(', ')}. ` +
        `Installed: ${inventory.installedPlugins.length > 0 ? inventory.installedPlugins.join(', ') : 'none'}. ` +
        'Name plugins by their exact `name@marketplace` id from `codex plugin list`.'
    );
  }
  for (const [id, { pluginName, marketplace }] of installed) {
    if (!plugins.includes(id)) continue;
    const detail = await requestScoped(
      connection,
      'plugin/read',
      marketplace.path !== null
        ? { pluginName, marketplacePath: marketplace.path }
        : { pluginName, remoteMarketplaceName: marketplace.name },
      pluginReadSchema
    );
    inventory.namedPluginServers[id] = detail.plugin.mcpServers;
  }
  return inventory;
}

/**
 * The thread config with the node's scope applied: ChatGPT apps off; every plugin off
 * unless named, and a named plugin's MCP servers off; every configured MCP server the
 * node does not declare off. Declared servers are the `mcp_servers` already in `config`;
 * their names come back with the config, for {@link checkThreadMcpScope} to allow.
 *
 * A declared server whose name the user's or project's config.toml also uses fails
 * `misconfigured`: Codex deep-merges the two tables, so the thread would get neither
 * the declared definition nor the configured one.
 */
export function applyNodeScope(
  config: ThreadConfig,
  inventory: CodexInventory,
  plugins: readonly string[]
): { config: ThreadConfig; declared: string[] } {
  const declared = declaredServers(config);
  const collisions = inventory.configuredServers.filter(name => name in declared);
  if (collisions.length > 0) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `The node's mcp: file declares ${collisions.join(', ')}, which your Codex config also defines ` +
        `(${inventory.codexHome}/config.toml or the project's .codex/config.toml). ` +
        'Codex would merge the two definitions. Rename the server in the mcp: file.'
    );
  }

  const mcpServers: JsonObject = {};
  for (const name of inventory.configuredServers) mcpServers[name] = { enabled: false };
  Object.assign(mcpServers, declared);

  const scoped: ThreadConfig = {
    ...config,
    // A named plugin turns plugins on for the thread even when the user turned them off
    // globally: the node asked for it, and every other plugin is switched off below.
    features: { apps: false, plugins: plugins.length > 0 },
  };
  if (Object.keys(mcpServers).length > 0) scoped.mcp_servers = mcpServers;
  if (plugins.length > 0) {
    const pluginSwitches: JsonObject = {};
    for (const id of inventory.installedPlugins) pluginSwitches[id] = { enabled: false };
    for (const id of plugins) {
      const servers: JsonObject = {};
      for (const name of inventory.namedPluginServers[id] ?? []) servers[name] = { enabled: false };
      pluginSwitches[id] = { enabled: true, mcp_servers: servers };
    }
    scoped.plugins = pluginSwitches;
  }
  return { config: scoped, declared: Object.keys(declared) };
}

/** The MCP servers the node declares: the `mcp_servers` the provider built from its `mcp:` file. */
function declaredServers(config: ThreadConfig): JsonObject {
  const servers = config.mcp_servers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? servers : {};
}

/**
 * Fails `misconfigured` unless every MCP server live on the thread is one the node
 * declared. Codex lists disabled servers too, so the status, not absence, is the
 * signal; a plugin's server never passes, because a declared server replaces the
 * plugin's and reports no plugin id. Runs between the thread request and `turn/start`,
 * so a failure spends nothing.
 */
export async function checkThreadMcpScope(
  connection: AppServerConnection,
  threadId: string,
  declared: readonly string[]
): Promise<void> {
  const allowed = new Set(declared);
  const unexpected: string[] = [];
  let cursor: string | null = null;
  do {
    const page: McpStatusPage = await requestScoped(
      connection,
      'mcpServerStatus/list',
      { threadId, detail: 'toolsAndAuthOnly', cursor },
      mcpStatusSchema
    );
    for (const server of page.data) {
      if (server.runtimeStatus === 'disabled') continue;
      if (server.pluginId === null && allowed.has(server.name)) continue;
      unexpected.push(
        server.pluginId === null ? server.name : `${server.name} (plugin ${server.pluginId})`
      );
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  if (unexpected.length > 0) {
    throw new ClassifiedProviderError(
      'misconfigured',
      `Codex loaded MCP servers this node does not declare: ${unexpected.join(', ')}. ` +
        'Declare each one the node needs in its mcp: file; Archon could not turn the others off for this Codex version.'
    );
  }
}
