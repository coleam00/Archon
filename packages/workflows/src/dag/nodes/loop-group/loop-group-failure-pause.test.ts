// @archon-test-isolated
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { dryRunWorkflow } from '../../../dry-run';
import { validateDagStructure } from '../../../loader/dag-structure';
import { createFileWorkflowStore } from '../../../file-store/store';
import { executeDagWorkflow } from '../../../dag-executor';
import { listAttentionQueue } from '../../../attention-queue';
import { dagNodeSchema, workflowDefinitionSchema } from '../../../schemas';
import { expandWorkflowIncludes } from '../../../include-expander';
import { createMockDeps, createMockPlatform, dagOptions, mockSendQueryDag } from '../../test-utils';

for (const [name, suspension] of [
  ['attention', { wait: { attention: 'Please decide' } }],
  ['duration', { wait: { duration_ms: 60_000 } }],
  ['until', { wait: { until: '2099-01-01T00:00:00.000Z' } }],
  ['event', { wait: { event: 'ready', deadline_ms: 60_000 } }],
  ['gate', { approval: { message: 'Please decide' } }],
  [
    'nested gate',
    {
      loop_group: {
        max_iterations: 1,
        until_bash: 'exit 1',
        nodes: [{ id: 'check', approval: { message: 'Please decide' } }],
      },
    },
  ],
  [
    'interactive group',
    {
      loop_group: {
        max_iterations: 1,
        until_bash: 'exit 1',
        interactive: true,
        gate_message: 'Please decide',
        nodes: [{ id: 'task', bash: 'echo done' }],
      },
    },
  ],
  [
    'interactive loop',
    {
      loop: {
        max_iterations: 1,
        until: 'DONE',
        interactive: true,
        gate_message: 'Please decide',
        prompt: 'Work',
      },
    },
  ],
  ...(
    [
      ['gate', { approval: { message: 'Please decide' } }],
      [
        'interactive group',
        {
          loop_group: {
            max_iterations: 1,
            until_bash: 'exit 1',
            interactive: true,
            gate_message: 'Please decide',
            nodes: [{ id: 'task', bash: 'echo done' }],
          },
        },
      ],
      [
        'interactive loop',
        {
          loop: {
            max_iterations: 1,
            until: 'DONE',
            interactive: true,
            gate_message: 'Please decide',
            prompt: 'Work',
          },
        },
      ],
    ] as const
  ).flatMap(([name, sink]) =>
    ['sole sink', 'before exec', 'beside exec'].map(
      topology =>
        [
          `recursive ${name} ${topology}`,
          {
            loop_group: {
              max_iterations: 1,
              until_bash: 'exit 1',
              nodes: [
                {
                  id: 'nested',
                  loop_group: {
                    max_iterations: 1,
                    until_bash: 'exit 1',
                    nodes: [{ id: 'check', ...sink }],
                  },
                },
                ...(topology === 'sole sink'
                  ? []
                  : [
                      {
                        id: 'finish',
                        bash: 'echo done',
                        depends_on: topology === 'before exec' ? ['nested'] : [],
                      },
                    ]),
              ],
            },
          },
        ] as const
    )
  ),
] as const) {
  for (const outerTopology of [
    'sole sink',
    ...(name === 'nested gate' ||
    name === 'interactive group' ||
    name === 'interactive loop' ||
    name.endsWith('sole sink')
      ? ['before exec', 'beside exec']
      : []),
  ]) {
    for (const failed of 'wait' in suspension || name === 'gate' ? [true, false] : [true]) {
      const offChain =
        outerTopology !== 'sole sink' ||
        name.includes('before exec') ||
        name.includes('beside exec');
      const outerId = offChain ? 'outer-pause' : 'pause';
      const brokenScript = failed ? 'exit 7' : 'echo success';
      const outerFinish =
        outerTopology === 'sole sink'
          ? []
          : [
              {
                id: 'outer-finish',
                bash: 'echo done',
                depends_on: outerTopology === 'before exec' ? ['pause'] : ['cleanup'],
                trigger_rule: 'all_done',
              },
            ];
      test(`${name} outer ${outerTopology}: ${failed ? 'body failure prevents suspension' : 'clean body still pauses'} without losing cleanup or usage`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'archon-loop-failure-pause-'));
        try {
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'work done' };
            yield {
              type: 'result',
              sessionId: 'work',
              cost: 0.02,
              tokens: { input: 20, output: 3 },
            };
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
          const options = dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: root,
            workflowRun: run,
            workflow: {
              name: 'failed-pause',
              nodes: [
                dagNodeSchema.parse({ id: outerId, bash: 'exit 8' }),
                dagNodeSchema.parse({
                  id: 'cycle',
                  depends_on: [outerId],
                  trigger_rule: 'all_done',
                  loop_group: {
                    max_iterations: 2,
                    until_bash: 'exit 1',
                    nodes: [
                      { id: 'work', prompt: 'Work' },
                      {
                        id: 'broken',
                        bash: brokenScript,
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
                      ...outerFinish,
                    ],
                  },
                }),
              ],
            },
          });
          if (offChain) expect(validateDagStructure(options.workflow.nodes)).toBeNull();
          await executeDagWorkflow(options);
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
            expect(
              events.some(
                event =>
                  event.step_name?.startsWith('cycle.pause') && event.event_type === 'node_failed'
              )
            ).toBe(false);
            if (name.includes('beside exec'))
              expect(
                events.some(
                  event =>
                    event.step_name === 'cycle.pause.finish' &&
                    event.event_type === 'node_completed'
                )
              ).toBe(true);
            if (name.includes('before exec'))
              expect(
                events.find(event => event.step_name === 'cycle.pause.finish')?.event_type
              ).toBe('node_skipped');
            if (outerTopology !== 'sole sink')
              expect(
                events.some(
                  event =>
                    event.step_name === 'cycle.outer-finish' &&
                    event.event_type === 'node_completed'
                )
              ).toBe(true);
            expect(pauseWait).not.toHaveBeenCalled();
            expect(pauseGate).not.toHaveBeenCalled();
            expect(events.some(event => event.event_type === 'workflow_failed')).toBe(true);
          } else {
            expect(bodyError).toBeUndefined();
            expect(groupFailure).toBeUndefined();
            expect(persisted?.status).toBe('paused');
            if (!('wait' in suspension)) {
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
          expect(
            events.filter(
              event => event.event_type === 'loop_iteration_started' && event.step_name === 'cycle'
            )
          ).toHaveLength(1);
        } finally {
          await removeTempTree(root);
        }
      });
    }
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

test('included cleanup failure fails the run and group before included attention can start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-loop-include-failure-'));
  try {
    const stage = workflowDefinitionSchema.parse({
      name: 'review-block',
      description: 'Review with cleanup',
      returns: 'result',
      nodes: [
        { id: 'review', bash: 'echo reviewed' },
        { id: 'result', bash: 'echo ready', depends_on: ['review'] },
        { id: 'prune-scratch', bash: 'exit 7', depends_on: ['review'], trigger_rule: 'all_done' },
      ],
    });
    const attention = workflowDefinitionSchema.parse({
      name: 'attention-block',
      description: 'Terminal attention',
      nodes: [{ id: 'ask', wait: { attention: 'Please decide' } }],
    });
    const entry = workflowDefinitionSchema.parse({
      name: 'included-review',
      description: 'Included stage then attention',
      nodes: [
        {
          id: 'cycle',
          loop_group: {
            max_iterations: 1,
            until_bash: 'exit 1',
            nodes: [
              { id: 'stage', include: stage.name },
              {
                id: 'attend',
                include: attention.name,
                depends_on: ['stage'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        [stage.name, stage],
        [attention.name, attention],
        [entry.name, entry],
      ])
    );
    expect(errors).toEqual([]);
    const workflow = workflows.get(entry.name);
    if (!workflow) throw new Error('Include expansion failed');
    const store = await createFileWorkflowStore({ root });
    const created = await store.createWorkflowRun({ workflow_name: entry.name, user_message: '' });
    const run = await store.claimPendingWorkflowRun(created.id, root);
    if (!run) throw new Error('Claim failed');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: root,
        workflowRun: run,
        workflow,
      })
    );
    const persisted = await store.getWorkflowRun(run.id);
    const events = await store.listWorkflowEvents(run.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.metadata.wait).toBeUndefined();
    expect(await listAttentionQueue({ store, branchOf: async () => null })).toEqual([]);
    expect(
      events.find(event => event.event_type === 'node_failed' && event.step_name === 'cycle')?.data
        .error
    ).toBe(
      "Loop-group node 'cycle' failed at iteration 1: 'stage__prune-scratch': Bash node 'stage__prune-scratch' failed [exit 7]: no diagnostic output"
    );
    expect(events.find(event => event.step_name === 'cycle.attend__ask')?.event_type).toBe(
      'node_skipped'
    );
    expect(events.some(event => event.event_type === 'workflow_failed')).toBe(true);
  } finally {
    await removeTempTree(root);
  }
});

for (const [name, suspension] of [
  [
    'nested gate',
    {
      loop_group: {
        max_iterations: 1,
        until_bash: 'exit 1',
        nodes: [
          { id: 'check', approval: { message: 'Decide' }, depends_on: ['nested-cleanup'] },
          { id: 'nested-cleanup', bash: 'echo cleaned' },
        ],
      },
    },
  ],
  [
    'interactive group',
    {
      loop_group: {
        max_iterations: 1,
        until_bash: 'exit 1',
        interactive: true,
        gate_message: 'Decide',
        nodes: [{ id: 'nested-cleanup', bash: 'echo cleaned' }],
      },
    },
  ],
  [
    'interactive loop',
    {
      loop: {
        max_iterations: 1,
        until: 'DONE',
        interactive: true,
        gate_message: 'Decide',
        prompt: 'Work',
      },
    },
  ],
] as const) {
  for (const interactionFirst of [true, false]) {
    for (const failed of [true, false]) {
      const expectedRunStatus = failed ? 'failed' : 'paused';
      const expectedSimulationStatus = failed
        ? 'failed'
        : name === 'nested gate'
          ? 'paused'
          : 'completed';
      const brokenScript = failed ? 'exit 7' : 'echo success';
      const brokenStubs: Record<string, string> = failed ? {} : { broken: 'success' };
      test(`same-layer ${name}, interaction ${interactionFirst ? 'first' : 'last'}, ${failed ? 'failed' : 'clean'} sibling`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'archon-loop-same-layer-'));
        try {
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'work done' };
            yield { type: 'result', sessionId: 'work' };
          });
          const store = await createFileWorkflowStore({ root });
          const pauseGate = spyOn(store, 'pauseWorkflowRun');
          const created = await store.createWorkflowRun({
            workflow_name: 'same-layer',
            user_message: '',
          });
          const run = await store.claimPendingWorkflowRun(created.id, root);
          if (!run) throw new Error('Claim failed');
          const peers = [
            { id: 'pause', ...suspension },
            { id: 'broken', bash: brokenScript },
          ];
          const options = dagOptions({
            deps: createMockDeps(store),
            platform: createMockPlatform(),
            cwd: root,
            workflowRun: run,
            workflow: {
              name: 'same-layer',
              nodes: [
                dagNodeSchema.parse({
                  id: 'cycle',
                  loop_group: {
                    max_iterations: 1,
                    until_bash: 'exit 1',
                    nodes: [
                      ...(interactionFirst ? peers : [...peers].reverse()),
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
            },
          });
          expect(validateDagStructure(options.workflow.nodes)).toBeNull();
          await executeDagWorkflow(options);
          const persisted = await store.getWorkflowRun(run.id);
          const events = await store.listWorkflowEvents(run.id);
          expect(persisted?.status).toBe(expectedRunStatus);
          if (failed) {
            const bodyError = events.find(
              e => e.event_type === 'node_failed' && e.step_name === 'cycle.broken'
            )?.data.error;
            expect(bodyError).toBe("Bash node 'broken' failed [exit 7]: no diagnostic output");
            expect(
              events.find(e => e.event_type === 'node_failed' && e.step_name === 'cycle')?.data
                .error
            ).toBe(`Loop-group node 'cycle' failed at iteration 1: 'broken': ${String(bodyError)}`);
            expect(persisted?.metadata.approval).toBeUndefined();
            expect(persisted?.metadata.wait).toBeUndefined();
            expect(await listAttentionQueue({ store, branchOf: async () => null })).toEqual([]);
            expect(pauseGate).not.toHaveBeenCalled();
            expect(
              events.some(e => e.step_name === 'cycle.cleanup' && e.event_type === 'node_completed')
            ).toBe(true);
            if (name !== 'interactive loop')
              expect(
                events.some(
                  e =>
                    e.step_name === 'cycle.pause.nested-cleanup' &&
                    e.event_type === 'node_completed'
                )
              ).toBe(true);
          } else {
            expect(pauseGate).toHaveBeenCalledTimes(1);
          }
          const simulated = await dryRunWorkflow({
            workflow: options.workflow,
            cwd: root,
            userMessage: '',
            stubs: {
              ...brokenStubs,
              pause: 'DONE',
              cleanup: 'cleaned',
              'nested-cleanup': 'cleaned',
            },
            pauseAtGates: true,
          });
          expect(simulated.outcome).toBe(expectedSimulationStatus);
          expect(simulated.trace.some(e => e.state === 'paused')).toBe(
            !failed && name === 'nested gate'
          );
          if (failed)
            expect(simulated.trace.filter(e => e.state === 'failed').map(e => e.nodeId)).toEqual([
              'broken',
              'cycle',
            ]);
        } finally {
          await removeTempTree(root);
        }
      });
    }
  }
}
