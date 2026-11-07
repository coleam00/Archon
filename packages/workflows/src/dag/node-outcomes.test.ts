// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockDeps, createMockPlatform, dagOptions, makeWorkflowRun } from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { nodeOutcomesListingSchema, type NodeOutcomesListing } from '../schemas/node-outcomes';
import type { DagNode } from '../schemas';

/** A node joined past every outcome, copying the listing it was handed. */
function reporter(dependsOn: string[]): DagNode {
  return {
    id: 'report',
    kind: 'exec',
    runtime: 'sh',
    // Braced form: reads the reserved process environment, not an engine substitution.
    script: 'cp "${NODE_OUTCOMES_FILE}" "$ARTIFACTS_DIR/observed-outcomes.json"',
    depends_on: dependsOn,
    trigger_rule: 'all_done',
  } as DagNode;
}

describe('executeDagWorkflow -- node outcomes listing', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-outcomes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  async function observed(): Promise<NodeOutcomesListing> {
    return nodeOutcomesListingSchema.parse(
      JSON.parse(await readFile(join(testDir, 'artifacts', 'observed-outcomes.json'), 'utf8'))
    );
  }

  it('tells a node joined past a failure which nodes failed, were skipped or completed', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'outcomes-top-level',
          nodes: [
            {
              id: 'broken',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "{\\"ok\\":false}"; exit 3',
            },
            {
              id: 'fine',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "{\\"ok\\":true}"',
              output_format: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
              },
            },
            {
              id: 'after',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo after',
              depends_on: ['broken'],
            },
            reporter(['after', 'fine']),
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('outcomes-top-level'),
      })
    );

    const listing = await observed();
    expect(listing.run_id).toBe('outcomes-top-level');
    expect(listing.first_failed_node).toBe('broken');
    const byId = new Map(listing.nodes.map(entry => [entry.node_id, entry]));
    const broken = byId.get('broken');
    expect(broken?.state).toBe('failed');
    expect(broken?.error).toBeString();
    // A failed node's output is never handed on, even when it printed JSON.
    expect(broken && 'output' in broken).toBe(false);
    expect(byId.get('fine')).toMatchObject({ state: 'completed', output: { ok: true } });
    expect(byId.get('after')).toMatchObject({
      state: 'skipped',
      reason: 'trigger_rule',
      cause: { kind: 'upstream_failed', origin: 'broken' },
    });
    // A bash node records its start before its listing is written, so it sees itself running.
    expect(byId.get('report')?.state).toBe('running');
  });

  it('records each loop_group iteration of a body node separately', async () => {
    const counterFile = join(testDir, 'outcomes-counter').replace(/\\/g, '/');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-outcomes-loop',
        cwd: testDir,
        workflow: {
          name: 'outcomes-loop',
          nodes: [
            {
              id: 'rounds',
              kind: 'loop_group',
              loop_group: {
                until_bash: 'false',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'work',
                    kind: 'exec',
                    runtime: 'sh',
                    // Keeps the listing each iteration saw, then completes in
                    // iteration 1 and fails in iteration 2.
                    script: `n=$(cat "${counterFile}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counterFile}"; cp "\${NODE_OUTCOMES_FILE}" "$ARTIFACTS_DIR/iteration-$n.json"; [ $n -lt 2 ] || exit 4; echo "{\\"n\\":$n}"`,
                    output_format: {
                      type: 'object',
                      properties: { n: { type: 'number' } },
                      required: ['n'],
                    },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
            reporter(['rounds']),
          ] as DagNode[],
        },
        workflowRun: makeWorkflowRun('outcomes-loop'),
        artifactsDir: join(testDir, 'artifacts'),
      })
    );

    const listing = await observed();
    const work = listing.nodes.filter(entry => entry.node_id === 'rounds.work');
    expect(work).toEqual([
      {
        node_id: 'rounds.work',
        state: 'completed',
        loop_group_path: [{ groupId: 'rounds', iteration: 1 }],
        output: { n: 1 },
      },
      expect.objectContaining({
        node_id: 'rounds.work',
        state: 'failed',
        loop_group_path: [{ groupId: 'rounds', iteration: 2 }],
      }),
    ]);
    expect(listing.nodes.find(entry => entry.node_id === 'rounds')?.state).toBe('failed');

    // Iteration 2 already sees iteration 1's completed entry beside its own.
    const second = nodeOutcomesListingSchema.parse(
      JSON.parse(await readFile(join(testDir, 'artifacts', 'iteration-2.json'), 'utf8'))
    );
    expect(second.nodes.filter(entry => entry.node_id === 'rounds.work')).toEqual([
      {
        node_id: 'rounds.work',
        state: 'completed',
        loop_group_path: [{ groupId: 'rounds', iteration: 1 }],
        output: { n: 1 },
      },
      {
        node_id: 'rounds.work',
        state: 'running',
        loop_group_path: [{ groupId: 'rounds', iteration: 2 }],
      },
    ]);
    expect(listing.first_failed_node).toBe('rounds.work');
  });
});
