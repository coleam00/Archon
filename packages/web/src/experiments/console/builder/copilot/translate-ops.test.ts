import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow } from '../types';
import { opsToEditorActions } from './translate-ops';
import type { ProposedEdit } from './op-schema';

function workflow(): BuilderWorkflow {
  return fromWorkflowDefinition(FIXTURES.mixed).workflow;
}

describe('opsToEditorActions — addNode', () => {
  test('maps to add-node with a staggered position and the requested id', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'gate', variant: 'approval' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'add-node', id: 'gate', variant: 'approval' });
  });

  test('addNode with data emits a follow-up patch-node merging over the variant defaults', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'Proceed?' } }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.type).toBe('add-node');
    expect(actions[1]).toMatchObject({
      type: 'patch-node',
      node: { id: 'gate', variant: 'approval', data: { message: 'Proceed?' } },
    });
  });

  test('addNode colliding with an existing id is dropped and surfaced as an issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'classify', variant: 'prompt' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.addNode.duplicate');
  });

  test('two addNodes in one batch stagger to distinct positions', () => {
    const { actions } = opsToEditorActions(
      [
        { op: 'addNode', id: 'a', variant: 'prompt' },
        { op: 'addNode', id: 'b', variant: 'prompt' },
      ],
      workflow()
    );
    const positions = actions.filter(a => a.type === 'add-node').map(a => a.position);
    expect(positions[0]).not.toEqual(positions[1]);
  });
});

describe('opsToEditorActions — connect', () => {
  test('maps to add-edge', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'connect', source: 'classify', target: 'report' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'add-edge', source: 'classify', target: 'report', at: 0 }]);
  });

  test('unknown source is an issue, not a thrown error', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'connect', source: 'nope', target: 'report' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.connect.unknownSource');
  });

  test('unknown target is an issue', () => {
    const { issues } = opsToEditorActions(
      [{ op: 'connect', source: 'classify', target: 'nope' }],
      workflow()
    );
    expect(issues[0]?.rule).toBe('copilot.connect.unknownTarget');
  });

  test('connect can target a node added earlier in the same batch', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'addNode', id: 'gate', variant: 'approval' },
        { op: 'connect', source: 'classify', target: 'gate' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions.some(a => a.type === 'add-edge' && a.target === 'gate')).toBe(true);
  });
});

describe('opsToEditorActions — setField', () => {
  test('maps to patch-node with the field merged into data', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'setField', id: 'classify', path: 'data.prompt', value: 'New prompt text' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.type).toBe('patch-node');
    if (action?.type === 'patch-node') {
      expect(action.node.id).toBe('classify');
      expect(action.node.data).toMatchObject({ prompt: 'New prompt text' });
    }
  });

  test('maps a base. path onto the node base fields', () => {
    const { actions } = opsToEditorActions(
      [{ op: 'setField', id: 'classify', path: 'base.model', value: 'opus' }],
      workflow()
    );
    const action = actions[0];
    if (action?.type === 'patch-node') {
      expect(action.node.base.model).toBe('opus');
    } else {
      throw new Error('expected patch-node');
    }
  });

  test('unknown node is an issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'setField', id: 'nope', path: 'data.prompt', value: 'x' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.setField.unknownNode');
  });

  // BEHAVIOUR CHANGE: this previously asserted a `copilot.setField.addedThisBatch`
  // issue. That guard existed ONLY because `setField` resolved against the
  // original, pre-batch workflow and so could not see a node the same batch had
  // just added. Resolving through batch-local state removed the limitation, so
  // the guard was removed with it — this is a special case deleted, not a
  // feature added.
  test('setField on a node added earlier in the same batch now applies', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'addNode', id: 'gate', variant: 'approval' },
        { op: 'setField', id: 'gate', path: 'data.message', value: 'Proceed?' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions.some(a => a.type === 'add-node')).toBe(true);
    const last = actions[actions.length - 1];
    if (last?.type !== 'patch-node') throw new Error('expected a trailing patch-node');
    expect((last.node.data as { message?: string }).message).toBe('Proceed?');
  });
});

describe('opsToEditorActions — rename', () => {
  test('maps to rename-node', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'rename', id: 'classify', nextId: 'triage' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'rename-node', id: 'classify', nextId: 'triage', at: 0 }]);
  });

  test('unknown node is an issue', () => {
    const { issues } = opsToEditorActions([{ op: 'rename', id: 'nope', nextId: 'x' }], workflow());
    expect(issues[0]?.rule).toBe('copilot.rename.unknownNode');
  });

  test('renaming onto an existing id is a collision issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'rename', id: 'classify', nextId: 'report' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.rename.collision');
  });
});

describe('opsToEditorActions — remove', () => {
  test('maps to remove-nodes', () => {
    const { actions, issues } = opsToEditorActions([{ op: 'remove', id: 'report' }], workflow());
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'remove-nodes', ids: ['report'], at: 0 }]);
  });

  test('unknown node is an issue', () => {
    const { issues } = opsToEditorActions([{ op: 'remove', id: 'nope' }], workflow());
    expect(issues[0]?.rule).toBe('copilot.remove.unknownNode');
  });
});

describe('opsToEditorActions — mixed batch', () => {
  test('one invalid op does not block the others', () => {
    const ops: ProposedEdit[] = [
      { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
      { op: 'connect', source: 'classify', target: 'gate' },
      { op: 'remove', id: 'nonexistent' },
      { op: 'rename', id: 'report', nextId: 'summary' },
    ];
    const { actions, issues } = opsToEditorActions(ops, workflow());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.remove.unknownNode');
    const kinds = actions.map(a => a.type);
    expect(kinds).toEqual(['add-node', 'patch-node', 'add-edge', 'rename-node']);
  });
});

/**
 * Regression: `setField` used to resolve its target against the ORIGINAL,
 * pre-batch workflow. Because `patch-node` is a whole-node REPLACE (not a
 * merge), that made a second `setField` silently revert the first, and made
 * `rename` → `setField` fail with a misleading "Unknown node". Both were
 * verified against the real reducer before the fix.
 */
describe('opsToEditorActions — batch-local node state', () => {
  const firstNodeId = (): string => {
    const id = workflow().nodes[0]?.id;
    if (id === undefined) throw new Error('fixture has no nodes');
    return id;
  };

  test('two setFields on the same node compose instead of the second reverting the first', () => {
    const id = firstNodeId();
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'setField', id, path: 'base.when', value: 'FIRST' },
        { op: 'setField', id, path: 'base.trigger_rule', value: 'all_done' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(2);
    // The SECOND patch must carry the first edit forward — that is the whole bug.
    const second = actions[1];
    expect(second?.type).toBe('patch-node');
    if (second?.type !== 'patch-node') throw new Error('expected patch-node');
    expect(second.node.base.when).toBe('FIRST');
    expect(second.node.base.trigger_rule).toBe('all_done');
  });

  test('rename then setField on the NEW id resolves instead of erroring', () => {
    const id = firstNodeId();
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'rename', id, nextId: 'renamed-node' },
        { op: 'setField', id: 'renamed-node', path: 'base.when', value: 'after rename' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions.map(a => a.type)).toEqual(['rename-node', 'patch-node']);
    const patch = actions[1];
    if (patch?.type !== 'patch-node') throw new Error('expected patch-node');
    // The patched node must agree with its own new id, or the reducer targets nothing.
    expect(patch.node.id).toBe('renamed-node');
    expect(patch.node.base.when).toBe('after rename');
  });

  test('setField on a node added in the same batch now composes', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'first' } },
        { op: 'setField', id: 'gate', path: 'data.message', value: 'second' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    const last = actions[actions.length - 1];
    if (last?.type !== 'patch-node') throw new Error('expected patch-node');
    expect((last.node.data as { message?: string }).message).toBe('second');
  });

  test('setField after remove still reports the node as unknown', () => {
    const id = firstNodeId();
    const { issues } = opsToEditorActions(
      [
        { op: 'remove', id },
        { op: 'setField', id, path: 'base.when', value: 'x' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.setField.unknownNode');
  });
});

describe('opsToEditorActions — rename interactions', () => {
  test('rename then remove targets the renamed node', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'rename', id: 'classify', nextId: 'triage' },
        { op: 'remove', id: 'triage' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions.map(a => a.type)).toEqual(['rename-node', 'remove-nodes']);
  });

  test('rename then remove using the OLD id reports it as unknown', () => {
    const { issues } = opsToEditorActions(
      [
        { op: 'rename', id: 'classify', nextId: 'triage' },
        { op: 'remove', id: 'classify' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.remove.unknownNode');
  });
});
