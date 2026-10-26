// @archon-test-isolated
import { buildTerminalRecord, observeRunArtifacts } from '../terminal-record';
import { RUN_GRAPH_METADATA_KEY } from '../schemas/terminal-record';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  type MockWorkflowStore,
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  ready,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { DagNode, WorkflowRun, WorkflowDefinition } from '../schemas';
import { dagNodeSchema } from '../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../store';

// ---------------------------------------------------------------------------
// #2637 — workflow values survive every boundary; resource-backed nodes bind
// them by name. AC1 (persistence round-trip), AC4 (node-local bindings),
// AC5 (skipped-branch reads).
// ---------------------------------------------------------------------------

describe('value transport (#2637): persistence, resume, and node-local bindings', () => {
  let testDir: string;

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  const PRODUCER_PAYLOAD = { green: true, items: ['a', 'b'], count: 2 };
  const PRODUCER_SCHEMA = {
    type: 'object',
    properties: {
      green: { type: 'boolean' },
      items: { type: 'array' },
      count: { type: 'number' },
    },
    required: ['green', 'items', 'count'],
  };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-value-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  /** Provider mock: the producer prompt returns the structured payload; every other
   *  prompt is captured so consumer-side delivery is observable. */
  function mockStructuredProducer(capture: (prompt: string) => void): void {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('PRODUCE')) {
        yield { type: 'agent_message_chunk', text: JSON.stringify(PRODUCER_PAYLOAD) };
        yield { type: 'result', sessionId: 'sid-prod', structuredOutput: PRODUCER_PAYLOAD };
        return;
      }
      capture(prompt);
      yield { type: 'agent_message_chunk', text: 'consumer done' };
      yield { type: 'result', sessionId: 'sid-cons' };
    });
  }

  async function runDag(
    workflow: WorkflowDefinition,
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>,
    workflowRunOverrides?: Partial<WorkflowRun>
  ): Promise<{ events: PersistedEvent[]; store: MockWorkflowStore }> {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2637',
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun(runId, workflowRunOverrides),
        priorCompletedNodes,
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    return { events, store };
  }

  it.each([false, true])(
    'preserves incomplete resumed output provenance (structured=%s)',
    async structured => {
      const preview = 'x'.repeat(32_768);
      const spillPath = join(testDir, 'missing-original-spill.txt');
      const resumed = await runDag(
        {
          name: 'incomplete-replay',
          description: 'resume preview',
          returns: 'producer',
          nodes: [dagNodeSchema.parse({ id: 'producer', bash: 'echo should-not-run' })],
        },
        'incomplete-replay',
        new Map([
          [
            'producer',
            {
              output: preview,
              outputTruncation: { originalBytes: 40_000, spillPath },
              ...(structured ? { structuredOutput: { answer: 42 } } : {}),
            },
          ],
        ])
      );
      const replay = resumed.events.find(
        event => event.event_type === 'node_skipped_prior_success'
      );
      expect(replay?.data).toMatchObject({
        node_output: preview,
        node_output_truncated: true,
        node_output_original_bytes: 40_000,
        node_output_spill_path: spillPath,
      });
      if (structured) expect(replay?.data?.structured_output).toEqual({ answer: 42 });
      expect(resumed.events.some(event => event.event_type === 'node_started')).toBe(false);
      const replayRun = makeWorkflowRun('incomplete-replay', {
        status: 'completed',
        metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['producer'], returns: 'producer' } },
      });
      const record = buildTerminalRecord({
        run: replayRun,
        events: resumed.events.map(event => ({ ...event, data: event.data ?? {} })),
        artifacts: await observeRunArtifacts(replayRun),
      });
      expect(record.returns).toEqual(
        structured
          ? { availability: 'available', node_id: 'producer', value: { answer: 42 } }
          : {
              availability: 'truncated',
              node_id: 'producer',
              original_bytes: 40_000,
              spill_path: spillPath,
            }
      );
    }
  );

  function producerConsumerWorkflow(): WorkflowDefinition {
    return {
      name: 'transport-roundtrip',
      description: 'structured producer feeding a typed consumer',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE the classification',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt:
            'green=[$producer.output.green] items=[$producer.output.items] whole=[$producer.output]',
          depends_on: ['producer'],
        }),
      ],
    };
  }

  it('AC1: persists structured_output in node_completed and rehydrates identical values on cold resume', async () => {
    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });

    const fresh = await runDag(producerConsumerWorkflow(), 'transport-fresh');

    // The producer's node_completed event carries the logical value beside its text.
    const producerCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'producer'
    );
    expect(producerCompleted?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);
    expect(String(producerCompleted?.data?.node_output)).toBe(JSON.stringify(PRODUCER_PAYLOAD));
    expect(freshPrompt).toBe(
      `green=[true] items=[["a","b"]] whole=[${JSON.stringify(PRODUCER_PAYLOAD)}]`
    );

    // Cold resume: the snapshot the store would rebuild from that event.
    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    const prior = new Map<string, PersistedNodeOutput>([
      [
        'producer',
        {
          output: String(producerCompleted?.data?.node_output),
          structuredOutput: producerCompleted?.data?.structured_output,
        },
      ],
    ]);
    const resumed = await runDag(producerConsumerWorkflow(), 'transport-resumed', prior);

    // Byte-identical consumer view — the invariant the whole slice exists for.
    expect(resumedPrompt).toBe(freshPrompt);
    // The re-emit copies the logical value forward so a SECOND resume still sees it.
    const replayed = resumed.events.find(e => e.event_type === 'node_skipped_prior_success');
    expect(replayed?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);

    // A pre-#2637 snapshot row (text only) still resolves via the text-parse fallback.
    let legacyPrompt: string | undefined;
    mockStructuredProducer(p => {
      legacyPrompt = p;
    });
    await runDag(
      producerConsumerWorkflow(),
      'transport-legacy',
      new Map([['producer', { output: JSON.stringify(PRODUCER_PAYLOAD) }]])
    );
    expect(legacyPrompt).toBe(freshPrompt);
  });

  it('AC1: a loop_group persists its terminal sink structured payload and re-exposes it after resume', async () => {
    const groupWorkflow = (): WorkflowDefinition => ({
      name: 'transport-group',
      description: 'loop_group whose terminal sink emits a structured payload',
      nodes: [
        dagNodeSchema.parse({
          id: 'group',
          loop_group: {
            until_bash: 'exit 0',
            max_iterations: 1,
            fresh_context: false,
            nodes: [
              {
                id: 'emit',
                prompt: 'PRODUCE inside the group',
                output_format: PRODUCER_SCHEMA,
              },
            ],
          },
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt: 'field=[$group.output.green]',
          depends_on: ['group'],
        }),
      ],
    });

    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });
    const fresh = await runDag(groupWorkflow(), 'transport-group-fresh');

    const groupCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'group'
    );
    expect(groupCompleted?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);
    expect(freshPrompt).toBe('field=[true]');

    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    await runDag(
      groupWorkflow(),
      'transport-group-resumed',
      new Map([
        [
          'group',
          {
            output: String(groupCompleted?.data?.node_output),
            structuredOutput: groupCompleted?.data?.structured_output,
          },
        ],
      ])
    );
    expect(resumedPrompt).toBe(freshPrompt);
  });

  it('AC4: a command node binds upstream values by name through $INPUTS (typed, whole-ref, and template)', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'consume.md'),
      'g=[$INPUTS.green] t=[$INPUTS.typed] items=[$INPUTS.items] msg=[$INPUTS.msg]'
    );
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-command-binding',
      description: 'command node with node-local bindings',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: {
            green: '$producer.output.green',
            typed: 42,
            items: '$producer.output.items',
            msg: 'count is $producer.output.count',
          },
          depends_on: ['producer'],
        }),
      ],
    };

    await runDag(workflow, 'transport-cmd-bind');
    // Whole refs keep the logical value (boolean/array), the literal stays typed, and
    // the template splices canonical text — all through one deterministic rule.
    expect(consumerPrompt).toBe('g=[true] t=[42] items=[["a","b"]] msg=[count is 2]');
  });

  it('AC4: a script node receives bindings as INPUTS_<UPPER_SNAKE> env text, single-encoded', async () => {
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-script-binding',
      description: 'script node with node-local bindings',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'emit',
          script:
            'console.log(`g=${process.env.INPUTS_GREEN}|payload=${process.env.INPUTS_PAYLOAD}`);',
          runtime: 'bun',
          depends_on: ['producer'],
          with: {
            green: '$producer.output.green',
            payload: '$producer.output',
          },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'script said [$emit.output]',
          depends_on: ['emit'],
        }),
      ],
    };

    await runDag(workflow, 'transport-script-bind');
    // Boolean delivers as its canonical text `true` (never re-quoted), and the whole
    // structured payload arrives single-encoded — no artifact-file bridge required.
    expect(consumerPrompt).toBe(`script said [g=true|payload=${JSON.stringify(PRODUCER_PAYLOAD)}]`);
  });

  it('AC4: node-local bindings win over a run input of the same name (nearest contract)', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'consume.md'), 'v=[$INPUTS.green]');
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-binding-precedence',
      description: 'node-local binding shadows the run input',
      nodes: [
        dagNodeSchema.parse({ id: 'producer', prompt: 'PRODUCE', output_format: PRODUCER_SCHEMA }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { green: '$producer.output.green' },
          depends_on: ['producer'],
        }),
      ],
    };

    await runDag(workflow, 'transport-precedence', undefined, {
      metadata: { inputs: { green: 'from-run-input' } },
    });
    expect(consumerPrompt).toBe('v=[true]');
  });

  it('AC4: an unknown or non-upstream binding fails the node with an actionable error, never an empty string', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'consume.md'), 'v=[$INPUTS.v]');
    mockStructuredProducer(() => {});

    // Built programmatically (the loader rejects this at load time) to prove the
    // runtime seam fails loudly too.
    const workflow: WorkflowDefinition = {
      name: 'transport-binding-unknown',
      description: 'binding to a producer that never ran',
      nodes: [
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { v: '$ghost.output' },
        }),
      ],
    };

    const { events } = await runDag(workflow, 'transport-unknown');
    const failed = events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("'$ghost.output' references node 'ghost'");
  });

  it('AC5: a binding on a skipped producer takes if_skipped; without one the node fails naming the fix', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'gate.md'), 'ready=[$INPUTS.ready]');
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const skippedProducerWorkflow = (withValue: unknown): WorkflowDefinition => ({
      name: 'transport-skipped',
      description: 'reads across a skipped branch',
      nodes: [
        dagNodeSchema.parse({ id: 'seed', bash: "printf '%s' no" }),
        dagNodeSchema.parse({
          id: 'maybe',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
          depends_on: ['seed'],
          when: "$seed.output == 'yes'",
        }),
        dagNodeSchema.parse({
          id: 'gate',
          command: 'gate',
          with: { ready: withValue },
          depends_on: ['maybe'],
          trigger_rule: 'all_done',
        }),
      ],
    });

    // With the declared default, the skipped branch resolves to it — explicitly.
    await runDag(
      skippedProducerWorkflow({ from: '$maybe.output.green', if_skipped: false }),
      'transport-skipped-default'
    );
    expect(consumerPrompt).toBe('ready=[false]');

    // Without it, the node fails and the message names the binding, producer, and fix.
    const { events } = await runDag(
      skippedProducerWorkflow({ from: '$maybe.output.green' }),
      'transport-skipped-loud'
    );
    const failed = events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("binding 'ready' reads '$maybe.output.green'");
    expect(String(failed?.data?.error)).toContain("'maybe' did not run");
    expect(String(failed?.data?.error)).toContain('if_skipped');
  });

  it('AC1+AC4 (issue acceptance): bindings resolve identically from a rehydrated snapshot after cold resume', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'consume.md'),
      'g=[$INPUTS.green] items=[$INPUTS.items]'
    );
    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });

    const workflow = (): WorkflowDefinition => ({
      name: 'transport-resume-binding',
      description: 'binding consumer after resume',
      nodes: [
        dagNodeSchema.parse({ id: 'producer', prompt: 'PRODUCE', output_format: PRODUCER_SCHEMA }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { green: '$producer.output.green', items: '$producer.output.items' },
          depends_on: ['producer'],
        }),
      ],
    });

    const fresh = await runDag(workflow(), 'transport-resume-bind-fresh');
    const producerCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'producer'
    );

    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    await runDag(
      workflow(),
      'transport-resume-bind-resumed',
      new Map([
        [
          'producer',
          {
            output: String(producerCompleted?.data?.node_output),
            structuredOutput: producerCompleted?.data?.structured_output,
          },
        ],
      ])
    );
    expect(resumedPrompt).toBe(freshPrompt);
    expect(resumedPrompt).toBe('g=[true] items=[["a","b"]]');
  });

  it('implement pattern (PR #2627): a boolean travels producer → script binding with no artifact file', async () => {
    // Deliberately overlaps the AC4 script-env test's code path: this one exists as
    // the issue's named acceptance bar (#2627's `.green` bridge, replicated as a
    // fixture), so the acceptance claim stays pinned even if the AC4 test evolves.
    let checkPrompt: string | undefined;
    mockStructuredProducer(p => {
      checkPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-implement-pattern',
      description: 'the .green file bridge, replaced by a binding',
      nodes: [
        dagNodeSchema.parse({
          id: 'impl',
          prompt: 'PRODUCE the validation verdict',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'record',
          script: 'console.log(`green=${process.env.INPUTS_GREEN}`);',
          runtime: 'bun',
          depends_on: ['impl'],
          with: { green: '$impl.output.green' },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'recorded [$record.output]',
          depends_on: ['record'],
        }),
      ],
    };

    await runDag(workflow, 'transport-implement');
    expect(checkPrompt).toBe('recorded [green=true]');
  });

  it('deliver pattern (PR #2627): an all_done join binds two mutually exclusive producers via if_skipped, on both branches', async () => {
    const deliverWorkflow = (seed: 'initial' | 'iteration'): WorkflowDefinition => ({
      name: 'transport-deliver-pattern',
      description: 'the .ready latch, replaced by explicit skipped-branch bindings',
      nodes: [
        dagNodeSchema.parse({ id: 'route', bash: `printf '%s' ${seed}` }),
        dagNodeSchema.parse({
          id: 'initial-ready',
          bash: `printf '%s' '{"ready":true,"source":"initial"}'`,
          output_format: {
            type: 'object',
            properties: { ready: { type: 'boolean' }, source: { type: 'string' } },
          },
          depends_on: ['route'],
          when: "$route.output == 'initial'",
        }),
        dagNodeSchema.parse({
          id: 'iteration-ready',
          bash: `printf '%s' '{"ready":true,"source":"iteration"}'`,
          output_format: {
            type: 'object',
            properties: { ready: { type: 'boolean' }, source: { type: 'string' } },
          },
          depends_on: ['route'],
          when: "$route.output == 'iteration'",
        }),
        dagNodeSchema.parse({
          id: 'join',
          script:
            'console.log(`initial=${process.env.INPUTS_INITIAL}|iteration=${process.env.INPUTS_ITERATION}`);',
          runtime: 'bun',
          depends_on: ['initial-ready', 'iteration-ready'],
          trigger_rule: 'all_done',
          with: {
            initial: { from: '$initial-ready.output.ready', if_skipped: false },
            iteration: { from: '$iteration-ready.output.ready', if_skipped: false },
          },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'joined [$join.output]',
          depends_on: ['join'],
        }),
      ],
    });

    const checkPrompts: string[] = [];
    mockStructuredProducer(p => {
      checkPrompts.push(p);
    });
    await runDag(deliverWorkflow('initial'), 'transport-deliver-initial');
    expect(checkPrompts).toEqual(['joined [initial=true|iteration=false]']);

    checkPrompts.length = 0;
    await runDag(deliverWorkflow('iteration'), 'transport-deliver-iteration');
    expect(checkPrompts).toEqual(['joined [initial=false|iteration=true]']);
  });

  // --- loop_group producer bindings, the real deliver topology (#2696) ---
  //
  // `deliver`'s `gate-ready` binds `{ from: '$corrections.output', if_skipped: null }`
  // on a `loop_group` (not a plain node), joined via `trigger_rule: all_done`. Three
  // cases: the group completes, the group is skipped, and the group fails. All three
  // build the same shape — a bash-only `corrections` loop_group feeding a `gate-ready`
  // script node — so each test constructs its own `nodes` array inline rather than a
  // shared builder, keeping every producer state (completed/skipped/failed) visible at
  // its call site.

  it("loop_group binding (#2696): a completed group's output resolves through an all_done join, not the if_skipped default", async () => {
    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: 'console.log(process.env.INPUTS_CORRECTIONS);',
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: 'NO_CORRECTIONS_RAN' },
        },
      }),
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-completed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-completed'),
      })
    );

    // The group's real whole-ref output resolved — the `if_skipped` default never fired.
    expect(result).toBe('CORRECTIONS_APPLIED');
  });

  it("loop_group binding (#2696): a skipped group's binding takes if_skipped", async () => {
    const nodes = [
      dagNodeSchema.parse({ id: 'gate', bash: "printf 'skip'", depends_on: [] }),
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: ['gate'],
        when: "$gate.output == 'run'",
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: 'console.log(process.env.INPUTS_CORRECTIONS);',
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: 'NO_CORRECTIONS_RAN' },
        },
      }),
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-skipped', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-skipped'),
      })
    );

    // The group never ran — the binding took its declared default, unchanged by #2696.
    expect(result).toBe('NO_CORRECTIONS_RAN');
  });

  it("loop_group binding (#2696): a failed group's binding fails the consumer instead of resolving stale output", async () => {
    // Reproduces run 6607bf20 (issue #2696): the group fails via max_iterations
    // exhaustion, but its one completed iteration left real, non-empty output behind
    // (captured as `lastIterationOutput` before the completion check that then failed).
    // Before the fix, `gate-ready` would resolve that stale text as if the group had
    // succeeded and run its own body on it — the split-brain that flipped PR #2705.
    const markerPath = join(testDir, 'gate-ready-ran.marker');

    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 1',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        // A stand-in for `flip-ready`'s real public write: proves whether the
        // consumer's own body ever ran, independent of the run's overall status.
        script: `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.INPUTS_CORRECTIONS ?? '');`,
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: null },
        },
      }),
    ];

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform,
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-failed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-failed'),
      })
    );

    // gate-ready's body never executed — no public-write consequence from a failed group.
    expect(await Bun.file(markerPath).exists()).toBe(false);

    // The failure names both the failed producer and the node whose binding rejected it.
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain("Node 'gate-ready'");
    expect(sent).toContain("'corrections' failed");
  });

  // --- sibling gaps to the #2710 binding-directive fix (#2713) ---
  //
  // #2710 fixed exactly one reader of a failed producer's output: the `{ from,
  // if_skipped }` binding directive above. This test proves the sibling it explicitly
  // deferred — a PLAIN (non-directive) `with:` value, which can never use the directive
  // form and so never got #2710's protection — now fails the consumer too, using the
  // same `deliver`-shaped topology and failure mode as the tests above.
  it("sibling gaps (#2713): a failed group's PLAIN with: value fails the consumer instead of resolving stale output", async () => {
    const markerPath = join(testDir, 'gate-ready-plain-with-ran.marker');

    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 1',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.INPUTS_CORRECTIONS ?? '');`,
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        // Plain whole-ref value — NOT the { from, if_skipped } directive form. This
        // is resolveWorkflowValue's whole-ref tier, not resolveBindingDirective.
        with: {
          corrections: '$corrections.output',
        },
      }),
    ];

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform,
        conversationId: 'conv-lg-binding-plain',
        cwd: testDir,
        workflow: { name: 'lg-binding-plain-with-failed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-plain-with-failed'),
      })
    );

    // gate-ready's body never executed — no public-write consequence from a failed group.
    expect(await Bun.file(markerPath).exists()).toBe(false);

    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain("node 'corrections'");
    expect(sent).toContain('failed');
  });
});

describe('executeDagWorkflow -- substituted values reach the node verbatim (#4046)', () => {
  let testDir: string;
  // Reference syntax and a replacement pattern, as a brief that discusses the engine
  // quotes them. None of these may be read as template text once substituted.
  const quoted =
    "Check $gate.output.decision, read $gate.output, use $INPUTS.plan, keep $& and it's done.";

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-verbatim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  const prompts = (): string[] => mockSendQueryDag.mock.calls.map(call => call[0] as string);

  async function runPrompt(
    prompt: string,
    options: { userMessage?: string; issueContext?: string } = {}
  ): Promise<MockWorkflowStore> {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        ...(options.issueContext !== undefined ? { issueContext: options.issueContext } : {}),
        workflow: {
          name: 'verbatim',
          nodes: [{ id: 'summarize', kind: 'agent', source: { kind: 'inline', prompt } }],
        },
        workflowRun: makeWorkflowRun('verbatim-run', {
          user_message: options.userMessage ?? 'plain request',
        }),
      })
    );
    return store;
  }

  it('sends the run message exactly as written', async () => {
    const store = await runPrompt('Summarize this request: $ARGUMENTS', { userMessage: quoted });

    expect(prompts()).toEqual([`Summarize this request: ${quoted}`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it('sends issue context exactly as written, substituted or appended', async () => {
    const substituted = await runPrompt('Context: $CONTEXT', { issueContext: quoted });
    expect(substituted.failWorkflowRun).not.toHaveBeenCalled();
    expect(prompts()).toEqual([`Context: ${quoted}`]);

    mockSendQueryDag.mockClear();
    const appended = await runPrompt('Review the issue.', { issueContext: quoted });
    expect(appended.failWorkflowRun).not.toHaveBeenCalled();
    expect(prompts()).toEqual([`Review the issue.\n\n---\n\n${quoted}`]);
  });

  it('does not read a run message that names a context variable as the issue context', async () => {
    await runPrompt('Request: $ARGUMENTS', {
      userMessage: 'explain $CONTEXT',
      issueContext: 'ISSUE BODY',
    });
    expect(prompts()).toEqual(['Request: explain $CONTEXT\n\n---\n\nISSUE BODY']);
  });

  it("sends an upstream node's output exactly as written", async () => {
    const upstream = 'Use $ARGUMENTS and $INPUTS.plan and $gate.output and $& here';
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: upstream };
      yield { type: 'result', sessionId: 'verbatim-upstream' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-upstream',
          nodes: [
            { id: 'gate', kind: 'agent', source: { kind: 'inline', prompt: 'decide' } },
            {
              id: 'act',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Got: $gate.output' },
              depends_on: ['gate'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-upstream-run'),
      })
    );

    expect(prompts()).toEqual(['decide', `Got: ${upstream}`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it('still fails a mistyped field reference in the template with the unknown-node error', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"decision":"approve"}' };
      yield { type: 'result', sessionId: 'verbatim-typo' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-typo',
          nodes: [
            { id: 'gate', kind: 'agent', source: { kind: 'inline', prompt: 'decide' } },
            {
              id: 'act',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Act on $gaet.output.decision' },
              depends_on: ['gate'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-typo-run'),
      })
    );

    const failure = (store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock
      .calls[0]?.[1];
    expect(failure).toContain(
      "'$gaet.output.decision' references node 'gaet', but no node with that id has produced output"
    );
    expect(failure).toContain("Did you mean: 'gate'?");
  });

  it('sends a rejection reason exactly as written to the rework prompt', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-reject',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Fix based on: $REJECTION_REASON', maxAttempts: 3 },
                },
              ],
              captureResponse: true,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-reject-run', {
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve this plan?',
              onRejectPrompt: 'Fix based on: $REJECTION_REASON',
              onRejectMaxAttempts: 3,
            },
            rejection_reason: quoted,
            rejection_count: 1,
          },
        }),
      })
    );

    expect(prompts()).toEqual([`Fix based on: ${quoted}`]);
    // The rework succeeded, so the gate re-pauses for another review.
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("sends a loop node's previous output exactly as written", async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? quoted : 'DONE' };
      yield { type: 'result', sessionId: `verbatim-loop-${calls}` };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-loop',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                prompt: 'Previous: [$LOOP_PREV_OUTPUT]',
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-loop-run'),
      })
    );

    expect(prompts()[1]).toBe(`Previous: [${quoted}]`);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('sends an interactive loop_group reply exactly as written to a body prompt', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DONE' };
      yield { type: 'result', sessionId: 'verbatim-reply' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-reply',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                interactive: true,
                gate_message: 'Review and reply.',
                nodes: [
                  {
                    id: 'revise',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Reply: [$LOOP_USER_INPUT]' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-reply-run', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'grp',
              iteration: 0,
              message: 'Review and reply.',
            },
            loop_user_input: quoted,
            loop_feedback_given: true,
          },
        }),
      })
    );

    expect(prompts()).toEqual([`Reply: [${quoted}]`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('sends a previous-iteration output exactly as written to a loop_group body prompt', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? quoted : 'DONE' };
      yield { type: 'result', sessionId: `verbatim-prev-${calls}` };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-prev',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                nodes: [
                  {
                    id: 'draft',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Prior: [$LOOP_PREV.draft.output]' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-prev-run'),
      })
    );

    expect(prompts()).toEqual(['Prior: []', `Prior: [${quoted}]`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });
});
