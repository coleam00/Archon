// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { getArchonHome, getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import {
  fanOutPosition,
  parseAttentionLabelPairs,
  parseAttentionQueueCountBy,
  parseAttentionQueueOrder,
  parseAttentionQueueRequest,
  projectRefForRun,
  toAttentionQueueItem,
} from './attention-queue';
import { queuedRunAttention, type WorkflowRun } from './schemas/workflow-run';

describe('attention queue arguments', () => {
  test('a label pair splits at the first =, and its value may be empty or hold =', () => {
    expect(parseAttentionLabelPairs(['ci=other', 'note=a=b', 'empty='])).toEqual({
      ci: 'other',
      note: 'a=b',
      empty: '',
    });
  });

  test.each([['ci'], ['=other'], ['c i=x']])('refuses the label pair %p', pair => {
    expect(() => parseAttentionLabelPairs([pair])).toThrow('Expected a label as key=value');
  });

  // Assigning `__proto__` to a plain object sets the prototype, so an accepted key would
  // vanish: a write would be dropped and a filter would match every item.
  test('refuses __proto__ as a key instead of dropping it', () => {
    expect(() => parseAttentionLabelPairs(['__proto__=x'])).toThrow(
      "'__proto__' cannot be a label key"
    );
    expect(() => parseAttentionQueueRequest({ labels: ['__proto__=x'] })).toThrow(
      "'__proto__' cannot be a label key"
    );
    expect(() => parseAttentionQueueOrder('label:__proto__')).toThrow('invalid label key');
  });

  test('refuses a key given twice rather than letting one win', () => {
    expect(() => parseAttentionLabelPairs(['ci=a', 'ci=b'])).toThrow("Label 'ci' is given twice");
  });

  test('sort and count-by accept only their documented forms', () => {
    expect(parseAttentionQueueOrder('age')).toEqual({ by: 'age' });
    expect(parseAttentionQueueOrder('label:ci')).toEqual({ by: 'label', key: 'ci' });
    expect(parseAttentionQueueCountBy('project')).toEqual({ by: 'project' });
    expect(parseAttentionQueueCountBy('label:ci')).toEqual({ by: 'label', key: 'ci' });
    expect(() => parseAttentionQueueOrder('newest')).toThrow("sort must be 'age' or 'label:<key>'");
    expect(() => parseAttentionQueueOrder('label:')).toThrow('invalid label key');
    expect(() => parseAttentionQueueCountBy('codebase')).toThrow(
      "count-by must be 'project' or 'label:<key>'"
    );
  });

  test('a request is refused when it names two scopes or both a sort and a count', () => {
    expect(() => parseAttentionQueueRequest({ project: 'web', all: true, labels: [] })).toThrow(
      'Use project or all, not both'
    );
    expect(() =>
      parseAttentionQueueRequest({ labels: [], sort: 'age', countBy: 'project' })
    ).toThrow('Use sort or count-by, not both');
    expect(parseAttentionQueueRequest({ labels: ['ci=other'] })).toEqual({
      labels: { ci: 'other' },
      order: { by: 'age' },
      countBy: undefined,
    });
  });
});

describe('queue item identity', () => {
  test('a run with no trusted storage root has no project', () => {
    expect(projectRefForRun({ output_root: null }, null)).toBeNull();
    expect(projectRefForRun({ output_root: '/elsewhere/acme/web' }, null)).toBeNull();
  });

  test('a root inside the home but outside the workspaces names no project', () => {
    expect(projectRefForRun({ output_root: join(getArchonHome(), 'stray') }, null)).toBeNull();
  });

  test('an unregistered project is named by its key', () => {
    expect(
      projectRefForRun({ output_root: join(getArchonWorkspacesPath(), '_cwd', 'scratch') }, null)
    ).toEqual({ key: '_cwd/scratch', codebaseId: null, name: 'scratch' });
  });

  test('only a child that records its fan-out node and index has a fan-out position', () => {
    const child = { parent_run_id: 'parent', metadata: { parent_node_id: 'each', child_index: 0 } };
    expect(fanOutPosition(child)).toEqual({ parentRunId: 'parent', nodeId: 'each', index: 0 });
    // A 1:1 `workflow:` child records no index.
    expect(fanOutPosition({ ...child, metadata: { parent_node_id: 'each' } })).toBeNull();
    expect(fanOutPosition({ ...child, parent_run_id: null })).toBeNull();
  });
});

describe('a usage-limit wait', () => {
  test('is an item naming its node, reset time and pause time, with nothing to answer', () => {
    const run: WorkflowRun = {
      origin: null,
      id: 'limited',
      workflow_name: 'deliver',
      conversation_id: null,
      parent_conversation_id: null,
      codebase_id: null,
      status: 'paused',
      outcome: null,
      user_message: '',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'implement',
          kind: 'quota',
          pauseId: 'limit-1',
          waitingSince: '2026-10-15T09:00:00.000Z',
          resumeAt: '2026-10-15T14:00:00.000Z',
        },
      },
      started_at: new Date('2026-10-15T08:00:00.000Z'),
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
    };
    const attention = queuedRunAttention(run);
    expect(attention).toEqual({
      kind: 'usage_limit',
      runId: 'limited',
      nodeId: 'implement',
      resumeAt: '2026-10-15T14:00:00.000Z',
    });
    if (attention === undefined) return;
    expect(toAttentionQueueItem(run, attention, { codebase: null, branch: null })).toMatchObject({
      kind: 'usage_limit',
      node: 'implement',
      resetAt: '2026-10-15T14:00:00.000Z',
      pausedAt: '2026-10-15T09:00:00.000Z',
    });
  });
});
