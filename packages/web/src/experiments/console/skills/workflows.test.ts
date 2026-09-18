import { describe, test, expect, afterEach } from 'bun:test';
import {
  buildWorkflowPath,
  buildSavePath,
  getWorkflowGraph,
  listWorkflows,
  loadWorkflow,
} from './workflows';

describe('buildWorkflowPath', () => {
  test('encodes both name and cwd', () => {
    expect(buildWorkflowPath('my-flow', 'D:/Dynamous/Archon')).toBe(
      '/api/workflows/my-flow?cwd=D%3A%2FDynamous%2FArchon'
    );
  });

  test('encodes special characters in the name', () => {
    expect(buildWorkflowPath('a b', '/repo')).toBe('/api/workflows/a%20b?cwd=%2Frepo');
  });

  test('uses encodeURIComponent (not encodeURI) — a literal % is escaped', () => {
    expect(buildWorkflowPath('50%off', '/repo')).toBe('/api/workflows/50%25off?cwd=%2Frepo');
  });
});

describe('buildSavePath', () => {
  test('appends &source=project to the encoded cwd query', () => {
    expect(buildSavePath('my-flow', '/repo', 'project')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=project'
    );
  });

  test('appends &source=global', () => {
    expect(buildSavePath('my-flow', '/repo', 'global')).toBe(
      '/api/workflows/my-flow?cwd=%2Frepo&source=global'
    );
  });
});

describe('listWorkflows — declared inputs survive the wire mapping (#2554)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("carries a workflow's declared inputs through to the console primitive", async () => {
    // The console's run form depends on this field surviving `listWorkflows`, and the
    // wire shape here is hand-rolled — it once omitted `inputs` entirely and still
    // compiled, because a missing optional property satisfies the parameter type. This
    // is the regression guard the compiler cannot be.
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
    expect(loaded.definition).toEqual(authored);
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
