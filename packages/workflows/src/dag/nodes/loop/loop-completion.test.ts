// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { sessionPreview, type SendQueryOptions } from '@archon/provider-contract';
import { nodeExecutionMetadataSchema } from '../../../schemas/node-execution';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  minimalConfig,
  dagOptions,
  ready,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import type { DagNode } from '../../../schemas';
import { dagNodeSchema, workflowDefinitionSchema } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';

describe('loop node completion channels', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'step1.md'), 'Step 1 prompt');
    await writeFile(join(commandsDir, 'step2.md'), 'Step 2 prompt using $step1.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
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

  // ─── Completion channels (#2563) ──────────────────────────────────────────
  //
  // These three spawn real `bash -c` subprocesses, which the repo keeps rare and
  // cheap on purpose. There is no way to prove `until_bash` semantics without
  // running it, and each case runs at most two one-line scripts.
  //
  // Shared idiom (from the loop_group until_bash tests): interpolate the counter
  // path with forward slashes and quotes so the script is valid under git-bash on
  // Windows, where join() yields backslashes that bash strips as escapes.

  it('completes a loop that declared only until_bash, with no prose signal', async () => {
    const counterFile = join(testDir, 'until-bash-only-counter');
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;

    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: `working, pass ${String(calls)}` };
      yield { type: 'result', sessionId: `s-${String(calls)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-until-bash-only');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-until-bash-only',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Keep working.',
                max_iterations: 5,
                // Bumps a counter and exits 0 only on the second call.
                until_bash: `n=$(cat ${counterRef} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counterRef}; test $n -ge 2`,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(calls).toBe(2);
    expect((await readFile(counterFile, 'utf8')).trim()).toBe('2');
  });

  it('#2803: loop until_bash fails when an upstream whole-output producer was skipped', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'working' };
      yield { type: 'result', sessionId: 'loop-required-ref' };
    });
    const store = createMockStore();
    const markerPath = join(testDir, 'loop-required-ref-ran.marker');
    const workflow = workflowDefinitionSchema.parse({
      name: 'loop-required-output-ref',
      description: 'A loop must not decide completion from a skipped producer',
      nodes: [
        { id: 'gate', bash: "printf 'skip'" },
        {
          id: 'probe',
          bash: "printf 'pending'",
          depends_on: ['gate'],
          when: "$gate.output == 'run'",
        },
        {
          id: 'poll',
          depends_on: ['probe'],
          trigger_rule: 'all_done',
          loop: {
            prompt: 'poll once',
            until_bash: `printf ran > ${JSON.stringify(markerPath)}; test $probe.output != pending`,
            max_iterations: 1,
          },
        },
      ],
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun('loop-required-output-ref'),
      })
    );

    const failed = store.createWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.event_type === 'node_failed' && event.step_name === 'poll');
    expect(failed?.data?.error).toContain(
      "Node 'poll' field 'loop.until_bash' cannot resolve '$probe.output'"
    );
    const started = store.persistWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.event_type === 'node_started' && event.step_name === 'poll');
    expect(started?.data?.attempt).toBeDefined();
    expect(failed?.data?.attempt).toEqual(started?.data?.attempt);
    expect(failed?.data?.binding).toEqual({
      ...nodeExecutionMetadataSchema.shape.binding.parse(started?.data?.binding),
      sessionPreview: sessionPreview('loop-required-ref'),
    });
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  it('reads oversized upstream output in until_bash from the run-owned spill directory', async () => {
    const artifactsDir = join(testDir, 'loop-until-artifacts');
    const logDir = join(testDir, 'loop-until-logs');
    const largeOutput = 'x'.repeat(33_000);
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'working' };
      yield { type: 'result', sessionId: 's-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-large-until-bash');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-large-until-bash',
          nodes: [
            {
              id: 'producer',
              kind: 'exec',
              runtime: 'sh',
              script: 'head -c 33000 /dev/zero | tr "\\0" x',
            },
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Keep working.',
                max_iterations: 2,
                until_bash: 'value=$producer.output; test "${#value}" -eq 33000',
              },
              depends_on: ['producer'],
            },
          ],
        },
        workflowRun,
        artifactsDir,
        logDir,
      })
    );

    expect(calls).toBe(1);
    expect(
      await readFile(
        join(artifactsDir, '.archon', 'node-output-spills', 'producer.nodeoutput'),
        'utf-8'
      )
    ).toBe(largeOutput);
    expect(await Bun.file(join(logDir, 'producer.nodeoutput')).exists()).toBe(false);
  });

  it('does not complete a loop with no until when the model emits a sentinel-shaped string', async () => {
    // The whole point of making `until` optional: with no signal declared there is
    // no prose path, so a model that happens to emit `<promise>COMPLETE</promise>`
    // while reasoning about its criteria cannot end the loop early. Only until_bash
    // can, and it does so on its second call.
    const counterFile = join(testDir, 'stray-sentinel-counter');
    const counterRef = `"${counterFile.replace(/\\/g, '/')}"`;

    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield {
        type: 'agent_message_chunk',
        text: 'The exit criterion is <promise>COMPLETE</promise>, which I have not met.',
      };
      yield { type: 'result', sessionId: `s-${String(calls)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-stray-sentinel');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-stray-sentinel',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Keep working.',
                max_iterations: 5,
                until_bash: `n=$(cat ${counterRef} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counterRef}; test $n -ge 2`,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Two iterations, not one — the sentinel was inert.
    expect(calls).toBe(2);
  });

  it('skips until_bash on an iteration whose until signal already fired', async () => {
    // Parity with executeLoopGroupNode's identical short-circuit (see the
    // loop_group "EDGE G" test). The variants disagreed until #2563: `loop:` ran
    // until_bash even after the signal completed the iteration, so a side-effecting
    // check fired one extra time for no possible change in outcome.
    const sentinel = join(testDir, 'loop-untilbash-ran');
    const sentinelRef = `"${sentinel.replace(/\\/g, '/')}"`;

    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'all done\n<promise>DONE</promise>' };
      yield { type: 'result', sessionId: `s-${String(calls)}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-shortcircuit');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-shortcircuit',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do work, emit DONE.',
                until: 'DONE',
                max_iterations: 3,
                // Creates the sentinel and exits 0. If the short-circuit works it
                // never runs, so the file is never created.
                until_bash: `touch ${sentinelRef}`,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(calls).toBe(1);
    let sentinelExists = true;
    try {
      await readFile(sentinel, 'utf8');
    } catch {
      sentinelExists = false;
    }
    expect(sentinelExists).toBe(false);
  });

  // ─── Structured completion channel: until_field (#2563 Part B) ────────────

  const untilFieldSchema = {
    type: 'object',
    properties: { done: { type: 'boolean' }, note: { type: 'string' } },
    required: ['done'],
  };

  it('completes on the iteration whose validated payload has until_field true', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      // Grammar-constrained providers routinely emit NO prose — the whole answer
      // is the payload. The iteration must not be failed as empty for that.
      yield {
        type: 'result',
        sessionId: `s-${String(calls)}`,
        structuredOutput: { done: calls >= 3, note: `pass ${String(calls)}` },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-until-field');

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-until-field',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Work until done.',
                max_iterations: 6,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // false, false, true -> exactly three iterations.
    expect(calls).toBe(3);
    // The node's output is the validated payload, not prose.
    if (typeof result !== 'string') throw new Error('Expected the loop output');
    expect(JSON.parse(result)).toMatchObject({ done: true, note: 'pass 3' });
  });

  it('requests output_format from the provider for a loop node', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { done: true } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-of-passthrough');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-of-passthrough',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                max_iterations: 2,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Before #2563 the parse transform dropped output_format for loop nodes, so
    // the schema never reached sendQuery at all.
    const options = mockSendQueryDag.mock.calls[0][3] as { outputFormat?: unknown };
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: untilFieldSchema });
  });

  it("applies a loop node's provider, model, and tool restrictions to every iteration (#3324, #3372)", async () => {
    // The whole chain, not the executor alone: the authored YAML shape goes through
    // the same `dagNodeSchema` transform the loader uses, because that transform is
    // where the restriction used to be discarded. The provider receives the node
    // config on each iteration's sendQuery and translates it (Claude
    // `disallowedTools`, Copilot `excludedTools`, Pi's tool set).
    let iterations = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      iterations += 1;
      yield {
        type: 'agent_message_chunk',
        text: iterations === 1 ? 'Still working.' : 'Done. <promise>COMPLETE</promise>',
      };
      yield { type: 'result', sessionId: `loop-tools-sess-${String(iterations)}` };
    });

    const loopNode = dagNodeSchema.parse({
      id: 'my-loop',
      provider: 'claude',
      model: 'node-loop-model',
      denied_tools: ['WebFetch', 'WebSearch'],
      allowed_tools: [],
      loop: {
        fresh_context: false,
        prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
        until: 'COMPLETE',
        max_iterations: 4,
      },
    }) as DagNode;

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: { name: 'dag-loop-denied-tools', nodes: [loopNode] },
        workflowRun: makeWorkflowRun('loop-denied-tools-run'),
        workflowProvider: 'codex',
        workflowModel: 'workflow-default-model',
        config: { ...minimalConfig, assistant: 'codex' },
      })
    );

    expect(iterations).toBe(2);
    expect(mockGetAgentProviderDag).toHaveBeenCalledWith('claude');
    expect(mockGetAgentProviderDag).not.toHaveBeenCalledWith('codex');
    expect(mockSendQueryDag.mock.calls).toHaveLength(2);
    for (const call of mockSendQueryDag.mock.calls) {
      const iterationOptions = call[3] as SendQueryOptions;
      expect(iterationOptions.model).toBe('node-loop-model');
      expect(iterationOptions.nodeConfig?.denied_tools).toEqual(['WebFetch', 'WebSearch']);
      expect(iterationOptions.nodeConfig?.allowed_tools).toEqual([]);
    }
  });

  it('fails rather than degrading when a payload never satisfies the schema', async () => {
    // A string "true" is not a boolean: ajv rejects it, so this is a validation
    // miss, NOT a quiet "not complete yet" that would burn max_iterations.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { done: 'true' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-strict-bool');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-strict-bool',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                max_iterations: 5,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Enforced provider -> zero reasks, fails on the first attempt.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const failed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(String((failed[0][0] as { data: { error: string } }).data.error)).toContain(
      'failed schema validation'
    );
  });

  it('re-asks a best-effort provider within the iteration, then completes', async () => {
    // Attempt 1 violates the schema; attempt 2 satisfies it with done: true.
    // The reask must not consume a loop iteration — one iteration, two attempts.
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'result', sessionId: 's1', structuredOutput: { note: 'no done key' } };
    });
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's2', structuredOutput: { done: true } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-reask-recover');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-reask-recover',
          nodes: [
            {
              id: 'my-loop',
              provider: 'pi',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                max_iterations: 4,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    // One ITERATION, despite two attempts.
    const iterationsStarted = events.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'loop_iteration_started'
    );
    expect(iterationsStarted.length).toBe(1);
    const completed = events.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(completed.length).toBe(1);
  });

  it('keeps threading the loop session across a mid-loop re-ask', async () => {
    // A reask runs in a throwaway session by design. Adopting it as the loop's
    // thread would silently discard every earlier iteration while
    // `fresh_context: false` still promises "each iteration resumes the prior
    // conversation" — so attempt 0's session stays the thread.
    const sessions: Array<string | undefined> = [];
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* (
      _p: unknown,
      _cwd: unknown,
      resumeId: string | undefined
    ) {
      calls++;
      sessions.push(resumeId);
      if (calls === 1) {
        // iteration 1, attempt 0 — valid but not done; establishes the thread.
        yield { type: 'result', sessionId: 'thread-1', structuredOutput: { done: false } };
      } else if (calls === 2) {
        // iteration 2, attempt 0 — schema miss, triggers a reask.
        yield { type: 'result', sessionId: 'thread-2', structuredOutput: { note: 'bad' } };
      } else if (calls === 3) {
        // iteration 2, reask — fresh throwaway session, repaired but not done.
        yield { type: 'result', sessionId: 'throwaway', structuredOutput: { done: false } };
      } else {
        yield { type: 'result', sessionId: 'thread-3', structuredOutput: { done: true } };
      }
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-reask-threading');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-reask-threading',
          nodes: [
            {
              id: 'my-loop',
              provider: 'pi',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                prompt: 'go',
                max_iterations: 5,
                until_field: 'done',
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // 1: fresh (iteration 1 always is). 2: threads from iteration 1's session.
    // 3: the reask, deliberately fresh. 4: MUST thread from attempt 0's session,
    // not from the throwaway one the reask created.
    expect(sessions[0]).toBeUndefined();
    expect(sessions[1]).toBe('thread-1');
    expect(sessions[2]).toBeUndefined();
    expect(sessions[3]).toBe('thread-2');
    expect(sessions[3]).not.toBe('throwaway');
    // The iteration's row and the node's row name attempt 0's session, never the reask's.
    const rows = persistedEvents(mockDeps.store);
    expect(
      rows
        .filter(row => row.event_type === 'loop_iteration_completed')
        .map(row => row.data?.session_id)
    ).toEqual(['thread-1', 'thread-2', 'thread-3']);
    expect(
      rows.filter(row => row.event_type === 'node_completed').map(row => row.data?.session_id)
    ).toEqual(['thread-3']);
  });

  it('keeps threading when the re-ask happens on iteration 1', async () => {
    // The i === 1 case. Iteration 1 has no session to resume FROM, so any fix that
    // restores the pre-iteration cursor is a no-op here and leaves the throwaway
    // session as the thread — the same defect, one iteration earlier. Attempt 0's
    // session is the loop's real conversation and is what iteration 2 must resume.
    const sessions: Array<string | undefined> = [];
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* (
      _p: unknown,
      _cwd: unknown,
      resumeId: string | undefined
    ) {
      calls++;
      sessions.push(resumeId);
      if (calls === 1) yield { type: 'result', sessionId: 'orig-1', structuredOutput: { bad: 1 } };
      else if (calls === 2)
        yield { type: 'result', sessionId: 'throwaway', structuredOutput: { done: false } };
      else yield { type: 'result', sessionId: 'orig-2', structuredOutput: { done: true } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-reask-iter1');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-reask-iter1',
          nodes: [
            {
              id: 'my-loop',
              provider: 'pi',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                prompt: 'go',
                max_iterations: 5,
                until_field: 'done',
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    expect(sessions[0]).toBeUndefined(); // iteration 1, attempt 0 — always fresh
    expect(sessions[1]).toBeUndefined(); // the reask — deliberately fresh
    expect(sessions[2]).toBe('orig-1'); // iteration 2 threads the real conversation
    expect(sessions[2]).not.toBe('throwaway');
  });

  it('hands the next sequential node the loop conversation, not a re-ask session', async () => {
    // R7 crosses the node boundary: the loop's completion returns
    // `sessionId: currentSessionId`, which becomes ctx.lastSequentialSession, and
    // downstream threading off that cursor is automatic. So a reask on the FINAL
    // iteration would otherwise hand the next node a single-turn throwaway.
    const sessions: Array<string | undefined> = [];
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* (
      _p: unknown,
      _cwd: unknown,
      resumeId: string | undefined
    ) {
      calls++;
      sessions.push(resumeId);
      if (calls === 1) yield { type: 'result', sessionId: 'loop-conv', structuredOutput: { x: 1 } };
      else if (calls === 2)
        yield { type: 'result', sessionId: 'throwaway', structuredOutput: { done: true } };
      else yield { type: 'agent_message_chunk', text: 'downstream ran' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-reask-crossnode');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-reask-crossnode',
          nodes: [
            {
              id: 'my-loop',
              provider: 'pi',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                prompt: 'go',
                max_iterations: 3,
                until_field: 'done',
                fresh_context: false,
              },
            },
            {
              id: 'after',
              provider: 'pi',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'continue' },
              depends_on: ['my-loop'],
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // The third call is the downstream node; it must inherit the loop's conversation.
    expect(sessions[2]).toBe('loop-conv');
    expect(sessions[2]).not.toBe('throwaway');
  });

  it('fails the node when best-effort re-asks are exhausted', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 's', structuredOutput: { note: 'still wrong' } };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-reask-exhausted');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-reask-exhausted',
          nodes: [
            {
              id: 'my-loop',
              provider: 'pi',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                max_iterations: 4,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
        workflowProvider: 'pi',
        config: { ...minimalConfig, assistant: 'pi' },
      })
    );

    // Original + 3 reasks, then fail — the loop does NOT keep iterating on a
    // broken completion channel until max_iterations.
    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    const failed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed.length).toBeGreaterThan(0);
  });

  it('gives a bare-approve finalize the same strict field contract as a normal completion', async () => {
    // The finalize-on-approve exit (#2074) is a COMPLETION path, so it must carry
    // declaredFields like every other one — otherwise a downstream
    // `$loop.output.<declared-optional>` THROWS here while resolving to '' on the
    // identical loop that completed without a gate. Re-derived from the definition,
    // exactly like the resume-hydration path (#2091).
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    // `note` is declared-optional and ABSENT from the finalized payload: with
    // declaredFields it resolves to ''; without, it throws an OutputRefError.
    const workflowRun = makeWorkflowRun('finalize-declared-fields', {
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'judge',
          iteration: 1,
          sessionId: 'sig-1',
          message: 'gate',
          completionSignaled: true,
          signaledOutput: JSON.stringify({ done: true }),
        },
        loop_user_input: '',
        loop_feedback_given: false,
      },
    });

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'finalize-declared-fields',
          nodes: [
            {
              id: 'judge',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'judge',
                until: 'APPROVED',
                max_iterations: 5,
                until_field: 'done',
                interactive: true,
                gate_message: 'Review.',
              },
            },
            {
              id: 'report',
              depends_on: ['judge'],
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "note=[$judge.output.note]"',
            },
          ],
        },
        workflowRun,
      })
    );

    // Declared-but-absent optional resolves to empty (shell-quoted by the
    // bash-escaped substitution path), not a failed consumer.
    expect(result).toContain("note=['']");
  });

  it('still honours an until signal on the final prose line when output_format is set', async () => {
    // Detection checks prose and serialized output separately. Concatenating them
    // would hide a final standalone signal line behind the serialized payload.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'All tasks are finished.\nALLDONE' };
      yield {
        type: 'result',
        sessionId: `s-${String(calls)}`,
        structuredOutput: { done: false, note: 'still working' },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-inline-sentinel');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-inline-sentinel',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                until: 'ALLDONE',
                max_iterations: 4,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // `done` stays false, so only the prose sentinel can have ended this.
    expect(calls).toBe(1);
  });

  it('still honours an until signal emitted inside the structured payload', async () => {
    // A loop declaring BOTH until: and output_format. On a grammar-constrained
    // provider the prose is empty, so detection reads the serialized payload too —
    // otherwise the declared signal channel could never fire, silently.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield {
        type: 'result',
        sessionId: `s-${String(calls)}`,
        structuredOutput: { done: false, note: '<promise>ALLDONE</promise>' },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-signal-in-payload');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-signal-in-payload',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                until: 'ALLDONE',
                max_iterations: 4,
                until_field: 'done',
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // `done` stays false, so only the signal can have ended it.
    expect(calls).toBe(1);
  });

  it('gives a downstream node strict field access to the loop output', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 's1',
        structuredOutput: { done: true, note: 'shipped' },
      };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('loop-downstream-field');

    const result = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-downstream-field',
          nodes: [
            {
              id: 'my-loop',
              output_format: untilFieldSchema,
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'go',
                max_iterations: 3,
                until_field: 'done',
              },
            },
            {
              id: 'report',
              depends_on: ['my-loop'],
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "note=$my-loop.output.note"',
            },
          ],
        },
        workflowRun,
      })
    );

    // Shell-quoted by the bash-escaped substitution path, as any $node.output.field is.
    expect(result).toContain("note='shipped'");
  });

  it('detects plain completion signal (non-<promise> format)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'All tasks done!\nCOMPLETE' };
      yield { type: 'result', sessionId: 'plain-sid' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-plain-signal',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should complete on first iteration (plain signal on own line)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const completeCalls = (
      mockDeps.store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][2]).toEqual({
      node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
    });
  });

  it('does not detect a negated plain signal at the end of output', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'The task is not COMPLETE' };
      yield { type: 'result', sessionId: 'false-pos-sid' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-loop-false-positive',
          nodes: [
            {
              id: 'my-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Work.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
      })
    );

    // Should have run max_iterations times (NOT detected as complete)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Should have FAILED (not completed)
    expect(
      (mockDeps.store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock.calls.length
    ).toBe(1);
  });
});
