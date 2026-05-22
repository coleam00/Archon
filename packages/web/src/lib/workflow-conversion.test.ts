import { describe, it, expect } from 'bun:test';
import { tryFromWorkflowDefinition } from './workflow-conversion';

describe('tryFromWorkflowDefinition', () => {
  it('returns null/null for null input', () => {
    const result = tryFromWorkflowDefinition(null);
    expect(result.builderNodes).toBeNull();
    expect(result.conversionError).toBeNull();
  });

  it('returns null/null for undefined input', () => {
    const result = tryFromWorkflowDefinition(undefined);
    expect(result.builderNodes).toBeNull();
    expect(result.conversionError).toBeNull();
  });

  it('converts a well-formed minimal prompt workflow', () => {
    const result = tryFromWorkflowDefinition({
      name: 'w',
      description: 'd',
      nodes: [{ id: 'p1', prompt: 'do the thing' }],
    });
    expect(result.conversionError).toBeNull();
    expect(result.builderNodes).not.toBeNull();
    expect(result.builderNodes).toHaveLength(1);
    expect(result.builderNodes![0]!.variant).toBe('prompt');
    expect(result.builderNodes![0]!.id).toBe('p1');
  });

  it('returns a non-empty conversionError for an unrecognisable node', () => {
    const result = tryFromWorkflowDefinition({
      name: 'broken',
      description: '',
      nodes: [{ id: 'x', mystery: 'value' }],
    });
    expect(result.builderNodes).toBeNull();
    expect(result.conversionError).not.toBeNull();
    expect(result.conversionError).toContain('x');
  });
});
