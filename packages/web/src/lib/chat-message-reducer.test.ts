import { describe, test, expect } from 'bun:test';
import { applyOnText, startsNewTextBatch } from './chat-message-reducer';
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
    const result = applyOnText(prev, '🚀 Workflow started', makeId, NOW, {
      category: 'workflow_dispatch_status',
    });

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].content).toBe('🚀 Workflow started');
    expect(result[1].isStreaming).toBe(true);
  });

  test('starts a new segment when current is workflow-status and incoming is regular text', () => {
    const prev: ChatMessage[] = [
      makeAssistant({ content: '✅ Workflow done', category: 'workflow_status' }),
    ];
    const result = applyOnText(prev, 'Regular text now', makeId, NOW);

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].content).toBe('Regular text now');
  });

  test('does not start new segment when incoming is workflow-status and current is empty', () => {
    // Empty content: the status text goes into the empty placeholder
    const prev: ChatMessage[] = [makeAssistant({ content: '' })];
    const result = applyOnText(prev, '🚀 Starting', makeId, NOW, {
      category: 'workflow_status',
    });

    // isWorkflowStatus && last.content evaluates to false because last.content === ''
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('🚀 Starting');
  });

  test('an empty placeholder adopts the category of the first text that lands in it', () => {
    // ChatInterface pushes `{ content: '', isStreaming: true }` the moment the
    // user sends, so a dispatch status is the first text to reach it. Without
    // adopting the category the placeholder would look like prose, and the
    // following text would merge into a workflow-status bubble.
    const placeholder: ChatMessage[] = [makeAssistant({ content: '' })];
    const filled = applyOnText(placeholder, '🚀 Dispatching workflow', makeId, NOW, {
      category: 'workflow_dispatch_status',
    });

    expect(filled).toHaveLength(1);
    expect(filled[0].category).toBe('workflow_dispatch_status');

    const next = applyOnText(filled, 'agent prose', makeId, NOW);
    expect(next).toHaveLength(2);
    expect(next[0].isStreaming).toBe(false);
    expect(next[1].content).toBe('agent prose');
  });

  test('consecutive workflow-status messages each get their own bubble', () => {
    const prev: ChatMessage[] = [
      makeAssistant({ content: '🚀 Starting', category: 'workflow_status' }),
    ];
    const result = applyOnText(prev, '🚀 Dispatching', makeId, NOW, {
      category: 'workflow_dispatch_status',
    });

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].category).toBe('workflow_dispatch_status');
  });

  test('stamps the category on the message it creates so the next event can read it', () => {
    const result = applyOnText([], 'Starting', makeId, NOW, { category: 'workflow_status' });

    expect(result[0].category).toBe('workflow_status');
    // …and the stamped category drives the trailing boundary on the next event.
    const next = applyOnText(result, 'agent prose', makeId, NOW);
    expect(next).toHaveLength(2);
    expect(next[1].content).toBe('agent prose');
    expect(next[1].category).toBeUndefined();
  });

  test('splits on a workflow-status message that does not start with an emoji', () => {
    // executor.ts prepends PR-review context before the 🚀 line, so a real
    // `workflow_status` message can begin with prose. The deleted `^`-anchored
    // emoji regex missed exactly this; the category does not.
    const prev: ChatMessage[] = [makeAssistant({ content: 'some existing text' })];
    const result = applyOnText(
      prev,
      'Reviewing PR at commit `abc1234`\n\n🚀 Starting',
      makeId,
      NOW,
      {
        category: 'workflow_status',
      }
    );

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].category).toBe('workflow_status');
  });

  test('does not split on emoji-prefixed text that carries no category', () => {
    // Uncategorized `✅` notices (e.g. container write-back) are agent-adjacent
    // prose to the server, which never segments them — the client now agrees.
    const prev: ChatMessage[] = [makeAssistant({ content: 'some existing text' })];
    const result = applyOnText(prev, '✅ Applied to the live folder', makeId, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('some existing text✅ Applied to the live folder');
  });

  test('a non-status category is not a status boundary', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'some existing text' })];
    const result = applyOnText(prev, ' more', makeId, NOW, { category: 'isolation_context' });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('some existing text more');
  });
});

// ---------------------------------------------------------------------------
// useSSE batch boundary — extracted so the 50 ms coalescing window is testable
// ---------------------------------------------------------------------------

describe('startsNewTextBatch', () => {
  const runA = { workflowName: 'plan', runId: 'run-a' };
  const runB = { workflowName: 'plan', runId: 'run-b' };

  test('keeps accumulating while the identity is unchanged', () => {
    expect(startsNewTextBatch({}, {})).toBe(false);
    expect(
      startsNewTextBatch({ category: 'workflow_status' }, { category: 'workflow_status' })
    ).toBe(false);
    expect(
      startsNewTextBatch(
        { category: 'workflow_result', workflowResult: runA },
        { category: 'workflow_result', workflowResult: runA }
      )
    ).toBe(false);
  });

  test('breaks when a categorized message follows agent prose', () => {
    expect(startsNewTextBatch({}, { category: 'workflow_dispatch_status' })).toBe(true);
  });

  test('breaks when agent prose follows a categorized message', () => {
    expect(startsNewTextBatch({ category: 'workflow_dispatch_status' }, {})).toBe(true);
  });

  test('breaks between two results for different runs', () => {
    // SSETransport replays its buffer on reconnect, so two `workflow_result`
    // events can land inside one 50 ms window. Merging them would drop a card.
    expect(
      startsNewTextBatch(
        { category: 'workflow_result', workflowResult: runA },
        { category: 'workflow_result', workflowResult: runB }
      )
    ).toBe(true);
  });

  test('breaks when a result follows text that had none', () => {
    expect(startsNewTextBatch({}, { category: 'workflow_result', workflowResult: runA })).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — workflow-result
// ---------------------------------------------------------------------------

describe('applyOnText — workflow-result (Rule 1)', () => {
  const wfResult = { workflowName: 'plan', runId: 'run-1' };

  test('creates a non-streaming message for a workflow result', () => {
    const result = applyOnText([], 'Plan complete', makeId, NOW, { workflowResult: wfResult });

    expect(result).toHaveLength(1);
    expect(result[0].workflowResult).toEqual(wfResult);
    expect(result[0].isStreaming).toBe(false);
    expect(result[0].content).toBe('Plan complete');
  });

  test('closes the current streaming message before adding workflow result', () => {
    const prev: ChatMessage[] = [makeAssistant({ content: 'partial' })];
    const result = applyOnText(prev, 'Done', makeId, NOW, { workflowResult: wfResult });

    expect(result).toHaveLength(2);
    expect(result[0].isStreaming).toBe(false);
    expect(result[1].workflowResult).toEqual(wfResult);
  });

  test('deduplicates workflow-result messages with the same runId', () => {
    const prev: ChatMessage[] = [
      makeAssistant({ content: 'Plan complete', isStreaming: false, workflowResult: wfResult }),
    ];
    const result = applyOnText(prev, 'Plan complete', makeId, NOW, { workflowResult: wfResult });

    // Same runId already in state — no new message added
    expect(result).toHaveLength(1);
    expect(result).toBe(prev); // reference equality: same array returned
  });
});
