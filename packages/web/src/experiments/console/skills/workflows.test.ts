import { describe, test, expect, afterEach } from 'bun:test';
import { getWorkflowGraph, listWorkflows, loadWorkflow } from './workflows';

describe('listWorkflows — declared inputs survive the wire mapping (#2554)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("carries a workflow's declared inputs through to the console primitive", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            workflows: [
              {
                workflow: {
                  name: 'review-block',
                  description: 'reviews a diff',
                  inputs: { diff: { required: true }, style: { default: 'strict' } },
                },
                source: 'project',
              },
            ],
            recommended: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch;

    const result = await listWorkflows('/repo');

    expect(result.workflows[0].inputs).toEqual([
      { name: 'diff', required: true, default: null, description: null },
      { name: 'style', required: false, default: 'strict', description: null },
    ]);
  });
});

describe('getWorkflowGraph', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('projects wait nodes as wait rather than prompt', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            workflows: [
              {
                workflow: {
                  name: 'await-checks',
                  description: 'waits for checks',
                  nodes: [{ id: 'checks', wait: { event: 'checks.complete', deadline_ms: 1000 } }],
                },
                source: 'project',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )) as typeof fetch;

    await expect(getWorkflowGraph('await-checks')).resolves.toEqual([
      { id: 'checks', dependsOn: [], kind: 'wait' },
    ]);
  });
});

describe('loadWorkflow', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubGet(body: unknown): void {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )) as typeof fetch;
  }

  test('hands the builder the authored form, not the normalized one', async () => {
    // The normalized `workflow` is what the engine runs; the builder imports and
    // saves the authored shape, and the server rejects the normalized one on save.
    const authored = {
      name: 'assist',
      description: 'one node',
      nodes: [{ id: 'assist', command: 'archon-assist' }],
    };
    stubGet({
      workflow: {
        name: 'assist',
        description: 'one node',
        nodes: [
          { id: 'assist', kind: 'agent', source: { kind: 'command', name: 'archon-assist' } },
        ],
      },
      authored,
      filename: 'assist.yaml',
      source: 'bundled',
    });

    const loaded = await loadWorkflow('assist', '/repo');
    expect(loaded).toMatchObject({ definition: authored });
  });

  test('reports an installed-pack workflow as such instead of failing on its missing authored form', async () => {
    stubGet({
      workflow: { name: 'acme/review:pr', description: 'pack entrypoint', nodes: [] },
      filename: 'acme/review:pr',
      source: 'installed',
    });

    expect(await loadWorkflow('acme/review:pr', '/repo')).toEqual({
      installedPack: true,
      name: 'acme/review:pr',
    });
  });

  test('refuses a response without the authored form instead of editing the normalized one', async () => {
    stubGet({
      workflow: { name: 'assist', description: 'one node', nodes: [] },
      filename: 'assist.yaml',
      source: 'bundled',
    });

    await expect(loadWorkflow('assist', '/repo')).rejects.toThrow('authored');
  });
});
