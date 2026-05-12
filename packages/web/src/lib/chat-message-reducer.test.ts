import { describe, test, expect } from 'bun:test';
import { applyOnText } from './chat-message-reducer';
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
