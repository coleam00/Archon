import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow } from '../loader';
import { discoverWorkflows } from '../workflow-discovery';
import { expandWorkflowIncludes } from '../include-expander';
import { dryRunWorkflow } from '../dry-run';
import { formatPackagedResourceReference, qualifyWorkflowResources } from '../packaged-workflow';
import type { WorkflowDefinition } from '../schemas/workflow';
import { z } from 'zod';

const root = join(import.meta.dir, '../../../..');
function loadQueue() {
  const definitions = new Map<string, WorkflowDefinition>();
  const commands = new Map<string, string>();
  for (const name of ['merge-queue', 'triage', 'review', 'validate']) {
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
  it('keeps independently materialized triage and diff complexity contracts conformant', () => {
    const workflow = loadQueue();
    const triages = workflow.nodes.find(n => n.id === 'triages');
    if (triages?.kind !== 'loop_group') throw new Error('Missing triage loop');
    const triage = triages.loop_group.nodes.find(n => 'kind' in n && n.kind === 'agent');
    const owner = z
      .object({
        output_format: z.object({
          properties: z.object({
            complexity: z.object({ enum: z.array(z.string()) }),
          }),
        }),
      })
      .parse(triage).output_format.properties.complexity.enum;
    expect(workflow.nodes.find(n => n.id === 'assess')).toMatchObject({
      output_format: {
        properties: { judgments: { items: { properties: { size: { enum: owner } } } } },
      },
    });
    for (const path of [
      'triage/scripts/validate-contract.py',
      'merge-queue/scripts/merge-queue.py',
    ]) {
      const source = readFileSync(join(root, '.archon/workflows/sdlc', path), 'utf8');
      const tuple = /^COMPLEXITIES = \((.+)\)$/m.exec(source)?.[1];
      expect(tuple).toBeDefined();
      expect(JSON.parse(`[${tuple}]`)).toEqual(owner);
    }
    expect(triage).toMatchObject({ mutates_checkout: false });
  });
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
    expect(groups).toHaveLength(3);
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

  it('passes the local range to the deterministic review publisher', () => {
    const workflow = loadQueue();
    const candidates = workflow.nodes.find(n => n.id === 'candidates');
    if (candidates?.kind !== 'loop_group') throw new Error('Missing candidates loop');
    const publish = candidates.loop_group.nodes.find(n => n.id.endsWith('publish'));
    expect(publish).toMatchObject({
      with: { local_range: '$prepare.output.local_range' },
    });
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
        'assessment-record': '{}',
        'triage-prepare': '{"run":false}',
        'triage-record': '{"done":true}',
        'order-snapshot':
          '{"snapshot":"pinned-order","human_required":true,"assessment":{"order":[2,1]}}',
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
        'assessment-record': '{}',
        'triage-prepare': '{"run":false}',
        'triage-record': '{"done":true}',
        'order-snapshot': '{"snapshot":"pinned-order","human_required":true}',
        'order-receipt': '{"proceed":true}',
        prepare: '{"run":false}',
        record: '{"done":true}',
        'candidate-snapshot': '{"ready":false,"human_required":false}',
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

  for (const ready of [true, false]) {
    it(`pauses at the genuine candidate gate for human-required evidence (ready=${String(ready)})`, async () => {
      const result = await dryRunWorkflow({
        workflow: loadQueue(),
        cwd: root,
        userMessage: '',
        pauseAtGates: true,
        inputs: { prs: '[]' },
        stubs: {
          intake: '{}',
          assess: '{"order":[1],"judgments":[]}',
          'assessment-record': '{}',
          'triage-prepare': '{"run":false}',
          'triage-record': '{"done":true}',
          'order-snapshot': '{"snapshot":"policy-order","human_required":false}',
          'order-receipt': '{"proceed":true}',
          prepare: '{"run":false}',
          record: '{"done":true}',
          'candidate-snapshot': {
            ready,
            human_required: true,
            snapshot: 'exact-evidence',
            decision: {
              kind: 'human_required',
              reasons: ['Independent evidence requires supervision'],
            },
          },
        },
      });
      expect(result.outcome).toBe('paused');
      expect(result.trace.at(-1)?.nodeId).toBe('approve-candidates');
      expect(result.trace.at(-1)?.resolvedText).toContain('exact-evidence');
      expect(result.trace.find(n => n.nodeId === 'approve-order')?.state).toBe('skipped');
      expect(result.trace.some(n => n.nodeId === 'merges')).toBe(false);
    });
  }

  it('skips both native gates only for distinct automatic decisions and passes null receipts', async () => {
    const result = await dryRunWorkflow({
      workflow: loadQueue(),
      cwd: root,
      userMessage: '',
      pauseAtGates: true,
      inputs: { prs: '[]' },
      stubs: {
        intake: '{}',
        assess: '{"order":[1],"judgments":[]}',
        'assessment-record': '{}',
        'triage-prepare': '{"run":false}',
        'triage-record': '{"done":true}',
        'order-snapshot': '{"snapshot":"policy-order","human_required":false}',
        'order-receipt': '{"proceed":true}',
        prepare: '{"run":false}',
        record: '{"done":true}',
        'candidate-snapshot': '{"ready":true,"human_required":false,"snapshot":"policy-chain"}',
        'candidate-receipt': '{"proceed":true}',
        merge: '{"done":true}',
        report: { merged: true, queue: 'queue.json', phase: 'merged', entries: [] },
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.missingStubs).toEqual([]);
    for (const gate of ['approve-order', 'approve-candidates']) {
      expect(result.trace.find(n => n.nodeId === gate)?.state).toBe('skipped');
    }
    const workflow = loadQueue();
    for (const receipt of ['order-receipt', 'candidate-receipt']) {
      expect(workflow.nodes.find(n => n.id === receipt)).toMatchObject({
        with: { receipt: { if_skipped: null } },
      });
    }
  });
});
