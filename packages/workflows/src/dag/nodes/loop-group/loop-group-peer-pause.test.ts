// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { dryRunWorkflow } from '../../../dry-run';
import { validateDagStructure } from '../../../loader/dag-structure';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { listAttentionQueue } from '../../../attention-queue';
import { dagNodeSchema } from '../../../schemas';
import { createMockDeps, createMockPlatform, dagOptions, mockSendQueryDag } from '../../test-utils';

const variants = ['gate group', 'interactive group', 'interactive loop'] as const;
const failingVariants = [...variants, 'skipped gate group'] as const;
function peer(id: string, variant: (typeof failingVariants)[number], failed = false) {
  if (variant === 'interactive loop')
    return {
      id,
      loop: {
        max_iterations: 1,
        until: 'DONE',
        interactive: true,
        gate_message: 'Decide',
        prompt: failed ? 'Fail' : 'Work',
      },
    };
  return {
    id,
    loop_group: {
      max_iterations: 1,
      until: 'DONE',
      ...(variant === 'interactive group' ? { interactive: true, gate_message: 'Decide' } : {}),
      nodes: [
        {
          id: `${id}-work`,
          bash:
            failed && variant !== 'skipped gate group'
              ? 'exit 7'
              : variant === 'skipped gate group'
                ? 'echo working'
                : 'echo DONE',
        },
        {
          id: `${id}-cleanup`,
          bash: 'echo cleaned',
          depends_on: [`${id}-work`],
          trigger_rule: 'all_done',
        },
        ...(variant === 'gate group' || variant === 'skipped gate group'
          ? [
              {
                id: `${id}-gate`,
                approval: { message: 'Decide' },
                ...(variant === 'skipped gate group'
                  ? { when: `$${id}-work.output == 'DONE'` }
                  : {}),
                depends_on: [`${id}-cleanup`],
                trigger_rule: 'all_done',
              },
            ]
          : []),
      ],
    },
  };
}

for (const failing of failingVariants)
  for (const pausing of variants)
    for (const pauseFirst of [true, false]) {
      test(`${failing} failure beside ${pausing}, pause ${pauseFirst ? 'first' : 'last'}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'archon-loop-peer-'));
        try {
          mockSendQueryDag.mockImplementation(async function* (prompt) {
            if (prompt.includes('Fail')) throw new Error('peer failed');
            yield { type: 'agent_message_chunk', text: 'DONE' };
            yield {
              type: 'result',
              sessionId: 'work',
              cost: 0.02,
              tokens: { input: 20, output: 3 },
            };
          });
          const store = await createFileWorkflowStore({ root });
          const pauseGate = spyOn(store, 'pauseWorkflowRun');
          const created = await store.createWorkflowRun({
            workflow_name: 'peers',
            user_message: '',
          });
          const run = await store.claimPendingWorkflowRun(created.id, root);
          if (!run) throw new Error('Claim failed');
          const peers = [peer('pause', pausing), peer('broken', failing, true)];
          const workflow = {
            name: 'peers',
            description: '',
            nodes: [
              dagNodeSchema.parse({
                id: 'cycle',
                loop_group: {
                  max_iterations: 1,
                  until: 'DONE',
                  nodes: [
                    ...(pauseFirst ? peers : [...peers].reverse()),
                    {
                      id: 'cleanup',
                      bash: 'echo cleaned',
                      depends_on: ['broken'],
                      trigger_rule: 'all_done',
                    },
                  ],
                },
              }),
            ],
          };
          expect(validateDagStructure(workflow.nodes)).toBeNull();
          const options = dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: root,
            workflowRun: run,
            workflow,
          });
          await executeDagWorkflow(options);
          const persisted = await store.getWorkflowRun(run.id);
          const events = await store.listWorkflowEvents(run.id);
          expect(persisted?.status).toBe('failed');
          const bodyError = events.find(
            e => e.event_type === 'node_failed' && e.step_name === 'cycle.broken'
          )?.data.error;
          expect(bodyError).toContain(
            failing === 'interactive loop'
              ? 'peer failed'
              : failing === 'skipped gate group'
                ? 'max iterations'
                : 'exit 7'
          );
          expect(
            events.find(e => e.event_type === 'node_failed' && e.step_name === 'cycle')?.data.error
          ).toBe(`Loop-group node 'cycle' failed at iteration 1: 'broken': ${String(bodyError)}`);
          expect(persisted?.metadata.approval).toBeUndefined();
          expect(persisted?.metadata.wait).toBeUndefined();
          expect(await listAttentionQueue({ store, branchOf: async () => null })).toEqual([]);
          expect(pauseGate).not.toHaveBeenCalled();
          if (pausing === 'interactive loop') {
            expect(persisted?.metadata).toMatchObject({
              total_cost_usd: 0.02,
              total_tokens_in: 20,
              total_tokens_out: 3,
            });
            const snapshot = await foldDagResumeSnapshot(events, run.id);
            expect(snapshot.costUsd).toBe(0.02);
            expect(snapshot.tokens).toEqual({ input: 20, output: 3 });
            if (!snapshot.unfinishedInvocations) throw new Error('Missing invocation snapshot');
            expect(
              [...snapshot.unfinishedInvocations.values()].some(e => e.path === 'cycle.pause')
            ).toBe(false);
          }
          for (const path of [
            'cycle.cleanup',
            ...(failing === 'interactive loop' ? [] : ['cycle.broken.broken-cleanup']),
            ...(pausing === 'interactive loop' ? [] : ['cycle.pause.pause-cleanup']),
          ]) {
            expect(
              events.some(e => e.step_name === path && e.event_type === 'node_completed')
            ).toBe(true);
          }
          const simulated = await dryRunWorkflow({
            workflow: options.workflow,
            cwd: root,
            userMessage: '',
            pauseAtGates: true,
            stubs: {
              pause: 'DONE',
              'pause-work': 'DONE',
              'pause-cleanup': 'DONE',
              'broken-cleanup': 'cleaned',
              ...(failing === 'skipped gate group' ? { 'broken-work': 'working' } : {}),
              cleanup: 'cleaned',
            },
          });
          if (failing === 'skipped gate group') {
            expect(
              events.find(
                e => e.step_name === 'cycle.broken.broken-gate' && e.event_type === 'node_skipped'
              )?.data.reason
            ).toBe('when_condition');
            expect(simulated.trace.find(e => e.nodeId === 'broken-gate')?.state).toBe('skipped');
            expect(
              simulated.trace.find(e => e.nodeId === 'broken' && e.state === 'failed')?.reason
            ).toContain('max iterations');
          }
          expect(simulated.outcome).toBe('failed');
          expect(simulated.trace.some(e => e.state === 'paused')).toBe(false);
          expect(simulated.trace.some(e => e.nodeId === 'broken' && e.state === 'failed')).toBe(
            true
          );
        } finally {
          await removeTempTree(root);
        }
      });
    }

for (const variant of variants) {
  test(`clean ${variant} peers retain suspension`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-loop-clean-peers-'));
    try {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'DONE' };
        yield { type: 'result', sessionId: 'work' };
      });
      const store = await createFileWorkflowStore({ root });
      const created = await store.createWorkflowRun({
        workflow_name: 'clean-peers',
        user_message: '',
      });
      const run = await store.claimPendingWorkflowRun(created.id, root);
      if (!run) throw new Error('Claim failed');
      const options = dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: root,
        workflowRun: run,
        workflow: {
          name: 'clean-peers',
          nodes: [
            dagNodeSchema.parse({
              id: 'cycle',
              loop_group: {
                max_iterations: 1,
                until: 'DONE',
                nodes: [peer('one', variant), peer('two', variant)],
              },
            }),
          ],
        },
      });
      expect(validateDagStructure(options.workflow.nodes)).toBeNull();
      await executeDagWorkflow(options);
      const persisted = await store.getWorkflowRun(run.id);
      expect(persisted?.status).toBe('paused');
      expect(persisted?.metadata.approval).toBeDefined();
    } finally {
      await removeTempTree(root);
    }
  });
}
