import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflows } from '../packages/workflows/src/workflow-discovery';
import { dryRunWorkflow } from '../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../packages/workflows/src/fixture-runner';
import { resolveWorkflow, resolvedBodyNodes } from '../packages/workflows/src/graph-plan';

// Cross-boundary checks live here so engine tests never depend on the bundled pack.
test('standalone archon-review fails without attention when prune-scratch fails', async () => {
  const repo = resolve(import.meta.dir, '..');
  const catalog = await discoverWorkflows(repo, {
    providers: providerRegistry,
    loadDefaults: false,
  });
  const entry = catalog.workflows.find(entry => entry.workflow.name === 'archon-review');
  if (!entry) throw new Error(JSON.stringify(catalog.errors));
  const fixturePath = resolve(
    repo,
    '.archon/workflows/sdlc/review-entry/fixtures/ready-draft.stubs.yaml'
  );
  const fixture = parseFixtureFile(await Bun.file(fixturePath).text(), fixturePath);
  for (const failed of [false, true]) {
    let injected = 0;
    const workflow = resolveWorkflow({
      ...entry.workflow,
      nodes: entry.workflow.nodes.map(node =>
        node.kind !== 'loop_group'
          ? node
          : {
              ...node,
              loop_group: {
                ...node.loop_group,
                nodes: resolvedBodyNodes(node.loop_group).map(body => {
                  if (!failed || body.id !== 'stage__prune-scratch' || body.kind !== 'exec')
                    return body;
                  injected++;
                  return { ...body, runtime: 'sh', script: 'exit 7' };
                }),
              },
            }
      ),
    });
    const stubs = { ...fixture.stubs };
    if (failed) delete stubs['stage__prune-scratch'];
    const result = await dryRunWorkflow({
      workflow,
      cwd: repo,
      userMessage: '',
      stubs,
      execCode: true,
      inputs: fixture.declaration.inputs,
    });
    expect(result.outcome).toBe(failed ? 'failed' : 'paused');
    expect(
      result.trace.filter(entry => entry.state === 'failed').map(entry => entry.nodeId)
    ).toEqual(failed ? ['stage__prune-scratch', 'cycle'] : []);
    expect(
      result.trace.filter(entry => entry.state === 'paused').map(entry => entry.nodeId)
    ).toEqual(failed ? [] : ['attend__ask']);
    expect(injected).toBe(failed ? 1 : 0);
  }
});
