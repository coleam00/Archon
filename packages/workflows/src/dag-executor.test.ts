// @archon-test-isolated
import { buildRunTerminalTelemetry } from './run-terminal-telemetry';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import {
  type MockWorkflowStore,
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  minimalConfig,
  resolveTestWorkflow,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from './dag/test-utils';
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from './dag-executor';
import { childOutcomeFromRun, type RunChildWorkflowFn } from './dag/child-run';
import type { DagNode } from './schemas';
import type { IWorkflowStore } from './store';

describe('executeDagWorkflow options type contract', () => {
  it('requires workflowModel even when it resolves to undefined', () => {
    const validOptions: ExecuteDagWorkflowOptions = {
      deps: createMockDeps(),
      platform: createMockPlatform(),
      conversationId: 'type-contract',
      cwd: '/tmp/type-contract',
      workflow: resolveTestWorkflow({ name: 'type-contract', nodes: [] }),
      workflowRun: makeWorkflowRun('type-contract'),
      workflowProvider: 'claude',
      workflowModel: undefined,
      artifactsDir: '/tmp/type-contract/artifacts',
      stateDir: '/tmp/type-contract/state',
      logDir: '/tmp/type-contract/logs',
      baseBranch: 'main',
      docsDir: 'docs',
      config: minimalConfig,
    };

    const { workflowModel, ...withoutWorkflowModel } = validOptions;
    expect(workflowModel).toBeUndefined();

    // @ts-expect-error workflowModel is a required resolved-policy input, even when undefined.
    const missingWorkflowModel: ExecuteDagWorkflowOptions = withoutWorkflowModel;
    expect(missingWorkflowModel).not.toHaveProperty('workflowModel');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TokenUsage axis seam guard (#2674)
//
// `TokenUsage` crosses boundaries where its fields are re-listed by hand on
// both sides, with nothing tying writer to reader. #2662 added one optional
// field, `cachePartial`, and three carrying sites dropped it while the full
// suite stayed green.
//
// The guard is two TYPE-level anchors plus runtime proof of what they claim:
//
//   1. `Required<TokenUsage>` — adding an axis makes AXIS_SPECIMEN a compile
//      error, so `bun run type-check` fails before a single test runs.
//   2. `Record<keyof TokenUsage, string | null>` — each seam's key map is
//      exhaustive, so a new axis must be dispositioned per seam: a key it is
//      carried under, or `null` for "this seam deliberately does not carry it".
//   3. Every non-null entry is then driven through the REAL production path,
//      because a declared key spelling is only a claim until a run proves it.
//
// SCOPE: the workflow engine's seams. `getDagResumeSnapshot` is one of them but
// lives in @archon/core, which this package cannot import; it is guarded there,
// under the same block name. Both packages compile their anchors through their
// normal TypeScript projects.
//
// Two hand-mapped hops are deliberately OUTSIDE the guard, both in telemetry:
//   - `captureChatTurn` (@archon/core orchestrator-agent) maps usage for the
//     direct-chat path, carrying gross totals only;
//   - `@archon/paths` remaps `buildRunUsageProps`'s output a fourth time on the
//     way to PostHog, and sits at the root of the dependency order, so it cannot
//     import `TokenUsage` and no anchor can fire there.
// A new axis therefore reaches PostHog only if someone follows it past this
// block. Tracked separately; this block covers the first hop, where the
// `TokenUsage` axes are still named.
//
// What this guard does NOT do: make a new *site* loud. No type can require an
// author to register the hand-mapped seam they just wrote. The maps below are
// the discoverable inventory a reviewer checks a new site against.
// ───────────────────────────────────────────────────────────────────────────
describe('TokenUsage axis seam guard', () => {
  /**
   * One value per axis, all distinct so a swapped key spelling fails instead of
   * passing on a coincidence.
   *
   * `Required<TokenUsage>` is the anchor. Adding `foo?: number` to TokenUsage
   * fails here with `TS2741: Property 'foo' is missing in type ... but required
   * in type 'Required<TokenUsage>'`.
   *
   * A provider never sets `cachePartial` — it is aggregation-only (see the field
   * docs in @archon/providers types). The specimen sets it anyway because this
   * guard tests CARRIAGE, not the fold rule that normally produces the flag;
   * `mergeTokenUsage` propagates an incoming `cachePartial`, so a one-node run
   * is enough to observe the axis at every seam.
   */
  const AXIS_SPECIMEN: Required<TokenUsage> = {
    input: 5000,
    output: 1200,
    cacheRead: 4000,
    cacheWrite: 250,
    cachePartial: true,
    total: 6400,
    cost: 0.25,
  };

  /**
   * How one seam spells each axis on its wire. `null` = this seam deliberately
   * does not carry the axis. Exhaustive over `keyof TokenUsage`, so a new axis
   * is a compile error at every seam until someone decides which it is.
   */
  type SeamAxisKeys = Record<keyof TokenUsage, string | null>;

  /**
   * Seams that carry the `TokenUsage` object whole, so the axis names ARE the
   * wire keys. They share one map because they share one decision: a new axis
   * either rides the object or does not. Each still gets its own assertion —
   * "carries it whole" is a claim about today's code, not a guarantee.
   *
   * `total` and `cost` cross none of the seams below, and both `null`s are
   * load-bearing — each is asserted absent, not merely declared:
   *  - No seam below reads `TokenUsage.cost`. Each carries its own scalar
   *    (`total_cost_usd`, `cost_usd`, `costUsd`, `signaledCostUsd`) sourced from
   *    the result message's `cost` field, which providers are expected to set —
   *    Pi's event bridge copies it there. `opencode/multi-agent.ts` does not, so
   *    on that path cost is stranded on the usage object. The fold seam carries
   *    no cost scalar at all.
   *  - `total` is set by several providers (Claude, Pi, and both OpenCode
   *    paths — the multi-agent one re-synthesizes it after its own internal
   *    fold) and then dropped by the engine's fold: `mergeTokenUsage` documents
   *    that it does not aggregate it. So no seam below carries it. It is NOT a
   *    dead axis: it is read by `formatCostFooter` in @archon/adapters on the
   *    direct-chat path, which never folds, and by OpenCode's own multi-agent
   *    sum. Recorded, not fixed.
   */
  const WHOLE_OBJECT_AXIS_KEYS: SeamAxisKeys = {
    input: 'input',
    output: 'output',
    cacheRead: 'cacheRead',
    cacheWrite: 'cacheWrite',
    cachePartial: 'cachePartial',
    total: null,
    cost: null,
  };

  /** Run metadata written by persistRunUsage and read back by childOutcomeFromRun. */
  const RUN_METADATA_AXIS_KEYS: SeamAxisKeys = {
    input: 'total_tokens_in',
    output: 'total_tokens_out',
    cacheRead: 'total_cache_read_tokens',
    cacheWrite: 'total_cache_write_tokens',
    cachePartial: 'total_cache_partial',
    total: null,
    cost: null,
  };

  /** Terminal telemetry props — a third spelling, remapped again inside @archon/paths. */
  const TELEMETRY_AXIS_KEYS: SeamAxisKeys = {
    input: 'tokensIn',
    output: 'tokensOut',
    cacheRead: 'cacheReadTokens',
    cacheWrite: 'cacheWriteTokens',
    cachePartial: 'cachePartialTokens',
    total: null,
    cost: null,
  };

  /**
   * Assert that every axis `keys` declares carried arrived under its declared key
   * with the specimen's value, AND that every axis it declares `null` really is
   * absent.
   *
   * The negative half matters as much as the positive one. Without it a `null`
   * asserts nothing and stays green forever after it stops being true — teach
   * `mergeTokenUsage` to aggregate `total` and it would start flowing to the
   * seams that spread the object whole while the ones that rebuild or rename it
   * drop it — with every map still reading `total: null` and every row green.
   * That is #2662 again, for the axis most likely to move next.
   *
   * Seam and axis are folded into the compared object's KEY, not into a sibling
   * field: bun's diff prints only a narrow window around the changed line, so a
   * sibling `axis` field is elided from the failure and the report names the seam
   * without saying which axis went missing.
   */
  function expectSeamCarriesAxes(
    seam: string,
    keys: SeamAxisKeys,
    carried: Record<string, unknown> | undefined
  ): void {
    expect({ [`${seam} carried usage`]: carried !== undefined }).toEqual({
      [`${seam} carried usage`]: true,
    });
    for (const [axis, key] of Object.entries(keys) as [keyof TokenUsage, string | null][]) {
      if (key === null) {
        // No declared key to look under, so the axis's own name is what a
        // careless passthrough would surface it as.
        const label = `${seam} → ${axis} (declared not carried)`;
        expect({ [label]: carried?.[axis] }).toEqual({ [label]: undefined });
        continue;
      }
      const label = `${seam} → ${axis} (as '${key}')`;
      expect({ [label]: carried?.[key] }).toEqual({ [label]: AXIS_SPECIMEN[axis] });
    }
  }

  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-axis-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
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
    // Restore the file-level provider stubs. `mockClear()` drops call records
    // but leaves implementations in place, and this block's last test installs a
    // generator that yields "should never run" — a describe appended after this
    // one (the header invites exactly that) would inherit it.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(_provider => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  /**
   * One AI node whose provider reports the specimen. Four seams read off this
   * single run: the node event, the run metadata, the telemetry props, and the
   * JSONL transcript row.
   */
  async function runSpecimenDag(outcome: 'completed' | 'failed' = 'completed'): Promise<{
    store: MockWorkflowStore;
    runId: string;
    logDir: string;
  }> {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield {
        type: 'result',
        sessionId: 'axis-sid',
        tokens: AXIS_SPECIMEN,
        // The provider reports its usage and its failure on the SAME chunk, so the
        // node reaches a failure writer with the specimen already accumulated. Any
        // earlier throw would leave nothing for the failure sink to carry, and the
        // row would pass the guard by being empty on both sides.
        ...(outcome === 'failed' ? { isError: true, errorSubtype: 'stream_error' } : {}),
      };
    });
    const store = createMockStore();
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun(`axis-seam-run-${outcome}`);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'axis-seam',
          nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
        },
        workflowRun,
        logDir,
      })
    );
    return { store, runId: workflowRun.id, logDir };
  }

  function nodeCompletedTokens(store: MockWorkflowStore, stepName: string): unknown {
    const completed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => {
        const event = call[0] as { event_type: string; step_name?: string };
        return event.event_type === 'node_completed' && event.step_name === stepName;
      }
    );
    expect(completed.length).toBe(1);
    return (
      (completed[0][0] as { data: Record<string, unknown> }).data as {
        tokens?: Record<string, unknown>;
      }
    ).tokens;
  }

  it('aggregation fold (mergeTokenUsage) carries every axis it claims', () => {
    // The chokepoint: every other seam's value passes through this fold first.
    // It rebuilds `{input, output}` rather than spreading, which is why a new
    // axis needs a deliberate merge rule here before any seam can carry it.
    expectSeamCarriesAxes(
      'mergeTokenUsage',
      WHOLE_OBJECT_AXIS_KEYS,
      mergeTokenUsage([AXIS_SPECIMEN]) as unknown as Record<string, unknown>
    );
  });

  it('node_completed event carries every axis it claims', async () => {
    const { store } = await runSpecimenDag();
    expectSeamCarriesAxes(
      'node_completed.data.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeCompletedTokens(store, 'step') as Record<string, unknown>
    );
  });

  it('run metadata round-trips every axis it claims, writer to reader', async () => {
    const { store } = await runSpecimenDag();
    const written = runUsageWrites(store);
    expect(written.length).toBe(1);
    expectSeamCarriesAxes('run metadata (write)', RUN_METADATA_AXIS_KEYS, written[0]);
    expectSeamCarriesAxes(
      'run metadata (read)',
      WHOLE_OBJECT_AXIS_KEYS,
      childOutcomeFromRun(
        makeWorkflowRun('axis-child', { status: 'completed', metadata: written[0] })
      ).tokens as unknown as Record<string, unknown>
    );
  });

  it('terminal telemetry props carry every axis they claim', () => {
    // The run store projects terminal telemetry from the cumulative usage fold, so
    // this hop starts at that fold's output rather than at a DAG run.
    const { cost: _cost, total: _total, ...tokens } = AXIS_SPECIMEN;
    const props = buildRunTerminalTelemetry({
      run: {
        id: 'axis-run',
        workflow_name: 'axis',
        parent_run_id: null,
        status: 'completed',
        metadata: {},
      },
      events: [],
      usage: { costUsd: AXIS_SPECIMEN.cost, tokens },
    });
    expectSeamCarriesAxes(
      'telemetry props',
      TELEMETRY_AXIS_KEYS,
      props as unknown as Record<string, unknown>
    );
  });

  it('JSONL transcript node_complete row carries every axis it claims', async () => {
    const { runId, logDir } = await runSpecimenDag();
    const rows = await readTranscript(logDir, runId);
    const nodeComplete = rows.find(row => row.type === 'node_complete' && row.step === 'step');
    expectSeamCarriesAxes(
      'JSONL node_complete.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeComplete?.tokens as Record<string, unknown>
    );
  });

  it('JSONL transcript node_error row carries every axis it claims', async () => {
    // The failure sink joins the guard here (#2693). It reuses the whole-object map
    // because logNodeError spreads the same WorkflowUsage carrier logNodeComplete
    // does — one decision, so a new axis either rides both rows or neither.
    const { runId, logDir } = await runSpecimenDag('failed');
    const rows = await readTranscript(logDir, runId);
    const nodeError = rows.find(row => row.type === 'node_error' && row.step === 'step');
    expectSeamCarriesAxes(
      'JSONL node_error.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeError?.tokens as Record<string, unknown>
    );
  });

  it('loop gate round-trips every axis it claims, pause to resume', async () => {
    // Writer: the gate persists the loop's cumulative usage whole.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Pass one. <promise>APPROVED</promise>' };
      yield { type: 'result', sessionId: 'axis-loop-sid', tokens: AXIS_SPECIMEN };
    });
    const loopNodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop',
        loop: {
          fresh_context: false,
          prompt: 'Refine.',
          until: 'APPROVED',
          max_iterations: 10,
          interactive: true,
          gate_message: 'Review.',
        },
      },
    ];
    const pausingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: pausingDeps,
        cwd: testDir,
        workflow: { name: 'axis-loop-pause', nodes: loopNodes },
        workflowRun: makeWorkflowRun('axis-loop-pause-run'),
      })
    );
    const pauseCalls = (
      pausingDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    const signaledTokens = (pauseCalls[0][1] as { signaledTokens?: Record<string, unknown> })
      .signaledTokens;
    expectSeamCarriesAxes('loop gate (write)', WHOLE_OBJECT_AXIS_KEYS, signaledTokens);

    // Reader: readSignaledTokens decodes it through a fixed key destructure.
    // Resumed on a BARE approve so the finalize path (#2074) completes from the
    // persisted usage without running another iteration — a new iteration would
    // add its own usage and destroy the value identity this assertion needs.
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });
    const resumingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: resumingDeps,
        cwd: testDir,
        workflow: { name: 'axis-loop-resume', nodes: loopNodes },
        workflowRun: makeWorkflowRun('axis-loop-resume-run', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              sessionId: 'axis-loop-sid',
              message: 'gate',
              completionSignaled: true,
              signaledOutput: 'REPORT',
              signaledTokens,
            },
            loop_user_input: 'Approved',
            loop_feedback_given: false,
          },
        }),
      })
    );
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expectSeamCarriesAxes(
      'loop gate (read)',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeCompletedTokens(resumingDeps.store, 'refine') as Record<string, unknown>
    );
  });
});

describe('executeDagWorkflow -- unified node-state sinks (#3255)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-unified-sinks-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('retains cause on trigger_rule skip in the transcript', async () => {
    const store = createMockStore();
    const logDir = join(testDir, 'trigger-rule-logs');
    const workflowRun = makeWorkflowRun('trigger-rule-run');

    const failingNode: DagNode = {
      id: 'step1',
      kind: 'exec',
      runtime: 'sh',
      script: 'exit 1',
    };
    const dependentNode: DagNode = {
      id: 'step2',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo done',
      depends_on: ['step1'],
      trigger_rule: 'all_success',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'trigger-rule-workflow',
          nodes: [failingNode, dependentNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const skipRow = rows.find(r => r.type === 'node_skipped' && r.step === 'step2');
    expect(skipRow).toBeDefined();
    expect(skipRow?.content).toBe('trigger_rule');
    expect(skipRow?.cause).toEqual({ kind: 'upstream_failed', origin: 'step1' });
  });

  it('the seven functions emit transcript rows: child workflow, fan-out, loop group, durable wait produce completions in transcript', async () => {
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(testDir, '.archon', 'workflows', 'dummy-child-fanout.yaml'),
      'name: dummy-child-fanout\ndescription: dummy child\nmutates_checkout: false\nnodes:\n  - id: inner\n    bash: echo child\n'
    );

    const store = createMockStore();
    const logDir = join(testDir, 'four-completions-logs');
    const persistedWait = {
      owner: 'node' as const,
      nodeId: 'wait-node',
      kind: 'attention' as const,
      message: 'continue',
      waitingSince: '2026-08-23T00:00:00.000Z',
    };
    const workflowRun = makeWorkflowRun('four-completions-run', {
      metadata: { wait: persistedWait },
    });

    const waitNode: DagNode = {
      id: 'wait-node',
      kind: 'wait',
      wait: { attention: 'continue' },
    };
    const childNode: DagNode = {
      id: 'child-node',
      kind: 'workflow',
      workflow: 'dummy-child',
      depends_on: ['wait-node'],
    };
    const fanOutNode: DagNode = {
      id: 'fanout-node',
      kind: 'workflow',
      workflow: 'dummy-child-fanout',
      depends_on: ['child-node'],
      fan_out: {
        items: '["item1", "item2"]',
        max_parallel: 2,
        join: 'all_success',
      },
    };
    const loopGroupNode: DagNode = {
      id: 'loop-group-node',
      kind: 'loop_group',
      depends_on: ['fanout-node'],
      loop_group: {
        max_iterations: 1,
        fresh_context: true,
        until: 'DONE',
        nodes: [
          {
            id: 'inner',
            kind: 'exec',
            runtime: 'sh',
            script: 'echo DONE',
          },
        ],
      },
    };

    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => ({
      status: 'completed' as const,
      output: 'child-output',
      childRunId: `subrun-${args.nodeId}`,
    }));

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        runChildWorkflow,
        workflow: {
          name: 'all-four-completions',
          nodes: [waitNode, childNode, fanOutNode, loopGroupNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const completeSteps = rows.filter(r => r.type === 'node_complete').map(r => r.step);

    expect(completeSteps).toContain('wait-node');
    expect(completeSteps).toContain('child-node');
    expect(completeSteps).toContain('fanout-node');
    expect(completeSteps).toContain('loop-group-node');
  });

  it('assertCheckoutUntouched writes node_error transcript row on mutates_checkout failure', async () => {
    await git.execFileAsync('git', ['init', '-q'], { cwd: testDir });
    await git.execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'],
      { cwd: testDir }
    );

    const store = createMockStore();
    const logDir = join(testDir, 'untouched-logs');
    const workflowRun = makeWorkflowRun('untouched-run');

    const violatingNode: DagNode = {
      id: 'violator',
      kind: 'exec',
      runtime: 'sh',
      script: 'touch modified-file.txt',
      mutates_checkout: false,
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'violator-workflow',
          nodes: [violatingNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const errorRow = rows.find(r => r.type === 'node_error' && r.step === 'violator');
    expect(errorRow).toBeDefined();
    expect(String(errorRow?.error)).toContain(
      'declared `mutates_checkout: false` but modified the working tree'
    );
  });

  it('persisted data payloads are unchanged and rebuild identical node state across resume', async () => {
    const store = createMockStore();
    const logDir = join(testDir, 'resume-fixture-logs');
    const workflowRun = makeWorkflowRun('resume-fixture-run');

    const node1: DagNode = {
      id: 'producer',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo producer-output',
    };
    const node2: DagNode = {
      id: 'consumer',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo consumer-output',
      depends_on: ['producer'],
    };

    // Run first pass
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'resume-fixture-wf',
          nodes: [node1, node2],
        },
      })
    );

    // Collect persisted node_completed event for producer
    const producerEvent = store.persistWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(e => e.event_type === 'node_completed' && e.step_name === 'producer');

    expect(producerEvent).toBeDefined();
    expect(producerEvent?.data).toMatchObject({
      type: 'bash',
      node_output: 'producer-output',
    });

    // Simulate resume using the exact persisted data
    const snapshotStore = createMockStore();
    (
      snapshotStore.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>
    ).mockResolvedValue({
      completedNodeOutputs: new Map([
        ['producer', { output: producerEvent!.data!.node_output as string }],
      ]),
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    });

    const resumedRun = makeWorkflowRun('resume-fixture-run-resumed');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(snapshotStore),
        cwd: testDir,
        workflowRun: resumedRun,
        logDir: join(testDir, 'resume-fixture-logs-2'),
        priorCompletedNodes: new Map([
          ['producer', { output: producerEvent!.data!.node_output as string }],
        ]),
        workflow: {
          name: 'resume-fixture-wf',
          nodes: [node1, node2],
        },
      })
    );

    // Producer was skipped due to prior success, consumer completed
    const resumedEvents = snapshotStore.persistWorkflowEvent.mock.calls.map(([e]) => e);
    const priorSuccess = resumedEvents.find(
      e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'producer'
    );
    expect(priorSuccess).toBeDefined();
    expect(priorSuccess?.data?.reason).toBe('prior_success');
  });
});
