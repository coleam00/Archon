import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';

import type { MessageChunk } from '../../types';
import {
  bridgeSession,
  buildResultChunk,
  isOmpStopReasonError,
  mapOmpEvent,
  ThinkingTagStripper,
} from './event-bridge';
import { createOmpDiagnosticsContext, summarizeUnknown } from './diagnostics';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: string; delta: string } }
  | { type: 'tool_execution_start'; toolName: string; args: unknown; toolCallId: string }
  | {
      type: 'tool_execution_end';
      toolName: string;
      result: unknown;
      isError: boolean;
      toolCallId: string;
    }
  | { type: 'agent_end'; messages: readonly unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end' };

function textDelta(delta: string): FakeEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } };
}

function toolStart(toolName: string, toolCallId: string, args: unknown = {}): FakeEvent {
  return { type: 'tool_execution_start', toolName, args, toolCallId };
}

function toolEnd(
  toolName: string,
  toolCallId: string,
  result: unknown,
  isError = false
): FakeEvent {
  return { type: 'tool_execution_end', toolName, result, isError, toolCallId };
}

function assistantMessage(stopReason: string, text = 'done'): unknown {
  return { role: 'assistant', stopReason, usage, content: [{ type: 'text', text }] };
}

function agentEnd(text = 'done', stopReason = 'stop'): FakeEvent {
  return { type: 'agent_end', messages: [assistantMessage(stopReason, text)] };
}

function makeDiagnostics() {
  return createOmpDiagnosticsContext({
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    cwd: '/tmp',
    resumed: false,
  });
}

function makeSession(events: readonly FakeEvent[]): AgentSession {
  let listener: ((event: FakeEvent) => void) | undefined;
  return {
    subscribe: (fn: (event: FakeEvent) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    prompt: mock(async () => {
      for (const event of events) listener?.(event);
    }),
    abort: mock(async () => undefined),
    dispose: mock(async () => undefined),
  } as unknown as AgentSession;
}

/**
 * Fake session driven by an async script. The script receives an `emit`
 * function (pushes events to the subscriber) and controls when (and whether)
 * `prompt()` resolves.
 */
function makeScriptedSession(
  script: (emit: (event: FakeEvent) => void) => Promise<void>
): AgentSession & { abortCalls: number; disposeCalls: number } {
  let listener: ((event: FakeEvent) => void) | undefined;
  const session = {
    abortCalls: 0,
    disposeCalls: 0,
    subscribe(fn: (event: FakeEvent) => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      await script(event => listener?.(event));
    },
    abort() {
      session.abortCalls += 1;
    },
    dispose: async () => {
      session.disposeCalls += 1;
    },
  };
  return session as unknown as AgentSession & { abortCalls: number; disposeCalls: number };
}

async function collect(
  session: AgentSession,
  options?: Parameters<typeof bridgeSession>[5]
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of bridgeSession(
    session,
    'prompt',
    undefined,
    undefined,
    undefined,
    options
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

const TIMEOUT_ENV_VARS = [
  'ARCHON_OMP_FIRST_EVENT_TIMEOUT_MS',
  'ARCHON_OMP_STREAM_DEATH_TIMEOUT_MS',
  'ARCHON_OMP_TOOL_EXECUTION_TIMEOUT_MS',
] as const;

afterEach(() => {
  for (const name of TIMEOUT_ENV_VARS) delete process.env[name];
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── mapOmpEvent ────────────────────────────────────────────────────────────

describe('mapOmpEvent', () => {
  test('text_delta maps to assistant chunk', () => {
    expect(mapOmpEvent(textDelta('hello'))).toEqual([{ type: 'assistant', content: 'hello' }]);
  });

  test('thinking_delta maps to thinking chunk', () => {
    expect(
      mapOmpEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden' },
      })
    ).toEqual([{ type: 'thinking', content: 'hidden' }]);
  });
});

// ─── Diagnostics summarizers ───────────────────────────────────────────────

describe('summarizeUnknown', () => {
  test('passes short strings through', () => {
    expect(summarizeUnknown('hello', 50)).toBe('hello');
  });

  test('truncates long strings with a marker', () => {
    const out = summarizeUnknown('a'.repeat(300), 100);
    expect(out.length).toBeLessThan(150);
    expect(out).toContain('… [truncated 200 chars]');
  });

  test('serializes objects and collapses newlines', () => {
    expect(summarizeUnknown({ a: 1 }, 50)).toBe('{"a":1}');
    expect(summarizeUnknown('line1\nline2', 50)).toBe('line1 line2');
  });

  test('handles unserializable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeUnknown(circular, 50)).toBe('[unserializable object]');
  });
});

describe('OmpDiagnosticsContext ledger', () => {
  test('records tool start/end ordering with args and result summaries', () => {
    const d = makeDiagnostics();
    d.recordToolStart('bash', 'c1', { command: 'ls -la' });
    expect(d.hasToolInFlight()).toBe(true);
    expect(d.getEarliestInFlightStart()).toBeNumber();

    const attempt = d.recordToolEnd('bash', 'c1', 'file listing', false);
    expect(attempt.phase).toBe('ended');
    expect(attempt.argsSummary).toContain('ls -la');
    expect(attempt.resultSummary).toContain('file listing');
    expect(d.hasToolInFlight()).toBe(false);
  });

  test('end-without-start synthesizes an attempt', () => {
    const d = makeDiagnostics();
    const attempt = d.recordToolEnd('edit', 'orphan', 'boom', true);
    expect(attempt.synthesized).toBe(true);
    expect(attempt.phase).toBe('failed');
    expect(d.getAttempts()).toHaveLength(1);
  });

  test('multiple same-name tools are tracked independently by call id', () => {
    const d = makeDiagnostics();
    d.recordToolStart('bash', 'c1', { command: 'first' });
    d.recordToolStart('bash', 'c2', { command: 'second' });
    expect(d.getInFlightAttempts()).toHaveLength(2);

    d.recordToolEnd('bash', 'c2', 'second done', false);
    const inFlight = d.getInFlightAttempts();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.toolCallId).toBe('c1');
    expect(d.findAttempt('c2')?.phase).toBe('ended');
  });

  test('formatForErrorMessage is bounded and includes recent tools', () => {
    const d = makeDiagnostics();
    for (let i = 0; i < 30; i++) {
      d.recordToolStart('bash', `c${String(i)}`, { command: 'x'.repeat(500) });
      d.recordToolEnd('bash', `c${String(i)}`, 'ok', false);
    }
    const msg = d.formatForErrorMessage();
    expect(msg).toContain('[omp diagnostics:');
    expect(msg).toContain('model=google/gemini-2.5-pro');
    expect(msg.length).toBeLessThan(3000);
  });
});

// ─── Ledger recording from bridge events ───────────────────────────────────

describe('bridgeSession ledger recording', () => {
  test('records every event and tool lifecycle into the shared diagnostics', async () => {
    const diagnostics = makeDiagnostics();
    await collect(
      makeSession([
        { type: 'turn_start' },
        toolStart('bash', 'call-1', { command: 'echo hi' }),
        toolEnd('bash', 'call-1', 'hi'),
        textDelta('answer'),
        agentEnd(),
      ]),
      { diagnostics }
    );

    expect(diagnostics.getLastEventType()).toBe('agent_end');
    expect(diagnostics.getLastStopReason()).toBe('stop');
    expect(diagnostics.getAttempts()).toHaveLength(1);
    expect(diagnostics.getAttempts()[0]?.phase).toBe('ended');
    expect(diagnostics.hasToolInFlight()).toBe(false);
  });

  test('in-flight tool detection survives an end-without-start', async () => {
    const diagnostics = makeDiagnostics();
    await collect(
      makeSession([
        toolStart('bash', 'c1', {}),
        toolEnd('edit', 'other', 'orphan result', true),
        agentEnd(),
      ]),
      { diagnostics }
    );
    // c1 never ended → still recorded as started; orphan end synthesized.
    expect(diagnostics.getAttempts()).toHaveLength(2);
    expect(diagnostics.findAttempt('c1')?.phase).toBe('started');
    expect(diagnostics.findAttempt('other')?.synthesized).toBe(true);
  });
});

// ─── Enriched tool failure chunks ──────────────────────────────────────────

describe('enriched tool failure chunks', () => {
  test('failed tool emits system + tool_result chunks with serialized error and call id', async () => {
    const diagnostics = makeDiagnostics();
    const chunks = await collect(
      makeSession([
        toolStart('bash', 'call-9', { command: 'rm -rf /nope' }),
        toolEnd('bash', 'call-9', { error: 'permission denied' }, true),
        agentEnd(),
      ]),
      { diagnostics }
    );

    const system = chunks.find(c => c.type === 'system');
    expect(system).toBeDefined();
    if (system?.type === 'system') {
      expect(system.content).toContain('⚠️');
      expect(system.content).toContain("Tool 'bash' failed");
      expect(system.content).toContain('callId=call-9');
      expect(system.content).toContain('phase=failed');
      expect(system.content).toContain('rm -rf /nope');
    }

    const toolResult = chunks.find(c => c.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.toolName).toBe('bash');
      expect(toolResult.toolCallId).toBe('call-9');
      expect(toolResult.toolOutput).toContain('permission denied');
      expect(toolResult.toolOutput).toContain('callId=call-9');
    }
  });

  test('successful tool keeps the plain serialized result', async () => {
    const chunks = await collect(
      makeSession([toolStart('bash', 'c1', {}), toolEnd('bash', 'c1', 'plain output'), agentEnd()])
    );
    const toolResult = chunks.find(c => c.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.toolOutput).toBe('plain output');
    }
    expect(chunks.some(c => c.type === 'system')).toBe(false);
  });
});

// ─── Stop-reason classification ────────────────────────────────────────────

describe('stop-reason classification', () => {
  test('isOmpStopReasonError marks known-bad reasons only', () => {
    expect(isOmpStopReasonError('error')).toBe(true);
    expect(isOmpStopReasonError('aborted')).toBe(true);
    expect(isOmpStopReasonError('length')).toBe(true);
    expect(isOmpStopReasonError('toolUse')).toBe(true);
    expect(isOmpStopReasonError('stop')).toBe(false);
    expect(isOmpStopReasonError(undefined)).toBe(false);
    expect(isOmpStopReasonError('some_future_reason')).toBe(false);
  });

  test('normal stop produces a non-error result preserving stopReason', () => {
    const chunk = buildResultChunk([assistantMessage('stop')]);
    expect(chunk).toMatchObject({ type: 'result', stopReason: 'stop' });
    expect('isError' in chunk && chunk.isError).toBeFalsy();
  });

  test.each(['error', 'aborted', 'length', 'toolUse'])(
    "stopReason '%s' produces isError with errorSubtype",
    stopReason => {
      const chunk = buildResultChunk([assistantMessage(stopReason)], makeDiagnostics());
      expect(chunk).toMatchObject({
        type: 'result',
        isError: true,
        errorSubtype: stopReason,
        stopReason,
      });
      if (chunk.type === 'result') {
        expect(chunk.errors?.[0]).toContain(stopReason);
        expect(chunk.errors?.[0]).toContain('[omp diagnostics:');
      }
    }
  );

  test('unknown stop reason is preserved visibly but NOT marked as error', () => {
    const chunk = buildResultChunk([assistantMessage('weird_new_reason')]);
    expect(chunk).toMatchObject({ type: 'result', stopReason: 'weird_new_reason' });
    expect('isError' in chunk && chunk.isError).toBeFalsy();
  });

  test('missing assistant message includes diagnostics summary in errors', () => {
    const diagnostics = makeDiagnostics();
    diagnostics.recordToolStart('bash', 'c1', { command: 'ls' });
    const chunk = buildResultChunk([], diagnostics);
    expect(chunk).toMatchObject({
      type: 'result',
      isError: true,
      errorSubtype: 'missing_assistant_message',
    });
    if (chunk.type === 'result') {
      expect(chunk.errors?.[0]).toContain('[omp diagnostics:');
      expect(chunk.errors?.[0]).toContain('bash#c1');
    }
  });
});

// ─── Timeouts ──────────────────────────────────────────────────────────────

describe('bridgeSession timeouts', () => {
  test('first-event timeout fires when no events arrive, aborts session', async () => {
    process.env.ARCHON_OMP_FIRST_EVENT_TIMEOUT_MS = '20';
    const session = makeScriptedSession(async () => {
      await sleep(10_000); // never emits, never resolves in test time
    });
    const diagnostics = makeDiagnostics();

    await expect(collect(session, { diagnostics })).rejects.toThrow(/OMP first-event timeout/);
    expect(session.abortCalls).toBeGreaterThanOrEqual(1);
    expect(session.disposeCalls).toBe(1);
  });

  test('stream-death timeout fires on silence between events', async () => {
    process.env.ARCHON_OMP_FIRST_EVENT_TIMEOUT_MS = '5000';
    process.env.ARCHON_OMP_STREAM_DEATH_TIMEOUT_MS = '25';
    const session = makeScriptedSession(async emit => {
      emit(textDelta('partial answer'));
      await sleep(10_000); // then silence
    });

    let error: Error | undefined;
    const chunks: MessageChunk[] = [];
    try {
      for await (const chunk of bridgeSession(session, 'prompt')) chunks.push(chunk);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toMatch(/OMP stream-death timeout/);
    expect(error?.message).toContain('[omp diagnostics:');
    expect(chunks.some(c => c.type === 'assistant')).toBe(true);
    expect(session.abortCalls).toBeGreaterThanOrEqual(1);
  });

  test('long tool execution does NOT trigger stream-death timeout', async () => {
    process.env.ARCHON_OMP_STREAM_DEATH_TIMEOUT_MS = '25';
    process.env.ARCHON_OMP_TOOL_EXECUTION_TIMEOUT_MS = '5000';
    const session = makeScriptedSession(async emit => {
      emit(textDelta('starting'));
      emit(toolStart('bash', 'slow-1', { command: 'long build' }));
      await sleep(90); // tool runs well past the 25ms stream-death window
      emit(toolEnd('bash', 'slow-1', 'build ok'));
      emit(agentEnd());
    });

    const chunks = await collect(session);
    expect(chunks.some(c => c.type === 'tool_result')).toBe(true);
    expect(chunks.some(c => c.type === 'result')).toBe(true);
    expect(session.abortCalls).toBe(0);
  });

  test('hung tool DOES trigger the tool-execution ceiling', async () => {
    process.env.ARCHON_OMP_STREAM_DEATH_TIMEOUT_MS = '5000';
    process.env.ARCHON_OMP_TOOL_EXECUTION_TIMEOUT_MS = '30';
    const session = makeScriptedSession(async emit => {
      emit(toolStart('bash', 'hung-1', { command: 'sleep forever' }));
      await sleep(10_000); // tool never ends
    });

    let error: Error | undefined;
    try {
      await collect(session);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toMatch(/OMP tool-execution timeout/);
    expect(error?.message).toContain('bash#hung-1');
    expect(session.abortCalls).toBeGreaterThanOrEqual(1);
  });
});

// ─── ThinkingTagStripper rerouting ─────────────────────────────────────────

describe('ThinkingTagStripper', () => {
  test('reroutes complete think blocks to thinking', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('before <think>hidden</think>after')).toEqual({
      visible: 'before after',
      thinking: 'hidden',
    });
    const flushed = stripper.flush();
    expect(flushed.visible).toBe('');
    expect(flushed.thinking).toBe('');
    expect(flushed.unclosedBlock).toBe(false);
  });

  test('reroutes split think blocks without leaking partial tags', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('before <thi').visible).toBe('before ');
    const mid = stripper.write('nk>hidden');
    expect(mid.visible).toBe('');
    expect(mid.thinking).toBe('hidden');
    const end = stripper.write('</think>after');
    expect(end.visible).toBe('after');
  });

  test('handles thinking alias blocks and stray closing tags', () => {
    const stripper = new ThinkingTagStripper();

    const first = stripper.write('<thinking>hidden</think');
    expect(first.visible).toBe('');
    expect(first.thinking).toBe('hidden');
    const second = stripper.write('ing>visible</thinking>');
    expect(second.visible).toBe('visible');
  });

  test('flush preserves non-tag partial text as visible', () => {
    const stripper = new ThinkingTagStripper();

    expect(stripper.write('literal <thi').visible).toBe('literal ');
    const flushed = stripper.flush();
    expect(flushed.visible).toBe('<thi');
    expect(flushed.unclosedBlock).toBe(false);
  });

  test('unclosed block at flush reports suppressed char count', () => {
    const stripper = new ThinkingTagStripper();

    const out = stripper.write('<think>this never closes');
    expect(out.visible).toBe('');
    expect(out.thinking).toBe('this never closes');
    const flushed = stripper.flush();
    expect(flushed.unclosedBlock).toBe(true);
    expect(flushed.suppressedChars).toBe('this never closes'.length);
    // state resets after flush
    expect(stripper.flush().unclosedBlock).toBe(false);
  });
});

describe('bridgeSession thinking tag rerouting', () => {
  test('reroutes raw think tags split across deltas to thinking chunks', async () => {
    const chunks = await collect(
      makeSession([textDelta('<thi'), textDelta('nk>hidden</think>visible'), agentEnd()])
    );

    const assistantText = chunks
      .filter(
        (chunk): chunk is Extract<MessageChunk, { type: 'assistant' }> => chunk.type === 'assistant'
      )
      .map(chunk => chunk.content)
      .join('');
    const thinkingText = chunks
      .filter(
        (chunk): chunk is Extract<MessageChunk, { type: 'thinking' }> => chunk.type === 'thinking'
      )
      .map(chunk => chunk.content)
      .join('');

    expect(assistantText).toBe('visible');
    expect(assistantText).not.toContain('<think>');
    expect(thinkingText).toBe('hidden');
    expect(chunks.some(chunk => chunk.type === 'result')).toBe(true);
  });

  test('unclosed think block emits warning system chunk and thinking chunks', async () => {
    const chunks = await collect(
      makeSession([textDelta('<think>reasoning that never closes'), agentEnd('')])
    );

    const thinkingText = chunks
      .filter(
        (chunk): chunk is Extract<MessageChunk, { type: 'thinking' }> => chunk.type === 'thinking'
      )
      .map(chunk => chunk.content)
      .join('');
    expect(thinkingText).toContain('reasoning that never closes');

    const warning = chunks.find(
      c => c.type === 'system' && c.content.includes('unclosed <think> block')
    );
    expect(warning).toBeDefined();
    if (warning?.type === 'system') {
      expect(warning.content).toContain('⚠️');
      expect(warning.content).toMatch(/\d+ chars/);
    }

    // No visible assistant text leaked from the unclosed block
    const assistantText = chunks
      .filter(
        (chunk): chunk is Extract<MessageChunk, { type: 'assistant' }> => chunk.type === 'assistant'
      )
      .map(chunk => chunk.content)
      .join('');
    expect(assistantText).toBe('');
  });

  test('normal text without tags is untouched', async () => {
    const chunks = await collect(makeSession([textDelta('plain answer, no tags'), agentEnd()]));
    expect(chunks.map(chunk => (chunk.type === 'assistant' ? chunk.content : chunk.type))).toEqual([
      'plain answer, no tags',
      'result',
    ]);
  });

  test('flushes pending non-tag text before terminal result', async () => {
    const chunks = await collect(makeSession([textDelta('literal <thi'), agentEnd()]));

    expect(chunks.map(chunk => (chunk.type === 'assistant' ? chunk.content : chunk.type))).toEqual([
      'literal ',
      '<thi',
      'result',
    ]);
  });
});

describe('bridgeSession terminal result chunk', () => {
  async function collectWithSchema(
    session: AgentSession,
    schema?: Record<string, unknown>
  ): Promise<MessageChunk[]> {
    const chunks: MessageChunk[] = [];
    for await (const chunk of bridgeSession(session, 'prompt', undefined, schema)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  test('yields exactly one result chunk with tokens AND structuredOutput when schema set', async () => {
    const json = '{"verdict":"pass","score":9}';
    const chunks = await collectWithSchema(makeSession([textDelta(json), agentEnd(json)]), {
      type: 'object',
    });

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    const result = results[0];
    // Tokens from agent_end usage preserved
    expect(result.tokens).toEqual({ input: 1, output: 1, total: 2, cost: 0 });
    // structuredOutput merged into the SAME terminal chunk
    expect(result.structuredOutput).toEqual({ verdict: 'pass', score: 9 });
    // Terminal result is the last chunk in the stream
    expect(chunks[chunks.length - 1]).toBe(result);
  });

  test('non-schema path yields exactly one result chunk without structuredOutput', async () => {
    const chunks = await collectWithSchema(makeSession([textDelta('hello'), agentEnd()]));

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].tokens).toEqual({ input: 1, output: 1, total: 2, cost: 0 });
    expect('structuredOutput' in results[0]).toBe(false);
  });

  test('unparseable transcript with schema yields the single token result without structuredOutput', async () => {
    const chunks = await collectWithSchema(
      makeSession([textDelta('not json at all'), agentEnd()]),
      { type: 'object' }
    );

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].tokens).toBeDefined();
    expect('structuredOutput' in results[0]).toBe(false);
  });

  test('preserves missing_assistant_message semantics on the single terminal result', async () => {
    const chunks = await collectWithSchema(makeSession([{ type: 'agent_end', messages: [] }]), {
      type: 'object',
    });

    const results = chunks.filter(
      (c): c is Extract<MessageChunk, { type: 'result' }> => c.type === 'result'
    );
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorSubtype).toBe('missing_assistant_message');
  });
});
