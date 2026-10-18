// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  ready,
  makeOutput,
  makeWorkflowRun,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { substituteLoopBodyText, type LoopBodyScope } from '../../references';
import type { DagNode, NodeOutput } from '../../../schemas';
import { dagNodeSchema, workflowDefinitionSchema } from '../../../schemas';
import { OutputRefError } from '../../../output-ref';
import type { IWorkflowStore } from '../../../store';

describe('executeDagWorkflow -- loop_group node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-loopgroup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('exhausts loop_group iterations after a negated final until signal', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: 'The task is not DONE' };
      yield { type: 'result', sessionId: `lg-sess-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-loopgroup-maxiter');

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work until it is done' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'dag-loopgroup-maxiter', nodes },
        workflowRun,
      })
    );

    expect(mockDeps.store.persistWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: workflowRun.id,
      event_type: 'node_failed',
      step_name: 'fixer',
      data: expect.objectContaining({
        type: 'loop_group',
        aggregate: true,
        failure_kind: 'max_iterations',
        error: expect.stringContaining("Loop-group node 'fixer' exceeded max iterations (2)"),
      }),
    });
    // The negated prose does not complete the group, so it exhausts max_iterations.
    expect(callCount).toBe(2);
    expect(result).toBeUndefined();
    expect(mockDeps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockDeps.store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('INSTANCE 1: multi-node body (implement→test→review) completes on iteration 2', async () => {
    // The body has 3 nodes; only `review` is AI (calls sendQuery). implement+test are
    // bash. On iteration 1 review does NOT emit DONE; on iteration 2 it does.
    let reviewCalls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      reviewCalls++;
      const content =
        reviewCalls === 1 ? 'tests still failing, need another pass' : 'all tests green now\nDONE';
      yield { type: 'agent_message_chunk', text: content };
      yield { type: 'result', sessionId: `review-sess-${reviewCalls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multinode');

    const nodes: DagNode[] = [
      {
        id: 'fix-loop',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'implement',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "editing files"',
              depends_on: [],
            },
            {
              id: 'test',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "running tests"',
              depends_on: ['implement'],
            },
            {
              id: 'review',
              kind: 'agent',
              source: {
                kind: 'inline',
                prompt: 'Review the test results. Emit DONE only when all tests pass.',
              },
              depends_on: ['test'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-multinode', nodes },
        workflowRun,
      })
    );

    // 2 iterations (review called once per iteration); DONE on iteration 2.
    expect(reviewCalls).toBe(2);
    expect(result).toContain('all tests green now');
  });

  it('overwrites the persisted-output spill file per iteration, keyed by the shared step_name (#2726)', async () => {
    // A loop_group body node's step_name is the SAME across every iteration
    // (stepNamePrefix + node.id, no iteration suffix) -- formatPersistedNodeOutput's
    // spill file is therefore keyed identically each iteration too, by design (see its
    // doc comment). This test proves that design empirically: each iteration's own DB
    // row keeps ITS OWN preview text frozen at write time, but the shared spill file on
    // disk ends the run holding only the LATEST iteration's full bytes -- which is
    // correct, because getDagResumeSnapshot's completedNodeOutputs map is itself
    // last-write-wins per step_name, so only the latest row (and therefore the latest
    // spill content) is ever actually consulted on resume.
    const counterFile = join(testDir, 'lg-spill-counter');
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;
    const artifactsDir = join(testDir, 'artifacts');

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-spill-overwrite');

    const nodes: DagNode[] = [
      {
        id: 'group',
        kind: 'loop_group',
        loop_group: {
          until_bash: `test "$(cat ${counterRef})" -ge 2`,
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'emit',
              kind: 'exec',
              runtime: 'sh',
              script: `n=$(cat ${counterRef} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counterRef}; if [ "$n" = "1" ]; then printf '%40000s' '' | tr ' ' a; else printf '%40000s' '' | tr ' ' b; fi`,
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg-spill',
        cwd: testDir,
        workflow: { name: 'lg-spill-overwrite', nodes },
        workflowRun,
        artifactsDir,
      })
    );

    expect((await readFile(counterFile, 'utf8')).trim()).toBe('2');

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const emitEvents = eventCalls.filter(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'group.emit'
    );
    expect(emitEvents).toHaveLength(2);
    const [iter1, iter2] = emitEvents.map(
      call => (call[0] as { data: { node_output: string; node_output_spill_path: string } }).data
    );
    // Each row's OWN preview reflects its OWN iteration's content -- frozen at write time.
    expect(iter1.node_output.startsWith('a')).toBe(true);
    expect(iter2.node_output.startsWith('b')).toBe(true);
    // Both rows point at the SAME spill path, by design.
    expect(iter1.node_output_spill_path).toBe(iter2.node_output_spill_path);
    expect(iter1.node_output_spill_path).toBe(
      join(artifactsDir, '.archon', 'node-output-spills', 'persisted', 'group.emit.nodeoutput')
    );
    // The file on disk, after the run, holds only the LATEST iteration's content.
    const finalSpillContent = await readFile(iter1.node_output_spill_path, 'utf8');
    expect(finalSpillContent).toBe('b'.repeat(40_000));
  });

  it("until_bash observes the typed artifacts its own iteration's body published", async () => {
    const counterFile = join(testDir, 'lg-typed-counter');
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-lg-typed',
        cwd: testDir,
        workflow: {
          name: 'lg-typed-until',
          nodes: [
            {
              id: 'group',
              kind: 'loop_group',
              loop_group: {
                // Stops as soon as the listing names a `verdict` artifact. The body
                // publishes one in iteration 1, so iteration 1's condition must see it.
                until_bash: 'grep -q \'"verdict"\' "${TYPED_ARTIFACTS_FILE}"',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'judge',
                    kind: 'exec',
                    runtime: 'sh',
                    script: `n=$(cat ${counterRef} 2>/dev/null || echo 0); echo $((n+1)) > ${counterRef}; echo ok`,
                    output_type: 'verdict',
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('lg-typed-until'),
        artifactsDir: join(testDir, 'artifacts'),
      })
    );

    expect((await readFile(counterFile, 'utf8')).trim()).toBe('1');
  });

  it('until_bash receives the same reserved environment as an exec node', async () => {
    const counterFile = join(testDir, 'lg-env-counter');
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        conversationId: 'conv-lg-env',
        cwd: testDir,
        workflow: {
          name: 'lg-env-until',
          nodes: [
            {
              id: 'group',
              kind: 'loop_group',
              loop_group: {
                // Braced forms bypass engine substitution, so this reads the process
                // environment a script launched from the condition would see.
                until_bash: 'test "${WORKFLOW_ID}" = lg-env-until && test -d "${ARTIFACTS_DIR}"',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'tick',
                    kind: 'exec',
                    runtime: 'sh',
                    script: `n=$(cat ${counterRef} 2>/dev/null || echo 0); echo $((n+1)) > ${counterRef}`,
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('lg-env-until'),
        artifactsDir: join(testDir, 'artifacts'),
      })
    );

    expect((await readFile(counterFile, 'utf8')).trim()).toBe('1');
  });

  it('INSTANCE 2: $LOOP_PREV cross-iteration ref sees prior iteration output', async () => {
    // The body prompt references $LOOP_PREV.work.output. We assert the mock receives a
    // prompt that contains the PREVIOUS iteration's output on iteration 2+ (and empty
    // on iteration 1). Iteration 1 returns "iter-1-draft"; iteration 2's prompt must
    // contain "iter-1-draft" (carried via $LOOP_PREV), and iteration 2 emits DONE.
    let callCount = 0;
    const receivedPrompts: string[] = [];
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      callCount++;
      receivedPrompts.push(prompt ?? '');
      const content = callCount === 1 ? 'iter-1-draft' : 'iter-2-final\nDONE';
      yield { type: 'agent_message_chunk', text: content };
      yield { type: 'result', sessionId: `s-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-loopprev');

    const nodes: DagNode[] = [
      {
        id: 'draft-loop',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: {
                kind: 'inline',
                prompt:
                  'Previous draft:\n$LOOP_PREV.work.output\nImprove it. Emit DONE when final.',
              },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-loopprev', nodes },
        workflowRun,
      })
    );

    // Iteration 1 prompt: $LOOP_PREV resolved to '' (no prior iteration).
    expect(callCount).toBeGreaterThanOrEqual(1);
    // The first prompt must NOT carry the prior output (there is none).
    expect(receivedPrompts[0]).not.toContain('iter-1-draft');
    // Iteration 2 prompt MUST carry iteration 1's output via $LOOP_PREV.
    expect(callCount).toBe(2);
    expect(receivedPrompts[1]).toContain('iter-1-draft');
  });

  it('substitutes $LOOP_PREV in a body node-local with: binding, like every other body surface (#2637)', async () => {
    // The two features compose: a body script binds the PREVIOUS iteration's output
    // by name ($LOOP_PREV — text semantics, '' on iteration 1) beside a
    // current-iteration sibling ref. Before the fix the $LOOP_PREV string survived
    // substitution as the literal token and landed in the env silently.
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      yield { type: 'agent_message_chunk', text: callCount === 1 ? 'draft-1' : 'DONE' };
      yield { type: 'result', sessionId: `s-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const workflowRun = makeWorkflowRun('lg-binding-loopprev');
    const nodes: DagNode[] = [
      {
        id: 'grp',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'gen',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Draft or DONE.' },
              depends_on: [],
            },
            {
              id: 'consume',
              kind: 'exec',
              script: [
                "const prev = process.env.INPUTS_PREV ?? 'unset';",
                "const now = process.env.INPUTS_NOW ?? 'unset';",
                'console.log(`prev=[${prev}] now=[${now}]`);',
                "if (now === 'DONE') console.log('DONE');",
              ].join('\n'),
              runtime: 'bun',
              depends_on: ['gen'],
              with: { prev: '$LOOP_PREV.gen.output', now: '$gen.output' },
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-binding-loopprev', nodes },
        workflowRun,
      })
    );

    const consumeRows = (
      mockDeps.store.createWorkflowEvent as Mock<
        (e: {
          event_type: string;
          step_name: string;
          data: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls
      .filter(c => c[0].event_type === 'node_completed' && c[0].step_name === 'grp.consume')
      .map(c => c[0].data);
    expect(consumeRows.length).toBe(2);
    // Iteration 1: no prior iteration — $LOOP_PREV is '', never the literal token.
    expect(consumeRows[0].node_output).toContain('prev=[] now=[draft-1]');
    // Iteration 2: the previous gen output, delivered by name through the env.
    expect(consumeRows[1].node_output).toContain('prev=[draft-1] now=[DONE]');
  });

  it('reads oversized $LOOP_PREV output from the run-owned spill directory', async () => {
    const artifactsDir = join(testDir, 'loop-prev-artifacts');
    const logDir = join(testDir, 'loop-prev-logs');
    const largeOutput = 'x'.repeat(33_000);
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-large-loopprev');

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: {
          name: 'lg-large-loopprev',
          nodes: [
            {
              id: 'draft-loop',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'work',
                    kind: 'exec',
                    runtime: 'sh',
                    script:
                      'previous=$LOOP_PREV.work.output; ' +
                      'if [ -z "$previous" ]; then head -c 33000 /dev/zero | tr "\\0" x; ' +
                      'else printf "%s\\nDONE\\n" "${#previous}"; fi',
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun,
        artifactsDir,
        logDir,
      })
    );

    expect(result).toContain('33000');
    expect(
      await readFile(
        join(artifactsDir, '.archon', 'node-output-spills', 'work.nodeoutput'),
        'utf-8'
      )
    ).toBe(largeOutput);
    expect(await Bun.file(join(logDir, 'work.nodeoutput')).exists()).toBe(false);
  });

  it('until_bash reads oversized current body output from the run-owned spill directory', async () => {
    // No `until` signal from AI; completion is decided solely by until_bash exit code.
    // The body emits an oversized value and the completion check proves byte-complete
    // readback through the same substitution path used in production.
    const artifactsDir = join(testDir, 'group-until-artifacts');
    const logDir = join(testDir, 'group-until-logs');
    const largeOutput = 'x'.repeat(33_000);
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-untilbash');

    const nodes: DagNode[] = [
      {
        id: 'bash-loop',
        kind: 'loop_group',
        loop_group: {
          // No `until` at all (#2563). Before that the schema forced a decoy signal
          // here; a pure-bash body emits no model text, so declaring one described a
          // channel that could never fire.
          max_iterations: 2,
          fresh_context: false,
          until_bash: 'value=$bump.output; test "${#value}" -eq 33000',
          nodes: [
            {
              id: 'bump',
              kind: 'exec',
              runtime: 'sh',
              script: 'head -c 33000 /dev/zero | tr "\\0" x',
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-untilbash', nodes },
        workflowRun,
        artifactsDir,
        logDir,
      })
    );

    expect(result).toBe(largeOutput);
    expect(
      await readFile(
        join(artifactsDir, '.archon', 'node-output-spills', 'bump.nodeoutput'),
        'utf-8'
      )
    ).toBe(largeOutput);
    expect(await Bun.file(join(logDir, 'bump.nodeoutput')).exists()).toBe(false);
  });

  it('#2803: loop_group until_bash fails when a direct whole-output producer was skipped', async () => {
    const store = createMockStore();
    const markerPath = join(testDir, 'group-required-ref-ran.marker');
    const workflow = workflowDefinitionSchema.parse({
      name: 'group-required-output-ref',
      description: 'A group must not decide completion from a skipped body producer',
      nodes: [
        {
          id: 'poll',
          loop_group: {
            until_bash: `printf ran > ${JSON.stringify(markerPath)}; test $probe.output != pending`,
            max_iterations: 1,
            nodes: [
              { id: 'gate', bash: "printf 'skip'" },
              {
                id: 'probe',
                bash: "printf 'pending'",
                depends_on: ['gate'],
                when: "$gate.output == 'run'",
              },
            ],
          },
        },
      ],
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun('group-required-output-ref'),
      })
    );

    const failed = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.event_type === 'node_failed' && event.step_name === 'poll');
    expect(failed?.data?.error).toContain(
      "Node 'poll' field 'loop_group.until_bash' cannot resolve '$probe.output'"
    );
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  it('INSTANCE 4: single-node body degenerates like loop: and completes in 1 iteration', async () => {
    // A loop_group with a single prompt node that emits DONE on the very first iteration.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'done immediately\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-single');

    const nodes: DagNode[] = [
      {
        id: 'once',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'only',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do it, emit DONE' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-single', nodes },
        workflowRun,
      })
    );

    // Single iteration, completed immediately.
    expect(calls).toBe(1);
    expect(result).toContain('done immediately');
  });

  // --- Edge cases ---

  it('EDGE A: a failed body node fails the group immediately with the real error', async () => {
    // A body node failure must NOT silently re-run the body until max_iterations —
    // that burns AI cost per iteration and buries the root cause under a generic
    // max-iterations message (the exact anti-pattern executeLoopNode already fixed).
    // The group fails fast, surfacing the failed body node's own error.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      throw new Error('body node exploded');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-body-fail');

    const nodes: DagNode[] = [
      {
        id: 'flaky',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-body-fail', nodes },
        workflowRun,
      })
    );

    // Fail-fast: exactly ONE iteration ran — no burn-to-max_iterations.
    expect(calls).toBe(1);
    // Run failed → no terminal output returned to the outer DAG.
    expect(result).toBeUndefined();
    // The user-facing failure surfaced the body node's real error, not a
    // generic max-iterations message.
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('body node exploded');
    expect(sent).not.toContain('exceeded max iterations');
  });

  it('EDGE B: body prompt can reference an outer-DAG upstream node via $nodeId.output', async () => {
    // The loop_group depends_on an outer bash node `setup`. The body prompt references
    // $setup.output. outerNodeOutputs is seeded into the scoped map, so the ref resolves.
    let receivedPrompt = '';
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      receivedPrompt = prompt ?? '';
      yield { type: 'agent_message_chunk', text: 'saw setup output\nDONE' };
      yield { type: 'result', sessionId: 's' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-outer-dep');

    const nodes: DagNode[] = [
      {
        id: 'setup',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo "setup-context-123"',
        depends_on: [],
      },
      {
        id: 'consumer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: {
                kind: 'inline',
                prompt: 'Outer setup said: $setup.output\nNow act on it. Emit DONE.',
              },
              depends_on: [],
            },
          ],
        },
        depends_on: ['setup'],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-outer-dep', nodes },
        workflowRun,
      })
    );

    // The body prompt received the outer node's output (seeded into the scoped map).
    expect(receivedPrompt).toContain('setup-context-123');
    // Completed in 1 iteration (signal emitted immediately).
    expect(result).toContain('saw setup output');
  });

  it('EDGE F: $LOOP_PREV.<id>.output.<field> resolves structured prior-iteration output (unit)', () => {
    // Unit-level: $LOOP_PREV field access against a structured NodeOutput.
    const prev = new Map<string, NodeOutput>([
      ['work', makeOutput('completed', '', { status: 'green', count: 7 }, ['status', 'count'])],
    ]);
    // Field access resolves from structuredOutput.
    expect(
      substituteLoopBodyText('status=$LOOP_PREV.work.output.status', [{ loopPrevOutputs: prev }])
    ).toBe('status=green');
    expect(
      substituteLoopBodyText('count=$LOOP_PREV.work.output.count', [{ loopPrevOutputs: prev }])
    ).toBe('count=7');
    // Whole-output form still works (returns the raw output string, here '').
    expect(
      substituteLoopBodyText('all=[$LOOP_PREV.work.output]', [{ loopPrevOutputs: prev }])
    ).toBe('all=[]');
  });

  it('EDGE F: resolves the complete nested prior-iteration path', () => {
    const prev = new Map<string, NodeOutput>([
      ['work', makeOutput('completed', '', { result: { status: { value: 'green' } } })],
    ]);

    expect(
      substituteLoopBodyText('$LOOP_PREV.work.output.result.status.value', [
        { loopPrevOutputs: prev },
      ])
    ).toBe('green');
  });

  it('EDGE F: $LOOP_PREV.<id>.output.<field> on a missing prior node resolves to empty', () => {
    // The referenced node wasn't in the prior iteration (skipped/absent) → '' not a throw.
    // Raw call (no knownBodyIds set) stays fully lenient — the typo check only engages when
    // the static body-id set is threaded in via the executor path.
    const prev = new Map<string, NodeOutput>([['work', makeOutput('completed', 'ran', undefined)]]);
    expect(
      substituteLoopBodyText('other=[$LOOP_PREV.absent.output.field]', [{ loopPrevOutputs: prev }])
    ).toBe('other=[]');
  });

  it('EDGE F (#2142): a loop scope classifies absent refs by the two body-id sets', () => {
    // Iteration-1 posture: no prior outputs yet. `knownBodyIds` is the TRANSITIVE set
    // (this group + nested descendants); `directBodyIds` is only this group's immediate ids.
    // Group body: { grader, work, refine(nested group) }; refine's inner body: { polish }.
    const knownBodyIds = new Set(['grader', 'work', 'refine', 'polish']);
    const directBodyIds = new Set(['grader', 'work', 'refine']);

    // Typo: `grrader` matches no body node → OutputRefError('unknown-node') + did-you-mean.
    let caught: unknown;
    try {
      substituteLoopBodyText('score=$LOOP_PREV.grrader.output.score', [
        { loopPrevOutputs: undefined, knownBodyIds, directBodyIds },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('unknown-node');
    expect((caught as OutputRefError).message).toContain("'grader'"); // did-you-mean names the near miss

    // Direct body id with no prior-iteration output (iteration 1) → '' (legitimate absence).
    expect(
      substituteLoopBodyText('score=$LOOP_PREV.grader.output.score', [
        { loopPrevOutputs: undefined, knownBodyIds, directBodyIds },
      ])
    ).toBe('score=');

    // Nested-owned id (`polish` ∈ known, ∉ direct): token left INTACT so the inner
    // loop_group resolves it against its OWN prior-iteration snapshot later. Both the
    // `.field` and whole-text forms are preserved.
    expect(
      substituteLoopBodyText('draft=[$LOOP_PREV.polish.output.draft]', [
        { loopPrevOutputs: undefined, knownBodyIds, directBodyIds },
      ])
    ).toBe('draft=[$LOOP_PREV.polish.output.draft]');
    expect(
      substituteLoopBodyText('whole=[$LOOP_PREV.polish.output]', [
        { loopPrevOutputs: undefined, knownBodyIds, directBodyIds },
      ])
    ).toBe('whole=[$LOOP_PREV.polish.output]');

    // Whole-text `$LOOP_PREV.<id>.output` to an unknown id stays lenient (no throw), even
    // with the set — mirrors substituteNodeOutputRefs' lenient whole-text surface.
    expect(
      substituteLoopBodyText('all=$LOOP_PREV.grrader.output', [
        { loopPrevOutputs: undefined, knownBodyIds, directBodyIds },
      ])
    ).toBe('all=');

    // Bash-escaped mode throws too (the typo would otherwise become an empty shell literal).
    expect(() =>
      substituteLoopBodyText(
        'echo $LOOP_PREV.grrader.output.score',
        [{ loopPrevOutputs: undefined, knownBodyIds, directBodyIds }],
        'shell'
      )
    ).toThrow(OutputRefError);

    // Raw caller with NO sets → fully lenient (pre-#2142 behavior): unknown id .field → ''.
    expect(
      substituteLoopBodyText('x=[$LOOP_PREV.grrader.output.score]', [
        { loopPrevOutputs: undefined },
      ])
    ).toBe('x=[]');
  });

  it('EDGE F (#2142): an outer scope throws on a typo and leaves a nested-owned ref to the inner scope', () => {
    // The executor path threads the transitive `knownBodyIds` and immediate `directBodyIds`.
    // Simulate the OUTER group's iteration-1 scope (no prior outputs). Outer body =
    // { review, refine(nested group) }; refine's inner body = { polish }.
    const outer: LoopBodyScope = {
      loopPrevOutputs: undefined,
      loopUserInput: '',
      knownBodyIds: new Set(['review', 'refine', 'polish']),
      directBodyIds: new Set(['review', 'refine']),
    };
    const inner: LoopBodyScope = {
      loopPrevOutputs: new Map([['polish', makeOutput('completed', '{"draft":"D1"}')]]),
      loopUserInput: '',
      knownBodyIds: new Set(['polish']),
      directBodyIds: new Set(['polish']),
    };

    // A typo in a body prompt fails loudly.
    expect(() => substituteLoopBodyText('act on $LOOP_PREV.reviw.output.verdict', [outer])).toThrow(
      OutputRefError
    );

    // A ref to a nested-owned id (`polish`) is not the outer scope's to resolve: alone it
    // leaves the token intact (this is the #2165 fix; before it the outer scope destroyed
    // the token to ''), and the inner scope resolves it in the same pass.
    expect(substituteLoopBodyText('refine on $LOOP_PREV.polish.output.draft', [outer])).toBe(
      'refine on $LOOP_PREV.polish.output.draft'
    );
    expect(substituteLoopBodyText('refine on $LOOP_PREV.polish.output.draft', [outer, inner])).toBe(
      'refine on D1'
    );

    // A ref to an OUTER-direct id (`review`) inside the nested body resolves at the outer
    // granularity — here to '' (iteration 1, no prior output), not left for the inner scope.
    expect(
      substituteLoopBodyText('saw outer [$LOOP_PREV.review.output.verdict]', [outer, inner])
    ).toBe('saw outer []');

    // But a typo INSIDE the nested body (id in no body node) still throws.
    expect(() =>
      substituteLoopBodyText('refine on $LOOP_PREV.reviw.output.verdict', [outer, inner])
    ).toThrow(OutputRefError);
  });

  it('EDGE F (#2165): a nested inner loop_group resolves its OWN prior-iteration $LOOP_PREV end-to-end', async () => {
    // The semantics the L3417 comment promises: an inner loop_group body node referencing
    // its own sibling's previous iteration (`$LOOP_PREV.w.output`) must see that output on
    // the inner group's 2nd+ iteration — even though the inner group is nested inside an
    // outer loop_group. Before #2165 the outer loop's substitution pass eagerly destroyed
    // the token to '' before the inner loop ran, so it was empty on EVERY inner iteration.
    //
    // Body node `w` emits a distinct marker each call; we capture the prompt it receives.
    // Inner iteration 1 → no prior output (''); inner iteration 2 → the marker from
    // iteration 1 (proving the inner loop resolved its own prior iteration).
    const capturedPrompts: string[] = [];
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      capturedPrompts.push(prompt ?? '');
      const n = capturedPrompts.length;
      // Call 1 emits MARK1 (no signal → inner iterates again); call 2 emits the signal.
      yield { type: 'agent_message_chunk', text: n === 1 ? 'MARK1' : 'MARK2\nINNER_DONE' };
      yield { type: 'result', sessionId: `s-${n}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-nested-prev');

    const nodes: DagNode[] = [
      {
        id: 'outer',
        kind: 'loop_group',
        loop_group: {
          until: 'OUTER_DONE',
          // One outer iteration is enough to run the inner group to its own completion.
          max_iterations: 1,
          fresh_context: false,
          nodes: [
            {
              id: 'inner',
              kind: 'loop_group',
              loop_group: {
                until: 'INNER_DONE',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'w',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'prev=[$LOOP_PREV.w.output] do work' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-nested-prev', nodes },
        workflowRun,
      })
    );

    // Two inner iterations ran within the single outer iteration.
    expect(capturedPrompts.length).toBe(2);
    // Inner iteration 1: no prior output → empty.
    expect(capturedPrompts[0]).toContain('prev=[]');
    // Inner iteration 2: the inner loop resolved ITS OWN prior-iteration output — the token
    // survived the outer pass and resolved against the inner snapshot. This is the fix.
    expect(capturedPrompts[1]).toContain('prev=[MARK1]');
  });

  it('EDGE H: loop scopes shell-quote only on the shell surface (unit)', () => {
    // Prior output contains a single quote — the acid test for escaping-mode mixups.
    const scopes: LoopBodyScope[] = [
      {
        loopPrevOutputs: new Map([['work', makeOutput('completed', "it's done", undefined)]]),
        loopUserInput: '',
      },
    ];

    // bash / until_bash: value arrives shell-quoted.
    expect(substituteLoopBodyText('echo $LOOP_PREV.work.output', scopes, 'shell')).toBe(
      "echo 'it'\\''s done'"
    );
    // script: runs via execFile argv (no shell) → raw value, no quote artifacts in source.
    expect(substituteLoopBodyText('console.log(`$LOOP_PREV.work.output`)', scopes, 'script')).toBe(
      "console.log(`it's done`)"
    );
    // prompt and display text → raw value.
    expect(substituteLoopBodyText('stopping: $LOOP_PREV.work.output', scopes)).toBe(
      "stopping: it's done"
    );
  });

  it('evaluates a loop-group body when against the prior iteration output', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 3 ? 'guarded\nDONE' : 'done' };
      yield { type: 'result', sessionId: `loop-prev-when-${calls}` };
    });

    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-loop-prev-when',
        cwd: testDir,
        workflow: {
          name: 'loop-prev-when',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'work' },
                    depends_on: [],
                  },
                  {
                    id: 'guarded',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'guarded' },
                    when: "$LOOP_PREV.work.output == 'done'",
                    depends_on: ['work'],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('loop-prev-when'),
      })
    );

    expect(calls).toBe(3);
    expect(result).toContain('guarded');
  });

  it("EDGE H (#2623): resolves namespaced $LOOP_PREV across a body node's AI configuration", async () => {
    const ref = '$LOOP_PREV.block__review.output';
    let useCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt === 'review') {
        yield { type: 'agent_message_chunk', text: 'PRIOR' };
      } else {
        useCalls++;
        yield { type: 'agent_message_chunk', text: useCalls === 2 ? 'DONE' : 'working' };
      }
      yield { type: 'result', sessionId: `lg-aicfg-${useCalls}` };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'lg-aicfg',
          nodes: [
            dagNodeSchema.parse({
              id: 'grp',
              loop_group: {
                until: 'DONE',
                max_iterations: 2,
                nodes: [
                  { id: 'block__review', prompt: 'review' },
                  {
                    id: 'use',
                    prompt: `main=${ref}`,
                    systemPrompt: `system=${ref}`,
                    agents: {
                      helper: { description: `description=${ref}`, prompt: `agent=${ref}` },
                    },
                    depends_on: ['block__review'],
                  },
                ],
              },
            }) as DagNode,
          ],
        },
        workflowRun: makeWorkflowRun('lg-aicfg'),
      })
    );

    const useCall = mockSendQueryDag.mock.calls.filter(call => call[0] !== 'review').at(-1);
    expect(useCall?.[0]).toBe('main=PRIOR');
    expect(useCall?.[3]?.systemPrompt).toBe('system=PRIOR');
    expect(useCall?.[3]?.nodeConfig?.agents?.helper?.description).toBe('description=PRIOR');
    expect(useCall?.[3]?.nodeConfig?.agents?.helper?.prompt).toBe('agent=PRIOR');
  });

  it('EDGE H: never splices $LOOP_USER_INPUT into a script body — env delivery only (#2115)', () => {
    // Malicious approval-gate free-text. Raw-spliced into TS source it would close the
    // string literal and execute; it must stay an inert literal token in the script so
    // executeExecNode delivers the value out-of-band via env instead.
    const injection = '"); require("child_process").execSync("touch pwned"); //';
    const scopes: LoopBodyScope[] = [{ loopPrevOutputs: undefined, loopUserInput: injection }];

    // Literal token preserved; the payload never reaches the executed source.
    expect(substituteLoopBodyText('console.log("$LOOP_USER_INPUT")', scopes, 'script')).toBe(
      'console.log("$LOOP_USER_INPUT")'
    );
    // bash stays shell-quoted (the existing safe channel) — proving only scripts changed.
    // No single quotes in the payload → shellQuote wraps it verbatim in single quotes.
    expect(substituteLoopBodyText('echo $LOOP_USER_INPUT', scopes, 'shell')).toBe(
      `echo '${injection}'`
    );
  });

  it('EDGE D: multi-terminal body runs parallel terminals; signal on the selected terminal completes', async () => {
    // Body has two no-dependency AI nodes (a, b) — a parallel layer, both run each
    // iteration. The group's terminal output is the FIRST completed terminal node in
    // definition order (a before b), so the completion signal must appear in a's output
    // to be detected. This verifies (1) parallel terminals run concurrently and (2) the
    // terminal-output selection picks `a`.
    let aCalls = 0;
    let bCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      // Distinguish the two body nodes by their prompt content.
      if (prompt.includes('node-a')) {
        aCalls++;
        yield { type: 'agent_message_chunk', text: 'a-output\nDONE' };
      } else {
        bCalls++;
        yield { type: 'agent_message_chunk', text: 'b-output (no signal)' };
      }
      yield { type: 'result', sessionId: 's' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multiterminal');

    const nodes: DagNode[] = [
      {
        id: 'multi',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'a',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'I am node-a. Emit DONE.' },
              depends_on: [],
            },
            {
              id: 'b',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'I am node-b. Do work.' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-multiterminal', nodes },
        workflowRun,
      })
    );

    // Both parallel terminal nodes ran on the completing iteration (iter 1).
    expect(aCalls).toBeGreaterThanOrEqual(1);
    expect(bCalls).toBeGreaterThanOrEqual(1);
    // `a` (first terminal in def order) emitted DONE → group completed; its output is
    // the group's terminal output.
    expect(result).toContain('a-output');
  });

  it('EDGE C: fresh_context=true does not crash and the group still completes', async () => {
    // Smoke: fresh_context:true path. We can't easily assert session reset from the mock,
    // but we verify the group completes normally with fresh_context on.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? 'wip' : 'final\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-fresh');

    const nodes: DagNode[] = [
      {
        id: 'fresh',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: true,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-fresh', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(2);
    expect(result).toContain('final');
  });

  it('EDGE E: between-iteration cancellation stops the loop with a failed result', async () => {
    // getWorkflowRunStatus returns 'running' on iteration 1, then 'cancelled' before
    // iteration 2 → the between-iteration check halts the loop with a failed result.
    let calls = 0;
    const statuses = ['running', 'cancelled', 'cancelled'];
    // Override the store mock to cycle statuses. createMockDeps uses createMockStore which
    // returns 'running' always; we override getWorkflowRunStatus here.
    const mockDeps = createMockDeps();
    (mockDeps.store.getWorkflowRunStatus as ReturnType<typeof mock>).mockImplementation(() => {
      const s = statuses[Math.min(calls, statuses.length - 1)];
      return Promise.resolve(s as 'running' | 'cancelled');
    });
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: `iter ${calls} work` };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-cancel');

    const nodes: DagNode[] = [
      {
        id: 'cancellable',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-cancel', nodes },
        workflowRun,
      })
    );

    // Only iteration 1 ran before cancellation halted the loop. The run did not complete
    // (no DONE) → outer DAG sees no terminal output.
    expect(calls).toBe(1);
    expect(result).toBeUndefined();
  });

  it('EDGE G: until signal OR until_bash — signal short-circuits until_bash (not executed)', async () => {
    // Both until and until_bash are set. The AI emits the until signal on iteration 1;
    // completionDetected = signalDetected (true) short-circuits before until_bash runs.
    // We prove until_bash was skipped via a sentinel file it would create if executed.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'done\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-or');
    const sentinel = join(testDir, 'untilbash-ran');

    const nodes: DagNode[] = [
      {
        id: 'either',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          // Creates a sentinel file + exits 0. If this runs, the file exists; if the
          // until-signal short-circuits, the file is never created.
          until_bash: `touch ${sentinel}`,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work, emit DONE' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-or', nodes },
        workflowRun,
      })
    );

    // Signal completed on iteration 1.
    expect(calls).toBe(1);
    expect(result).toContain('done');
    // until_bash was short-circuited (sentinel file NOT created).
    let sentinelExists = true;
    try {
      await readFile(sentinel, 'utf8');
    } catch {
      sentinelExists = false;
    }
    expect(sentinelExists).toBe(false);
  });

  it('EDGE I: max_iterations=1 single-shot completes when signal present, fails otherwise', async () => {
    // Single iteration allowed. With the signal present → completes in 1.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'one-shot\nDONE' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-single-shot');

    const nodes: DagNode[] = [
      {
        id: 'once',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work, emit DONE' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-single-shot', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(1);
    expect(result).toContain('one-shot');
  });

  it('EDGE H: nested loop_group (loop_group inside a loop_group body) runs', async () => {
    // Outer body contains an inner loop_group. The inner group completes in 1 iteration
    // (emits INNER_DONE), and the outer completes when its terminal node emits OUTER_DONE.
    // This smoke-tests that a body node which is itself a loop_group dispatches correctly.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      // Inner loop_group's body node runs first (emits INNER_DONE → inner completes iter 1).
      // Then the outer's review node emits OUTER_DONE. Distinguish by call order.
      const content = calls === 1 ? 'inner work\nINNER_DONE' : 'outer review\nOUTER_DONE';
      yield { type: 'agent_message_chunk', text: content };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-nested');

    const nodes: DagNode[] = [
      {
        id: 'outer',
        kind: 'loop_group',
        loop_group: {
          until: 'OUTER_DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'inner',
              kind: 'loop_group',
              loop_group: {
                until: 'INNER_DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'inner-work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'inner work, emit INNER_DONE' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'review inner result, emit OUTER_DONE' },
              depends_on: ['inner'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-nested', nodes },
        workflowRun,
      })
    );

    // Inner ran (1 call), then outer review ran (1 call) emitting OUTER_DONE → outer completes.
    expect(calls).toBe(2);
    expect(result).toContain('outer review');
  });

  // --- Dimension 3: cost/token accumulation across iterations ---

  it('COST: accumulates total_cost_usd across loop_group iterations', async () => {
    // 2 iterations: iter 1 no signal (cost 0.01), iter 2 DONE (cost 0.02).
    // The group sums per-iteration cost into its NodeExecutionResult; the outer runLayers
    // then aggregates it into the run's total_cost_usd.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      const cost = calls === 1 ? 0.01 : 0.02;
      const content = calls === 1 ? 'work in progress' : 'done\nDONE';
      yield { type: 'agent_message_chunk', text: content };
      yield { type: 'result', sessionId: `s-${calls}`, cost };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-cost');

    const nodes: DagNode[] = [
      {
        id: 'paid',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-cost', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(2);
    // 0.01 + 0.02 = 0.03 accumulated across the group's 2 iterations.
    expect(runUsageWrites(store)).toEqual([{ total_cost_usd: 0.03 }]);

    // #2469 producer half: the group's own node_completed row restates the cost its
    // `<groupId>.<nodeId>` body rows already carry, so it must be marked as derived —
    // getDagResumeSnapshot skips marked rows when rebuilding cost across a resume.
    // Without the marker a resumed run seeds ~2x the true prior spend, silently.
    const completedEvents = (
      store.createWorkflowEvent as Mock<
        (data: {
          event_type: string;
          step_name?: string;
          data?: Record<string, unknown>;
        }) => Promise<void>
      >
    ).mock.calls
      .map(call => call[0])
      .filter(e => e.event_type === 'node_completed');

    const groupRollUp = completedEvents.find(e => e.step_name === 'paid');
    expect(groupRollUp?.data?.cost_usd).toBeCloseTo(0.03, 5);
    expect(groupRollUp?.data?.aggregate).toBe(true);

    // The body rows are the authoritative leaves and must NOT be marked.
    const bodyRows = completedEvents.filter(e => e.step_name?.startsWith('paid.'));
    expect(bodyRows.length).toBeGreaterThan(0);
    for (const row of bodyRows) expect(row.data?.aggregate).toBeUndefined();

    // The transcript half of the same rule (#3508): the roll-up row restates its body's
    // spend, which those same leaves already report, so it reports none of its own and a
    // sum of the transcript's node_complete costs equals the run total.
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const rollUpRow = rows.find(r => r.type === 'node_complete' && r.step === 'paid');
    const bodyCompleted = rows.filter(
      r =>
        r.type === 'node_complete' &&
        String((r.execution as { path?: string })?.path ?? '').startsWith('paid.')
    );
    expect(rollUpRow).toBeDefined();
    expect(rollUpRow).not.toHaveProperty('cost_usd');
    expect(bodyCompleted.length).toBeGreaterThan(0);
    for (const row of bodyCompleted) expect(row).toHaveProperty('cost_usd');
    expect(
      rows
        .filter(r => r.type === 'node_complete')
        .reduce((total, r) => total + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0)
    ).toBeCloseTo(0.03, 5);
  });

  it('COST: accumulates token usage across loop_group iterations', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      const content = calls === 1 ? 'work in progress' : 'done\nDONE';
      yield { type: 'agent_message_chunk', text: content };
      yield {
        type: 'result',
        sessionId: `s-${calls}`,
        tokens:
          calls === 1
            ? { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 }
            : { input: 200, output: 20, cacheRead: 125, cacheWrite: 5 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-tokens');

    const nodes: DagNode[] = [
      {
        id: 'paid',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-tokens', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(2);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    // The BODY node's per-iteration rows are the authoritative per-node usage.
    const bodyEvents = eventCalls.filter(
      ([arg]) => arg.event_type === 'node_completed' && arg.step_name === 'paid.work'
    );
    expect(bodyEvents.map(([arg]) => arg.data?.tokens)).toEqual([
      { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 },
      { input: 200, output: 20, cacheRead: 125, cacheWrite: 5 },
    ]);
    // The GROUP row must NOT repeat the same total under the same field name: body
    // rows and the aggregate live in one event stream, so a consumer summing
    // `data.tokens` would otherwise count this group twice (600/60 for 300/30).
    const groupEvent = eventCalls.find(
      ([arg]) => arg.event_type === 'node_completed' && arg.step_name === 'paid'
    );
    expect(groupEvent).toBeDefined();
    expect(groupEvent?.[0].data).not.toHaveProperty('tokens');
    // The property the persisted stream must hold: a naive consumer summing every
    // node_completed row's tokens gets the run's real usage, with no discriminator.
    const naiveSum = eventCalls
      .filter(([arg]) => arg.event_type === 'node_completed')
      .reduce(
        (acc, [arg]) => {
          const t = arg.data?.tokens as { input: number; output: number } | undefined;
          return t ? { input: acc.input + t.input, output: acc.output + t.output } : acc;
        },
        { input: 0, output: 0 }
      );
    expect(naiveSum).toEqual({ input: 300, output: 30 });
  });

  it('COST: a loop_group gate → bare approve → finalize does not double-count body tokens (#2333)', async () => {
    // Both phases write to ONE event store, the way a real database behaves. Per-test
    // isolation would hide the defect entirely: the body's per-iteration rows are
    // persisted BEFORE the pause and survive it, so a finalize row carrying the same
    // usage doubles it in the single stream a consumer actually reads.
    const store = createMockStore();
    const nodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop_group',
        loop_group: {
          until: 'APPROVED',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Review the result.',
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'validate' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];
    const workflow = { name: 'lg-finalize-tokens', nodes };

    // Phase 1 — iteration 1 signals but still gates (fresh interactive, no
    // signal_completes). Its body row persists 100/10, the run's ONLY real usage.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'validation PASS\nAPPROVED' };
      yield { type: 'result', sessionId: 'lg-dbl-sess-1', tokens: { input: 100, output: 10 } };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-finalize-tokens-run'),
      })
    );

    const pauseCalls = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls;
    expect(pauseCalls.length).toBe(1);

    // Phase 2 — bare approve. The resumed run carries EXACTLY the context the gate
    // persisted, so what the pause writes is what the finalize reads.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never', tokens: { input: 999, output: 99 } };
    });
    const aiCallsBeforeResume = mockSendQueryDag.mock.calls.length;

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('lg-finalize-tokens-run', {
          metadata: {
            approval: pauseCalls[0][1],
            loop_user_input: '',
            loop_feedback_given: false,
          },
        }),
      })
    );

    // Finalized from the persisted output — no body iteration re-ran.
    expect(mockSendQueryDag.mock.calls.length).toBe(aiCallsBeforeResume);

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const completedRows = eventCalls.filter(([arg]) => arg.event_type === 'node_completed');
    expect(completedRows.map(([arg]) => arg.step_name)).toEqual(['refine.work', 'refine']);
    // The pre-pause body row is authoritative and still present after the resume.
    expect(completedRows[0][0].data?.tokens).toEqual({ input: 100, output: 10 });
    // The finalize row is an aggregate over body rows that already carry the usage —
    // same reason the natural-completion group row omits `tokens`.
    expect(completedRows[1][0].data).not.toHaveProperty('tokens');
    // The property the persisted stream must hold across a gate: a naive consumer
    // summing every node_completed row's tokens gets the run's real usage.
    const naiveSum = completedRows.reduce(
      (acc, [arg]) => {
        const t = arg.data?.tokens as { input: number; output: number } | undefined;
        return t ? { input: acc.input + t.input, output: acc.output + t.output } : acc;
      },
      { input: 0, output: 0 }
    );
    expect(naiveSum).toEqual({ input: 100, output: 10 });
  });

  it('omits tokens from loop_group body node_completed events when providers report no usage', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done\nDONE' };
      yield { type: 'result', sessionId: 'lg-no-usage-sid' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const nodes: DagNode[] = [
      {
        id: 'no-usage-group',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-lg-no-usage',
        cwd: testDir,
        workflow: { name: 'lg-no-usage', nodes },
        workflowRun: makeWorkflowRun('lg-no-usage-run'),
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name: string; data?: Record<string, unknown> }]
    >;
    const bodyEvent = eventCalls.find(
      ([event]) =>
        event.event_type === 'node_completed' && event.step_name === 'no-usage-group.work'
    );
    expect(bodyEvent).toBeDefined();
    expect(bodyEvent?.[0].data).not.toHaveProperty('tokens');
    const groupEvent = eventCalls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'no-usage-group'
    );
    expect(groupEvent).toBeDefined();
    expect(groupEvent?.[0].data).not.toHaveProperty('tokens');
  });

  it('SESSION: fresh_context=false threads the body session between iterations', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls >= 2 ? 'done\nDONE' : 'progress' };
      yield { type: 'result', sessionId: `lg-sess-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-session-thread');

    const nodes: DagNode[] = [
      {
        id: 'stateful',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-session-thread', nodes },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Iteration 1: always fresh.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // Iteration 2: resumes iteration 1's session (fresh_context: false).
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('lg-sess-1');
  });

  it('SESSION: fresh_context=true starts a fresh body session every iteration', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls >= 2 ? 'done\nDONE' : 'progress' };
      yield { type: 'result', sessionId: `lg-fresh-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-session-fresh');

    const nodes: DagNode[] = [
      {
        id: 'stateless',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: true,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-session-fresh', nodes },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('WHEN: a body node when: gates on a sibling output per iteration without leaking skip state', async () => {
    // Iteration 1: gate node outputs 'stop' → work is skipped (when false) → no
    // completed terminal output → no signal → iteration 2. Iteration 2: gate outputs
    // 'go' → work runs and emits DONE. Proves (1) when: evaluates against the SAME
    // iteration's scoped outputs and (2) skip state doesn't leak into iteration 2.
    let gateCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('GATE')) {
        gateCalls++;
        yield { type: 'agent_message_chunk', text: gateCalls === 1 ? 'stop' : 'go' };
        yield { type: 'result', sessionId: `gate-${gateCalls}` };
      } else {
        yield { type: 'agent_message_chunk', text: 'work ran\nDONE' };
        yield { type: 'result', sessionId: 'work-1' };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-when');

    const nodes: DagNode[] = [
      {
        id: 'gated',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: true,
          nodes: [
            {
              id: 'gate',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'GATE: decide' },
              depends_on: [],
            },
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do the work' },
              depends_on: ['gate'],
              when: "$gate.output == 'go'",
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-when', nodes },
        workflowRun,
      })
    );

    // gate ran twice (both iterations); work ran once (iteration 2 only).
    expect(gateCalls).toBe(2);
    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    expect(result).toContain('work ran');
  });

  it('EDGE A2: a failed upstream body node skips its dependent and fails the group with the real error', async () => {
    // Multi-node body: implement fails → verify (depends_on implement) is skipped by
    // trigger-rule semantics → group fails fast with implement's error, one iteration.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      calls++;
      if (prompt.includes('IMPLEMENT')) {
        throw new Error('implement blew up');
      }
      yield { type: 'agent_message_chunk', text: 'verified\nDONE' };
      yield { type: 'result', sessionId: 'v-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-multi-fail');

    const nodes: DagNode[] = [
      {
        id: 'pipeline',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'implement',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'IMPLEMENT: fix it' },
              depends_on: [],
            },
            {
              id: 'verify',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'verify the fix' },
              depends_on: ['implement'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-multi-fail', nodes },
        workflowRun,
      })
    );

    // Only implement's single (failing) call ran — verify was skipped, no iteration 2.
    expect(calls).toBe(1);
    expect(result).toBeUndefined();
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain('implement blew up');
    expect(sent).not.toContain('exceeded max iterations');
  });

  // --- Dimension 2: output_type typed artifact from final iteration ---

  it('OUTPUT_TYPE: loop_group with output_type writes a sidecar from the final terminal output', async () => {
    // The group declares output_type: 'result'. On completion, the outer runLayers writes
    // nodes/{groupId}.md from the group's NodeExecutionResult.output (= final iteration's
    // terminal output).
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      const content = calls === 1 ? 'draft v1' : 'final result v2\nDONE';
      yield { type: 'agent_message_chunk', text: content };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-artifact');
    const artifactsDir = join(testDir, 'artifacts');

    const nodes: DagNode[] = [
      {
        id: 'producer',
        output_type: 'result',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'produce output' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-artifact', nodes },
        workflowRun,
        artifactsDir,
      })
    );

    expect(calls).toBe(2);
    // The sidecar artifact carries the final iteration's terminal output.
    const written = await readFile(join(artifactsDir, 'nodes', 'producer.md'), 'utf8');
    expect(written).toContain('final result v2');
    expect(written).not.toContain('draft v1');
  });

  it('records iteration on node_failed for a failing loop_group body agent (#3080)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'agent_message_chunk', text: 'iteration 1 done' };
        yield { type: 'result', sessionId: 'lg-fail-1' };
      } else {
        throw new Error('Simulated provider failure on iteration 2');
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-fail-iter');

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg-fail',
        cwd: testDir,
        workflow: { name: 'lg-fail-iter', nodes },
        workflowRun,
      })
    );

    expect(callCount).toBe(2);
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      c => c[0] as { event_type: string; step_name: string; data?: Record<string, unknown> }
    );

    // Iteration 1 completed normally — started and completed carry iteration.
    const iter1Started = events.find(
      e => e.event_type === 'node_started' && e.step_name === 'fixer.work'
    );
    const iter1Completed = events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'fixer.work'
    );
    expect(iter1Started?.data?.iteration).toBe(1);
    expect(iter1Completed?.data?.iteration).toBe(1);

    // Iteration 2 failed — started and failed carry the same iteration.
    const iter2Started = events.filter(
      e => e.event_type === 'node_started' && e.step_name === 'fixer.work'
    )[1];
    const iter2Failed = events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'fixer.work'
    );
    expect(iter2Started?.data?.iteration).toBe(2);
    expect(iter2Failed?.data?.iteration).toBe(2);
    expect(iter2Failed?.data?.error).toContain('Simulated provider failure');
  });

  it('does not record iteration on node_failed for a non-loop agent (#3080)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      throw new Error('Simulated provider failure');
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-loop-fail');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-noloop',
        cwd: testDir,
        workflow: {
          name: 'no-loop-fail',
          nodes: [
            {
              id: 'agent',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work' },
            },
          ],
        },
        workflowRun,
      })
    );

    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      c => c[0] as { event_type: string; step_name: string; data?: Record<string, unknown> }
    );
    const failed = events.find(e => e.event_type === 'node_failed' && e.step_name === 'agent');
    expect(failed).toBeDefined();
    expect(failed?.data?.iteration).toBeUndefined();
  });
});
