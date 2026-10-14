import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { getArchonHome, getArchonWorkspacesPath } from '@archon/paths/archon-paths';
import {
  fanOutPosition,
  parseAttentionLabelPairs,
  parseAttentionQueueCountBy,
  parseAttentionQueueOrder,
  projectRefForRun,
} from './attention-queue';

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
