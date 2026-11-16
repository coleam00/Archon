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
    expect(result).toStrictEqual({
      workflowDispatch: { workerConversationId: 'w', workflowName: 'wf' },
    });
  });
});
