import { describe, test, expect } from 'bun:test';
import { orderWithRecommended } from './recommended';
import type { Workflow } from '../primitives/workflow';

function wf(name: string, source: Workflow['source'] = 'bundled'): Workflow {
  return { name, description: null, source, parseWarnings: [], inputs: [] };
}

describe('orderWithRecommended', () => {
  test('pins recommended first in declared order, rest follow', () => {
    const workflows = [wf('alpha'), wf('beta'), wf('gamma')];
    const { ordered, recommended } = orderWithRecommended(workflows, ['gamma', 'alpha']);
    expect(ordered.map(w => w.name)).toEqual(['gamma', 'alpha', 'beta']);
    expect(recommended.map(w => w.name)).toEqual(['gamma', 'alpha']);
  });

  test('ignores recommended names that do not resolve to a workflow', () => {
    const workflows = [wf('alpha'), wf('beta')];
    const { ordered, recommended } = orderWithRecommended(workflows, ['ghost', 'beta']);
    expect(ordered.map(w => w.name)).toEqual(['beta', 'alpha']);
    expect(recommended.map(w => w.name)).toEqual(['beta']);
  });

  test('rest sorted project > global > bundled, then alpha', () => {
    const workflows = [
      wf('z-bundled', 'bundled'),
      wf('a-global', 'global'),
      wf('m-project', 'project'),
    ];
    const { ordered } = orderWithRecommended(workflows, []);
    expect(ordered.map(w => w.name)).toEqual(['m-project', 'a-global', 'z-bundled']);
  });

  test('empty recommended yields a plain sorted list and no pins', () => {
    const workflows = [wf('beta'), wf('alpha')];
    const { ordered, recommended } = orderWithRecommended(workflows, []);
    expect(ordered.map(w => w.name)).toEqual(['alpha', 'beta']);
    expect(recommended).toHaveLength(0);
  });

  test('collapses duplicate recommended names to first occurrence', () => {
    const workflows = [wf('alpha'), wf('beta'), wf('gamma')];
    const { ordered, recommended } = orderWithRecommended(workflows, ['beta', 'alpha', 'beta']);
    expect(recommended.map(w => w.name)).toEqual(['beta', 'alpha']);
    expect(ordered.map(w => w.name)).toEqual(['beta', 'alpha', 'gamma']);
    expect(ordered.filter(w => w.name === 'beta')).toHaveLength(1);
  });

  test('an unrecognised source ranks after the three known sources (#2578)', () => {
    // Mirrors `toWorkflow`'s verbatim-passthrough contract: a misspelled or
    // future source must not collapse to 'bundled' (or any known value), and
    // the picker must place it deterministically rather than indexing an
    // undeclared key on the rank map.
    const workflows = [
      wf('z-bundled', 'bundled'),
      wf('a-unknown', 'something-new'),
      wf('m-project', 'project'),
    ];
    const { ordered } = orderWithRecommended(workflows, []);
    expect(ordered.map(w => w.name)).toEqual(['m-project', 'z-bundled', 'a-unknown']);
  });
});
