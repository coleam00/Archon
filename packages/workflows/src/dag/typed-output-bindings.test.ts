// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  spyOnNodeExec,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { expandWorkflowIncludes } from '../include-expander';
import { mapOf, wf } from '../include-expander.fixtures';
import type { DagNode, TypedOutputRecord } from '../schemas';

const VERDICT_FORMAT = {
  type: 'object',
  properties: { ready: { type: 'boolean' } },
  required: ['ready'],
};

/** A bash node whose certified output is a `verdict`. */
function verdict(id: string, ready: boolean, dependsOn: string[] = []): DagNode {
  return {
    id,
    kind: 'exec',
    runtime: 'sh',
    script: `echo '{"ready":${String(ready)}}'`,
    output_type: 'verdict',
    output_format: VERDICT_FORMAT,
    depends_on: dependsOn,
  } as DagNode;
}

/** The script node under test: it binds every `verdict` output of its run. */
function reader(dependsOn: string[], extra: Partial<DagNode> = {}): DagNode {
  return {
    id: 'read',
    kind: 'exec',
    runtime: 'bun',
    script: 'console.log("read")',
    depends_on: dependsOn,
    with: { verdicts: { outputs: 'verdict' } },
    ...extra,
  } as DagNode;
}

describe('executeDagWorkflow -- typed-outputs bindings', () => {
  let testDir: string;
  let execSpy: ReturnType<typeof spyOnNodeExec>;
  /** The environment of each `read` invocation, in order. */
  let delivered: (string | undefined)[];

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-typed-bind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    delivered = [];
    // The subject is what the engine hands the script, so the script itself never spawns;
    // the bash producers run for real and write real typed outputs.
    const real = git.execFileAsync;
    execSpy = spyOnNodeExec().mockImplementation(async (command, args, options) => {
      if (command !== 'bun') return real(command, args, options);
      delivered.push(options?.env?.INPUTS_VERDICTS);
      return { stdout: 'read\n', stderr: '' };
    });
  });

  afterEach(async () => {
    execSpy.mockRestore();
    await removeTempTree(testDir);
  });

  function bound(index = 0): TypedOutputRecord[] {
    const text = delivered[index];
    if (text === undefined)
      throw new Error(`read invocation ${String(index)} got no INPUTS_VERDICTS`);
    return JSON.parse(text) as TypedOutputRecord[];
  }

  async function run(nodes: DagNode[], overrides: Parameters<typeof dagOptions>[0] | object = {}) {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: { name: 'typed-bind', nodes },
        workflowRun: makeWorkflowRun('typed-bind-run'),
        ...overrides,
      })
    );
    return store;
  }

  function failureOf(store: ReturnType<typeof createMockStore>, nodeId: string): string {
    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === nodeId
    );
    return String((failed?.data as { error?: unknown } | undefined)?.error ?? '');
  }

  it('delivers every output of the type across loop iterations, in production order', async () => {
    const counter = join(testDir, 'rounds').replace(/\\/g, '/');
    await run([
      verdict('first', false),
      {
        id: 'rounds',
        kind: 'loop_group',
        depends_on: ['first'],
        loop_group: {
          until_bash: `test "$(cat "${counter}")" -ge 2`,
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'judge',
              kind: 'exec',
              runtime: 'sh',
              // Not ready on the first pass, ready on the second.
              script: `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; if [ $n -ge 2 ]; then echo '{"ready":true}'; else echo '{"ready":false}'; fi`,
              output_type: 'verdict',
              output_format: VERDICT_FORMAT,
              depends_on: [],
            },
          ],
        },
      } as DagNode,
      reader(['rounds']),
    ]);

    const records = bound();
    expect(records.map(({ node, loop, value }) => ({ node, loop, value }))).toEqual([
      { node: 'first', loop: [], value: { ready: false } },
      { node: 'judge', loop: [{ group: 'rounds', iteration: 1 }], value: { ready: false } },
      { node: 'judge', loop: [{ group: 'rounds', iteration: 2 }], value: { ready: true } },
    ]);
    for (const record of records) expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it('reads a producer that arrived through an include, by its type', async () => {
    const block = wf('verdict-block', [
      {
        id: 'judge',
        bash: `echo '{"ready":true}'`,
        output_type: 'verdict',
        output_format: VERDICT_FORMAT,
      },
    ]);
    const parent = wf('parent', [
      { id: 'review', include: 'verdict-block' },
      {
        id: 'read',
        script: 'console.log("read")',
        runtime: 'bun',
        depends_on: ['review'],
        with: { verdicts: { outputs: 'verdict' } },
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(mapOf(block, parent));
    expect(errors).toEqual([]);

    await run([...(workflows.get('parent')?.nodes ?? [])]);

    expect(bound().map(({ node, value }) => ({ node, value }))).toEqual([
      { node: 'review__judge', value: { ready: true } },
    ]);
  });

  it('delivers an empty array when the run produced no output of the type', async () => {
    await run([
      {
        id: 'other',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo hi',
        output_type: 'note',
      } as DagNode,
      reader(['other']),
    ]);

    expect(delivered).toEqual(['[]']);
  });

  it('fails the node, naming the record, when a typed-output record cannot be read', async () => {
    await mkdir(join(testDir, 'artifacts', 'nodes'), { recursive: true });
    await writeFile(join(testDir, 'artifacts', 'nodes', 'torn.meta.json'), '{ not json');

    const store = await run([verdict('first', true), reader(['first'])]);

    expect(delivered).toEqual([]);
    const error = failureOf(store, 'read');
    expect(error).toContain("binding 'verdicts'");
    expect(error).toContain('nodes/torn.meta.json (invalid_metadata)');
  });

  it('delivers the declared if_unreadable value instead, and only for an unreadable record', async () => {
    const tolerant = { with: { verdicts: { outputs: 'verdict', if_unreadable: null } } };
    await mkdir(join(testDir, 'artifacts', 'nodes'), { recursive: true });
    await writeFile(join(testDir, 'artifacts', 'nodes', 'torn.meta.json'), '{ not json');

    await run([verdict('first', true), reader(['first'], tolerant as Partial<DagNode>)]);
    expect(delivered).toEqual(['null']);

    // An output that is not JSON is the producer's defect, which the default does not cover.
    await removeTempTree(join(testDir, 'artifacts'));
    const store = await run([
      { id: 'prose', kind: 'exec', runtime: 'sh', script: 'echo fine', output_type: 'verdict' },
      reader(['prose'], tolerant as Partial<DagNode>),
    ] as DagNode[]);
    expect(delivered).toEqual(['null']);
    expect(failureOf(store, 'read')).toContain("declare output_format on 'prose'");
  });

  it('fails the node when an output of the type is not a JSON document', async () => {
    const store = await run([
      {
        id: 'prose',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo looks fine',
        output_type: 'verdict',
      } as DagNode,
      reader(['prose']),
    ]);

    expect(delivered).toEqual([]);
    expect(failureOf(store, 'read')).toContain("declare output_format on 'prose'");
  });

  it('reads outputs recorded before a resume, without re-running their producer', async () => {
    const nodes = [verdict('first', true), reader(['first'])];
    await run(nodes);

    const resumed = await run(nodes, {
      priorCompletedNodes: new Map([['first', { output: '{"ready":true}' }]]),
    });

    expect(
      persistedEvents(resumed).some(
        event => event.event_type === 'node_skipped_prior_success' && event.step_name === 'first'
      )
    ).toBe(true);
    // One record, not two: the skipped producer's output is recorded once per node.
    expect(bound(1).map(({ node, value }) => ({ node, value }))).toEqual([
      { node: 'first', value: { ready: true } },
    ]);
  });
});
