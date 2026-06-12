import { describe, test, expect } from 'bun:test';
import { applyOnText, mergeHydratedHistory, mergeRecoveredHistory } from './chat-message-reducer';
import type { ChatMessage, ToolCallDisplay } from './types';

// Helpers

let idCounter = 0;
function makeId(): string {
  idCounter++;
  return `msg-${String(idCounter)}`;
}
const NOW = 1000;

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: makeId(),
    role: 'assistant',
    content: '',
    timestamp: NOW,
    isStreaming: true,
    toolCalls: [],
    ...overrides,
  };
}

function makeToolCall(id = 'tc1'): ToolCallDisplay {
  return { id, name: 'read_file', input: {}, startedAt: NOW, isExpanded: false };
}

// ---------------------------------------------------------------------------
// Rule 4 — tool-call boundary (the new guard added by PR #1054)
// ---------------------------------------------------------------------------

describe('applyOnText — tool-call boundary (Rule 4)', () => {
  test('starts a new segment when last streaming message has tool calls', () => {
    const prev: ChatMessage[] = [makeAssistant({ toolCalls: [makeToolCall()] })];
    const result = applyOnText(prev, 'Post-tool text', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].content).toBe('Post-tool text');
    expect(result[1].toolCalls).toEqual([]);
    expect(result[1].isStreaming).toBe(true);
  });

  test('does not split when last streaming message has an empty toolCalls array', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'hello ', toolCalls: [] })];
    const result = applyOnText(prev, 'world', makeId, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hello world');
  });

  test('treats absent toolCalls the same as empty array (no split)', () => {
    // toolCalls is optional on ChatMessage
    const prev: ChatMessage[] = [makeAssistant({ content: 'x', toolCalls: undefined })];
    const result = applyOnText(prev, 'y', makeId, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('xy');
  });

  test('handles multiple tool calls — still splits on any non-empty toolCalls', () => {
    const prev: ChatMessage[] = [
      makeAssistant({ toolCalls: [makeToolCall('tc1'), makeToolCall('tc2')] }),
    ];
    const result = applyOnText(prev, 'more text', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[1].toolCalls).toEqual([]);
    expect(result[1].isStreaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — append to existing streaming message
// ---------------------------------------------------------------------------

describe('applyOnText — append (Rule 5)', () => {
  test('appends to the current streaming message when no boundary condition fires', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'hello ' })];
    const result = applyOnText(prev, 'world', makeId, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hello world');
    expect(result[0].isStreaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — new assistant message when none is streaming
// ---------------------------------------------------------------------------

describe('applyOnText — new message (Rule 6)', () => {
  test('creates a new streaming message when prev is empty', () => {
    const result = applyOnText([], 'hello', makeId, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hello');
    expect(result[0].role).toBe('assistant');
    expect(result[0].isStreaming).toBe(true);
    expect(result[0].toolCalls).toEqual([]);
  });

  test('creates a new streaming message when last message is from a user', () => {
    const prev: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'hi', timestamp: NOW }];
    const result = applyOnText(prev, 'response', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toBe('response');
  });

  test('creates a new streaming message when last assistant message is not streaming', () => {
    const prev: ChatMessage[] = [makeAssistant({ isStreaming: false, content: 'done' })];
    const result = applyOnText(prev, 'new', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[1].isStreaming).toBe(true);
    expect(result[1].content).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// Rules 2 & 3 — workflow-status boundary
// ---------------------------------------------------------------------------

describe('applyOnText — workflow-status boundary (Rules 2 & 3)', () => {
  test('starts a new segment when incoming is workflow-status and current has content', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'some existing text' })];
    const result = applyOnText(prev, '🚀 Workflow started', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].content).toBe('🚀 Workflow started');
    expect(result[1].isStreaming).toBe(true);
  });

  test('starts a new segment when current is workflow-status and incoming is regular text', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: '✅ Workflow done' })];
    const result = applyOnText(prev, 'Regular text now', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].content).toBe('Regular text now');
  });

  test('does not start new segment when incoming is workflow-status and current is empty', () => {
    // Empty content: the status emoji goes into the empty placeholder
    const prev: ChatMessage[] = [makeAssistant({ content: '' })];
    const result = applyOnText(prev, '🚀 Starting', makeId, NOW);

    // isWorkflowStatus && last.content evaluates to false because last.content === ''
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('🚀 Starting');
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — workflow-result
// ---------------------------------------------------------------------------

describe('applyOnText — workflow-result (Rule 1)', () => {
  const wfResult = { workflowName: 'plan', runId: 'run-1' };

  test('creates a non-streaming message for a workflow result', () => {
    const result = applyOnText([], 'Plan complete', makeId, NOW, wfResult);

    expect(result).toHaveLength(1);
    expect(result[0].workflowResult).toEqual(wfResult);
    expect(result[0].isStreaming).toBe(false);
    expect(result[0].content).toBe('Plan complete');
  });

  test('closes the current streaming message before adding workflow result', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'partial' })];
    const result = applyOnText(prev, 'Done', makeId, NOW, wfResult);

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].workflowResult).toEqual(wfResult);
  });

  test('deduplicates workflow-result messages with the same runId', () => {
    const prev: ChatMessage[] = [
      makeAssistant({ content: 'Plan complete', isStreaming: false, workflowResult: wfResult }),
    ];
    const result = applyOnText(prev, 'Plan complete', makeId, NOW, wfResult);

    // Same runId already in state — no new message added
    expect(result).toHaveLength(1);
    expect(result).toBe(prev); // reference equality: same array returned
  });
});
// ---------------------------------------------------------------------------
// mergeRecoveredHistory — regression for #1972 (duplicate assistant replies)
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `user-${String(++idCounter)}`,
    role: 'user',
    content: 'hi',
    timestamp: NOW,
    ...overrides,
  };
}

function makeHydrated(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: NOW,
    isStreaming: false,
    toolCalls: [],
    ...overrides,
  };
}

describe('mergeRecoveredHistory', () => {
  test('drops the persisted streamed copy (#1972 scenario)', () => {
    const content = "Hi! I'm Archon, your AI assistant.";
    const prev: ChatMessage[] = [
      makeUser({ id: 'user-synth', timestamp: 999 }),
      makeAssistant({ id: 'assistant-synth', content, isStreaming: false, timestamp: 1000 }),
    ];
    const hydrated: ChatMessage[] = [
      makeUser({ id: 'user-db', timestamp: 999 }),
      makeHydrated({ content, timestamp: 9000 }),
    ];

    const result = mergeRecoveredHistory(prev, hydrated);

    expect(result).toHaveLength(2);
    expect(result.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(result.find(m => m.role === 'assistant')?.content).toBe(content);
    expect(result.find(m => m.role === 'assistant')?.id).not.toBe('assistant-synth');
  });

  test('keeps distinct client-only content interleaved by timestamp', () => {
    const prev: ChatMessage[] = [
      makeUser({ id: 'u1', timestamp: 100 }),
      makeAssistant({ id: 'a-synth', content: 'client-only', isStreaming: false, timestamp: 200 }),
    ];
    const hydrated: ChatMessage[] = [
      makeUser({ id: 'u-db', timestamp: 100 }),
      makeHydrated({ content: 'db-reply', timestamp: 300 }),
    ];

    const result = mergeRecoveredHistory(prev, hydrated);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].content).toBe('client-only');
    expect(result[2].content).toBe('db-reply');
  });

  test('keeps system messages even when content matches a hydrated row', () => {
    const content = 'System announcement';
    const prev: ChatMessage[] = [{ id: 'sys-1', role: 'system', content, timestamp: NOW }];
    const hydrated: ChatMessage[] = [makeHydrated({ content, timestamp: NOW + 1 })];

    const result = mergeRecoveredHistory(prev, hydrated);

    expect(result).toHaveLength(2);
    expect(result.some(m => m.role === 'system')).toBe(true);
  });

  test('keeps error-bearing messages even when content matches a hydrated row', () => {
    const content = 'Error happened';
    const prev: ChatMessage[] = [
      makeAssistant({
        id: 'a-err',
        content,
        isStreaming: false,
        timestamp: NOW,
        error: { message: 'Oops', classification: 'transient', suggestedActions: [] },
      }),
    ];
    const hydrated: ChatMessage[] = [makeHydrated({ content, timestamp: NOW + 1 })];

    const result = mergeRecoveredHistory(prev, hydrated);

    expect(result).toHaveLength(2);
    expect(result.some(m => m.error !== undefined)).toBe(true);
  });
});

describe('mergeHydratedHistory', () => {
  test('returns hydrated when prev is empty', () => {
    const hydrated: ChatMessage[] = [makeHydrated({ content: 'hello', timestamp: NOW })];

    const result = mergeHydratedHistory([], hydrated, false);

    expect(result).toEqual(hydrated);
  });

  test('preserves an empty streaming placeholder when sendActive is true', () => {
    const prev: ChatMessage[] = [
      makeUser({ id: 'u1', timestamp: 100 }),
      makeAssistant({ id: 'thinking-1', content: '', timestamp: 200 }),
    ];
    const hydrated: ChatMessage[] = [makeUser({ id: 'u-db', timestamp: 100 })];

    const result = mergeHydratedHistory(prev, hydrated, true);

    expect(result).toHaveLength(2);
    expect(result.some(m => m.id === 'thinking-1')).toBe(true);
  });

  test('drops a streaming message whose content already matches a hydrated assistant row', () => {
    const content = 'already flushed';
    const prev: ChatMessage[] = [
      makeUser({ id: 'u1', timestamp: 100 }),
      makeAssistant({ id: 'a-synth', content, isStreaming: true, timestamp: 200 }),
    ];
    const hydrated: ChatMessage[] = [
      makeUser({ id: 'u-db', timestamp: 100 }),
      makeHydrated({ content, timestamp: 200 }),
    ];

    const result = mergeHydratedHistory(prev, hydrated, false);

    expect(result).toHaveLength(2);
    expect(result.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(result.find(m => m.role === 'assistant')?.id).not.toBe('a-synth');
  });

  test('keeps tool-call messages with empty content (not falsely deduped)', () => {
    const prev: ChatMessage[] = [
      makeAssistant({
        id: 'a-tool',
        content: '',
        isStreaming: true,
        timestamp: 200,
        toolCalls: [makeToolCall()],
      }),
    ];
    const hydrated: ChatMessage[] = [makeHydrated({ content: 'db-reply', timestamp: 100 })];

    const result = mergeHydratedHistory(prev, hydrated, false);

    expect(result).toHaveLength(2);
    expect(result.some(m => m.id === 'a-tool')).toBe(true);
  });
});
