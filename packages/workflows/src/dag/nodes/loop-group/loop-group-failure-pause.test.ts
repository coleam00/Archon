// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { listAttentionQueue } from '../../../attention-queue';
import { dagNodeSchema } from '../../../schemas';
import { createMockDeps, createMockPlatform, dagOptions, mockSendQueryDag } from '../../test-utils';

for (const [name, suspension] of [
  ['attention', { wait: { attention: 'Please decide' } }],
  ['duration', { wait: { duration_ms: 60_000 } }],
  ['until', { wait: { until: '2099-01-01T00:00:00.000Z' } }],
  ['event', { wait: { event: 'ready', deadline_ms: 60_000 } }],
  ['gate', { approval: { message: 'Please decide' } }],
] as const) {
  for (const failed of [true, false]) {
    test(`${name}: ${failed ? 'body failure prevents suspension' : 'clean body still pauses'} without losing cleanup or usage`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'archon-loop-failure-pause-'));
      try {
        mockSendQueryDag.mockImplementation(async function* () {
          yield { type: 'agent_message_chunk', text: 'work done' };
          yield { type: 'result', sessionId: 'work', cost: 0.02, tokens: { input: 20, output: 3 } };
        });
        const store = await createFileWorkflowStore({ root });
        const pauseWait = spyOn(store, 'pauseWorkflowRunForWait');
        const pauseGate = spyOn(store, 'pauseWorkflowRun');
        const created = await store.createWorkflowRun({
          workflow_name: 'failed-pause',
          user_message: '',
        });
        const run = await store.claimPendingWorkflowRun(created.id, root);
        if (!run) throw new Error('Claim failed');
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: root,
            workflowRun: run,
            workflow: {
              name: 'failed-pause',
              nodes: [
                dagNodeSchema.parse({
                  id: 'cycle',
                  loop_group: {
                    max_iterations: 2,
                    until_bash: 'exit 1',
                    nodes: [
                      { id: 'work', prompt: 'Work' },
                      {
                        id: 'broken',
                        bash: failed ? 'exit 7' : 'echo success',
                        depends_on: ['work'],
                      },
                      {
                        id: 'cleanup',
                        bash: 'echo cleaned',
                        depends_on: ['broken'],
                        trigger_rule: 'all_done',
                      },
                      {
                        id: 'pause',
                        ...suspension,
                        depends_on: ['cleanup'],
                        trigger_rule: 'all_done',
                      },
                    ],
                  },
                }),
              ],
            },
          })
        );
        const persisted = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        const bodyError = events.find(
          event => event.event_type === 'node_failed' && event.step_name === 'cycle.broken'
        )?.data.error;
        const groupFailure = events.find(
          event => event.event_type === 'node_failed' && event.step_name === 'cycle'
        );
        if (failed) {
          expect(bodyError).toBe("Bash node 'broken' failed [exit 7]: no diagnostic output");
          expect(groupFailure?.data.error).toBe(
            `Loop-group node 'cycle' failed at iteration 1: 'broken': ${String(bodyError)}`
          );
          expect(groupFailure?.data.cost_usd).toBe(0.02);
          expect(persisted?.status).toBe('failed');
          expect(persisted?.metadata.wait).toBeUndefined();
          expect(persisted?.metadata.approval).toBeUndefined();
          expect(await listAttentionQueue({ store, branchOf: async () => null })).toEqual([]);
          expect(events.some(event => event.step_name === 'cycle.pause')).toBe(false);
          expect(pauseWait).not.toHaveBeenCalled();
          expect(pauseGate).not.toHaveBeenCalled();
          expect(events.some(event => event.event_type === 'workflow_failed')).toBe(true);
        } else {
          expect(bodyError).toBeUndefined();
          expect(groupFailure).toBeUndefined();
          expect(persisted?.status).toBe('paused');
          if (name === 'gate') {
            expect(pauseGate).toHaveBeenCalledTimes(1);
          } else {
            expect(pauseWait).toHaveBeenCalledTimes(1);
          }
        }
        expect(persisted?.metadata).toMatchObject({
          total_cost_usd: 0.02,
          total_tokens_in: 20,
          total_tokens_out: 3,
        });
        expect(
          events.some(
            event => event.step_name === 'cycle.cleanup' && event.event_type === 'node_completed'
          )
        ).toBe(true);
        expect(events.filter(event => event.event_type === 'loop_iteration_started')).toHaveLength(
          1
        );
      } finally {
        await removeTempTree(root);
      }
    });
  }
}

test('an outer failure sharing the terminal wait id does not suppress a clean body pause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-loop-scoped-failure-'));
  try {
    const store = await createFileWorkflowStore({ root });
    const created = await store.createWorkflowRun({
      workflow_name: 'scoped-failure',
      user_message: '',
    });
    const run = await store.claimPendingWorkflowRun(created.id, root);
    if (!run) throw new Error('Claim failed');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: root,
        workflowRun: run,
        workflow: {
          name: 'scoped-failure',
          nodes: [
            dagNodeSchema.parse({ id: 'pause', bash: 'exit 7' }),
            dagNodeSchema.parse({
              id: 'cycle',
              depends_on: ['pause'],
              trigger_rule: 'all_done',
              loop_group: {
                max_iterations: 1,
                until_bash: 'exit 1',
                nodes: [{ id: 'pause', wait: { attention: 'Please decide' } }],
              },
            }),
          ],
        },
      })
    );
    const persisted = await store.getWorkflowRun(run.id);
    expect(persisted?.status).toBe('paused');
    expect(persisted?.metadata.wait).toMatchObject({ nodeId: 'cycle', bodyWaitId: 'pause' });
    const events = await store.listWorkflowEvents(run.id);
    expect(
      events.some(event => event.event_type === 'node_failed' && event.step_name === 'cycle')
    ).toBe(false);
  } finally {
    await removeTempTree(root);
  }
});
