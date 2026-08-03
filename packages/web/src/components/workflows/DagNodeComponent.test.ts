import { describe, test, expect } from 'bun:test';
import { getContentPreview } from './DagNodeComponent';
import type { DagNodeData } from './DagNodeComponent';

describe('getContentPreview', () => {
  test('loop node with multi-line prompt returns first line only', () => {
    const data: DagNodeData = {
      id: 'n1',
      label: 'Loop',
      nodeType: 'loop',
      promptText: 'first line\nsecond line\nthird line',
    };
    expect(getContentPreview(data)).toBe('first line');
  });

  test('approval node returns empty string', () => {
    const data: DagNodeData = {
      id: 'n2',
      label: 'Approval',
      nodeType: 'approval',
      approval: { message: 'Please approve' },
    };
    expect(getContentPreview(data)).toBe('');
  });
});
