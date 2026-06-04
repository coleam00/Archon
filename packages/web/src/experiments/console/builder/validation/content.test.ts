import { describe, test, expect } from 'bun:test';
import { validateContent } from './content';
import type { BuilderNode, BuilderWorkflow } from '../types';

function wf(nodes: BuilderNode[]): BuilderWorkflow {
  return { name: 'c', description: 'd', meta: {}, nodes };
}

describe('validateContent', () => {
  test('valid upstream output ref passes', () => {
    const issues = validateContent(
      wf([
        { id: 'classify', variant: 'prompt', base: {}, data: { prompt: 'classify it' } },
        {
          id: 'use',
          variant: 'prompt',
          base: { depends_on: ['classify'] },
          data: { prompt: 'Given $classify.output, proceed.' },
        },
      ])
    );
    expect(issues.filter(i => i.rule === 'content.var.unknown')).toEqual([]);
  });

  test('reference to a non-upstream node warns', () => {
    const issues = validateContent(
      wf([
        { id: 'classify', variant: 'prompt', base: {}, data: { prompt: 'classify it' } },
        {
          id: 'use',
          variant: 'prompt',
          base: {},
          data: { prompt: 'Given $classify.output, proceed.' },
        },
      ])
    );
    expect(issues.some(i => i.rule === 'content.var.unknown')).toBe(true);
  });

  test('refs inside code spans are ignored', () => {
    const issues = validateContent(
      wf([
        {
          id: 'use',
          variant: 'prompt',
          base: {},
          data: { prompt: 'Example: `$ghost.output` and ```\n$other.output\n``` are docs.' },
        },
      ])
    );
    expect(issues.filter(i => i.rule === 'content.var.unknown')).toEqual([]);
  });

  test('self-reference warns (a node is not its own upstream)', () => {
    const issues = validateContent(
      wf([{ id: 'me', variant: 'prompt', base: {}, data: { prompt: 'loop on $me.output' } }])
    );
    expect(issues.some(i => i.rule === 'content.var.unknown')).toBe(true);
  });

  test('valid when expression passes; malformed when errors', () => {
    const ok = validateContent(
      wf([
        { id: 'a', variant: 'prompt', base: {}, data: { prompt: 'x' } },
        {
          id: 'b',
          variant: 'prompt',
          base: { depends_on: ['a'], when: "$a.output == 'YES'" },
          data: { prompt: 'y' },
        },
      ])
    );
    expect(ok.filter(i => i.rule === 'content.when.parse')).toEqual([]);

    const bad = validateContent(
      wf([
        {
          id: 'b',
          variant: 'prompt',
          base: { when: 'not a valid expression' },
          data: { prompt: 'y' },
        },
      ])
    );
    expect(bad.some(i => i.rule === 'content.when.parse')).toBe(true);
  });
});
