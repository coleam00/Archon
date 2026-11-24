import {
  type FakeEvent,
  mockPrompt,
  mockCreateAgentSession,
  capturedListener,
  createMockSessionResult,
  scriptedEvents,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider output', () => {
  test('yields tool_call + tool_call_update for tool_execution events', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: '/x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'read',
        result: 'contents',
        isError: false,
      },
      ...scriptedAgentEnd(),
    ]);

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(chunks.length).toBe(5);
    expect(chunks[4]).toEqual({ type: 'settled' });
    expect(chunks[0]).toMatchObject({ type: 'session' });
    expect(chunks[1]).toEqual({
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'read',
      rawInput: { path: '/x' },
    });
    expect(chunks[2]).toEqual({
      type: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      output: 'contents',
    });
    expect(chunks[3]).toMatchObject({ type: 'result' });
  });

  // Script an assistant text_delta followed by agent_end so the bridge has
  // buffered content to parse when outputFormat is set.
  function scriptedAssistantThenEnd(text: string): FakeEvent[] {
    return [
      {
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: { role: 'assistant' } as never,
        },
      },
      ...scriptedAgentEnd(),
    ];
  }

  test('outputFormat: the prompt asks for the structured_output tool call', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('Summarize this bug.', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { area: { type: 'string' } } },
        },
      })
    );

    expect(mockPrompt).toHaveBeenCalled();
    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toContain('Summarize this bug.');
    expect(sentPrompt).toContain('calling the `structured_output` tool');
    expect(sentPrompt).not.toContain('Respond with ONLY a JSON object');
    expect(sentPrompt).toContain('"area"');
  });

  test('outputFormat: absent → prompt passed through unchanged', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('do a thing', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toBe('do a thing');
    expect(sentPrompt).not.toContain('JSON');
  });

  test('outputFormat: result chunk carries parsed structuredOutput on clean JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"area":"web","confidence":0.9}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('classify', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result?.structuredOutput).toEqual({ area: 'web', confidence: 0.9 });
  });

  test('no outputFormat → structuredOutput never set even if assistant emits JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"accidental":"json"}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toBeUndefined();
  });

  test('outputFormat: adds the structured_output tool beside the default tools', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.customTools as { __piTool?: string; name?: string }[];
    expect(callArgs.noTools).toBe('builtin');
    expect(tools.map(t => t.__piTool ?? t.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'structured_output',
    ]);
  });

  test('outputFormat: the tool call answers the turn and its failed calls are capped', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    const sessionResult = createMockSessionResult();
    const session = { ...sessionResult.session, agent: {} } as typeof sessionResult.session;
    mockCreateAgentSession.mockImplementationOnce(async options => {
      const tool = options?.customTools?.find(t => t.name === 'structured_output');
      mockPrompt.mockImplementationOnce(async () => {
        await tool?.execute('call-1', { area: 'web' }, undefined, undefined, {} as never);
        for (const ev of scriptedEvents) capturedListener?.(ev);
      });
      return { ...sessionResult, session };
    });

    const { chunks } = await consume(
      new PiProvider().sendQuery('classify', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toEqual({ area: 'web' });

    const failedCall = { toolName: 'structured_output', isError: true };
    const turn = { toolResults: [failedCall, failedCall, failedCall] } as unknown as Parameters<
      NonNullable<typeof session.agent.finishTurn>
    >[0];
    expect(await session.agent.finishTurn?.(turn)).toEqual({ action: 'end' });
  });

  test('outputFormat: a schema without an object root fails before the session opens', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { failure } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: { type: 'array', items: {} } },
      })
    );

    expect(failure?.class).toBe('misconfigured');
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  test('outputFormat: a schema Pi cannot compile fails before the session opens', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { failure } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { id: { type: 'string', pattern: '(' } } },
        },
      })
    );

    expect(failure?.class).toBe('misconfigured');
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });
});
