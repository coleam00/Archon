import {
  mockCreateAgentSession,
  mockCreateBashTool,
  mockCreatePowerShellTool,
  mockSettingsManagerInMemory,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { delimiter } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider tools', () => {
  test('nodeConfig.effort=medium passes thinkingLevel', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { effort: 'medium' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBe('medium');
  });

  test('nodeConfig.allowed_tools filters Pi built-in tools', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'grep'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Pi 0.68+: customTools holds the actual Tool objects; noTools: "builtin"
    // suppresses Pi's default built-in set so the customTools list is authoritative.
    expect(Array.isArray(callArgs.customTools)).toBe(true);
    expect(callArgs.noTools).toBe('builtin');
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(tools.map(t => t.__piTool).sort()).toEqual(['grep', 'read']);
  });

  test('nodeConfig.allowed_tools: [] disables all Pi tools (LLM-only)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: [] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Empty customTools + noTools: "builtin" == "no tools at all".
    expect(callArgs.customTools).toEqual([]);
    expect(callArgs.noTools).toBe('builtin');
  });

  test('unknown tool names yield a pi.unknown_tools warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'WebFetch'] },
      })
    );

    const warnings = chunks.filter(
      (c): c is { type: 'warning'; code: string; message: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'warning'
    );
    expect(
      warnings.some(c => c.code === 'pi.unknown_tools' && c.message.includes('WebFetch'))
    ).toBe(true);
  });

  test('denied_tools alone starts from full built-in set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { denied_tools: ['bash', 'write'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(callArgs.noTools).toBe('builtin');
    // Pi has 7 built-ins, 2 denied → 5 remain
    expect(tools).toHaveLength(5);
    expect(tools.find(t => t.__piTool === 'bash')).toBeUndefined();
    expect(tools.find(t => t.__piTool === 'write')).toBeUndefined();
  });

  test('no allowed_tools / denied_tools leaves Pi default tools in place', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // No overrides → neither customTools nor noTools should be set; Pi uses
    // its default built-in tools.
    expect('customTools' in callArgs).toBe(false);
    expect('noTools' in callArgs).toBe(false);
  });

  test('requestOptions.env with no tool restrictions overrides Pi defaults with env-aware bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { DATABASE_URL: 'postgres://managed' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Env present → we override Pi's built-in defaults so bash sees the env.
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(callArgs.noTools).toBe('builtin');
    expect(tools.map(t => t.__piTool).sort()).toEqual(['bash', 'edit', 'read', 'write']);

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    expect(typeof bashOptions.spawnHook).toBe('function');

    // The spawnHook must merge caller env OVER Pi's inherited baseline, matching
    // Claude's { ...subprocessEnv, ...requestOptions.env } and Codex's buildCodexEnv.
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin', DATABASE_URL: 'postgres://stale' },
    }) as { env: Record<string, string> };
    expect(merged.env.PATH).toBe('/usr/bin');
    expect(merged.env.DATABASE_URL).toBe('postgres://managed');
  });

  test('requestOptions.env threads through to bash tool when allowed_tools includes bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'bash'] },
        env: { STRIPE_KEY: 'sk_test_abc' },
      })
    );

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    }) as { env: Record<string, string> };
    expect(merged.env.STRIPE_KEY).toBe('sk_test_abc');
    expect(merged.env.PATH).toBe('/usr/bin');
  });

  test('a caller PATH goes first and keeps Pi bin dir entries after it', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { PATH: ['/archon/gh-shim', '/usr/bin'].join(delimiter) },
      })
    );

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: ['/pi/agent/bin', '/usr/bin'].join(delimiter) },
    }) as { env: Record<string, string> };
    expect(merged.env.PATH).toBe(['/archon/gh-shim', '/usr/bin', '/pi/agent/bin'].join(delimiter));
  });

  test('empty requestOptions.env does NOT construct a spawnHook', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: {},
      })
    );

    // Every createBashTool call in this test path is either (cwd) or (cwd, undefined).
    for (const call of mockCreateBashTool.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  test("the user's Pi defaultTools setting survives when output_format adds a tool", async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockSettingsManagerInMemory.mockImplementationOnce(() => ({
      getDefaultTools: () => ['read', 'grep', 'ls', 'powershell'],
    }));

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.customTools as { __piTool?: string; name?: string }[];
    expect(tools.map(t => t.__piTool ?? t.name)).toEqual([
      'read',
      'grep',
      'ls',
      'powershell',
      'structured_output',
    ]);
  });

  test("the user's Pi defaultTools setting survives env-aware bash injection", async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockSettingsManagerInMemory.mockImplementationOnce(() => ({
      getDefaultTools: () => ['read', 'bash', 'powershell'],
    }));

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { DATABASE_URL: 'postgres://managed' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.customTools as { __piTool: string }[];
    expect(tools.map(t => t.__piTool)).toEqual(['read', 'bash', 'powershell']);
    const powershellOptions = mockCreatePowerShellTool.mock.calls.at(-1)?.[1] as
      | { spawnHook?: unknown }
      | undefined;
    expect(typeof powershellOptions?.spawnHook).toBe('function');
  });
});
