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

async function withStatusResponse<T>(
  server: object,
  check: (connection: AppServerConnection) => Promise<T>
): Promise<T> {
  const spawner = createFakeAppServer();
  const connection = AppServerConnection.start(
    { path: '/bin/codex', pathDirs: [] },
    [],
    {},
    spawner
  );
  const request = spyOn(connection, 'request').mockResolvedValue({
    data: [server],
    nextCursor: null,
  });
  try {
    return await check(connection);
  } finally {
    request.mockRestore();
    spawner.processes[0].exit(0);
    await connection.shutdown();
  }
}

describe('MCP status response parsing', () => {
  test('normalizes omitted nullable fields and permits a declared server', async () => {
    const server = { name: 'declared', runtimeStatus: 'connected' } as const;
    await withStatusResponse(server, async connection => {
      expect(await readThreadMcpStatuses(connection, 'thread-1')).toEqual([
        { ...server, pluginId: null, toolsError: null },
      ]);
      await checkThreadMcpScope(connection, 'thread-1', ['declared']);
    });
  });

  test('an undeclared server with omitted nullable fields remains blocked', async () => {
    await expect(
      withStatusResponse({ name: 'ambient', runtimeStatus: 'connected' }, connection =>
        checkThreadMcpScope(connection, 'thread-1', [])
      )
    ).rejects.toMatchObject({
      failureClass: 'misconfigured',
      message: expect.stringContaining('does not declare: ambient.'),
    });
  });
});
