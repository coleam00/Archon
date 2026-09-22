import { describe, test, expect } from 'bun:test';
import { toPersistedMessageMetadata } from './message-metadata';

describe('toPersistedMessageMetadata', () => {
  test('returns undefined when metadata is undefined', () => {
    expect(toPersistedMessageMetadata(undefined)).toBeUndefined();
  });

  test('returns undefined when metadata is empty', () => {
    expect(toPersistedMessageMetadata({})).toBeUndefined();
  });

  test('omits segment — segment is intentionally transient', () => {
    const result = toPersistedMessageMetadata({ segment: 'new' });
    expect(result).toBeUndefined();
  });

  test('returns undefined when only segment is set alongside undefined siblings', () => {
    const result = toPersistedMessageMetadata({
      segment: 'auto',
      category: undefined,
      workflowDispatch: undefined,
      workflowResult: undefined,
    });
    expect(result).toBeUndefined();
  });

  test('persists category', () => {
    const result = toPersistedMessageMetadata({ category: 'workflow_status' });
    expect(result).toEqual({ category: 'workflow_status' });
  });

  test('persists workflowDispatch', () => {
    const dispatch = { workerConversationId: 'worker-1', workflowName: 'assist' };
    const result = toPersistedMessageMetadata({ workflowDispatch: dispatch });
    expect(result).toEqual({ workflowDispatch: dispatch });
  });

  test('persists workflowResult', () => {
    const outcome = { workflowName: 'review', runId: 'run-123' };
    const result = toPersistedMessageMetadata({ workflowResult: outcome });
    expect(result).toEqual({ workflowResult: outcome });
  });

  test('persists every non-segment field together', () => {
    const result = toPersistedMessageMetadata({
      category: 'workflow_result',
      workflowDispatch: { workerConversationId: 'w', workflowName: 'wf' },
      workflowResult: { workflowName: 'wf', runId: 'r' },
      segment: 'new',
    });
    expect(result).toEqual({
      category: 'workflow_result',
      workflowDispatch: { workerConversationId: 'w', workflowName: 'wf' },
      workflowResult: { workflowName: 'wf', runId: 'r' },
    });
  });

  test('does not include segment in any output', () => {
    const result = toPersistedMessageMetadata({
      category: 'workflow_status',
      segment: 'auto',
    });
    expect(result).not.toHaveProperty('segment');
  });

  test('a new MessageMetadata field flows through without changing the helper (#2709)', () => {
    // Simulates adding a brand-new field to MessageMetadata — this is what
    // real callers do when a new field lands and proves the helper does not
    // hand-maintain a field list.
    const result = toPersistedMessageMetadata({
      category: 'workflow_status',
      segment: 'auto',
      // New field — the helper must pick it up by derivation, not enumeration.
      newField: { traceId: 'abc' },
    });
    expect(result).toEqual({
      category: 'workflow_status',
      newField: { traceId: 'abc' },
    });
  });

  test('drops undefined-valued fields so the projection is the saved subset only', () => {
    const result = toPersistedMessageMetadata({
      category: undefined,
      workflowDispatch: { workerConversationId: 'w', workflowName: 'wf' },
      workflowResult: undefined,
    });
    expect(result).toEqual({
      workflowDispatch: { workerConversationId: 'w', workflowName: 'wf' },
    });
  });
});
