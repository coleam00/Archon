import { describe, test, expect } from 'bun:test';
import { validateStructural } from './structural';
import type { BuilderNode, BuilderWorkflow } from '../types';

function wf(nodes: BuilderNode[]): BuilderWorkflow {
  return { name: 's', description: 'd', meta: {}, nodes };
}

describe('validateStructural', () => {
  test('clean workflow has no structural issues', () => {
    const issues = validateStructural(
      wf([
        { id: 'a', variant: 'prompt', base: {}, data: { prompt: 'hello' } },
        { id: 'b', variant: 'command', base: {}, data: { command: 'do-thing' } },
      ])
    );
    expect(issues).toEqual([]);
  });

  test('empty id is flagged', () => {
    const issues = validateStructural(
      wf([{ id: '  ', variant: 'prompt', base: {}, data: { prompt: 'x' } }])
    );
    expect(issues.some(i => i.rule === 'structural.id.empty')).toBe(true);
  });

  test('duplicate ids are flagged', () => {
    const issues = validateStructural(
      wf([
        { id: 'dup', variant: 'prompt', base: {}, data: { prompt: 'x' } },
        { id: 'dup', variant: 'prompt', base: {}, data: { prompt: 'y' } },
      ])
    );
    expect(issues.some(i => i.rule === 'structural.id.duplicate')).toBe(true);
  });

  test('loop missing prompt/until/max_iterations is flagged', () => {
    const issues = validateStructural(
      wf([
        {
          id: 'l',
          variant: 'loop',
          base: {},
          data: { prompt: '', until: '', max_iterations: 0, fresh_context: false },
        },
      ])
    );
    const fields = issues.filter(i => i.rule === 'structural.field.missing').map(i => i.path.field);
    expect(fields).toContain('loop.prompt');
    expect(fields).toContain('loop.until');
    expect(fields).toContain('loop.max_iterations');
  });

  test('script missing runtime is flagged', () => {
    const issues = validateStructural(
      wf([
        {
          id: 's',
          variant: 'script',
          base: {},
          // Force an invalid runtime to exercise the check.
          data: { script: 'process.stdout.write("1")', runtime: 'python' as 'bun' },
        },
      ])
    );
    expect(issues.some(i => i.path.field === 'runtime')).toBe(true);
  });

  test('approval missing message is flagged', () => {
    const issues = validateStructural(
      wf([{ id: 'g', variant: 'approval', base: {}, data: { message: '' } }])
    );
    expect(issues.some(i => i.path.field === 'approval.message')).toBe(true);
  });

  test('cancel missing reason is flagged', () => {
    const issues = validateStructural(
      wf([{ id: 'c', variant: 'cancel', base: {}, data: { reason: '' } }])
    );
    expect(issues.some(i => i.path.field === 'cancel')).toBe(true);
  });
});
