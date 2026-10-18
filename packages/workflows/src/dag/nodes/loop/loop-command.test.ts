// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  ready,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import type { DagNode, IncludeDirective, WorkflowDefinition } from '../../../schemas';
import { discoverWorkflows } from '../../../workflow-discovery';
import {
  COMPILED_LOOP_COMMAND,
  type CompiledLoopCommand,
  type LoopWithCompiledCommand,
} from '../../../compiled-command';
import type { IWorkflowStore } from '../../../store';

describe('loop.command (command-file-backed loop nodes)', () => {
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

  // ─── loop.command (command-file-backed loop nodes) ──────────────────────
  //
  // Hidden mechanics these tests pin down:
  //   • The command file is read ONCE per run/node — loaded at node start,
  //     reused for every iteration, and persisted across an interactive gate
  //     pause (`commandSnapshot`) so a file edited or deleted while paused
  //     cannot change the running loop's prompt.
  //   • A missing / empty / unsafe `loop.command` fails the node *before*
  //     any iteration runs — no `sendQuery` call, one `node_failed` event
  //     with an actionable error. The schema's superRefine catches unsafe
  //     names at parse, but a hand-constructed workflow can bypass parse;
  //     these tests exercise the executor's defense-in-depth branch.
  //   • Loop variable substitution (`$LOOP_PREV_OUTPUT`, `$LOOP_USER_INPUT`,
  //     and the standard workflow vars) applies to the loaded command-file
  //     text identically to inline `loop.prompt` text.

  it('reads loop.command file once at node start, not per iteration', async () => {
    // Regression guard for the "load once, reuse" invariant. We write a
    // command file, run iteration 1, delete the file synchronously inside
    // the mock generator, and confirm iteration 2 still runs successfully.
    // If the executor re-read the file per iteration, the load would fail
    // on iteration 2 and surface as `node_failed` / `loop_iteration_failed`.
    const cmdPath = join(testDir, '.archon', 'commands', 'read-once-loop.md');
    await writeFile(cmdPath, 'Command-loaded loop body. iter prev=<<$LOOP_PREV_OUTPUT>>');

    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // Delete the source file *during* iteration 1 so it is gone by the
        // time iteration 2 begins. Synchronous unlink ensures the file is
        // removed before the next `for await` yield resumes the loop body.
        unlinkSync(cmdPath);
        yield { type: 'agent_message_chunk', text: 'iter1 work output' };
        yield { type: 'result', sessionId: 'sid-once-1' };
      } else {
        yield { type: 'agent_message_chunk', text: 'iter2 done. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'sid-once-2' };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-cmd-read-once',
          nodes: [
            {
              id: 'read-once-loop',
              kind: 'loop',
              loop: {
                command: 'read-once-loop',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    // Both iterations ran — the mid-run deletion did not break iteration 2.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // No failure events of any kind.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvents = eventCalls.filter((call: unknown[]) => {
      const evt = (call[0] as Record<string, unknown>).event_type as string;
      return evt === 'node_failed' || evt === 'loop_iteration_failed';
    });
    expect(failedEvents).toHaveLength(0);
    // Both iterations received the *same* file body as their prompt template
    // — proving the file contents were loaded once and reused, not re-read.
    expect(mockSendQueryDag.mock.calls[0][0] as string).toContain('Command-loaded loop body.');
    expect(mockSendQueryDag.mock.calls[1][0] as string).toContain('Command-loaded loop body.');
    // node_started carries the command name so the event stream identifies
    // command-backed loops without reading the workflow YAML.
    const started = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_started' &&
        (call[0] as Record<string, unknown>).step_name === 'read-once-loop'
    );
    expect(started).toBeDefined();
    const startedData = (started![0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(startedData.command).toBe('read-once-loop');
  });

  it('fails fast with node_failed when loop.command names a missing file', async () => {
    // Schema rejection at parse only fires when the workflow is parsed via
    // the loader; a hand-constructed workflow bypasses that. The runtime
    // guard inside `executeLoopNode` must catch the missing command and
    // fail the node before iteration 1 runs.
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-cmd-missing',
          nodes: [
            {
              id: 'missing-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                command: 'does-not-exist-anywhere',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    // sendQuery must never have been invoked — load failed pre-iteration.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    // `node_failed` event was emitted with the actionable message.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'missing-loop'
    );
    expect(failed).toBeDefined();
    const data = (failed![0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(String(data.error)).toContain('not found');
    // The failing command name must travel with the event so consumers of the
    // event stream see the same context as the structured log.
    expect(data.command).toBe('does-not-exist-anywhere');

    // node_started must be paired with node_failed even when the failure is
    // pre-iteration — same lifecycle contract as bash and script nodes.
    const started = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_started' &&
        (call[0] as Record<string, unknown>).step_name === 'missing-loop'
    );
    expect(started).toBeDefined();
  });

  it('fails fast with node_failed when loop.command target file is empty', async () => {
    // An empty command file is a load-time failure in `loadCommandPrompt`
    // (same as for `command:` nodes). The loop must fail with the empty-file
    // diagnostic before iteration 1.
    await writeFile(join(testDir, '.archon', 'commands', 'empty-loop.md'), '');

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-cmd-empty',
          nodes: [
            {
              id: 'empty-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                command: 'empty-loop',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'empty-loop'
    );
    expect(failed).toBeDefined();
    const data = (failed![0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(String(data.error)).toContain('empty');
    expect(data.command).toBe('empty-loop');
  });

  it('fails fast with node_failed when loop.command is an unsafe name', async () => {
    // The loop schema's superRefine rejects `'../escape'` at parse, but a
    // programmatically-constructed workflow bypasses parse. The executor
    // branch must still flag this via `isValidCommandName` inside
    // `loadCommandPrompt` rather than attempting any file resolution.
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'loop-cmd-unsafe',
          nodes: [
            {
              id: 'unsafe-loop',
              kind: 'loop',
              loop: {
                fresh_context: false,
                command: '../escape',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failed = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>).event_type === 'node_failed' &&
        (call[0] as Record<string, unknown>).step_name === 'unsafe-loop'
    );
    expect(failed).toBeDefined();
    const data = (failed![0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(String(data.error)).toContain('Invalid command name');
    expect(data.command).toBe('../escape');
  });

  it('applies $LOOP_PREV_OUTPUT and $LOOP_USER_INPUT substitution to command-loaded text', async () => {
    // Loop variable substitution applies to command-loaded prompt text
    // identically to inline prompt text: both `$LOOP_PREV_OUTPUT` and
    // `$LOOP_USER_INPUT` are embedded in the command file body, and the
    // prompt actually sent to the AI must substitute them the same way the
    // inline-prompt tests verify for `loop.prompt`. The body itself must
    // appear in the sent prompt — proof the file contents (not the YAML
    // node body) flow through `substituteWorkflowVariables`.
    await writeFile(
      join(testDir, '.archon', 'commands', 'subst-loop.md'),
      'Cmd-file body. PREV=<<$LOOP_PREV_OUTPUT>> USER=<<$LOOP_USER_INPUT>>'
    );

    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'agent_message_chunk', text: 'iter1 result text' };
        yield { type: 'result', sessionId: 'sid-subst-1' };
      } else {
        yield { type: 'agent_message_chunk', text: 'done. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'sid-subst-2' };
      }
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
          name: 'loop-cmd-subst',
          nodes: [
            {
              id: 'subst-loop',
              kind: 'loop',
              loop: {
                command: 'subst-loop',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            } as unknown as DagNode,
          ],
        },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
    const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
    // The file body is what reached the AI — not the YAML inline-prompt path.
    expect(promptIter1).toContain('Cmd-file body.');
    expect(promptIter2).toContain('Cmd-file body.');
    // Iteration 1: PREV substitutes to empty (no prior output); USER empty
    // (non-interactive, no resume metadata).
    expect(promptIter1).toContain('PREV=<<>>');
    expect(promptIter1).toContain('USER=<<>>');
    // Iteration 2: PREV carries iteration 1's cleaned output, USER stays
    // empty (still non-interactive).
    expect(promptIter2).toContain('PREV=<<iter1 result text>>');
    expect(promptIter2).toContain('USER=<<>>');
  });

  it('reuses the pause-time command snapshot on approval resume — file mutated and deleted while paused', async () => {
    // Two-invocation contract: invocation 1 loads the command file and pauses
    // at the interactive gate, persisting the loaded body (`commandSnapshot`)
    // in the pause context. While the run sits paused, the file is rewritten
    // AND then deleted. Invocation 2 (the approval resume) must run the next
    // iteration from the SNAPSHOT — never from the mutated file, and without
    // failing on the missing file.
    const cmdPath = join(testDir, '.archon', 'commands', 'gated-loop.md');
    await writeFile(cmdPath, 'ORIGINAL gated body. USER=<<$LOOP_USER_INPUT>>');

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'iteration output, no signal yet' };
      yield { type: 'result', sessionId: 'sid-gated-1' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const gatedWorkflow = {
      name: 'loop-cmd-gated',
      nodes: [
        {
          id: 'gated-loop',
          kind: 'loop',
          loop: {
            fresh_context: false,
            command: 'gated-loop',
            until: 'COMPLETE',
            max_iterations: 5,
            interactive: true,
            gate_message: 'Review this iteration.',
          },
        } as unknown as DagNode,
      ],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: gatedWorkflow,
        workflowRun,
      })
    );

    // Invocation 1 paused at the gate and persisted the loaded body.
    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    const pausedContext = pauseCalls[0][1];
    expect(pausedContext.commandSnapshot).toContain('ORIGINAL gated body.');
    expect(mockSendQueryDag.mock.calls[0][0] as string).toContain('ORIGINAL gated body.');

    // While paused: the file is rewritten, then deleted entirely.
    await writeFile(cmdPath, 'TAMPERED body that must never run');
    unlinkSync(cmdPath);

    // Invocation 2: approval resume with feedback (feedback forces a real
    // resumed iteration rather than a bare-approve finalize).
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'refined. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'sid-gated-2' };
    });
    const resumedRun = makeWorkflowRun(workflowRun.id, {
      metadata: {
        approval: { ...pausedContext },
        loop_user_input: 'tighten the summary',
        loop_feedback_given: true,
      },
    });
    const store2 = createMockStore();
    const mockDeps2 = createMockDeps(store2);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps2,
        platform,
        cwd: testDir,
        workflow: gatedWorkflow,
        workflowRun: resumedRun,
      })
    );

    // The resumed iteration ran from the snapshot: original body, user
    // feedback substituted, no trace of the tampered content, no failure
    // from the deleted file.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const resumedPrompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(resumedPrompt).toContain('ORIGINAL gated body.');
    expect(resumedPrompt).toContain('USER=<<tighten the summary>>');
    expect(resumedPrompt).not.toContain('TAMPERED');
    const failed = (store2.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failed).toHaveLength(0);
  });

  it('reuses the pause-time prompt snapshot after a composed loop prompt is rediscovered', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'iteration output, no signal yet' };
      yield { type: 'result', sessionId: 'sid-prompt-1' };
    });

    const platform = createMockPlatform();
    const firstDeps = createMockDeps();
    const blockWorkflow = {
      name: 'materialized-loop-block',
      description: 'Command-backed loop block',
      nodes: [
        {
          id: 'gated-loop',
          kind: 'loop',
          loop: {
            fresh_context: false,
            command: 'materialized-loop-command',
            until: 'COMPLETE',
            max_iterations: 5,
            interactive: true,
            gate_message: 'Review materialized prompt.',
          },
        } satisfies DagNode,
      ],
    } satisfies WorkflowDefinition;
    const parentWorkflow = {
      name: 'materialized-loop-gated',
      description: 'Includes the command-backed loop',
      nodes: [
        {
          id: 'included',
          kind: 'include',
          include: 'materialized-loop-block',
        } satisfies IncludeDirective,
      ],
    } satisfies WorkflowDefinition;
    const workflowDir = join(testDir, '.archon', 'workflows');
    const commandPath = join(testDir, '.archon', 'commands', 'materialized-loop-command.md');
    await mkdir(workflowDir, { recursive: true });
    await Promise.all([
      writeFile(join(workflowDir, 'materialized-block.yaml'), JSON.stringify(blockWorkflow)),
      writeFile(join(workflowDir, 'materialized-parent.yaml'), JSON.stringify(parentWorkflow)),
      writeFile(commandPath, 'ORIGINAL materialized command. USER=<<$LOOP_USER_INPUT>>'),
    ]);
    const firstDiscovery = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(firstDiscovery.errors).toHaveLength(0);
    const originalWorkflow = firstDiscovery.workflows.find(
      item => item.workflow.name === parentWorkflow.name
    )?.workflow;
    expect(originalWorkflow).toBeDefined();

    await executeDagWorkflow(
      dagOptions({
        deps: firstDeps,
        platform,
        cwd: testDir,
        workflow: ready(originalWorkflow!),
        workflowRun: makeWorkflowRun(),
      })
    );

    const pauseCalls = (
      firstDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    const pausedContext = pauseCalls[0][1];
    expect(pausedContext.commandSnapshot).toContain('ORIGINAL materialized command.');

    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'refined. <promise>COMPLETE</promise>' };
      yield { type: 'result', sessionId: 'sid-prompt-2' };
    });
    // Cold filesystem rediscovery after the source command was deleted still returns the
    // workflow. Its engine-private compilation error blocks a fresh run, while
    // this resumed run can reach and reuse the persisted snapshot.
    unlinkSync(commandPath);
    const rediscovery = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(rediscovery.errors).toHaveLength(0);
    const rediscoveredWorkflow = rediscovery.workflows.find(
      item => item.workflow.name === parentWorkflow.name
    )?.workflow;
    expect(rediscoveredWorkflow).toBeDefined();
    mockSendQueryDag.mockClear();
    const freshStore = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(freshStore),
        platform,
        cwd: testDir,
        workflow: ready(rediscoveredWorkflow!),
        workflowRun: makeWorkflowRun('fresh-invalid-command-run'),
      })
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const freshFailures = (
      freshStore.createWorkflowEvent as ReturnType<typeof mock>
    ).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(freshFailures).toHaveLength(1);

    const resumedRun = makeWorkflowRun(undefined, {
      metadata: {
        approval: { ...pausedContext },
        loop_user_input: 'tighten the summary',
        loop_feedback_given: true,
      },
    });

    mockSendQueryDag.mockClear();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(createMockStore()),
        platform,
        cwd: testDir,
        workflow: ready(rediscoveredWorkflow!),
        workflowRun: resumedRun,
      })
    );

    const resumedPrompt = mockSendQueryDag.mock.calls[0]?.[0] as string;
    expect(resumedPrompt).toContain('ORIGINAL materialized command.');
    expect(resumedPrompt).toContain('USER=<<tighten the summary>>');
    expect(resumedPrompt).not.toContain('could not be resolved');
  });

  it('fails before provider invocation when compiled loop metadata is malformed', async () => {
    const loop: Extract<DagNode, { loop: unknown }>['loop'] & LoopWithCompiledCommand = {
      command: 'malformed-compiled-command',
      until: 'DONE',
      max_iterations: 1,
      fresh_context: false,
    };
    loop[COMPILED_LOOP_COMMAND] = {} as CompiledLoopCommand;
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'malformed-compiled-command-workflow',
          nodes: [{ id: 'repeat', kind: 'loop', loop }],
        },
        workflowRun: makeWorkflowRun('malformed-compiled-command-run'),
      })
    );

    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const failures = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failures).toHaveLength(1);
    expect((failures[0]?.[0] as { data: { error: string } }).data.error).toContain(
      'malformed compiled command metadata'
    );
  });

  it('keeps a whitespace-only included loop discoverable but fails a fresh run', async () => {
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(workflowDir, 'empty-loop-block.yaml'),
        JSON.stringify({
          name: 'empty-loop-block',
          description: 'Whitespace loop command block',
          nodes: [
            {
              id: 'repeat',
              kind: 'loop',
              loop: {
                fresh_context: false,
                command: 'empty-included-loop',
                until: 'DONE',
                max_iterations: 1,
              },
            },
          ],
        })
      ),
      writeFile(
        join(workflowDir, 'empty-loop-parent.yaml'),
        JSON.stringify({
          name: 'empty-loop-parent',
          description: 'Includes whitespace loop command block',
          nodes: [{ id: 'inc', include: 'empty-loop-block' }],
        })
      ),
      writeFile(join(testDir, '.archon', 'commands', 'empty-included-loop.md'), '  \n\t'),
    ]);
    const discovery = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(discovery.errors).toHaveLength(0);
    const workflow = discovery.workflows.find(
      item => item.workflow.name === 'empty-loop-parent'
    )?.workflow;
    expect(workflow).toBeDefined();
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflow!),
        workflowRun: makeWorkflowRun('empty-included-loop-run'),
      })
    );

    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const failures = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(failures).toHaveLength(1);
    expect((failures[0]?.[0] as { data: { error: string } }).data.error).toContain(
      "command 'empty-included-loop' is empty"
    );
  });
});
