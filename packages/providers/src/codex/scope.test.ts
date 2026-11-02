import { describe, expect, spyOn, test } from 'bun:test';
import { ClassifiedProviderError } from '../shared/failure';
import { createFakeAppServer } from '../test/codex-app-server-fake';
import { AppServerConnection } from './app-server';
import {
  applyNodeScope,
  checkThreadMcpScope,
  readThreadMcpStatuses,
  type CodexInventory,
} from './scope';

const inventory: CodexInventory = {
  codexHome: '/home/user/.codex',
  configuredServers: ['posthog', 'notion'],
  installedPlugins: ['alpha@fixture', 'beta@fixture'],
  namedPluginServers: { 'alpha@fixture': ['alpha_srv'] },
};

const base = { skills: { include_instructions: false } };

describe('applyNodeScope', () => {
  test('a node that names nothing turns off plugins, apps and every configured server', () => {
    expect(applyNodeScope(base, { ...inventory, namedPluginServers: {} }, [])).toEqual({
      declared: [],
      config: {
        skills: { include_instructions: false },
        features: { apps: false, plugins: false },
        mcp_servers: { posthog: { enabled: false }, notion: { enabled: false } },
      },
    });
  });

  test('a named plugin stays on without its MCP servers, and every other installed plugin is off', () => {
    expect(applyNodeScope(base, inventory, ['alpha@fixture']).config).toMatchObject({
      features: { apps: false, plugins: true },
      plugins: {
        'beta@fixture': { enabled: false },
        'alpha@fixture': { enabled: true, mcp_servers: { alpha_srv: { enabled: false } } },
      },
    });
  });

  test('a declared server keeps its definition beside the disabled configured ones', () => {
    const scoped = applyNodeScope(
      { ...base, mcp_servers: { alpha_srv: { command: 'alpha' } } },
      inventory,
      ['alpha@fixture']
    );
    expect(scoped.config.mcp_servers).toEqual({
      posthog: { enabled: false },
      notion: { enabled: false },
      alpha_srv: { command: 'alpha' },
    });
    expect(scoped.declared).toEqual(['alpha_srv']);
  });

  test('feature switches already on the thread config survive, and scoping still wins', () => {
    const config = { ...base, features: { multi_agent: false, apps: true, plugins: true } };
    expect(applyNodeScope(config, inventory, []).config.features).toEqual({
      multi_agent: false,
      apps: false,
      plugins: false,
    });
  });

  test('a declared server that reuses a configured name fails before the thread starts', () => {
    const scope = (): unknown =>
      applyNodeScope({ ...base, mcp_servers: { posthog: { command: 'x' } } }, inventory, []);
    expect(scope).toThrow(ClassifiedProviderError);
    expect(scope).toThrow(/declares posthog, which your Codex config also defines/);
  });
});

/** Exercise the wire reader without the fake server filling absent fields with null. */
async function withMcpStatus(
  status: object,
  check: (connection: AppServerConnection) => Promise<void>
): Promise<void> {
  const connection = AppServerConnection.start(
    { path: '/bin/codex', pathDirs: [] },
    [],
    {},
    createFakeAppServer()
  );
  const request = spyOn(connection, 'request').mockResolvedValue({
    data: [status],
    nextCursor: null,
  });
  try {
    await check(connection);
  } finally {
    request.mockRestore();
    await connection.shutdown();
  }
}

describe('Codex MCP status wire fields', () => {
  test.each([{}, { pluginId: null }, { toolsError: null }, { pluginId: null, toolsError: null }])(
    'normalizes absent nullable fields: %j',
    async fields => {
      await withMcpStatus({ name: 'local', runtimeStatus: 'connected', ...fields }, async c => {
        expect(await readThreadMcpStatuses(c, 'thread')).toEqual([
          { name: 'local', runtimeStatus: 'connected', pluginId: null, toolsError: null },
        ]);
        await checkThreadMcpScope(c, 'thread', ['local']);
      });
    }
  );

  test('disabled ambient servers may omit nullable fields', async () => {
    await withMcpStatus({ name: 'ambient', runtimeStatus: 'disabled' }, async c => {
      await checkThreadMcpScope(c, 'thread', []);
    });
  });

  test.each(['connected', undefined])('undeclared servers still fail closed: %s', async status => {
    await withMcpStatus({ name: 'ambient', runtimeStatus: status }, async c => {
      await expect(checkThreadMcpScope(c, 'thread', [])).rejects.toThrow(
        'Codex loaded MCP servers this node does not declare: ambient'
      );
    });
  });

  test('a plugin server cannot pass by matching a declared name', async () => {
    await withMcpStatus(
      { name: 'local', runtimeStatus: 'connected', pluginId: 'alpha@fixture' },
      async c => {
        await expect(checkThreadMcpScope(c, 'thread', ['local'])).rejects.toThrow(
          'local (plugin alpha@fixture)'
        );
      }
    );
  });

  test.each([{ pluginId: 42 }, { toolsError: false }])(
    'rejects malformed fields: %j',
    async fields => {
      await withMcpStatus({ name: 'local', runtimeStatus: 'connected', ...fields }, async c => {
        await expect(readThreadMcpStatuses(c, 'thread')).rejects.toThrow(
          'unexpected `mcpServerStatus/list` response'
        );
      });
    }
  );
});
