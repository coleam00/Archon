import { describe, expect, test } from 'bun:test';
import { ClassifiedProviderError } from '../shared/failure';
import { applyNodeScope, type CodexInventory } from './scope';

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

  test('a declared server that reuses a configured name fails before the thread starts', () => {
    const scope = (): unknown =>
      applyNodeScope({ ...base, mcp_servers: { posthog: { command: 'x' } } }, inventory, []);
    expect(scope).toThrow(ClassifiedProviderError);
    expect(scope).toThrow(/declares posthog, which your Codex config also defines/);
  });
});
