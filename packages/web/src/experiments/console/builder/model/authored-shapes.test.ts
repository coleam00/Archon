/**
 * Authored node shapes the editor has no form for must survive an unedited
 * open-and-save verbatim, and must not show up as validation errors.
 *
 * The shapes below are taken from real workflows: a `loop_group`, a sub-workflow
 * fan-out (`workflow:` + `fan_out:`), an `include:`, an approval with authored
 * `decisions`, and AI nodes carrying `settingSources` / node-local `with`.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromWorkflowDefinition } from './from-workflow';
import { toWorkflowDefinition } from './to-workflow';
import { runValidation } from '../validation';
import type { Issue, WireWorkflowDefinition } from '../types';

const AUTHORED: WireWorkflowDefinition = {
  name: 'authored-shapes',
  description: 'Every authored shape the editor has to carry through untouched',
  nodes: [
    {
      id: 'load',
      script: 'load-part',
      runtime: 'uv',
      with: { part: '$INPUTS.part' },
    },
    {
      id: 'spec',
      depends_on: ['load'],
      command: 'kf-spec',
      model: 'opus',
      settingSources: [],
      allowed_tools: ['Read'],
      with: { slug: '$load.output.slug' },
    },
    {
      id: 'gate',
      depends_on: ['spec'],
      approval: {
        message: 'Approve the spec?',
        decisions: [{ id: 'approve' }, { id: 'reject', label: 'Stop here' }],
        capture_response: true,
      },
    },
    {
      id: 'tdd',
      depends_on: ['gate'],
      loop_group: {
        max_iterations: 3,
        fresh_context: true,
        until_bash: 'test -f done',
        nodes: [{ id: 'tester', command: 'kf-tests', settingSources: [] }],
      },
    },
    {
      id: 'parts',
      depends_on: ['tdd'],
      workflow: 'kf-part',
      isolation: 'worktree',
      fan_out: { items: '$load.output', as: 'part', max_parallel: 2, join: 'all_done' },
    },
    {
      id: 'shared',
      depends_on: ['parts'],
      include: 'shared-checks',
    },
  ],
};

function blocking(issues: Issue[]): Issue[] {
  return issues.filter(i => i.severity === 'error' || i.severity === 'warning');
}

describe('authored shapes', () => {
  test('an unedited open-and-save reproduces every node verbatim (AC-4)', () => {
    const { workflow } = fromWorkflowDefinition(AUTHORED);
    expect(toWorkflowDefinition(workflow)).toEqual(AUTHORED);
  });

  test('import and validation raise no errors or warnings (AC-1)', () => {
    const { workflow, issues } = fromWorkflowDefinition(AUTHORED);
    expect(blocking([...issues, ...runValidation(workflow)])).toEqual([]);
  });

  test('nodes the editor has no form for open read-only, not as empty prompts (AC-3)', () => {
    const { workflow } = fromWorkflowDefinition(AUTHORED);
    const variantOf = (id: string): string | undefined =>
      workflow.nodes.find(n => n.id === id)?.variant;
    expect(variantOf('tdd')).toBe('opaque');
    expect(variantOf('parts')).toBe('opaque');
    expect(variantOf('shared')).toBe('opaque');
    expect(variantOf('spec')).toBe('command');
    expect(variantOf('gate')).toBe('approval');
  });

  test('the bundled archon-assist opens clean and round-trips (AC-2)', () => {
    const file = join(
      import.meta.dir,
      '../../../../../../../.archon/workflows/defaults/archon-assist.yaml'
    );
    const def = Bun.YAML.parse(readFileSync(file, 'utf-8')) as WireWorkflowDefinition;
    const { workflow, issues } = fromWorkflowDefinition(def);
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(runValidation(workflow).filter(i => i.severity === 'error')).toEqual([]);
    expect(toWorkflowDefinition(workflow)).toEqual(def);
  });
});
