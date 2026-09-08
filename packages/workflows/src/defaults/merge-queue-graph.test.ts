import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow } from '../loader';
import { discoverWorkflows } from '../workflow-discovery';
import { expandWorkflowIncludes } from '../include-expander';
import { dryRunWorkflow } from '../dry-run';
import { formatPackagedResourceReference, qualifyWorkflowResources } from '../packaged-workflow';
import type { WorkflowDefinition } from '../schemas/workflow';

const root = join(import.meta.dir, '../../../..');
function loadQueue() {
  const definitions = new Map<string, WorkflowDefinition>();
  const commands = new Map<string, string>();
  for (const name of ['merge-queue', 'review', 'validate']) {
    const directory = join(root, '.archon/workflows/sdlc', name);
    const parsed = parseWorkflow(
      readFileSync(join(directory, `archon-${name}.yaml`), 'utf8'),
      `archon-${name}.yaml`
    );
    expect(parsed.error).toBeNull();
    if (!parsed.workflow) throw new Error('Missing workflow');
    const owner = { source: 'project' as const, pack: 'sdlc', workflow: name };
    definitions.set(parsed.workflow.name, qualifyWorkflowResources(parsed.workflow, owner));
    for (const file of readdirSync(join(directory, 'commands'))) {
      commands.set(
        formatPackagedResourceReference(owner, file.slice(0, -3)),
        readFileSync(join(directory, 'commands', file), 'utf8')
      );
    }
  }
  const result = expandWorkflowIncludes(definitions, commands);
  expect(result.errors).toEqual([]);
  const workflow = result.workflows.get('archon-merge-queue');
  if (!workflow) throw new Error('Queue did not expand');
  return workflow;
}

describe('merge queue authored graph', () => {
  it('discovers the packaged entry point with all conditional script bindings satisfied', async () => {
    const result = await discoverWorkflows(root, { loadDefaults: false });
    expect(result.errors.filter(error => error.filename.includes('merge-queue'))).toEqual([]);
    expect(result.workflows.some(entry => entry.workflow.name === 'archon-merge-queue')).toBe(true);
  });
  it('expands native includes inside bounded loops, keeping both gates top-level', () => {
    const workflow = loadQueue();
    expect(workflow.nodes.filter(n => n.kind === 'gate').map(n => n.id)).toEqual([
      'approve-order',
      'approve-candidates',
    ]);
    const groups = workflow.nodes.filter(n => n.kind === 'loop_group');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      if (group.kind !== 'loop_group') throw new Error('Expected loop');
      const script = readFileSync(
        join(root, '.archon/workflows/sdlc/merge-queue/scripts/merge-queue.py'),
        'utf8'
      );
      const limit = /^MAX_BATCH = (\d+)$/m.exec(script)?.[1];
      expect(limit).toBeDefined();
      expect(group.loop_group.max_iterations).toBe(Number(limit));
      expect(
        group.loop_group.nodes.some(
          n => 'kind' in n && (n.kind === 'gate' || n.kind === 'workflow')
        )
      ).toBe(false);
    }
  });

  it('pauses at the order gate before any candidate computation', async () => {
    const result = await dryRunWorkflow({
      workflow: loadQueue(),
      cwd: root,
      userMessage: '',
      pauseAtGates: true,
      inputs: { prs: '[]' },
      stubs: {
        intake: '{}',
        assess: '{"order":[2,1],"judgments":[]}',
        'order-snapshot': '{"snapshot":"pinned-order","assessment":{"order":[2,1]}}',
      },
    });
    expect(result.outcome).toBe('paused');
    expect(result.trace.at(-1)?.nodeId).toBe('approve-order');
    expect(result.trace.at(-1)?.resolvedText).toContain('pinned-order');
    expect(result.trace.some(n => n.nodeId === 'candidates')).toBe(false);
  });

  it('routes a held composition past skipped includes without inventing their outputs', async () => {
    const result = await dryRunWorkflow({
      workflow: loadQueue(),
      cwd: root,
      userMessage: '',
      inputs: { prs: '[]' },
      stubs: {
        intake: '{}',
        assess: '{"order":[1,2],"judgments":[]}',
        'order-snapshot': '{"snapshot":"pinned-order"}',
        'order-receipt': '{"proceed":true}',
        prepare: '{"run":false}',
        record: '{"done":true}',
        'candidate-snapshot': '{"ready":false}',
        report: { merged: false, queue: 'queue.json', phase: 'held', entries: [] },
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace.find(n => n.nodeId === 'report')).toMatchObject({ state: 'stubbed' });
    expect(result.authoredOutcome).toBe('failed');
    expect(result.missingStubs).toEqual([]);
    expect(result.trace.find(n => n.nodeId === 'approve-candidates')?.state).toBe('skipped');
    expect(result.trace.find(n => n.nodeId === 'merges')?.state).toBe('skipped');
  });
});
