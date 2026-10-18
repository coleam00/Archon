import { describe, expect, test } from 'bun:test';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { MessageChunk } from '../../types';
import { bridgeSession } from './event-bridge';
import { createArchonUIBridge, createArchonUIContext } from './ui-context-stub';

describe('assistant chunk coalescing', () => {
  const usage = { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } };

  function textDelta(delta: string): AgentSessionEvent {
    return {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} },
    } as unknown as AgentSessionEvent;
  }

  function textEnd(content: string): AgentSessionEvent {
    return {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content, partial: {} },
    } as unknown as AgentSessionEvent;
  }

  function toolStart(toolCallId: string, toolName: string): AgentSessionEvent {
    return { type: 'tool_execution_start', toolCallId, toolName, args: {} } as AgentSessionEvent;
  }

  function toolEnd(toolCallId: string, toolName: string): AgentSessionEvent {
    return {
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      result: 'ok',
      isError: false,
    } as AgentSessionEvent;
  }

  function agentEnd(fullText: string): AgentSessionEvent {
    return {
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          usage,
          stopReason: 'stop',
          content: [{ type: 'text', text: fullText }],
        },
      ],
    } as unknown as AgentSessionEvent;
  }

  /** Mock session that replays `events` on prompt(), then resolves — unless
   *  `rejectWith` is set, in which case prompt() throws after replaying. */
  function makeSession(events: AgentSessionEvent[], rejectWith?: Error): AgentSession {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    return {
      sessionId: 'session-coalesce',
      subscribe: (fn: (event: AgentSessionEvent) => void) => {
        listener = fn;
        return () => {};
      },
      prompt: async () => {
        for (const event of events) listener?.(event);
        if (rejectWith) throw rejectWith;
      },
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;
  }

  async function collect(session: AgentSession): Promise<MessageChunk[]> {
    const chunks: MessageChunk[] = [];
    for await (const chunk of bridgeSession(session, 'prompt')) chunks.push(chunk);
    return chunks;
  }

  test('coalesces char-level deltas into a single agent_message_chunk', async () => {
    // Regression for #1814: Pi streams token/char deltas. Before the fix each
    // became its own chunk and the DAG executor joined them with "\n\n",
    // yielding "Се\n\nгод\n\nня …". They must arrive as one block-level chunk.
    const deltas = ['Се', 'год', 'ня ', '**пят', 'ница**'];
    const full = deltas.join('');
    const chunks = await collect(
      makeSession([
        { type: 'turn_start' } as AgentSessionEvent,
        ...deltas.map(textDelta),
        agentEnd(full),
      ])
    );

    const assistantChunks = chunks.filter(c => c.type === 'agent_message_chunk');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0].text).toBe(full);
    expect(chunks[chunks.length - 1].type).toBe('result');
  });

  test('flushes buffered text before a tool call, preserving order', async () => {
    const full = 'Let me read the file.Done.';
    const chunks = await collect(
      makeSession([
        { type: 'turn_start' } as AgentSessionEvent,
        textDelta('Let me '),
        textDelta('read the file.'),
        toolStart('call-1', 'read'),
        toolEnd('call-1', 'read'),
        textDelta('Done.'),
        agentEnd(full),
      ])
    );

    const types = chunks.map(c => c.type);
    expect(types).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'result',
    ]);
    const assistantChunks = chunks.filter(c => c.type === 'agent_message_chunk');
    expect(assistantChunks[0].text).toBe('Let me read the file.');
    expect(assistantChunks[1].text).toBe('Done.');
  });

  test('flushes each completed text block at text_end', async () => {
    const full = 'block one block two';
    const chunks = await collect(
      makeSession([
        { type: 'turn_start' } as AgentSessionEvent,
        textDelta('block '),
        textDelta('one '),
        textEnd('block one '),
        textDelta('block two'),
        agentEnd(full),
      ])
    );

    const assistantChunks = chunks.filter(c => c.type === 'agent_message_chunk');
    expect(assistantChunks).toHaveLength(2);
    expect(assistantChunks[0].text).toBe('block one ');
    expect(assistantChunks[1].text).toBe('block two');
  });

  test('preserves partial buffered output when the stream errors', async () => {
    const session = makeSession(
      [{ type: 'turn_start' } as AgentSessionEvent, textDelta('partial answer before crash')],
      new Error('stream exploded')
    );

    const chunks: MessageChunk[] = [];
    let thrown: Error | undefined;
    try {
      for await (const chunk of bridgeSession(session, 'prompt')) chunks.push(chunk);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown?.message).toBe('stream exploded');
    const assistantChunks = chunks.filter(c => c.type === 'agent_message_chunk');
    expect(assistantChunks).toHaveLength(1);
    expect(assistantChunks[0].text).toBe('partial answer before crash');
  });

  function thinkingDelta(delta: string): AgentSessionEvent {
    return {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta, partial: {} },
    } as unknown as AgentSessionEvent;
  }

  test('coalesces thinking deltas into one agent_thought_chunk, apart from the text block', async () => {
    const chunks = await collect(
      makeSession([
        { type: 'turn_start' } as AgentSessionEvent,
        thinkingDelta('Let me '),
        thinkingDelta('think.'),
        textDelta('The '),
        textDelta('answer.'),
        agentEnd('The answer.'),
      ])
    );

    expect(chunks.filter(c => c.type !== 'result')).toEqual([
      { type: 'agent_thought_chunk', text: 'Let me think.' },
      { type: 'agent_message_chunk', text: 'The answer.' },
    ]);
  });

  test('an extension notify() reaches the consumer, after the buffered text, while the prompt still blocks', async () => {
    // Extensions such as plannotator notify the operator of a URL and then block the
    // turn until the operator acts, so the warning cannot wait for the prompt to end.
    const uiBridge = createArchonUIBridge();
    const ui = createArchonUIContext(uiBridge);
    let unblock: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      unblock = resolve;
    });
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      sessionId: 'session-notify',
      subscribe: (fn: (event: AgentSessionEvent) => void) => {
        listener = fn;
        return () => {};
      },
      prompt: async () => {
        listener?.({ type: 'turn_start' } as AgentSessionEvent);
        listener?.(textDelta('🔧 Running'));
        ui.notify('Open http://host:8080/', 'info');
        await blocked;
        ui.notify('Still waiting', 'info');
        listener?.(textDelta(' tool output'));
        ui.notify('Continue', 'info');
        listener?.(textDelta('\n\nFinal answer'));
        listener?.(textEnd('🔧 Running tool output\n\nFinal answer'));
        listener?.(textDelta('Separate block'));
        listener?.(agentEnd('🔧 Running tool output\n\nFinal answerSeparate block'));
      },
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;
    const chunks: MessageChunk[] = [];
    for await (const chunk of bridgeSession(session, 'prompt', undefined, undefined, uiBridge)) {
      chunks.push(chunk);
      if (chunk.type === 'warning') unblock();
    }
    expect(chunks.filter(c => c.type === 'agent_message_chunk')).toEqual([
      { type: 'agent_message_chunk', text: '🔧 Running' },
      { type: 'agent_message_chunk', text: ' tool output', continuesPreviousBlock: true },
      { type: 'agent_message_chunk', text: '\n\nFinal answer', continuesPreviousBlock: true },
      { type: 'agent_message_chunk', text: 'Separate block' },
    ]);
    expect(chunks[1]).toEqual({
      type: 'warning',
      code: 'pi.extension_notify',
      message: 'pi extension info: Open http://host:8080/',
    });
  });
});
