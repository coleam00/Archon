import {
  type FakeEvent,
  mockPrompt,
  createMockSessionResult,
  mockCreateAgentSession,
  type MockModelRuntime,
  mockModelRuntimeCreate,
  mockSessionList,
  mockDefineTool,
  consume,
  resetScript,
  readEnv,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { overStreams } from '../../test/plugin';
import { createProvider, descriptor } from './index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, mock, test } from 'bun:test';
import { PiProvider } from './provider';
import { PI_CAPABILITIES } from './capabilities';
import { runProviderConformance } from '@archon/provider-contract/conformance';
describe('PiProvider contract', () => {
  test('getType returns "pi"', () => {
    expect(new PiProvider().getType()).toBe('pi');
  });

  test('getCapabilities matches PI_CAPABILITIES constant', () => {
    const caps = new PiProvider().getCapabilities();
    expect(caps).toEqual(PI_CAPABILITIES);
    expect(caps).toMatchObject({
      effortControl: true,
      toolRestrictions: true,
      skills: true,
      sessionResume: true,
      envInjection: true,
      structuredOutput: 'best-effort',
      mcp: false,
      hooks: false,
    });
  });

  test('sendQuery installs PI_PACKAGE_DIR shim before Pi SDK loads', async () => {
    // Runtime-safety regression: Pi's config.js reads `getPackageJsonPath()` at
    // its module init, which resolves to a non-existent path inside compiled
    // archon binaries. The shim writes a stub package.json to tmpdir and sets
    // PI_PACKAGE_DIR so Pi's short-circuit kicks in. Must run BEFORE the
    // dynamic imports in sendQuery — we verify by calling the fast-fail "no
    // model" path (which returns before any Pi SDK logic executes) and
    // asserting the env var was set regardless.
    delete process.env.PI_PACKAGE_DIR;
    expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
    await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(readEnv('PI_PACKAGE_DIR')).toBeDefined();
    expect(readEnv('PI_PACKAGE_DIR')).toContain('archon-pi-shim');

    // Stub contents are load-bearing: Pi reads `version` to populate its
    // user-agent and `piConfig` (even when empty) to opt into the defaults
    // path instead of erroring on missing config. Asserting on shape so a
    // regression here surfaces in the test suite, not in a Pi runtime crash.
    const shimDir = readEnv('PI_PACKAGE_DIR');
    expect(shimDir).toBe(join(tmpdir(), 'archon-pi-shim'));
    const stub = JSON.parse(readFileSync(join(shimDir!, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      piConfig: Record<string, unknown>;
    };
    expect(stub.name).toBe('archon-pi-shim');
    expect(stub.version).toBe('0.0.0');
    expect(stub.piConfig).toEqual({});
  });

  test.each([false, true])('conforms to the provider contract (streams: %s)', async remote => {
    const client = remote ? overStreams(createProvider, descriptor) : createProvider();
    process.env.GEMINI_API_KEY = 'sk-test';
    const erroredAgentEnd = (): FakeEvent[] => {
      const events = scriptedAgentEnd();
      const end = events[0] as { messages: Record<string, unknown>[] };
      end.messages[0].stopReason = 'error';
      end.messages[0].errorMessage = '429 Too Many Requests: rate limit exceeded';
      return events;
    };
    // Pi aborts mid-tool: `bash` started and never ended before the agent loop stopped.
    const interruptedToolTurn = (): FakeEvent[] => {
      const [agentEnd] = scriptedAgentEnd();
      if (agentEnd.type !== 'agent_end') throw new Error('scriptedAgentEnd changed shape');
      return [
        {
          type: 'tool_execution_start',
          toolCallId: 'read-1',
          toolName: 'read',
          args: { path: '/x' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'read-1',
          toolName: 'read',
          result: 'contents',
          isError: false,
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'bash-1',
          toolName: 'bash',
          args: { command: 'sleep 60' },
        },
        {
          ...agentEnd,
          messages: agentEnd.messages.map(m => ({ ...m, stopReason: 'aborted' }) as typeof m),
        },
      ];
    };
    const violations = await runProviderConformance({
      capabilities: client.getCapabilities(),
      turns: [
        {
          name: 'completed prompt',
          run: () => {
            resetScript(scriptedAgentEnd());
            return client.sendQuery('hi', '/tmp', undefined, {
              model: 'google/gemini-2.5-pro',
            });
          },
        },
      ],
      forkTurn: {
        name: 'forked session',
        source: 'source-id',
        run: () => {
          mockSessionList.mockImplementationOnce(async () => [
            { id: 'source-id', path: '/sessions/source-id.jsonl', cwd: '/tmp' },
          ]);
          resetScript(scriptedAgentEnd());
          return client.sendQuery('hi', '/tmp', 'source-id', {
            model: 'google/gemini-2.5-pro',
            forkSession: true,
          });
        },
      },
      toolTurn: {
        name: 'interrupted tool turn',
        run: () => {
          resetScript(interruptedToolTurn());
          return client.sendQuery('hi', '/tmp', undefined, {
            model: 'google/gemini-2.5-pro',
          });
        },
      },
      failureCases: [
        {
          name: 'errored turn',
          expected: 'unknown',
          evidence: '429 Too Many Requests',
          run: () => {
            resetScript(erroredAgentEnd());
            return client.sendQuery('hi', '/tmp', undefined, {
              model: 'google/gemini-2.5-pro',
            });
          },
        },
        {
          name: 'rejected prompt',
          expected: 'unknown',
          evidence: 'pi backend exploded',
          run: () => {
            mockPrompt.mockImplementationOnce(async () => {
              throw new Error('pi backend exploded');
            });
            return client.sendQuery('hi', '/tmp', undefined, {
              model: 'google/gemini-2.5-pro',
            });
          },
        },
        {
          name: 'no model configured',
          expected: 'misconfigured',
          evidence: 'Pi provider requires a model',
          run: () => {
            delete process.env.GEMINI_API_KEY;
            return client.sendQuery('hi', '/tmp');
          },
        },
      ],
    });
    expect(violations).toEqual([]);
  });

  test('Pi native tools execute host callbacks and carry identical chunks over streams', async () => {
    process.env.GEMINI_API_KEY = 'fixture-key';
    const handler = mock(async (input: Record<string, unknown>) => JSON.stringify(input));
    const chunks: unknown[][] = [];
    try {
      for (const provider of [createProvider(), overStreams(createProvider, descriptor)]) {
        resetScript(scriptedAgentEnd());
        let toolResult: unknown;
        mockCreateAgentSession.mockImplementationOnce(async options => {
          const native = options?.customTools?.find(tool => tool.name === 'manage_run');
          expect(native).toBeDefined();
          const defined = mockDefineTool.mock.calls.at(-1)![0];
          expect(defined.name).toBe(native!.name);
          toolResult = await defined.execute('native-call', { action: 'inspect' });
          return createMockSessionResult();
        });
        chunks.push(
          await Array.fromAsync(
            provider.sendQuery('inspect', '/tmp', undefined, {
              model: 'google/gemini-2.5-pro',
              nativeTools: [
                {
                  name: 'manage_run',
                  description: 'Inspect a run',
                  inputSchema: { properties: { action: { kind: 'string' } }, required: ['action'] },
                  handler,
                },
              ],
            })
          )
        );
        expect(toolResult).toMatchObject({
          content: [{ type: 'text', text: '{"action":"inspect"}' }],
        });
      }
      expect(chunks[1]).toEqual(chunks[0]);
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  test.each(['direct', 'transport'] as const)(
    'Pi %s model listing propagates in-flight cancellation without caching an empty catalog',
    async mode => {
      const started = Promise.withResolvers<AbortSignal>();
      const runtimeCancelled = Promise.withResolvers<void>();
      mockModelRuntimeCreate.mockImplementationOnce(async options => {
        const signal = options?.signal;
        if (!signal) throw new Error('catalog signal missing');
        started.resolve(signal);
        return await new Promise<MockModelRuntime>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              runtimeCancelled.resolve();
              reject(signal.reason);
            },
            { once: true }
          );
        });
      });
      const direct = createProvider();
      const abort = new AbortController();
      if (mode === 'direct') {
        const pending = direct.listModels({ signal: abort.signal });
        expect(await started.promise).toBe(abort.signal);
        abort.abort(new Error('catalog deadline'));
        await expect(pending).rejects.toThrow('catalog deadline');
      } else {
        const remote = overStreams(createProvider, descriptor);
        const pending = remote.listModels!({ signal: abort.signal });
        await started.promise;
        abort.abort(new Error('catalog deadline'));
        await expect(pending).rejects.toThrow('catalog deadline');
      }
      await runtimeCancelled.promise;
      expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
    }
  );

  test('Pi information hooks preserve backend status and model lists over streams', async () => {
    process.env.GEMINI_API_KEY = 'p4-backend-secret';
    const request = {
      signal: new AbortController().signal,
      assistantConfig: { model: 'google/gemini-2.5-pro' },
    };
    const direct = createProvider();
    const remote = overStreams(createProvider, descriptor);
    const diagnostics = await direct.diagnose(request);
    expect(diagnostics.checks.map(check => check.status)).toEqual(['ok', 'ok']);
    expect(await remote.diagnose!(request)).toEqual(diagnostics);
    expect(JSON.stringify(diagnostics)).not.toContain('p4-backend-secret');
    const models = {
      models: [
        {
          id: 'google/gemini-2.5-pro',
          label: 'google/gemini-2.5-pro',
          details: {
            provider: 'google',
            modelId: 'gemini-2.5-pro',
            reasoning: false,
            cost: { input: 0, output: 0 },
            contextWindow: 128_000,
          },
        },
      ],
    };
    expect(await direct.listModels({ signal: new AbortController().signal })).toEqual(models);
    expect(await remote.listModels!({ signal: new AbortController().signal })).toEqual(models);
  });
});
