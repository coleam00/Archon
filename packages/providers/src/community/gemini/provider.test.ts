import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths so the provider + binary-resolver stay quiet and run
// in dev mode (BUNDLED_IS_BINARY=false → resolveGeminiBinaryPath returns
// undefined without touching the filesystem). ──────────────────────────────
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: () => '/tmp/.archon-test',
}));

// ─── Mock the Gemini SDK. `query` replays a scripted chunk sequence and
// records the QueryOptions it was called with. ─────────────────────────────
let scriptedChunks: Array<Record<string, unknown>> = [];
const mockQuery = mock(async function* () {
  for (const chunk of scriptedChunks) yield chunk;
});
mock.module('@lrilai/gemini-cli-sdk', () => ({
  query: mockQuery,
}));

// Static import AFTER the mocks — Bun hoists mock.module above this import.
import { GeminiProvider } from './provider';

async function collect(gen: AsyncGenerator<unknown>): Promise<Array<{ type: string }>> {
  const results: Array<{ type: string }> = [];
  for await (const chunk of gen) results.push(chunk as { type: string });
  return results;
}

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider();
    scriptedChunks = [];
    mockQuery.mockClear();
  });

  test('getType() returns gemini', () => {
    expect(provider.getType()).toBe('gemini');
  });

  test('getCapabilities() returns the conservative v1 matrix', () => {
    const caps = provider.getCapabilities();
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.mcp).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.hooks).toBe(false);
  });

  test('passes an assistant chunk through', async () => {
    scriptedChunks = [{ type: 'assistant', content: 'Hello world' }];
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    expect(chunks).toContainEqual({ type: 'assistant', content: 'Hello world' });
  });

  test('does NOT emit workflow_dispatch before tool chunks (port-time fix)', async () => {
    scriptedChunks = [{ type: 'tool', toolName: 'bash', toolId: 'id-1', parameters: {} }];
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    expect(chunks.filter(c => c.type === 'workflow_dispatch')).toHaveLength(0);
    expect(chunks.filter(c => c.type === 'tool')).toHaveLength(1);
  });

  test('tool_result has an empty toolName (SDK omits it)', async () => {
    scriptedChunks = [{ type: 'tool_result', toolId: 'id-1', status: 'success', output: 'ok' }];
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    const toolResult = chunks.find(c => c.type === 'tool_result') as
      | { type: string; toolName: string }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolName).toBe('');
  });

  test('forwards env to the SDK without injecting HOME', async () => {
    scriptedChunks = [{ type: 'result', sessionId: 's', stopReason: 'end_turn' }];
    await collect(provider.sendQuery('hi', '/cwd', undefined, { env: { MY_SECRET: 'x' } }));
    const callArg = mockQuery.mock.calls[0]?.[0] as { env?: Record<string, string> };
    expect(callArg.env?.MY_SECRET).toBe('x');
    expect(callArg.env?.HOME).toBeUndefined();
  });

  test('passes resumeSessionId as session', async () => {
    scriptedChunks = [{ type: 'result', sessionId: 's', stopReason: 'end_turn' }];
    await collect(provider.sendQuery('hi', '/cwd', 'ses-abc'));
    const callArg = mockQuery.mock.calls[0]?.[0] as { session?: string };
    expect(callArg.session).toBe('ses-abc');
  });

  test('propagates SDK errors', async () => {
    mockQuery.mockImplementationOnce(async function* () {
      await Promise.resolve();
      throw new Error('gemini-cli crashed');
    });
    await expect(collect(provider.sendQuery('hi', '/cwd'))).rejects.toThrow('gemini-cli crashed');
  });
});
