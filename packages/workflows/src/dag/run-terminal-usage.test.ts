// @archon-test-isolated
import * as runControl from './run-control';
import { readNodeRecordEvent } from '../node-record-reader';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { inspectResumableRun } from '../run-resume';
import { NodeEventWriteError } from '../node-event-write';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  setSystemTime,
  spyOn,
  type Mock,
} from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockLogFn,
  type MockWorkflowStore,
  createMockStore,
  runUsageWrites,
  authoredOutcomeWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  failedLoopIterations,
  minimalConfig,
  type TestWorkflowDefinition,
  type DagOptionsOverrides,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from './test-utils';
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from '../dag-executor';
import type { DagNode, AgentNode, ExecNode, WorkflowRun } from '../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../store';
import { captureWorkflowSource, capturedSourceRoots } from '../workflow-source';

/**
 * #2469 — a run's spend has to survive its outcome. Usage used to be written only in
 * the metadata argument of completeWorkflowRun, so anything other than a clean
 * completion recorded nothing at all: the number was simply lower than reality, in the
 * direction that does not prompt investigation.
 */
describe('executeDagWorkflow -- run usage survives every disposition', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

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

  it('records what a FAILED run burned before it died', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'partial output before failure' };
      yield {
        type: 'result',
        sessionId: 'sid-1',
        cost: 0.05,
        tokens: { input: 900, output: 90, cacheRead: 700, cacheWrite: 0 },
        isError: true,
        errorSubtype: 'stream_error',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('usage-failure-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-usage',
        cwd: testDir,
        workflow: {
          name: 'usage-on-failure',
          nodes: [
            {
              id: 'spend-and-die',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Burn some tokens, then fail.' },
              retry: { max_attempts: 1, delay_ms: 1 },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(runUsageWrites(store)).toEqual([
      {
        total_cost_usd: 0.05,
        total_tokens_in: 900,
        total_tokens_out: 90,
        total_cache_read_tokens: 700,
        total_cache_write_tokens: 0,
      },
    ]);
    const errorRow = (await readTranscript(join(testDir, 'logs'), workflowRun.id)).find(
      row => row.type === 'workflow_error'
    );
    expect(errorRow?.cost_usd).toBe(0.05);
    expect(errorRow?.tokens).toEqual({
      input: 900,
      output: 90,
      cacheRead: 700,
      cacheWrite: 0,
    });
  });

  it('a node that fails mid-stream reports its spend in the transcript, not just the DB', async () => {
    // #2609's worked example. Node A completes at $0.01; a `loop_group` body burns
    // $0.02 and then the provider throws. The DB row has carried that $0.02 since #2654
    // — the JSONL failure row did not, because logNodeError had no usage parameter. The
    // two sinks disagreeing about what a node cost is the bug. The body sits under a
    // group so the failure path also has a restatement row above it to keep honest.
    let call = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      call++;
      if (call === 1) {
        yield { type: 'agent_message_chunk', text: 'node A output' };
        yield { type: 'result', sessionId: 'sid-a', cost: 0.01, tokens: { input: 10, output: 1 } };
        return;
      }
      // The body node streams, reports what it burned, and the same result chunk carries
      // the provider's error — so it throws with its usage already accumulated. This is
      // the ordering that makes the bug reachable: the spend is real and the node still
      // ends at a failure writer.
      yield { type: 'agent_message_chunk', text: 'node B got this far' };
      yield {
        type: 'result',
        sessionId: 'sid-b',
        cost: 0.02,
        tokens: { input: 20, output: 2 },
        isError: true,
        errorSubtype: 'stream_error',
      };
    });

    const store = createMockStore();
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun('spend-transcript-run');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-spend',
        cwd: testDir,
        workflow: {
          name: 'spend-transcript',
          nodes: [
            { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'Cheap work.' } },
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'b',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Expensive work that dies.' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: ['a'],
            },
          ],
        },
        workflowRun,
        logDir,
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);

    const failureRow = rows.find(row => row.type === 'node_error' && row.step === 'b');
    expect(failureRow?.cost_usd).toBe(0.02);
    expect(failureRow?.tokens).toEqual({ input: 20, output: 2 });

    // The completed node was already right; asserting it here proves the transcript
    // now accounts for the whole run rather than trading one gap for another.
    const completeRow = rows.find(row => row.type === 'node_complete' && row.step === 'a');
    expect(completeRow?.cost_usd).toBe(0.01);

    // The group's own failure row restates the body's $0.02, which that body already
    // reported, so it reports none of its own (#3508). A failed restatement is the one
    // a run that spent money and then died cannot afford to re-report.
    const rollUp = rows.find(row => row.type === 'node_error' && row.step === 'grp');
    expect(rollUp).toBeDefined();
    expect(rollUp).not.toHaveProperty('cost_usd');
    // Counting the error rows, not only the completed ones, is what makes this fail if a
    // failed restatement row starts reporting again.
    expect(
      rows
        .filter(row => row.type === 'node_complete' || row.type === 'node_error')
        .reduce((total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0), 0)
    ).toBeCloseTo(0.03, 5);

    // Same figure in the persisted event: the fix closes the gap between the sinks
    // rather than moving it.
    const failedEvents = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (c: unknown[]) => {
        const e = c[0] as { event_type: string; step_name?: string };
        return e.event_type === 'node_failed' && e.step_name === 'grp.b';
      }
    );
    expect(failedEvents.length).toBe(1);
    expect((failedEvents[0][0] as { data: Record<string, unknown> }).data.cost_usd).toBe(0.02);
    expect(typeof (failedEvents[0][0] as { data: Record<string, unknown> }).data.duration_ms).toBe(
      'number'
    );

    // And the run total is the money burned across both nodes — the group restating the
    // body's spend in its own result does not add to it.
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.03, total_tokens_in: 30, total_tokens_out: 3 },
    ]);
  });

  it.each([
    { kind: 'loop', fault: 'shell', retry: false },
    { kind: 'loop', fault: 'shell', retry: true },
    { kind: 'loop', fault: 'listing', retry: false },
    { kind: 'loop', fault: 'spawn', retry: false },
    { kind: 'loop_group', fault: 'shell', retry: false },
    { kind: 'loop_group', fault: 'listing', retry: false },
    { kind: 'loop_group', fault: 'spawn', retry: false },
  ] as const)('$kind retains paid usage after $fault throws (retry: $retry)', async test => {
    const store = createMockStore();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    const tokens = { input: 100, output: 20, cacheRead: 40, cacheWrite: 5 };
    const invalidShell = join(
      testDir,
      test.fault === 'spawn' ? 'nonexecutable-bash' : 'missing-bash'
    );
    if (test.fault === 'spawn') await writeFile(invalidShell, '', { mode: 0o600 });
    const listingDir = join(testDir, 'artifacts', '.archon', 'typed-artifacts');
    const savedBashPath = process.env.ARCHON_BASH_PATH;
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Paid work.' };
      yield { type: 'result', sessionId: 'paid-session', cost: 0.25, tokens };
      if (test.fault !== 'listing') process.env.ARCHON_BASH_PATH = invalidShell;
      else {
        await removeTempTree(listingDir);
        await writeFile(listingDir, 'blocks directory creation');
      }
    });
    const node: DagNode =
      test.kind === 'loop'
        ? {
            id: 'work',
            kind: 'loop',
            loop: {
              prompt: 'Work.',
              until_bash: test.fault === 'listing' ? 'false' : 'true',
              max_iterations: 3,
              fresh_context: false,
            },
            ...(test.retry ? { retry: { max_attempts: 2, delay_ms: 1 } } : {}),
          }
        : {
            id: 'work',
            kind: 'loop_group',
            loop_group: {
              until_bash: 'true',
              max_iterations: 3,
              fresh_context: false,
              nodes: [{ id: 'body', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } }],
            },
          };
    try {
      const iterations = await failedLoopIterations('work', () =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform,
            cwd: testDir,
            logDir: join(testDir, 'logs'),
            workflowRun,
            workflow: { name: 'loop-thrown-usage', nodes: [node] },
          })
        )
      );
      expect(iterations).toBe(1);
    } finally {
      if (savedBashPath === undefined) delete process.env.ARCHON_BASH_PATH;
      else process.env.ARCHON_BASH_PATH = savedBashPath;
    }
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    const events = persistedEvents(store);
    const failures = events.filter(event => event.event_type === 'node_failed');
    expect(failures).toHaveLength(1);
    const failed = failures[0];
    expect(failed.step_name).toBe('work');
    expect(failed.data?.failure_kind).toBe('unknown');
    expect(failed.data?.error).toContain(test.fault === 'listing' ? listingDir : invalidShell);
    if (test.fault === 'listing') expect(failed.data?.error).toContain('EEXIST');
    if (test.fault === 'spawn') expect(failed.data?.error).toContain('cannot execute bash');
    expect(failed.data?.cost_usd).toBe(0.25);
    expect(failed.data?.spend).toMatchObject({
      costUsd: { source: 'provider', value: 0.25 },
      tokens: { source: 'provider', value: tokens },
    });
    expect(
      events.filter(event => event.event_type === 'node_completed' && event.step_name === 'work')
    ).toHaveLength(0);
    expect(runUsageWrites(store)).toEqual([
      {
        total_cost_usd: 0.25,
        total_tokens_in: 100,
        total_tokens_out: 20,
        total_cache_read_tokens: 40,
        total_cache_write_tokens: 5,
      },
    ]);
    const snapshot = await foldDagResumeSnapshot(events, workflowRun.id);
    expect(snapshot.costUsd).toBe(0.25);
    expect(snapshot.tokens).toEqual(tokens);
    expect(snapshot.completedNodeOutputs.has('work')).toBe(false);
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const failureRow = rows.find(row => row.type === 'node_error' && row.step === 'work');
    expect(failureRow).toBeDefined();
    if (test.kind === 'loop') {
      expect(failureRow?.cost_usd).toBe(0.25);
      expect(failureRow?.tokens).toEqual(tokens);
    } else {
      expect(failed.data?.accounting).toBe('aggregate');
      expect(
        events.filter(
          event => event.event_type === 'node_completed' && event.step_name === 'work.body'
        )
      ).toHaveLength(1);
      expect(failureRow).not.toHaveProperty('cost_usd');
      expect(failureRow).not.toHaveProperty('tokens');
    }
    expect(
      rows
        .filter(row => row.type === 'node_complete' || row.type === 'node_error')
        .reduce((total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0), 0)
    ).toBe(0.25);
    const messages = platform.sendMessage.mock.calls.map(call => call[1]).join('\n');
    expect(messages).toContain(String(failed.data?.error));
    expect(messages).not.toContain('failed before execution');
  });

  it.each([
    'post-body cancel',
    'between-iteration cancel',
    'until-bash cancel',
    'completion error',
  ] as const)('loop_group retains paid usage on %s', async exit => {
    const store = createMockStore();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    let status: 'running' | 'cancelled' = 'running';
    let calls = 0;
    store.getWorkflowRunStatus.mockImplementation(async () => status);
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'Paid work.' };
      yield {
        type: 'result',
        sessionId: `paid-${calls}`,
        cost: 0.05,
        tokens: { input: 100, output: 10, cacheRead: 40, cacheWrite: 5 },
      };
      if (exit === 'post-body cancel' && calls === 2) status = 'cancelled';
    });
    store.createWorkflowEvent.mockImplementation(async event => {
      if (
        exit === 'between-iteration cancel' &&
        event.event_type === 'loop_iteration_completed' &&
        event.step_name === 'grp' &&
        event.data?.iteration === 2
      )
        status = 'cancelled';
    });
    const shell =
      exit === 'until-bash cancel'
        ? spyOn(runControl, 'runSubprocessUntilRunStops').mockRejectedValue(
            Object.assign(new Error('Workflow cancelled'), { cancelled: true })
          )
        : undefined;
    let iterations: number | undefined;
    try {
      iterations = await failedLoopIterations('grp', () =>
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform,
            cwd: testDir,
            logDir: join(testDir, 'logs'),
            workflowRun,
            workflow: {
              name: 'loop-group-early-exit-usage',
              nodes: [
                {
                  id: 'grp',
                  kind: 'loop_group',
                  loop_group: {
                    until: 'DONE',
                    ...(exit === 'completion error'
                      ? { until_bash: 'test -n "$skipped.output"' }
                      : exit === 'until-bash cancel'
                        ? { until_bash: 'true' }
                        : {}),
                    max_iterations: 4,
                    fresh_context: false,
                    nodes: [
                      { id: 'b', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } },
                      ...(exit === 'completion error'
                        ? [
                            {
                              id: 'skipped',
                              kind: 'agent' as const,
                              source: { kind: 'inline' as const, prompt: 'Skip.' },
                              depends_on: ['b'],
                              when: "$b.output == 'never'",
                            },
                          ]
                        : []),
                    ],
                  },
                },
              ],
            },
          })
        )
      );
    } finally {
      shell?.mockRestore();
    }
    expect(calls).toBe(exit === 'completion error' || exit === 'until-bash cancel' ? 1 : 2);
    expect(iterations).toBe(calls);
    const groupFailure = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'grp'
    );
    expect(groupFailure?.data?.failure_kind).toBe(
      exit === 'completion error' ? 'unknown' : 'cancelled'
    );
    if (exit === 'completion error')
      expect(groupFailure?.data?.error).toContain("cannot resolve '$skipped.output'");
    expect(groupFailure?.data?.cost_usd).toBe(0.05 * calls);
    expect(groupFailure?.data?.spend).toMatchObject({
      costUsd: { source: 'provider', value: 0.05 * calls },
      tokens: {
        source: 'provider',
        value: {
          input: 100 * calls,
          output: 10 * calls,
          cacheRead: 40 * calls,
          cacheWrite: 5 * calls,
        },
      },
    });
    expect(runUsageWrites(store)).toEqual([
      {
        total_cost_usd: 0.05 * calls,
        total_tokens_in: 100 * calls,
        total_tokens_out: 10 * calls,
        total_cache_read_tokens: 40 * calls,
        total_cache_write_tokens: 5 * calls,
      },
    ]);
    const snapshot = await foldDagResumeSnapshot(persistedEvents(store), workflowRun.id);
    expect(snapshot.costUsd).toBe(0.05 * calls);
    expect(snapshot.tokens).toEqual({
      input: 100 * calls,
      output: 10 * calls,
      cacheRead: 40 * calls,
      cacheWrite: 5 * calls,
    });
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const groupRow = rows.find(row => row.type === 'node_error' && row.step === 'grp');
    expect(groupRow).toBeDefined();
    expect(groupRow).not.toHaveProperty('cost_usd');
    expect(groupRow).not.toHaveProperty('tokens');
    expect(
      rows
        .filter(row => row.type === 'node_complete' || row.type === 'node_error')
        .reduce((total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0), 0)
    ).toBeCloseTo(0.05 * calls, 5);
  });

  it('a node cancelled by the user leaves its spend in the transcript', async () => {
    // The abort branch called no logNodeError at all, so a cancelled node produced no
    // transcript row whatsoever — not even one without usage (#2693). It is the only
    // terminal outcome in executeNodeInternal that was missing from the transcript.
    //
    // The cancel is driven the way production drives it: the throttled mid-stream
    // status check sees a non-running run and aborts. setSystemTime jumps past
    // CANCEL_CHECK_INTERVAL_MS between chunks so that check fires deterministically,
    // and the usage-bearing result chunk is delivered BEFORE the jump so the node has
    // something to report by the time it is torn down.
    let usageDelivered = false;
    mockSendQueryDag.mockImplementation(async function* () {
      // A live background task keeps the stream open past the result chunk, which is
      // what lets the node still be streaming once it has usage to report.
      yield {
        type: 'subtask',
        taskId: 't-live',
        status: 'started',
        taskType: 'local_agent',
        description: 'still running',
      };
      yield { type: 'agent_message_chunk', text: 'partial work' };
      yield { type: 'result', sessionId: 'sid-x', cost: 0.02, tokens: { input: 30, output: 3 } };
      usageDelivered = true;
      setSystemTime(new Date(Date.now() + 11_000));
      yield { type: 'agent_message_chunk', text: 'MUST NOT BE REACHED' };
    });

    const store = createMockStore();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
      Promise.resolve(usageDelivered ? 'cancelled' : 'running')
    );
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun('cancel-transcript-run');

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-cancel',
          cwd: testDir,
          workflow: {
            name: 'cancel-transcript',
            nodes: [{ id: 'only', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } }],
          },
          workflowRun,
          logDir,
        })
      );
    } finally {
      setSystemTime(); // restore the real clock
    }

    // Prove the abort branch is the one that ran: it is the only path that reports
    // exactly 'Cancelled by user'.
    const rows = await readTranscript(logDir, workflowRun.id);
    const cancelRow = rows.find(row => row.type === 'node_error' && row.step === 'only');
    expect(cancelRow?.error).toBe('Cancelled by user');
    expect(cancelRow?.cost_usd).toBe(0.02);
    expect(cancelRow?.tokens).toEqual({ input: 30, output: 3 });

    const failedEvent = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.event_type === 'node_failed' && event.step_name === 'only');
    expect(typeof failedEvent?.data?.duration_ms).toBe('number');
  });

  it('a cancel that surfaces as a thrown error still leaves a transcript row', async () => {
    // The abort has TWO exits. One returns from the streaming-cancel branch; the other
    // reaches the outer catch, because an aborted node with `output_format` is refused a
    // reask and throws instead. Only the first was fixed at first, which would have made
    // a cancelled node's transcript row depend on whether the node declared
    // `output_format` — the provider-shaped inconsistency #2693 exists to remove.
    let usageDelivered = false;
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'subtask',
        taskId: 't-live',
        status: 'started',
        taskType: 'local_agent',
        description: 'still running',
      };
      yield { type: 'agent_message_chunk', text: 'prose, not the declared JSON' };
      yield { type: 'result', sessionId: 'sid-of', cost: 0.02, tokens: { input: 30, output: 3 } };
      usageDelivered = true;
      setSystemTime(new Date(Date.now() + 11_000));
      yield { type: 'agent_message_chunk', text: 'MUST NOT BE REACHED' };
    });

    const store = createMockStore();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() =>
      Promise.resolve(usageDelivered ? 'cancelled' : 'running')
    );
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun('cancel-throw-run');

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-cancel-throw',
          cwd: testDir,
          workflow: {
            name: 'cancel-throw',
            nodes: [
              {
                id: 'only',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Work.' },
                output_format: { type: 'object', properties: { status: { type: 'string' } } },
              },
            ],
          },
          workflowRun,
          logDir,
        })
      );
    } finally {
      setSystemTime();
    }

    const rows = await readTranscript(logDir, workflowRun.id);
    const cancelRow = rows.find(row => row.type === 'node_error' && row.step === 'only');
    expect(cancelRow?.error).toBe('Cancelled by user');
    expect(cancelRow?.cost_usd).toBe(0.02);
  });

  it('records usage when the run is CANCELLED out of band mid-flight', async () => {
    // A cancel is driven by another process (CLI abandon, the API abandon route, a
    // fan-out cancelling a child), so the cancelling side has no usage in scope. The
    // executing side notices at its next status check and bails out of BOTH terminal
    // writers — which is exactly why the usage write cannot live in either of them.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'work done before the cancel landed' };
      yield {
        type: 'result',
        sessionId: 'sid-cancel',
        cost: 0.02,
        tokens: { input: 30, output: 3 },
      };
    });

    const store = createMockStore();
    // The cancel lands the moment the node finishes — pinned to the node's own
    // node_completed write so the run is unambiguously past accumulation and the
    // during-streaming cancel check never tears the node down mid-stream.
    let nodeFinished = false;
    const realPersistEvent = store.persistWorkflowEvent;
    store.persistWorkflowEvent = mock<IWorkflowStore['persistWorkflowEvent']>(data => {
      if (data.event_type === 'node_completed') nodeFinished = true;
      return realPersistEvent(data);
    });
    store.getWorkflowRunStatus = mock(() =>
      Promise.resolve(nodeFinished ? ('cancelled' as const) : ('running' as const))
    );
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-usage',
        cwd: testDir,
        workflow: {
          name: 'usage-on-cancel',
          nodes: [
            { id: 'spend', kind: 'agent', source: { kind: 'inline', prompt: 'Burn some tokens.' } },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.02, total_tokens_in: 30, total_tokens_out: 3 },
    ]);
  });

  it('records usage accumulated before an approval gate PAUSES the run', async () => {
    // A paused run may never resume (an operator can abandon it, cancelling it without
    // running it again), so the pause is its only chance to record what it spent.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'analysis' };
      yield {
        type: 'result',
        sessionId: 'sid-pause',
        cost: 0.04,
        tokens: { input: 60, output: 6 },
      };
    });

    const store = createMockStore();
    let paused = false;
    store.pauseWorkflowRun = mock(() => {
      paused = true;
      return Promise.resolve();
    });
    store.getWorkflowRunStatus = mock(() =>
      Promise.resolve(paused ? ('paused' as const) : ('running' as const))
    );
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-usage',
        cwd: testDir,
        workflow: {
          name: 'usage-on-pause',
          nodes: [
            { id: 'analyze', kind: 'agent', source: { kind: 'inline', prompt: 'Analyze.' } },
            {
              id: 'review',
              kind: 'gate',
              message: 'Ship it?',
              decisions: [{ id: 'approve' }, { id: 'reject' }],
              captureResponse: false,
              decisionsAuthored: false,
              depends_on: ['analyze'],
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.pauseWorkflowRun).toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.04, total_tokens_in: 60, total_tokens_out: 6 },
    ]);
  });

  it("one node reporting a non-finite cost does not erase the whole run's cost", async () => {
    // NaN > 0 is false, so an unguarded NaN would drop total_cost_usd for EVERY node in
    // the run, silently — the exact loss this work exists to remove, arriving through a
    // provider instead of a code path. Tokens have carried this guard; cost had not.
    let call = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      call++;
      if (call === 1) {
        yield { type: 'agent_message_chunk', text: 'good node' };
        yield { type: 'result', sessionId: 'sid-ok', cost: 0.05, tokens: { input: 10, output: 2 } };
        return;
      }
      yield { type: 'agent_message_chunk', text: 'bad provider' };
      yield {
        type: 'result',
        sessionId: 'sid-nan',
        cost: Number.NaN,
        tokens: { input: 4, output: 1 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-usage',
        cwd: testDir,
        workflow: {
          name: 'usage-nan-cost',
          nodes: [
            { id: 'good', kind: 'agent', source: { kind: 'inline', prompt: 'Spend normally.' } },
            {
              id: 'bad',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Report a broken cost.' },
              depends_on: ['good'],
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    // The healthy node's spend survives; only the broken node's contribution is dropped.
    // Tokens are unaffected — both nodes reported finite ones.
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.05, total_tokens_in: 14, total_tokens_out: 3 },
    ]);
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'dag_node.usage_cost_non_finite_ignored'
      )
    ).toBe(true);
  });

  it('a failed usage write is logged and never fails the run', async () => {
    // persistRunUsage is documented best-effort: a bookkeeping write must not turn an
    // otherwise-fine run into a failed one. Documented, but never watched failing — and
    // the durability tail stands between the run and its own completion, so a throw here
    // would be maximally disruptive.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield {
        type: 'result',
        sessionId: 'sid-dbfail',
        cost: 0.02,
        tokens: { input: 9, output: 3 },
      };
    });

    const store = createMockStore();
    store.updateWorkflowRun = mock(
      (_id: string, updates: { metadata?: Record<string, unknown> }): Promise<void> =>
        updates.metadata && 'total_cost_usd' in updates.metadata
          ? Promise.reject(new Error('Workflow run not found (id: gone)'))
          : Promise.resolve()
    );
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-usage',
        cwd: testDir,
        workflow: {
          name: 'usage-write-fails',
          nodes: [
            { id: 'spend', kind: 'agent', source: { kind: 'inline', prompt: 'Burn some tokens.' } },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    // The run still completes normally — the usage figure is simply absent, and every
    // reader type-guards that. Absent is safe; plausible-and-wrong is the failure mode.
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    // ...and the loss is recorded rather than swallowed.
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'dag.run_usage_persist_failed'
      )
    ).toBe(true);
  });

  it.each([
    ['records usage and an earlier authored outcome when a store write escapes', false],
    ['preserves the escaping error when the outcome backstop also fails', true],
  ])('%s', async (_label, outcomeWriteFails) => {
    // A halt's rejected cancel write interrupts the layer before its usage and authored
    // outcome reach the run accumulator. Both must survive without a terminal transition.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'spent before the halt write failed' };
      yield {
        type: 'result',
        sessionId: 'sid-throw',
        cost: 0.01,
        tokens: { input: 20, output: 2 },
        structuredOutput: { green: true },
      };
    });

    const store = createMockStore();
    store.getDagResumeSnapshot.mockImplementation(async id =>
      foldDagResumeSnapshot(persistedEvents(store), id)
    );
    let announceNodeFinished: (() => void) | undefined;
    const nodeFinishedSignal = new Promise<void>(resolve => {
      announceNodeFinished = resolve;
    });
    const realPersistEvent = store.persistWorkflowEvent;
    store.persistWorkflowEvent = mock<IWorkflowStore['persistWorkflowEvent']>(data => {
      if (data.event_type === 'node_completed') {
        announceNodeFinished?.();
      }
      return realPersistEvent(data);
    });

    // Ordering is the real discriminator. The unwind catch runs AFTER runLayers throws, so
    // the usage write must land after the rejected cancel write. A write placed inside runLayers
    // (per-node or per-layer) would satisfy a bare "usage was persisted" assertion while
    // recording BEFORE the throw — and would not need the unwind backstop at all.
    const order: string[] = [];
    const realUpdateRun = store.updateWorkflowRun;
    store.updateWorkflowRun = mock<IWorkflowStore['updateWorkflowRun']>((id, updates) => {
      if (updates.outcome !== undefined) {
        order.push('outcome-write');
        if (outcomeWriteFails) return Promise.reject(new Error('outcome database unavailable'));
      }
      if (updates.metadata && 'total_cost_usd' in updates.metadata) order.push('usage-write');
      return realUpdateRun(id, updates);
    });

    // The halt sibling starts concurrently but waits for the selected result to finish
    // before its cancel write rejects, so the only remaining outcome write is the unwind
    // backstop.
    const platform = createMockPlatform();
    platform.sendMessage = mock(async (_conversationId, message): Promise<void> => {
      if (message.includes('Workflow cancelled')) await nodeFinishedSignal;
    });
    store.cancelWorkflowRun = mock<IWorkflowStore['cancelWorkflowRun']>(() => {
      order.push('cancel-write-rejected');
      return Promise.reject(new Error('database unavailable'));
    });

    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          conversationId: 'conv-usage',
          cwd: testDir,
          workflow: {
            name: 'usage-on-throw',
            returns: 'spend',
            outcome_field: 'green',
            nodes: [
              {
                id: 'spend',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Burn some tokens.' },
                output_format: {
                  type: 'object',
                  properties: { green: { type: 'boolean' } },
                  required: ['green'],
                },
              },
              { id: 'stop', kind: 'halt', reason: 'stop the run' },
            ],
          },
          workflowRun: makeWorkflowRun(),
        })
      )
    ).rejects.toMatchObject({ name: 'TerminalStatusWriteError' });

    // Neither terminal writer ran — the throw skipped them both — yet the spend survived.
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(runUsageWrites(store)).toEqual([
      { total_cost_usd: 0.01, total_tokens_in: 20, total_tokens_out: 2 },
    ]);
    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    // Both durable backstops run only after the write that killed layer aggregation.
    expect(order[0]).toBe('cancel-write-rejected');
    expect(order.indexOf('cancel-write-rejected')).toBeLessThan(order.indexOf('usage-write'));
    expect(order.indexOf('cancel-write-rejected')).toBeLessThan(order.indexOf('outcome-write'));
    expect(
      (mockLogFn as unknown as Mock<(obj: unknown, msg?: string) => void>).mock.calls.some(
        call => call[1] === 'dag.authored_outcome_persist_failed_during_unwind'
      )
    ).toBe(outcomeWriteFails);
  });
});

describe('executeDagWorkflow -- authored run outcome (#2618)', () => {
  let testDir: string;

  const resultNode = (alwaysRun = false): DagNode => ({
    id: 'result',
    kind: 'agent',
    source: { kind: 'inline', prompt: 'author the result' },
    ...(alwaysRun ? { always_run: true } : {}),
    output_format: {
      type: 'object',
      properties: { green: { type: 'boolean' } },
      required: ['green'],
    },
  });

  const mockStructuredVerdict = (green: boolean): void => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: JSON.stringify({ green }) };
      yield {
        type: 'result',
        sessionId: 'outcome-session',
        structuredOutput: { green },
      };
    });
  };

  const run = async (
    store: MockWorkflowStore,
    nodes: DagNode[],
    options: {
      workflowRun?: WorkflowRun;
      declared?: boolean;
      priorCompletedNodes?: Map<string, PersistedNodeOutput>;
      workflowSourceRoots?: ExecuteDagWorkflowOptions['workflowSourceRoots'];
    } = {}
  ): Promise<void> => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-outcome',
        cwd: testDir,
        workflow: {
          name: 'authored-outcome',
          nodes,
          ...(options.declared === false ? {} : { returns: 'result', outcome_field: 'green' }),
        },
        workflowRun: options.workflowRun ?? makeWorkflowRun('authored-outcome-run'),
        priorCompletedNodes: options.priorCompletedNodes,
        workflowSourceRoots: options.workflowSourceRoots,
      })
    );
  };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-authored-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    await removeTempTree(testDir);
  });

  it('persists false as failed while lifecycle completion remains successful', async () => {
    mockStructuredVerdict(false);
    const store = createMockStore();

    await run(store, [resultNode()]);

    expect(authoredOutcomeWrites(store)).toEqual(['failed']);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('persists the verdict before a later layer finishes', async () => {
    let releaseLater: (() => void) | undefined;
    const laterReleased = new Promise<void>(resolve => {
      releaseLater = resolve;
    });
    let announceLaterStarted: (() => void) | undefined;
    const laterStarted = new Promise<void>(resolve => {
      announceLaterStarted = resolve;
    });
    mockSendQueryDag.mockImplementation(async function* (prompt) {
      if (prompt.includes('author the result')) {
        yield { type: 'agent_message_chunk', text: JSON.stringify({ green: true }) };
        yield {
          type: 'result',
          sessionId: 'outcome-session',
          structuredOutput: { green: true },
        };
        return;
      }
      announceLaterStarted?.();
      await laterReleased;
      yield { type: 'agent_message_chunk', text: 'later finished' };
      yield { type: 'result', sessionId: 'later-session' };
    });
    const store = createMockStore();

    const runPromise = run(store, [
      resultNode(),
      {
        id: 'later',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'wait for release' },
        depends_on: ['result'],
      },
    ]);
    await laterStarted;

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    releaseLater?.();
    await runPromise;
  });

  it('retains succeeded when a later node fails', async () => {
    mockStructuredVerdict(true);
    const store = createMockStore();

    await run(store, [
      resultNode(),
      {
        id: 'later-failure',
        kind: 'exec',
        runtime: 'sh',
        script: 'exit 1',
        depends_on: ['result'],
      },
    ]);

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('persists the selected verdict when a sibling fails in the same layer', async () => {
    mockStructuredVerdict(true);
    const store = createMockStore();

    await run(store, [
      resultNode(),
      { id: 'sibling-failure', kind: 'exec', runtime: 'sh', script: 'exit 1' },
    ]);

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('retains succeeded when a later approval pauses the run', async () => {
    mockStructuredVerdict(true);
    const store = createMockStore();
    let status: WorkflowRun['status'] = 'running';
    store.pauseWorkflowRun.mockImplementation(async () => {
      status = 'paused';
    });
    store.getWorkflowRunStatus.mockImplementation(async () => status);

    await run(store, [
      resultNode(),
      {
        id: 'review',
        kind: 'gate',
        message: 'Ship?',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
        captureResponse: false,
        decisionsAuthored: false,
        depends_on: ['result'],
      },
    ]);

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    expect(await store.getWorkflowRunStatus('run-1')).toBe('paused');
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('retains succeeded when a later node cancels the run', async () => {
    mockStructuredVerdict(true);
    const store = createMockStore();
    let status: WorkflowRun['status'] = 'running';
    store.cancelWorkflowRun.mockImplementation(async () => {
      status = 'cancelled';
      return { cancelled: true };
    });
    store.getWorkflowRunStatus.mockImplementation(async () => status);

    await run(store, [
      resultNode(),
      { id: 'stop', kind: 'halt', reason: 'not shipping', depends_on: ['result'] },
    ]);

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    expect(await store.getWorkflowRunStatus('run-1')).toBe('cancelled');
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('resolves a selected result rehydrated from serialized completion output', async () => {
    const store = createMockStore();

    await run(store, [resultNode()], {
      priorCompletedNodes: new Map([['result', { output: JSON.stringify({ green: true }) }]]),
    });

    expect(authoredOutcomeWrites(store)).toEqual(['succeeded']);
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('does not clear or rewrite an already-persisted outcome during resume', async () => {
    const store = createMockStore();

    await run(store, [resultNode()], {
      workflowRun: makeWorkflowRun('resume-existing-outcome', { outcome: 'succeeded' }),
      priorCompletedNodes: new Map([['result', { output: JSON.stringify({ green: true }) }]]),
    });

    expect(authoredOutcomeWrites(store)).toEqual([]);
  });

  it('allows a real selected-node re-execution to replace the prior verdict', async () => {
    mockStructuredVerdict(false);
    const store = createMockStore();

    await run(store, [resultNode(true)], {
      workflowRun: makeWorkflowRun('resume-reworked-outcome', { outcome: 'succeeded' }),
      priorCompletedNodes: new Map([['result', { output: JSON.stringify({ green: true }) }]]),
    });

    expect(authoredOutcomeWrites(store)).toEqual(['failed']);
  });

  it('keeps an earlier outcome when source integrity stops the selected node', async () => {
    const scriptsDir = join(testDir, '.archon', 'scripts');
    const captureRoot = join(testDir, 'capture');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'result.ts'), 'console.log(\'{"green":false}\')');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    await writeFile(
      join(captureRoot, 'project', '.archon', 'scripts', 'result.ts'),
      'console.log(\'{"green":true}\')'
    );
    const store = createMockStore();
    const selectedScript: ExecNode = {
      id: 'result',
      kind: 'exec',
      runtime: 'bun',
      script: 'result',
      output_format: {
        type: 'object',
        properties: { green: { type: 'boolean' } },
        required: ['green'],
      },
    };
    const workflowRun = makeWorkflowRun('integrity-existing-outcome', {
      outcome: 'succeeded',
    });

    await run(store, [selectedScript], {
      workflowRun,
      workflowSourceRoots: capturedSourceRoots(capture.anchor),
    });

    expect(authoredOutcomeWrites(store)).toEqual([]);
    expect(workflowRun.outcome).toBe('succeeded');
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('leaves undeclared workflows and unreached selected outputs unchanged', async () => {
    mockStructuredVerdict(true);
    const undeclaredStore = createMockStore();
    await run(undeclaredStore, [resultNode()], { declared: false });
    expect(authoredOutcomeWrites(undeclaredStore)).toEqual([]);

    mockSendQueryDag.mockImplementation(async function* () {
      throw new Error('selected node failed');
    });
    const failedStore = createMockStore();
    await run(failedStore, [resultNode()]);
    expect(authoredOutcomeWrites(failedStore)).toEqual([]);
  });

  it('surfaces a declared-outcome persistence failure', async () => {
    mockStructuredVerdict(true);
    const store = createMockStore();
    store.updateWorkflowRun.mockImplementation(async (_id, updates) => {
      if (updates.outcome !== undefined) throw new Error('outcome database unavailable');
    });

    await expect(run(store, [resultNode()])).rejects.toThrow('outcome database unavailable');
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('executeDagWorkflow -- run budget (#2814)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    await removeTempTree(testDir);
  });

  const ai = (id: string, depends_on?: string[], extra?: Partial<AgentNode>): AgentNode => ({
    id,
    kind: 'agent',
    source: { kind: 'inline', prompt: `Do ${id}` },
    ...(depends_on ? { depends_on } : {}),
    ...extra,
  });
  const sh = (id: string, depends_on?: string[]): DagNode => ({
    id,
    kind: 'exec',
    runtime: 'sh',
    script: 'echo ok',
    ...(depends_on ? { depends_on } : {}),
  });

  /** Every provider call reports `cost` (or none when undefined). */
  function providerCosts(cost: number | undefined): void {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 's', ...(cost !== undefined ? { cost } : {}) };
    });
  }

  /** A store whose resume read folds the rows written so far, as the real stores do. */
  function durableStore(): MockWorkflowStore {
    const store = createMockStore();
    store.getDagResumeSnapshot.mockImplementation(async id =>
      foldDagResumeSnapshot(persistedEvents(store), id)
    );
    return store;
  }

  async function run(
    workflow: TestWorkflowDefinition,
    store = durableStore(),
    extra: Partial<DagOptionsOverrides> = {}
  ): Promise<MockWorkflowStore> {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun('budget-run'),
        ...extra,
      })
    );
    return store;
  }

  const refusals = (store: MockWorkflowStore) =>
    persistedEvents(store).filter(e => e.event_type === 'run_budget_refused');
  const started = (store: MockWorkflowStore, step: string) =>
    persistedEvents(store).filter(e => e.event_type === 'node_started' && e.step_name === step);
  const exitReason = (store: MockWorkflowStore) =>
    (store.failWorkflowRun.mock.calls[0]?.[2] as { exitReason?: string } | undefined)?.exitReason;

  /** What a cold resume hands the executor, read through the same store handoff. */
  async function resumeOptions(store: MockWorkflowStore): Promise<Partial<DagOptionsOverrides>> {
    const inspection = await inspectResumableRun(
      createMockDeps(store),
      makeWorkflowRun('budget-run')
    );
    if (!inspection) throw new Error('Expected the refused run to be resumable');
    return {
      priorCompletedNodes: inspection.priorCompletedNodes,
      priorUsage: inspection.priorUsage,
    };
  }

  it('refuses the next attempt once the work ceiling is reached, before it starts', async () => {
    providerCosts(0.1);
    const store = await run({
      name: 'units',
      budget: { max_work_units: 2 },
      nodes: [ai('a'), ai('b', ['a']), ai('c', ['b'])],
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
    expect(exitReason(store)).toBe('budget_refused');
    expect(started(store, 'c')).toHaveLength(0);
    expect(
      persistedEvents(store).some(e => e.step_name === 'c' && e.event_type === 'node_failed')
    ).toBe(false);
    expect(refusals(store)).toHaveLength(1);
    expect(refusals(store)[0].data).toMatchObject({
      reason: 'work_units_exhausted',
      node: 'c',
      consumed: { work_units: 2 },
    });
  });

  it('lets an admitted attempt overshoot the spend ceiling and refuses the next one', async () => {
    providerCosts(0.6);
    const store = await run({
      name: 'spend',
      budget: { max_spend_usd: 1 },
      nodes: [ai('a'), ai('b', ['a']), ai('c', ['b'])],
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
    expect(refusals(store)[0].data).toMatchObject({
      reason: 'spend_exhausted',
      node: 'c',
      consumed: { work_units: 2, spend_usd: 1.2 },
    });
  });

  it('counts a retry as a work unit and refuses it once the spend is gone', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['crash'],
        failure: { class: 'transient', evidence: 'crash' },
        sessionId: 's',
        cost: 0.6,
      };
    });
    const store = await run({
      name: 'retry',
      budget: { max_spend_usd: 0.5 },
      nodes: [ai('a', undefined, { retry: { max_attempts: 2, delay_ms: 1 } })],
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(exitReason(store)).toBe('budget_refused');
    expect(refusals(store)[0].data).toMatchObject({ reason: 'spend_exhausted', node: 'a' });
    // The refused retry's earlier attempt still counts toward the run's recorded spend.
    expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBe(0.6);
  });

  it('admits exactly the remaining units from a parallel layer and lets them finish', async () => {
    providerCosts(0.1);
    const store = await run({
      name: 'parallel',
      budget: { max_work_units: 2 },
      nodes: [ai('a'), ai('b'), ai('c')],
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
    expect(persistedEvents(store).filter(e => e.event_type === 'node_completed')).toHaveLength(2);
    expect(
      persistedEvents(store).filter(e => e.event_type === 'run_budget_work_unit')
    ).toHaveLength(2);
    expect(exitReason(store)).toBe('budget_refused');
  });

  it('fails a spend-limited run as soon as an attempt reports no cost', async () => {
    providerCosts(undefined);
    const store = await run({
      name: 'unknown-cost',
      budget: { max_spend_usd: 5 },
      nodes: [ai('a'), ai('b', ['a'])],
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(started(store, 'b')).toHaveLength(0);
    expect(refusals(store)[0].data).toMatchObject({
      reason: 'cost_unavailable',
      cost_unavailable: { node: 'a', reason: 'not_reported' },
    });

    // A work ceiling alone does not need cost, so the same run completes.
    const unitsOnly = await run({
      name: 'unknown-cost-units',
      budget: { max_work_units: 5 },
      nodes: [ai('a'), ai('b', ['a'])],
    });
    expect(unitsOnly.completeWorkflowRun).toHaveBeenCalled();
    expect(refusals(unitsOnly)).toHaveLength(0);
  });

  it('treats an attempt that reported only part of its cost as unknown', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 's', cost: 0.2 };
      yield { type: 'result', sessionId: 's' };
    });
    const store = await run({
      name: 'partial',
      budget: { max_spend_usd: 5 },
      nodes: [ai('a'), ai('b', ['a'])],
    });
    expect(refusals(store)[0].data).toMatchObject({
      reason: 'cost_unavailable',
      cost_unavailable: { node: 'a', reason: 'partial' },
    });
    const completed = persistedEvents(store).find(
      e => e.event_type === 'node_completed' && e.step_name === 'a'
    );
    expect(completed?.data?.spend).toMatchObject({
      costUsd: { source: 'provider', value: 0.2, partial: true },
    });
    // Run telemetry keeps the reported value exactly as before.
    expect(runUsageWrites(store).at(-1)?.total_cost_usd).toBe(0.2);
  });

  it('rebuilds the same totals on cold resume and refuses again without calling the provider', async () => {
    providerCosts(0.1);
    const workflow = {
      name: 'resume-units',
      budget: { max_work_units: 2 },
      nodes: [ai('a'), ai('b', ['a']), ai('c', ['b'])],
    };
    const store = await run(workflow);
    const consumed = refusals(store)[0].data?.consumed;
    const snapshot = await foldDagResumeSnapshot(persistedEvents(store), 'budget-run');
    expect({ work_units: snapshot.budget.workUnits, spend_usd: snapshot.budget.spendUsd }).toEqual(
      consumed as { work_units: number; spend_usd: number }
    );

    // Cold resume: a new pass over the same durable rows.
    store.failWorkflowRun.mockClear();
    await run(workflow, store, await resumeOptions(store));
    expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
    expect(exitReason(store)).toBe('budget_refused');
  });

  it('refuses a resumed spend-limited run at start when recorded spend is unknown', async () => {
    providerCosts(undefined);
    const workflow = {
      name: 'resume-unknown',
      budget: { max_spend_usd: 5 },
      nodes: [ai('a'), ai('b', ['a'])],
    };
    const store = await run(workflow);
    store.failWorkflowRun.mockClear();
    mockSendQueryDag.mockClear();
    await run(workflow, store, await resumeOptions(store));
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(exitReason(store)).toBe('budget_refused');
  });

  it('treats an attempt that started and never finished as unknown spend on resume', async () => {
    providerCosts(0.1);
    const seeded = createMockStore();
    const workflow = {
      name: 'interrupted',
      budget: { max_spend_usd: 5 },
      nodes: [ai('a')],
    };
    // A first pass that stopped after `a` started: its unit and start row, no terminal.
    await run({ ...workflow, budget: { max_work_units: 99 } }, seeded);
    const rows = persistedEvents(seeded).filter(
      e => e.event_type === 'run_budget_work_unit' || e.event_type === 'node_started'
    );

    const spendLimited = durableStore();
    spendLimited.getDagResumeSnapshot.mockImplementation(async id =>
      foldDagResumeSnapshot(rows, id)
    );
    mockSendQueryDag.mockClear();
    await run(workflow, spendLimited, { priorCompletedNodes: new Map() });
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(refusals(spendLimited)[0].data).toMatchObject({
      reason: 'cost_unavailable',
      cost_unavailable: { node: 'a', reason: 'interrupted' },
    });

    const unitsOnly = durableStore();
    unitsOnly.getDagResumeSnapshot.mockImplementation(async id => foldDagResumeSnapshot(rows, id));
    await run({ ...workflow, budget: { max_work_units: 5 } }, unitsOnly, {
      priorCompletedNodes: new Map(),
    });
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(unitsOnly.completeWorkflowRun).toHaveBeenCalled();
  });

  it('never starts an attempt whose work-unit record cannot be written', async () => {
    providerCosts(0.1);
    const store = durableStore();
    store.persistWorkflowEvent.mockImplementation(async event => {
      if (event.event_type === 'run_budget_work_unit') throw new Error('disk full');
      await store.createWorkflowEvent(event);
    });
    await expect(
      run({ name: 'required-write', budget: { max_work_units: 3 }, nodes: [ai('a')] }, store)
    ).rejects.toBeInstanceOf(NodeEventWriteError);
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(started(store, 'a')).toHaveLength(0);
  });

  it('counts deterministic nodes as work but charges them no spend', async () => {
    const free = await run({
      name: 'bash-spend',
      budget: { max_spend_usd: 0.01 },
      nodes: [sh('x'), sh('y', ['x'])],
    });
    expect(free.completeWorkflowRun).toHaveBeenCalled();

    const counted = await run({
      name: 'bash-units',
      budget: { max_work_units: 1 },
      nodes: [sh('x'), sh('y', ['x'])],
    });
    expect(refusals(counted)[0].data).toMatchObject({ reason: 'work_units_exhausted', node: 'y' });
  });

  it('admits an approval rework attempt like any other attempt', async () => {
    providerCosts(0.1);
    const store = createMockStore();
    store.getDagResumeSnapshot.mockImplementation(async () => ({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      costUsd: 0.1,
      budget: { workUnits: 1, spendUsd: 0.1 },
    }));
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'rework',
          budget: { max_work_units: 1 },
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve?',
              decisions: [
                { id: 'approve' },
                { id: 'reject', rework: { prompt: 'Fix: $REJECTION_REASON', maxAttempts: 3 } },
              ],
              captureResponse: false,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun: makeWorkflowRun('rework-run', {
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve?',
              onRejectPrompt: 'Fix: $REJECTION_REASON',
              onRejectMaxAttempts: 3,
            },
            rejection_reason: 'wrong',
            rejection_count: 1,
          },
        }),
      })
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(exitReason(store)).toBe('budget_refused');
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
  });

  it('charges an attempt once on resume when its failure is recorded twice', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['crash'],
        failure: { class: 'transient', evidence: 'crash' },
        sessionId: 's',
        cost: 0.1,
      };
    });
    const store = durableStore();
    // The status read before the retry fails, so the dispatch catch re-finishes the
    // attempt's start record: a second `node_failed` row for the same attempt id.
    // The retry wait's own read tolerates a failure; the one before the attempt does not.
    let readsAfterFailure = 0;
    store.getWorkflowRunStatus.mockImplementation(async () => {
      if (
        persistedEvents(store).some(e => e.event_type === 'node_failed') &&
        ++readsAfterFailure === 2
      ) {
        throw new Error('store unavailable');
      }
      return 'running';
    });
    await run(
      {
        name: 'double-terminal',
        budget: { max_spend_usd: 5 },
        nodes: [ai('a', undefined, { retry: { max_attempts: 2, delay_ms: 1 } })],
      },
      store
    );
    expect(
      persistedEvents(store).filter(e => e.event_type === 'node_failed' && e.step_name === 'a')
    ).toHaveLength(2);
    const snapshot = await foldDagResumeSnapshot(persistedEvents(store), 'budget-run');
    expect(snapshot.budget).toEqual({ workUnits: 1, spendUsd: 0.1 });
  });

  it('refuses later work in the same pass after an attempt throws once started', async () => {
    providerCosts(0.1);
    const nodes = [ai('a'), ai('b', ['a'], { trigger_rule: 'all_done' })];
    // Throws inside node `a`'s attempt, after its execution has begun.
    const throwingPlatform = () => {
      const platform = createMockPlatform();
      platform.getStreamingMode.mockImplementationOnce(() => {
        throw new Error('platform gone');
      });
      return platform;
    };

    const spendLimited = await run(
      { name: 'thrown', budget: { max_spend_usd: 5 }, nodes },
      durableStore(),
      { platform: throwingPlatform() }
    );
    expect(started(spendLimited, 'b')).toHaveLength(0);
    expect(refusals(spendLimited)[0].data).toMatchObject({
      reason: 'cost_unavailable',
      node: 'b',
      cost_unavailable: { node: 'a', reason: 'interrupted' },
    });

    const unitsOnly = await run(
      { name: 'thrown-units', budget: { max_work_units: 5 }, nodes },
      durableStore(),
      { platform: throwingPlatform() }
    );
    expect(started(unitsOnly, 'b')).toHaveLength(1);
    expect(refusals(unitsOnly)).toHaveLength(0);
  });

  it('treats an attempt whose later pass ended without a result as partial cost', async () => {
    // A best-effort provider re-asks after invalid structured output; the re-ask
    // stream ends without a result, so 0.2 is only a floor of what the attempt spent.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { other: 'x' }, cost: 0.2 };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'thinking' };
    });
    const store = await run(
      {
        name: 'no-result-pass',
        budget: { max_spend_usd: 5 },
        nodes: [
          ai('a', undefined, {
            provider: 'pi',
            output_format: {
              type: 'object',
              properties: { verdict: { type: 'string' } },
              required: ['verdict'],
            },
            retry: { max_attempts: 0 },
          }),
          ai('b', ['a'], { trigger_rule: 'all_done' }),
        ],
      },
      durableStore(),
      { workflowProvider: 'pi', config: { ...minimalConfig, assistant: 'pi' } }
    );
    expect(started(store, 'b')).toHaveLength(0);
    expect(refusals(store)[0].data).toMatchObject({
      reason: 'cost_unavailable',
      cost_unavailable: { node: 'a', reason: 'partial' },
    });
  });

  it('charges no spend for an agent attempt that failed before calling its provider', async () => {
    providerCosts(0.1);
    const store = await run({
      name: 'missing-command',
      budget: { max_spend_usd: 5 },
      nodes: [
        { ...ai('a'), source: { kind: 'command', name: 'missing-command' } },
        ai('b', ['a'], { trigger_rule: 'all_done' }),
      ],
    });
    expect(refusals(store)).toHaveLength(0);
    expect(started(store, 'b')).toHaveLength(1);
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    const failed = persistedEvents(store).find(
      e => e.step_name === 'a' && e.event_type === 'node_failed'
    );
    expect(failed?.data).not.toHaveProperty('cost_usd');
    const record = failed && readNodeRecordEvent({ ...failed, data: failed.data });
    expect(record?.metadata?.spend.costUsd).toEqual({
      source: 'unavailable',
      reason: 'not_applicable',
    });
  });

  it('keeps an operator cancel instead of failing the run for its budget', async () => {
    providerCosts(0.1);
    const store = durableStore();
    store.getWorkflowRunStatus.mockImplementation(async () => 'cancelled');
    // One parallel layer, so the second node is refused inside the layer, before any
    // between-layer stop.
    await run(
      { name: 'cancelled', budget: { max_work_units: 1 }, nodes: [ai('a'), ai('b')] },
      store
    );
    expect(persistedEvents(store).filter(e => e.event_type === 'node_started')).toHaveLength(1);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(refusals(store)).toHaveLength(0);
  });

  it.each([
    ['bash', undefined, false],
    ['unpriced AI', undefined, true],
    ['free AI', 0, true],
    ['paid AI', 0.25, true],
  ] as const)(
    'preserves cost presence from %s when resuming into bash-only work',
    async (_label, cost, aiPrior) => {
      providerCosts(cost);
      const prior = aiPrior ? ai('prior') : sh('prior');
      const store = await run({ name: 'cost-presence', nodes: [prior] });
      const resume = await resumeOptions(store);
      expect(resume.priorUsage?.costUsd).toBe(cost);
      store.updateWorkflowRun.mockClear();
      mockSendQueryDag.mockClear();

      await run(
        { name: 'cost-presence', nodes: [prior, sh('remaining', ['prior'])] },
        store,
        resume
      );

      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(2);
      expect(mockSendQueryDag).not.toHaveBeenCalled();
      expect(started(store, 'remaining')).toHaveLength(1);
      const writes = runUsageWrites(store);
      if (cost === undefined) {
        expect(writes.every(write => !('total_cost_usd' in write))).toBe(true);
      } else {
        expect(writes).toEqual([expect.objectContaining({ total_cost_usd: cost })]);
      }
    }
  );

  it.each([undefined, 0, 0.25])(
    'preserves reported cost %s when a retry is budget-refused',
    async cost => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          isError: true,
          failure: { class: 'transient', evidence: 'crash' },
          sessionId: 's',
          ...(cost !== undefined ? { cost } : {}),
        };
      });
      const store = await run({
        name: 'retry-refusal-cost',
        budget: { max_work_units: 1 },
        nodes: [ai('a', undefined, { retry: { max_attempts: 2, delay_ms: 1 } })],
      });
      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      expect(exitReason(store)).toBe('budget_refused');
      expect(refusals(store)).toHaveLength(1);
      const writes = runUsageWrites(store);
      if (cost === undefined) {
        expect(writes.every(write => !('total_cost_usd' in write))).toBe(true);
      } else {
        expect(writes).toEqual([expect.objectContaining({ total_cost_usd: cost })]);
      }
    }
  );

  it('records no run cost when a run without AI attempts is refused', async () => {
    const store = await run({
      name: 'bash-refused',
      budget: { max_work_units: 1 },
      nodes: [sh('x'), sh('y', ['x'])],
    });
    expect(exitReason(store)).toBe('budget_refused');
    expect(runUsageWrites(store).some(write => 'total_cost_usd' in write)).toBe(false);
  });

  it('leaves an unbudgeted run untouched', async () => {
    providerCosts(0.1);
    const store = await run({ name: 'plain', nodes: [ai('a'), ai('b', ['a'])] });
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(
      persistedEvents(store).filter(
        e => e.event_type === 'run_budget_work_unit' || e.event_type === 'run_budget_refused'
      )
    ).toHaveLength(0);
    expect(store.getDagResumeSnapshot).not.toHaveBeenCalled();
  });
});
