import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import { isSourceReadFailure } from './workflow-source';
import { INCLUDE_MAX_DEPTH } from './include-expander';
import { COMPOSE_FAN_OUT_STEP_MARKER } from './fan-out-identity';
import { wf, mapOf } from './include-expander.fixtures';

describe('missing include discovery errors', () => {
  const root = wf('root', [{ id: 'wrapped', include: 'Missing' }]);
  const cause = Object.assign(new Error('source unavailable'), { code: 'EIO', syscall: 'open' });

  test('an unreadable declaration makes the missing target a read failure', () => {
    const result = expandWorkflowIncludes(mapOf(root), undefined, [
      { filename: 'unreadable.yaml', error: 'source unavailable', errorType: 'read_error', cause },
    ]);
    expect(result.errors[0]?.errorType).toBe('read_error');
    expect(isSourceReadFailure(result.errors[0]?.cause)).toBe(true);
  });

  test('the target is looked up the way every other load-error consumer looks it up', () => {
    const result = expandWorkflowIncludes(mapOf(root), undefined, [
      { filename: 'unreadable.yaml', error: 'source unavailable', errorType: 'read_error', cause },
      {
        filename: 'invalid.yaml',
        workflowName: 'missing',
        error: 'invalid definition',
        errorType: 'validation_error',
      },
    ]);
    expect(result.errors[0]?.error).toBe("Node 'wrapped': invalid definition");
    expect(result.errors[0]?.errorType).toBe('validation_error');
  });
});

describe('expandWorkflowIncludes — errors', () => {
  test('unknown target drops the workflow with a clear error; others survive', () => {
    const bad = wf('bad', [{ id: 'r', include: 'nope' }]);
    const good = wf('good', [{ id: 'only', prompt: 'hi' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(bad, good));
    expect(workflows.has('bad')).toBe(false);
    expect(workflows.has('good')).toBe(true);
    const err = errors.find(e => e.filename === 'bad');
    expect(err?.error).toContain('not found');
    expect(err?.error).toContain("Node 'r'");
  });

  test('self-include is a cycle error', () => {
    const a = wf('a', [{ id: 'r', include: 'a' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(a));
    expect(workflows.has('a')).toBe(false);
    expect(errors[0]?.error).toContain('cycle');
  });

  test('mutual include (a -> b -> a) is a cycle error', () => {
    const a = wf('a', [{ id: 'ra', include: 'b' }]);
    const b = wf('b', [{ id: 'rb', include: 'a' }]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(a, b));
    expect(workflows.has('a')).toBe(false);
    expect(errors.some(e => e.error.includes('cycle'))).toBe(true);
  });

  test('honors "up to N levels": an N-level chain expands, N+1 fails', () => {
    const e = wf('e', [{ id: 'x', prompt: 'x' }]);
    const d = wf('d', [{ id: 'r', include: 'e' }]);
    const c = wf('c', [{ id: 'r', include: 'd' }]);
    const b = wf('b', [{ id: 'r', include: 'c' }]);
    const a = wf('a', [{ id: 'r', include: 'b' }]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(a, b, c, d, e));
    expect(INCLUDE_MAX_DEPTH).toBe(3);
    expect(workflows.has('a')).toBe(false);
    expect(errors.find(err => err.filename === 'a')?.error).toContain('depth');
    expect(workflows.has('b')).toBe(true);
    expect(workflows.has('c')).toBe(true);
    expect(workflows.has('d')).toBe(true);
    expect(workflows.has('e')).toBe(true);
  });

  test('a namespaced id colliding with a hand-written node is a duplicate-id error', () => {
    const blk = wf('blk', [{ id: 'verify', prompt: 'v' }]);
    const parent = wf('parent', [
      { id: 'review__verify', prompt: 'hand-written collision' },
      { id: 'review', include: 'blk' },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(blk, parent));
    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(err => err.filename === 'parent')?.error).toContain('Duplicate node id');
  });

  test('reserves the engine-owned composed fan-out namespace from authored ids', () => {
    const block = wf('blk', [{ id: 'work', bash: 'echo work' }]);
    const parent = wf('parent', [
      { id: 'list', bash: 'echo []' },
      {
        id: 'fan',
        include: 'blk',
        depends_on: ['list'],
        fan_out: { items: '$list.output', as: 'item' },
      },
      { id: `authored${COMPOSE_FAN_OUT_STEP_MARKER}collision`, bash: 'echo collision' },
    ]);

    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));

    expect(workflows.has('parent')).toBe(false);
    expect(errors.find(error => error.filename === 'parent')?.error).toContain(
      `reserved engine namespace '${COMPOSE_FAN_OUT_STEP_MARKER}'`
    );
  });
});
