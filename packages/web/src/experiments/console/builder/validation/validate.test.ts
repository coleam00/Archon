import { describe, test, expect } from 'bun:test';
import { runValidation } from './validate';
import { promptNode, wf } from './test-helpers';

describe('runValidation', () => {
  test('clean workflow produces no issues', () => {
    expect(runValidation(wf([promptNode('a'), promptNode('b', ['a'])]))).toEqual([]);
  });

  test('aggregates issues from all three client tiers in one pass', () => {
    const issues = runValidation(
      wf([
        // structural: empty prompt body
        { id: 'empty', variant: 'prompt', base: {}, data: { prompt: '' } },
        // graph: unknown depends_on ref; content: malformed when expression
        {
          id: 'broken',
          variant: 'prompt',
          base: { depends_on: ['ghost'], when: 'not parseable' },
          data: { prompt: 'x' },
        },
      ])
    );
    const rules = issues.map(i => i.rule);
    expect(rules).toContain('structural.field.missing');
    expect(rules).toContain('graph.ref.unknown');
    expect(rules).toContain('content.when.parse');
  });

  test('identical findings dedup by stable issue id', () => {
    // Two nodes with the same whitespace-only id produce byte-identical
    // structural.id.empty findings (same rule, path, and message) — the dedup
    // map must collapse them to one.
    const issues = runValidation(
      wf([
        { id: '', variant: 'prompt', base: {}, data: { prompt: 'x' } },
        { id: '', variant: 'prompt', base: {}, data: { prompt: 'x' } },
      ])
    );
    const emptyIdIssues = issues.filter(i => i.rule === 'structural.id.empty');
    expect(emptyIdIssues).toHaveLength(1);
    // Distinct findings (different ids) are NOT collapsed.
    const distinct = runValidation(
      wf([
        { id: 'dup', variant: 'prompt', base: {}, data: { prompt: 'x' } },
        { id: 'dup', variant: 'prompt', base: {}, data: { prompt: 'x' } },
      ])
    );
    expect(distinct.some(i => i.rule === 'structural.id.duplicate')).toBe(true);
  });
});
