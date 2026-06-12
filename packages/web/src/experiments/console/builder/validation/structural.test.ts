import { describe, test, expect } from 'bun:test';
import { validateStructural } from './structural';
import { wf } from './test-helpers';

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

  test('loop empty prompt/until is flagged as missing; bad max_iterations as invalid', () => {
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
    const missing = issues
      .filter(i => i.rule === 'structural.field.missing')
      .map(i => i.path.field);
    expect(missing).toContain('loop.prompt');
    expect(missing).toContain('loop.until');
    // A present-but-invalid value uses the distinct invalid rule, not missing.
    const invalid = issues
      .filter(i => i.rule === 'structural.field.invalid')
      .map(i => i.path.field);
    expect(invalid).toContain('loop.max_iterations');
  });

  test('script invalid runtime is flagged', () => {
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
    expect(
      issues.some(i => i.path.field === 'runtime' && i.rule === 'structural.field.invalid')
    ).toBe(true);
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

  test('empty prompt, command, and bash bodies are flagged as missing', () => {
    const issues = validateStructural(
      wf([
        { id: 'p', variant: 'prompt', base: {}, data: { prompt: '   ' } },
        { id: 'c', variant: 'command', base: {}, data: { command: '' } },
        { id: 'b', variant: 'bash', base: {}, data: { bash: '\n' } },
      ])
    );
    const missing = issues.filter(i => i.rule === 'structural.field.missing');
    expect(missing.map(i => ({ nodeId: i.path.nodeId, field: i.path.field }))).toEqual([
      { nodeId: 'p', field: 'prompt' },
      { nodeId: 'c', field: 'command' },
      { nodeId: 'b', field: 'bash' },
    ]);
  });

  test('non-empty prompt/command/bash bodies pass', () => {
    const issues = validateStructural(
      wf([
        { id: 'p', variant: 'prompt', base: {}, data: { prompt: 'hi' } },
        { id: 'c', variant: 'command', base: {}, data: { command: 'run-it' } },
        { id: 'b', variant: 'bash', base: {}, data: { bash: 'echo hi' } },
      ])
    );
    expect(issues).toEqual([]);
  });
});
