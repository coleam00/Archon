// @archon-test-isolated
import { createEscalationStore, seedPreviousLoopGroupPass } from '../../pause-test-utils';
import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import {
  type MockWorkflowStore,
  mockSendQueryDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  ready,
  makeWorkflowRun,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../event-emitter';
import type {
  WorkflowDefinition,
  ResolvedWorkflow,
  ApprovalContext,
  WorkflowWaitContext,
} from '../../../schemas';
import {
  dagNodeSchema,
  workflowDefinitionSchema,
  workflowWaitContextSchema,
} from '../../../schemas';
import { expandWorkflowIncludes } from '../../../include-expander';
import type { IWorkflowStore, PersistedNodeOutput } from '../../../store';

// ─── #2707 step 3: gate-terminated loop_group pause escalation ─────────────

/** A loop_group whose body ends in a gate — the canonical Design A shape. */
function gateTerminatedLoopGroupWorkflow(): WorkflowDefinition {
  return {
    name: 'gate-terminated-loop-group',
    description: 'Design A canonical shape',
    nodes: [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          // NOT '[ "$check.output.decision" = "approve" ]' — substituteNodeOutputRefs
          // already shell-quotes the substituted value (e.g. 'approve'), so wrapping
          // the ref in ITS OWN double quotes compares the literal string 'approve'
          // (with embedded quote characters) against "approve" and never matches.
          until_bash: '[ $check.output.decision = "approve" ]',
          max_iterations: 5,
          nodes: [
            { id: 'work', prompt: 'do work. Prior feedback: $LOOP_PREV.check.output.text' },
            {
              id: 'check',
              depends_on: ['work'],
              approval: {
                message: 'Continue?',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
              },
            },
          ],
        },
      }),
    ],
  };
}

function waitTerminatedLoopGroupWorkflow(): WorkflowDefinition {
  return {
    name: 'wait-terminated-loop-group',
    description: 'wait escalation shape',
    nodes: [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          until_bash: '[ $delay.output.status = "satisfied" ]',
          max_iterations: 2,
          nodes: [{ id: 'delay', wait: { duration_ms: 60_000 } }],
        },
      }),
    ],
  };
}

function attentionTerminatedLoopGroupWorkflow(
  probeCountPath: string,
  greenMarkerPath: string,
  maxIterations = 2
): WorkflowDefinition {
  return {
    name: 'attention-terminated-loop-group',
    description: 'attention wait escalation shape',
    nodes: [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          until_bash: 'test $probe.output.state = "concluded"',
          max_iterations: maxIterations,
          nodes: [
            {
              id: 'probe',
              bash: [
                'COUNT=0',
                `[ ! -f ${JSON.stringify(probeCountPath)} ] || COUNT=$(cat ${JSON.stringify(probeCountPath)})`,
                'COUNT=$((COUNT + 1))',
                `printf '%s' "$COUNT" > ${JSON.stringify(probeCountPath)}`,
                `if [ -f ${JSON.stringify(greenMarkerPath)} ]; then`,
                `  printf '%s' '{"state":"concluded","detail":"green"}'`,
                'else',
                `  printf '%s' '{"state":"red","detail":"windows tests failed"}'`,
                'fi',
              ].join('\n'),
            },
            {
              id: 'pause',
              wait: { attention: '$probe.output.detail Re-run the check, then resume.' },
              when: "$probe.output.state != 'concluded'",
              depends_on: ['probe'],
            },
          ],
        },
      }),
    ],
  };
}

function includedProbeWaitTerminatedLoopGroupWorkflow(
  markerPath: string,
  quoteOutputRef = false
): ResolvedWorkflow {
  const stateRef = quoteOutputRef ? '"$ci-probe.output.state"' : '$ci-probe.output.state';
  const block = workflowDefinitionSchema.parse({
    name: 'probe-wait-block',
    description: 'Included polling loop with a terminal wait',
    returns: 'await-checks',
    nodes: [
      {
        id: 'await-checks',
        loop_group: {
          until_bash: `printf ran > ${JSON.stringify(markerPath)}; test ${stateRef} != "pending"`,
          max_iterations: 3,
          nodes: [
            { id: 'ci-probe', bash: `printf '{"state":"pending"}'` },
            { id: 'ci-pause', wait: { duration_ms: 60_000 }, depends_on: ['ci-probe'] },
          ],
        },
      },
    ],
  });
  const parent = workflowDefinitionSchema.parse({
    name: 'included-probe-wait',
    description: 'Runs the polling loop through include expansion',
    nodes: [{ id: 'deliver', include: 'probe-wait-block' }],
  });
  const { workflows, errors } = expandWorkflowIncludes(
    new Map([
      [block.name, block],
      [parent.name, parent],
    ])
  );
  if (errors.length > 0) {
    throw new Error(`included probe fixture failed to expand: ${JSON.stringify(errors)}`);
  }
  const expanded = workflows.get(parent.name);
  if (!expanded) throw new Error('included probe fixture was not expanded');
  return expanded;
}

function repeatingWaitTerminatedLoopGroupWorkflow(): WorkflowDefinition {
  return {
    name: 'repeating-wait-terminated-loop-group',
    description: 'wait escalation must create a fresh cursor per iteration',
    nodes: [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          until_bash: '[ $delay.output.status = "expired" ]',
          max_iterations: 2,
          nodes: [{ id: 'delay', wait: { duration_ms: 60_000 } }],
        },
      }),
    ],
  };
}

function eventWaitTerminatedLoopGroupWorkflow(): WorkflowDefinition {
  return {
    name: 'event-wait-terminated-loop-group',
    description: 'event wait ownership must be final at first visibility',
    nodes: [
      dagNodeSchema.parse({
        id: 'grp',
        loop_group: {
          until_bash: '[ $await.output.status = "satisfied" ]',
          max_iterations: 2,
          nodes: [
            {
              id: 'await',
              wait: { event: 'checks.complete', deadline_ms: 60_000 },
            },
          ],
        },
      }),
    ],
  };
}

describe('#2707 step 3: gate-terminated loop_group pause escalation', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-gate-escalation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('pauses correctly instead of barreling through remaining iterations', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'work done' };
      yield { type: 'result', sessionId: 'work-session', cost: 0 };
    });

    const store = createEscalationStore('run-escalation-1');
    const platform = createMockPlatform();

    const emitted: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => emitted.push(event));
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: ready(gateTerminatedLoopGroupWorkflow()),
        workflowRun: makeWorkflowRun('run-escalation-1'),
      })
    );

    unsubscribe();
    // Only 'work' ran once — proves the loop did NOT barrel through remaining
    // iterations re-running the body every time the gate re-paused.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(store.getState().status).toBe('paused');

    const pauseCalls = store.pauseWorkflowRun.mock.calls;
    expect(pauseCalls).toHaveLength(1);
    const approval = pauseCalls[0][1];
    expect(store.getState().metadata.approval).toEqual(approval);
    expect(approval).toMatchObject({
      nodeId: 'grp',
      bodyGateId: 'check',
      type: 'approval',
      iteration: 1,
      pauseId: expect.any(String),
    });
    expect(emitted.find(event => event.type === 'approval_pending')).toMatchObject({
      nodeId: 'grp',
      pauseId: approval?.pauseId,
      decisions: approval?.decisions,
    });
    const groupSuspension = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as {
            event_type: string;
            step_name?: string | null;
            data?: Record<string, unknown>;
          }
      )
      .find(event => event.event_type === 'node_suspended' && event.step_name === 'grp');
    expect(groupSuspension?.data?.suspend_point).toBe('approval');
    expect(groupSuspension?.data?.cost_usd).toBe(0);
    expect(store.getState().status).toBe('paused');
  });

  it("#3532: each pause persists the paused iteration's own session, so fresh_context: false continues it", async () => {
    const workflow = ready(gateTerminatedLoopGroupWorkflow());
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'draft 1' };
      yield { type: 'result', sessionId: 'iteration-1-session' };
    });
    const firstStore = createEscalationStore('run-escalation-session');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(firstStore),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-escalation-session'),
      })
    );

    // Iteration 1 starts fresh, and its pause stores the session it just produced.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    const firstPause = firstStore.getState().metadata.approval as ApprovalContext;
    expect(firstPause).toMatchObject({ iteration: 1, sessionId: 'iteration-1-session' });
    expect(firstPause.sessionProvider).toEqual(expect.any(String));

    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'draft 2' };
      yield { type: 'result', sessionId: 'iteration-2-session' };
    });
    const revise = { decision: 'revise', text: 'tighten it' };
    const secondStore = createEscalationStore('run-escalation-session');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(secondStore),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-escalation-session', {
          metadata: { approval: firstPause },
        }),
        priorCompletedNodes: new Map<string, PersistedNodeOutput>([
          ['grp.work', { output: 'draft 1' }],
          ['grp.check', { output: JSON.stringify(revise), structuredOutput: revise }],
        ]),
      })
    );

    // Iteration 2 resumes iteration 1's session, and the next pause advances the
    // cursor to iteration 2's session instead of re-storing iteration 1's.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('iteration-1-session');
    expect(secondStore.getState().metadata.approval).toMatchObject({
      iteration: 2,
      sessionId: 'iteration-2-session',
    });
  });

  it('escalates a terminal wait and completes it from the persisted deadline on resume', async () => {
    const store = createEscalationStore('run-wait-escalation');
    const deps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps,
        platform,
        cwd: testDir,
        workflow: ready(waitTerminatedLoopGroupWorkflow()),
        workflowRun: makeWorkflowRun('run-wait-escalation'),
      })
    );

    const paused = store.getState();
    expect(paused.status).toBe('paused');
    expect(paused.metadata.wait).toMatchObject({
      nodeId: 'grp',
      bodyWaitId: 'delay',
      iteration: 1,
    });
    const groupSuspension = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as {
            event_type: string;
            step_name?: string | null;
            data?: Record<string, unknown>;
          }
      )
      .find(event => event.event_type === 'node_suspended' && event.step_name === 'grp');
    expect(groupSuspension?.data?.suspend_point).toBe('wait');
    expect(groupSuspension?.data?.cost_usd).toBeUndefined();

    const persisted = workflowWaitContextSchema.parse(paused.metadata.wait);
    const earlyStore = createEscalationStore('run-wait-escalation');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(earlyStore),
        platform,
        cwd: testDir,
        workflow: ready(waitTerminatedLoopGroupWorkflow()),
        workflowRun: makeWorkflowRun('run-wait-escalation', {
          metadata: { wait: { ...persisted, futureField: true } },
        }),
      })
    );
    const continued = earlyStore.pauseWorkflowRunForWait.mock.calls[0];
    expect(workflowWaitContextSchema.parse(continued?.[1])).toEqual(persisted);
    expect(continued?.[1]).toEqual(persisted);
    expect(continued?.[2]).toEqual({ kind: 'continued' });

    const expiredWait = {
      ...(paused.metadata.wait as WorkflowWaitContext),
      waitingSince: '2026-08-23T00:00:00.000Z',
      resumeAt: '2026-08-23T00:01:00.000Z',
    };
    const resumeRun = makeWorkflowRun('run-wait-escalation', {
      metadata: { wait: expiredWait },
    });
    const resumedStore = createEscalationStore('run-wait-escalation');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        platform,
        cwd: testDir,
        workflow: ready(waitTerminatedLoopGroupWorkflow()),
        workflowRun: resumeRun,
      })
    );

    expect(resumedStore.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(resumedStore.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  });

  it('starts a fresh wait cursor when a resumed loop advances to another iteration', async () => {
    const expiredWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'delay',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'time',
      waitingSince: '2026-08-23T00:00:00.000Z',
      resumeAt: '2026-08-23T00:01:00.000Z',
    };
    const store = createEscalationStore('run-repeating-wait');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(repeatingWaitTerminatedLoopGroupWorkflow()),
        workflowRun: makeWorkflowRun('run-repeating-wait', { metadata: { wait: expiredWait } }),
      })
    );

    expect(store.getState().status).toBe('paused');
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledTimes(1);
    expect(store.getState().metadata.wait).toMatchObject({
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'delay',
      iteration: 2,
    });
  });

  it('probes once per explicit action resume and creates a fresh loop wait cursor', async () => {
    const probeCountPath = join(testDir, 'attention-probe-count');
    const greenMarkerPath = join(testDir, 'attention-green');
    const workflow = ready(attentionTerminatedLoopGroupWorkflow(probeCountPath, greenMarkerPath));
    const initialStore = createEscalationStore('run-attention-loop');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(initialStore),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-attention-loop'),
      })
    );

    expect(await Bun.file(probeCountPath).text()).toBe('1');
    const firstWait = initialStore.getState().metadata.wait as WorkflowWaitContext;
    expect(firstWait).toMatchObject({
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'pause',
      iteration: 1,
      kind: 'attention',
      message: 'windows tests failed Re-run the check, then resume.',
    });

    const resumedStore = createEscalationStore('run-attention-loop');
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.probe', { output: '{"state":"red","detail":"windows tests failed"}' }],
    ]);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-attention-loop', { metadata: { wait: firstWait } }),
        priorCompletedNodes,
      })
    );

    expect(await Bun.file(probeCountPath).text()).toBe('2');
    expect(resumedStore.getState()).toMatchObject({
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'grp',
          bodyWaitId: 'pause',
          iteration: 2,
          kind: 'attention',
        },
      },
    });
  });

  it('keeps an attention loop resumable beyond its autonomous iteration bound', async () => {
    const probeCountPath = join(testDir, 'attention-unbounded-probe-count');
    const greenMarkerPath = join(testDir, 'attention-unbounded-green-marker');
    const workflow = ready(
      attentionTerminatedLoopGroupWorkflow(probeCountPath, greenMarkerPath, 13)
    );
    const thirteenthWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'pause',
      iteration: 13,
      sessionId: null,
      sessionProvider: null,
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'windows tests failed Re-run the check, then resume.',
    };
    const store = createEscalationStore('run-attention-unbounded');
    seedPreviousLoopGroupPass(
      store,
      'run-attention-unbounded',
      'grp',
      12,
      new Map([
        ['grp.probe', { output: '{"state":"red","detail":"windows tests failed"}' }],
        ['grp.pause', { output: '{"status":"satisfied"}' }],
      ])
    );

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-attention-unbounded', {
          metadata: { wait: thirteenthWait },
        }),
        priorCompletedNodes: new Map([
          ['grp.probe', { output: '{"state":"red","detail":"windows tests failed"}' }],
        ]),
      })
    );

    expect(await Bun.file(probeCountPath).text()).toBe('1');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'grp',
          bodyWaitId: 'pause',
          iteration: 14,
          kind: 'attention',
        },
      },
    });
  });

  it('completes an attention loop when the explicit-resume probe turns green', async () => {
    const probeCountPath = join(testDir, 'attention-green-probe-count');
    const greenMarkerPath = join(testDir, 'attention-green-marker');
    const workflow = ready(attentionTerminatedLoopGroupWorkflow(probeCountPath, greenMarkerPath));
    const firstWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'windows tests failed Re-run the check, then resume.',
    };
    await writeFile(greenMarkerPath, 'green');
    const store = createEscalationStore('run-attention-green');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('run-attention-green', { metadata: { wait: firstWait } }),
        priorCompletedNodes: new Map([
          ['grp.probe', { output: '{"state":"red","detail":"windows tests failed"}' }],
        ]),
      })
    );

    expect(await Bun.file(probeCountPath).text()).toBe('1');
    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('#2803: an included wait-resume fails loud when until_bash cannot restore its producer', async () => {
    const markerPath = join(testDir, 'included-resume-required-ref-ran.marker');
    const workflow = includedProbeWaitTerminatedLoopGroupWorkflow(markerPath);
    const group = workflow.nodes.find(node => node.id === 'deliver__await-checks');
    expect(group && !('include' in group)).toBe(true);
    if (!group || 'include' in group || group.kind !== 'loop_group') {
      throw new Error('expected the included loop_group to be expanded');
    }
    expect(group.loop_group.nodes.map(node => node.id)).toEqual(['ci-probe', 'ci-pause']);

    const expiredWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'deliver__await-checks',
      bodyWaitId: 'ci-pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'time',
      waitingSince: '2026-08-23T00:00:00.000Z',
      resumeAt: '2026-08-23T00:01:00.000Z',
    };
    const store = createEscalationStore('run-included-missing-probe');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun('run-included-missing-probe', {
          metadata: { wait: expiredWait },
        }),
        priorCompletedNodes: new Map(),
      })
    );

    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    const failed = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(
        event => event.event_type === 'node_failed' && event.step_name === 'deliver__await-checks'
      );
    expect(failed?.data?.error).toContain(
      "Node 'deliver__await-checks' field 'loop_group.until_bash' cannot resolve '$ci-probe.output.state'"
    );
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  it('#2794: an included wait-resume rechecks the restored JSON field without extra quoting', async () => {
    const markerPath = join(testDir, 'included-resume-restored-ref-ran.marker');
    const workflow = includedProbeWaitTerminatedLoopGroupWorkflow(markerPath);
    const expiredWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'deliver__await-checks',
      bodyWaitId: 'ci-pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'time',
      waitingSince: '2026-08-23T00:00:00.000Z',
      resumeAt: '2026-08-23T00:01:00.000Z',
    };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['deliver__await-checks.ci-probe', { output: '{"state":"pending"}' }],
    ]);
    const store = createEscalationStore('run-included-restored-probe');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun('run-included-restored-probe', {
          metadata: { wait: expiredWait },
        }),
        priorCompletedNodes,
      })
    );

    expect(await Bun.file(markerPath).exists()).toBe(true);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      status: 'paused',
      metadata: {
        wait: {
          nodeId: 'deliver__await-checks',
          bodyWaitId: 'ci-pause',
          iteration: 2,
        },
      },
    });
  });

  it('#2794: double-quoting the already shell-quoted JSON field reproduces the incident', async () => {
    const markerPath = join(testDir, 'included-resume-double-quoted-ref-ran.marker');
    const workflow = includedProbeWaitTerminatedLoopGroupWorkflow(markerPath, true);
    const expiredWait: WorkflowWaitContext = {
      owner: 'loop_group',
      nodeId: 'deliver__await-checks',
      bodyWaitId: 'ci-pause',
      iteration: 1,
      sessionId: null,
      sessionProvider: null,
      kind: 'time',
      waitingSince: '2026-08-23T00:00:00.000Z',
      resumeAt: '2026-08-23T00:01:00.000Z',
    };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['deliver__await-checks.ci-probe', { output: '{"state":"pending"}' }],
    ]);
    const store = createEscalationStore('run-included-double-quoted-probe');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun('run-included-double-quoted-probe', {
          metadata: { wait: expiredWait },
        }),
        priorCompletedNodes,
      })
    );

    expect(await Bun.file(markerPath).exists()).toBe(true);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
  });

  it('keeps loop ownership when an event signal lands before the pause call returns', async () => {
    const store = createEscalationStore('run-immediate-signal', wait => ({
      ...wait,
      signaledAt: new Date().toISOString(),
    }));

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(eventWaitTerminatedLoopGroupWorkflow()),
        workflowRun: makeWorkflowRun('run-immediate-signal'),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledTimes(1);
    expect(store.getState().metadata.wait).toMatchObject({
      owner: 'loop_group',
      nodeId: 'grp',
      bodyWaitId: 'await',
      iteration: 1,
      signaledAt: expect.any(String),
    });
  });

  it('resuming after "approve" completes the group without re-running the body', async () => {
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should not run' };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });

    const store = createEscalationStore('run-escalation-2');
    const platform = createMockPlatform();
    const approvedDecision = { decision: 'approve', text: '' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      [
        'grp.check',
        { output: JSON.stringify(approvedDecision), structuredOutput: approvedDecision },
      ],
    ]);
    const workflowRun = makeWorkflowRun('run-escalation-2', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: ready(gateTerminatedLoopGroupWorkflow()),
        workflowRun,
        priorCompletedNodes,
      })
    );

    // No fresh iteration ran — the resumed iteration's completion was decided
    // from the reconstructed data, not by re-running the body.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect(
      (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock.calls.length
    ).toBe(1);

    const completedEvents = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls
      .map(call => call[0])
      .filter(data => data.event_type === 'node_completed' && data.step_name === 'grp');
    expect(completedEvents.length).toBe(1);
    // until_bash read the answer; the group's output is still the work (#4043).
    expect(completedEvents[0].data?.node_output).toBe('work output');
    expect(completedEvents[0].data?.structured_output).toBeUndefined();
  });

  it('#4164: resumed loop_group.until_bash receives named inputs', async () => {
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should not run' };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });

    const store = createEscalationStore('run-escalation-2');
    const platform = createMockPlatform();
    const approvedDecision = { decision: 'approve', text: '' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      [
        'grp.check',
        { output: JSON.stringify(approvedDecision), structuredOutput: approvedDecision },
      ],
    ]);
    const workflowRun = makeWorkflowRun('run-escalation-2', {
      metadata: {
        inputs: { target: 'done' },
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });

    const workflow = gateTerminatedLoopGroupWorkflow();
    workflow.inputs = { target: { required: true } };
    const group = workflow.nodes[0];
    if (group?.kind !== 'loop_group') throw new Error('expected group');
    group.loop_group.until_bash = '[ "$INPUTS_TARGET" = done ]';

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun,
        priorCompletedNodes,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect(
      (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock.calls.length
    ).toBe(1);
  });

  it('resuming after a non-completing decision advances to a fresh iteration, with the text available via $LOOP_PREV', async () => {
    mockSendQueryDag.mockClear();
    let seenPrompt: string | undefined;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      seenPrompt = prompt;
      yield { type: 'agent_message_chunk', text: 'revised work' };
      yield { type: 'result', sessionId: 'revised-session' };
    });

    const store = createEscalationStore('run-escalation-3');
    const platform = createMockPlatform();
    const revisedDecision = { decision: 'revise', text: 'please improve X' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      ['grp.check', { output: JSON.stringify(revisedDecision), structuredOutput: revisedDecision }],
    ]);
    const workflowRun = makeWorkflowRun('run-escalation-3', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: ready(gateTerminatedLoopGroupWorkflow()),
        workflowRun,
        priorCompletedNodes,
      })
    );

    // A genuinely fresh iteration 2 ran (the "revise" decision did not satisfy
    // until_bash), seeded with the human's feedback via the ordinary $LOOP_PREV
    // channel — not the retired $LOOP_USER_INPUT.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(seenPrompt).toContain('please improve X');
  });

  it('#4290: a non-completing decision at max_iterations fails instead of running past the cap', async () => {
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should not run' };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });

    const store = createEscalationStore('run-escalation-at-cap');
    const revisedDecision = { decision: 'revise', text: 'please improve X' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      ['grp.check', { output: JSON.stringify(revisedDecision), structuredOutput: revisedDecision }],
    ]);
    const workflow = gateTerminatedLoopGroupWorkflow();
    const group = workflow.nodes[0];
    if (group?.kind !== 'loop_group') throw new Error('expected group');
    group.loop_group.max_iterations = 1;
    // Feedback on an interactive_loop gate buys one more iteration; the flag must not
    // leak that allowance to a body approval gate, whose cap stays autonomous.
    const workflowRun = makeWorkflowRun('run-escalation-at-cap', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
        loop_feedback_given: true,
      },
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun,
        priorCompletedNodes,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect(store.persistWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'node_failed',
        step_name: 'grp',
        data: expect.objectContaining({ failure_kind: 'max_iterations' }),
      })
    );
  });

  it('resume completion recheck resolves an outer-DAG ref inside until_bash, not just the gate decision', async () => {
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should not run' };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });

    const store = createEscalationStore('run-escalation-5');
    const platform = createMockPlatform();
    const approvedDecision = { decision: 'approve', text: '' };
    // 'outer' is a bare top-level id (not namespaced) — it reaches the resumed
    // until_bash only via outerNodeOutputs, exactly the path the merge fix covers.
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['outer', { output: 'ok' }],
      ['grp.work', { output: 'work output' }],
      [
        'grp.check',
        { output: JSON.stringify(approvedDecision), structuredOutput: approvedDecision },
      ],
    ]);
    const workflowRun = makeWorkflowRun('run-escalation-5', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });

    const outerRefWorkflow: WorkflowDefinition = {
      ...gateTerminatedLoopGroupWorkflow(),
      nodes: [
        dagNodeSchema.parse({ id: 'outer', bash: 'echo ok' }),
        dagNodeSchema.parse({
          id: 'grp',
          depends_on: ['outer'],
          loop_group: {
            // Combines an outer-scope ref with the gate's own decision — the
            // outer ref only resolves if resumedScope includes outerNodeOutputs.
            until_bash: '[ $outer.output = "ok" ] && [ $check.output.decision = "approve" ]',
            max_iterations: 5,
            nodes: [
              { id: 'work', prompt: 'do work' },
              {
                id: 'check',
                depends_on: ['work'],
                approval: {
                  message: 'Continue?',
                  decisions: [{ id: 'approve' }, { id: 'revise' }],
                },
              },
            ],
          },
        }),
      ],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
        workflow: ready(outerRefWorkflow),
        workflowRun,
        priorCompletedNodes,
      })
    );

    // No fresh iteration ran — the outer ref resolved correctly on resume, so
    // until_bash saw both halves satisfied and completed without re-running the body.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect(
      (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock.calls.length
    ).toBe(1);
  });

  it("retains the resumed until_bash probe under the resumed iteration's own key (#2967)", async () => {
    // The resume branch runs its own probe, separate from the per-iteration one, and
    // it is the only exec site in a run that completes straight off a human's answer.
    // `iteration: 2` in the gate context makes the label discriminating: the resumed
    // iteration is 2, while a fresh one would be 3 and a hardcoded fallback would be 1.
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should not run' };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });

    const logDir = join(testDir, 'resume-probe-logs');
    const store = createEscalationStore('run-escalation-retention');
    const platform = createMockPlatform();
    const approvedDecision = { decision: 'approve', text: '' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      [
        'grp.check',
        { output: JSON.stringify(approvedDecision), structuredOutput: approvedDecision },
      ],
    ]);
    seedPreviousLoopGroupPass(store, 'run-escalation-retention', 'grp', 1, priorCompletedNodes);
    const workflowRun = makeWorkflowRun('run-escalation-retention', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 2,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });

    const talkativeProbeWorkflow: WorkflowDefinition = {
      ...gateTerminatedLoopGroupWorkflow(),
      nodes: [
        dagNodeSchema.parse({
          id: 'grp',
          timeout: 600_000,
          loop_group: {
            until_bash:
              'printf "resume probe ran\\n"; printf "recheck note\\n" >&2; [ $check.output.decision = "approve" ]',
            max_iterations: 5,
            nodes: [
              { id: 'work', prompt: 'do work' },
              {
                id: 'check',
                depends_on: ['work'],
                approval: {
                  message: 'Continue?',
                  decisions: [{ id: 'approve' }, { id: 'revise' }],
                },
              },
            ],
          },
        }),
      ],
    };

    const execSpy = spyOn(git, 'execFileAsync');
    let resumeProbeTimeout: number | undefined;
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          cwd: testDir,
          workflow: ready(talkativeProbeWorkflow),
          workflowRun,
          logDir,
          priorCompletedNodes,
        })
      );
      const resumeProbe = execSpy.mock.calls.find(call =>
        call[2]?.input?.includes('resume probe ran')
      );
      resumeProbeTimeout = resumeProbe?.[2]?.timeout;
    } finally {
      execSpy.mockRestore();
    }

    expect(resumeProbeTimeout).toBe(600_000);

    // Zero provider calls means no fresh iteration ran, so the single retained row
    // below can only have come from the resume branch's probe — not the ordinary
    // per-iteration site, which would have needed a body execution first.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    const probeRows = (await readTranscript(logDir, workflowRun.id)).filter(
      row => row.type === 'exec_output'
    );
    expect(probeRows).toHaveLength(1);
    expect(probeRows[0].step).toBe('grp-iteration-2');
    expect(probeRows[0].content).toBe('<until_bash>');
    expect(probeRows[0].stdout_tail).toBe('resume probe ran');
    expect(probeRows[0].stderr_tail).toBe('recheck note');
    expect(probeRows[0].exit_code).toBe(0);
  });

  it('passes no deadline to the resumed until_bash probe when the group declares no timeout', async () => {
    mockSendQueryDag.mockClear();
    const store = createEscalationStore('run-escalation-no-timeout');
    const approvedDecision = { decision: 'approve', text: '' };
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['grp.work', { output: 'work output' }],
      [
        'grp.check',
        { output: JSON.stringify(approvedDecision), structuredOutput: approvedDecision },
      ],
    ]);
    const workflowRun = makeWorkflowRun('run-escalation-no-timeout', {
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          iteration: 1,
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        } satisfies ApprovalContext,
      },
    });
    const undeclaredWorkflow: WorkflowDefinition = {
      ...gateTerminatedLoopGroupWorkflow(),
      nodes: [
        dagNodeSchema.parse({
          id: 'grp',
          loop_group: {
            until_bash: 'echo UNDECLARED; [ $check.output.decision = "approve" ]',
            max_iterations: 5,
            nodes: [
              { id: 'work', prompt: 'do work' },
              {
                id: 'check',
                depends_on: ['work'],
                approval: {
                  message: 'Continue?',
                  decisions: [{ id: 'approve' }, { id: 'revise' }],
                },
              },
            ],
          },
        }),
      ],
    };

    const execSpy = spyOn(git, 'execFileAsync');
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: ready(undeclaredWorkflow),
          workflowRun,
          priorCompletedNodes,
        })
      );
      const resumeProbe = execSpy.mock.calls.find(call => call[2]?.input?.includes('UNDECLARED'));
      expect(resumeProbe).toBeDefined();
      expect(resumeProbe?.[2]?.timeout).toBeUndefined();
    } finally {
      execSpy.mockRestore();
    }
    // No fresh iteration ran, so the probe above came from the resume branch.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });
});

// A pause asks about the work; it is not the work. The group's output reads past it
// to the nodes it depends on, while `until_bash` and `$LOOP_PREV.<pause>.output`
// keep reading the answer (#4043).
describe('executeDagWorkflow -- loop_group output with a pause sink (#4043)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-pause-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function groupCompletion(store: MockWorkflowStore): Record<string, unknown> | undefined {
    return store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.event_type === 'node_completed' && event.step_name === 'grp')?.data;
  }

  function loopGroupWorkflow(nodes: unknown[], untilBash = 'true'): WorkflowDefinition {
    return {
      name: 'loop-group-output',
      description: 'loop_group output selection',
      nodes: [
        dagNodeSchema.parse({
          id: 'grp',
          loop_group: { until_bash: untilBash, max_iterations: 1, nodes },
        }),
      ],
    };
  }

  it('a skipped approval gate leaves the work as the group output', async () => {
    const store = createEscalationStore('run-skipped-gate');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(
          loopGroupWorkflow(
            [
              { id: 'work', bash: "printf 'the plan'" },
              {
                id: 'ask',
                depends_on: ['work'],
                when: "$work.output == 'blocked'",
                approval: { message: 'Unblock?' },
              },
            ],
            'test $work.output != blocked'
          )
        ),
        workflowRun: makeWorkflowRun('run-skipped-gate'),
      })
    );

    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(groupCompletion(store)?.node_output).toBe('the plan');
  });

  it('a skipped attention wait leaves the work as the group output', async () => {
    const greenMarkerPath = join(testDir, 'green');
    await writeFile(greenMarkerPath, 'green');
    const store = createEscalationStore('run-skipped-attention');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(
          attentionTerminatedLoopGroupWorkflow(join(testDir, 'probe-count'), greenMarkerPath)
        ),
        workflowRun: makeWorkflowRun('run-skipped-attention'),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(groupCompletion(store)?.node_output).toBe('{"state":"concluded","detail":"green"}');
  });

  it('an answered attention wait leaves the work as the group output', async () => {
    const store = createEscalationStore('run-answered-attention');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(
          attentionTerminatedLoopGroupWorkflow(join(testDir, 'probe-count'), join(testDir, 'green'))
        ),
        workflowRun: makeWorkflowRun('run-answered-attention', {
          metadata: {
            wait: {
              owner: 'loop_group',
              nodeId: 'grp',
              bodyWaitId: 'pause',
              iteration: 1,
              sessionId: null,
              sessionProvider: null,
              kind: 'attention',
              waitingSince: '2026-08-24T10:00:00.000Z',
              message: 'Re-run the check, then resume.',
            } satisfies WorkflowWaitContext,
          },
        }),
        priorCompletedNodes: new Map([
          ['grp.probe', { output: '{"state":"concluded","detail":"rerun"}' }],
        ]),
      })
    );

    // The restored probe satisfied until_bash on the resume recheck: no fresh iteration.
    expect(await Bun.file(join(testDir, 'probe-count')).exists()).toBe(false);
    expect(groupCompletion(store)?.node_output).toBe('{"state":"concluded","detail":"rerun"}');
  });

  it('a group without a pause sink still takes its output from its terminal sink', async () => {
    const store = createEscalationStore('run-no-pause');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(
          loopGroupWorkflow([
            { id: 'work', bash: "printf 'draft'" },
            { id: 'polish', depends_on: ['work'], bash: "printf 'final'" },
          ])
        ),
        workflowRun: makeWorkflowRun('run-no-pause'),
      })
    );

    expect(groupCompletion(store)?.node_output).toBe('final');
  });
});
