import { describe, test, expect } from 'bun:test';
import { toMessage, isSystemCategory } from './message';

type Raw = Parameters<typeof toMessage>[0];

function raw(over: Partial<Raw> & { id: string }, metadata: Record<string, unknown> = {}): Raw {
  return {
    role: 'assistant',
    content: 'hello',
    created_at: '2026-06-05T10:00:00Z',
    metadata: JSON.stringify(metadata),
    ...over,
  };
}

describe('toMessage — workflowResult', () => {
  test('parses a workflow_result message into category + workflowResult', () => {
    const m = toMessage(
      raw(
        { id: 'm1', content: 'Done — 7/8 nodes.' },
        {
          category: 'workflow_result',
          workflowResult: { workflowName: 'e2e-deterministic', runId: 'run-123' },
        }
      )
    );
    expect(m.category).toBe('workflow_result');
    expect(m.workflowResult).toEqual({ workflowName: 'e2e-deterministic', runId: 'run-123' });
  });

  test('a malformed workflowResult (missing runId) yields null — never half-renders', () => {
    const m = toMessage(
      raw(
        { id: 'm1' },
        {
          category: 'workflow_result',
          workflowResult: { workflowName: 'e2e-deterministic' },
        }
      )
    );
    expect(m.category).toBe('workflow_result');
    expect(m.workflowResult).toBeNull();
  });

  test('an explicit workflowResult: null does not throw — yields null (guard regression)', () => {
    // Regression: the guard must be `!= null`, not `!== undefined`. An explicit
    // JSON null slips past `!== undefined` and then `typeof wr.workflowName` throws.
    const m = toMessage(raw({ id: 'm1' }, { category: 'workflow_result', workflowResult: null }));
    expect(m.category).toBe('workflow_result');
    expect(m.workflowResult).toBeNull();
  });

  test('a non-string workflowName yields null (typeof guard)', () => {
    const m = toMessage(
      raw(
        { id: 'm1' },
        { category: 'workflow_result', workflowResult: { workflowName: 42, runId: 'run-123' } }
      )
    );
    expect(m.workflowResult).toBeNull();
  });

  test('a plain assistant message has null category/dispatch/workflowResult', () => {
    const m = toMessage(raw({ id: 'm1', content: 'hi there' }));
    expect(m.category).toBeNull();
    expect(m.dispatch).toBeNull();
    expect(m.workflowResult).toBeNull();
  });
});

describe('toMessage — malformed metadata', () => {
  test('corrupt metadata JSON degrades to empty (no throw, null category/result)', () => {
    const m = toMessage({
      id: 'm1',
      role: 'assistant',
      content: 'hi',
      metadata: '{ not valid json',
      created_at: '2026-06-05T10:00:00Z',
    });
    expect(m.category).toBeNull();
    expect(m.workflowResult).toBeNull();
    expect(m.content).toBe('hi');
  });
});

describe('toMessage — dispatch (regression)', () => {
  test('still parses workflowDispatch into dispatch', () => {
    const m = toMessage(
      raw(
        { id: 'm1' },
        {
          category: 'workflow_dispatch_status',
          workflowDispatch: { workflowName: 'plan', workerConversationId: 'cli-9' },
        }
      )
    );
    expect(m.dispatch).toEqual({ workflowName: 'plan', workerConversationId: 'cli-9' });
    expect(m.workflowResult).toBeNull();
  });
});

describe('isSystemCategory', () => {
  test('workflow_result is a system category (so ChatStream must branch BEFORE the filter)', () => {
    expect(isSystemCategory('workflow_result')).toBe(true);
    expect(isSystemCategory('workflow_status')).toBe(true);
    expect(isSystemCategory('system_x')).toBe(true);
  });

  test('null and non-prefixed categories are not system', () => {
    expect(isSystemCategory(null)).toBe(false);
    expect(isSystemCategory('tool_call_formatted')).toBe(false);
  });
});

describe('toMessage — attachments', () => {
  const withFiles = (metadata: Record<string, unknown>) =>
    toMessage(raw({ id: 'm1', role: 'user', content: 'see this' }, metadata));

  test('carries the files the server persisted on the message', () => {
    const m = withFiles({ files: [{ name: 'shot.png', mimeType: 'image/png', size: 2048 }] });
    expect(m.files).toEqual([{ name: 'shot.png', mimeType: 'image/png', size: 2048 }]);
  });

  test('a message with no attachments has an empty list, not undefined', () => {
    expect(withFiles({}).files).toEqual([]);
    expect(withFiles({ category: 'workflow_status' }).files).toEqual([]);
  });

  test('drops an entry with no usable name rather than rendering a blank chip', () => {
    const m = withFiles({
      files: [{ mimeType: 'image/png', size: 10 }, { name: '', size: 10 }, null],
    });
    expect(m.files).toEqual([]);
  });

  test('a non-array files value yields no attachments instead of throwing', () => {
    // parseMetadata does not validate, so toMessage must survive a wrong-typed
    // blob rather than take the whole history's render down.
    expect(withFiles({ files: { name: 'not-an-array.png' } }).files).toEqual([]);
    expect(withFiles({ files: 'shot.png' }).files).toEqual([]);
    expect(withFiles({ files: null }).files).toEqual([]);
  });

  test('a missing size degrades to 0 rather than losing the attachment', () => {
    const m = withFiles({ files: [{ name: 'notes.md' }] });
    expect(m.files).toEqual([{ name: 'notes.md', mimeType: '', size: 0 }]);
  });
});
