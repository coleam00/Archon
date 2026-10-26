import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { IPlatformAdapter } from '../../types';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { captureWorkflowSource } from '../../../../workflows/src/workflow-source';
import type { trackTempRoots } from '@archon/paths/test-utils';
import {
  CAPTURED_SOURCE_ROOTS,
  makeCodebase,
  makeCodebaseForSync,
  makeConversation,
  makePlatform,
  makeRun,
  mockDiscoverWorkflowsWithConfig,
  mockDispatchBackgroundWorkflow,
  mockExecuteWorkflow,
  mockGetCodebase,
  mockGetOrCreateConversation,
  mockGetWorkflowRunDb,
  mockHandleCommand,
  mockHydrateResumableRun,
  mockListCodebases,
  mockParseCommand,
  mockResolveContinuationWorkflow,
  mockUpdateConversation,
  mockValidateAndResolveIsolation,
  operator,
  realDiscoverWorkflowsWithConfig,
  realResolveContinuationWorkflow,
} from '../../test/orchestrator-agent-harness';
import { handleMessage } from '../orchestrator-agent';
import { continueResolvedGateRun } from '../workflow-dispatch';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';

export function registerNoProjectTests() {
  // ─── handleWorkflowRunCommand — no project attached ──────────────────────────

  describe('handleWorkflowRunCommand — no project attached', () => {
    const assistWorkflow = makeTestResolvedWorkflow({ name: 'assist' });

    beforeEach(() => {
      mockGetOrCreateConversation.mockReset();
      mockListCodebases.mockReset();
      mockParseCommand.mockReset();
      mockHandleCommand.mockReset();
      mockUpdateConversation.mockClear();
      mockDispatchBackgroundWorkflow.mockClear();
      mockExecuteWorkflow.mockClear();

      mockGetOrCreateConversation.mockImplementation(() =>
        Promise.resolve(makeConversation({ codebase_id: null }))
      );
      mockListCodebases.mockImplementation(() => Promise.resolve([makeCodebaseForSync()]));
    });

    test('asks for a project even when only one is registered', async () => {
      mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
      mockHandleCommand.mockReturnValueOnce(
        Promise.resolve({
          success: true,
          message: 'Running workflow assist...',
          workflow: { kind: 'start', definition: assistWorkflow, args: 'test prompt' },
        })
      );

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      expect(mockUpdateConversation).not.toHaveBeenCalledWith(
        'conv-1-db',
        expect.objectContaining({ codebase_id: expect.anything() })
      );
      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'Which project should this workflow run on?\n\n- test-repo\n\n' +
          'Reply with the project name, or choose one with `/setproject <name>` and then use: /workflow run assist "test prompt"'
      );
    });

    test('asks for a project before resuming when only one is registered', async () => {
      const run = makeRun({ id: 'paused-run', workflow_name: 'assist', status: 'paused' });
      mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['resume', run.id] });
      mockHandleCommand.mockResolvedValueOnce({
        success: true,
        message: 'Resume requested.',
        workflow: { kind: 'resume', run },
      });

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', `/workflow resume ${run.id}`, { actor: operator });

      expect(mockUpdateConversation).not.toHaveBeenCalledWith(
        'conv-1-db',
        expect.objectContaining({ codebase_id: expect.anything() })
      );
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'Choose a project for this conversation with `/setproject <name>`, then retry `/workflow resume paused-run`.\n\n- test-repo'
      );
    });
  });
}

export function registerStartNoticesTests() {
  // ─── dispatchOrchestratorWorkflow — run-start notices ────────────────────────

  // #2213 — every chat and console run funnels through dispatchOrchestratorWorkflow,
  // so this is the one place that covers them all. The console's Start button
  // synthesizes `/workflow run <name>` into exactly this path, which is why a picker
  // badge alone was not enough.
  describe('dispatchOrchestratorWorkflow — run-start notices', () => {
    beforeEach(() => {
      mockGetOrCreateConversation.mockReset();
      mockGetCodebase.mockReset();
      mockParseCommand.mockReset();
      mockHandleCommand.mockReset();
      mockDispatchBackgroundWorkflow.mockClear();

      mockGetOrCreateConversation.mockImplementation(() =>
        Promise.resolve(makeConversation({ codebase_id: 'codebase-1' }))
      );
      mockGetCodebase.mockImplementation(() => Promise.resolve(makeCodebaseForSync()));
    });

    function runsWorkflow(definition: ResolvedWorkflow, parseWarnings?: string[]): void {
      mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', definition.name] });
      mockHandleCommand.mockReturnValueOnce(
        Promise.resolve({
          success: true,
          message: `Running workflow ${definition.name}...`,
          workflow: { kind: 'start', definition, args: 'test prompt', parseWarnings },
        })
      );
    }

    test('mirrors parse warnings into the conversation before the run starts', async () => {
      runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }), [
        "Node 'plan': unknown key 'interactive' will be ignored.",
      ]);

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining("unknown key 'interactive' will be ignored")
      );
      // The warning must not replace the run — it precedes it.
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    });

    // The contract behind persisting warnings on the run: a failed chat delivery
    // must not take the record with it. If this ever regresses, a Slack hiccup at
    // dispatch reproduces #2213 exactly — a dropped `interactive:` gate with
    // nothing anywhere to show for it.
    test('still hands warnings to the executor when sendMessage throws', async () => {
      runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }), [
        "Node 'plan': unknown key 'interactive' will be ignored.",
      ]);

      const platform = makePlatform();
      // Fail ONLY the warning delivery — a rate limit or over-length message on
      // that one call. Failing every send instead would throw out of an unrelated,
      // pre-existing `sendMessage` earlier in the turn and never reach this code.
      (platform.sendMessage as ReturnType<typeof mock>).mockImplementation(
        (_id: string, text: string) =>
          text.includes('declares keys the engine ignores')
            ? Promise.reject(new Error('rate limited'))
            : Promise.resolve()
      );

      // Must not throw: an undeliverable warning cannot fail the run.
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      // The run still started, and it carries the warnings — so the executor
      // records them as a `workflow_parse_warnings` event regardless of delivery.
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
      const ctx = (mockDispatchBackgroundWorkflow as ReturnType<typeof mock>).mock.calls[0][0] as {
        parseWarnings?: readonly string[];
      };
      expect(ctx.parseWarnings).toEqual([
        "Node 'plan': unknown key 'interactive' will be ignored.",
      ]);
    });

    test('sends no parse-warning message for a clean workflow', async () => {
      runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }));

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('declares keys the engine ignores')
      );
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    });

    // #2781 — a deprecated bundled default announces its removal on the surface
    // the run reports to, before any background dispatch.
    test('sends the deprecation notice at run start for a workflow declaring deprecated:', async () => {
      runsWorkflow(
        makeTestResolvedWorkflow({
          name: 'assist',
          deprecated: { message: 'Switch to the sdlc pack instead.' },
        })
      );

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.'
      );
      // The notice must not replace the run — it precedes it.
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    });

    test('sends no deprecation notice for a clean workflow', async () => {
      runsWorkflow(makeTestResolvedWorkflow({ name: 'assist' }));

      const platform = makePlatform();
      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });

      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'conv-1',
        expect.stringContaining('will be removed in an upcoming release')
      );
    });

    test('a failed deprecation delivery does not stop the run', async () => {
      runsWorkflow(
        makeTestResolvedWorkflow({ name: 'assist', deprecated: { message: 'Switch instead.' } })
      );

      const platform = makePlatform();
      (platform.sendMessage as ReturnType<typeof mock>).mockImplementation(
        (_id: string, text: string) =>
          text.includes('will be removed in an upcoming release')
            ? Promise.reject(new Error('rate limited'))
            : Promise.resolve()
      );

      await handleMessage(platform, 'conv-1', '/workflow run assist test prompt', {
        actor: operator,
      });
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    });
  });
}

export function registerGateContinuationTests(trackTempRoot: ReturnType<typeof trackTempRoots>) {
  describe('continueResolvedGateRun — chat gate continuation source (#2646)', () => {
    function makeGateRun(): WorkflowRun {
      return makeRun({
        id: 'run-gated',
        workflow_name: 'gated',
        conversation_id: 'conv-1-db',
        parent_conversation_id: 'conv-1-db',
        user_message: 'go',
        working_path: '/repos/test-repo/worktrees/feature',
      });
    }

    async function writeGateWorkflow(
      root: string,
      description: string,
      disableWorktree: boolean
    ): Promise<void> {
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'gated.yaml'),
        [
          'name: gated',
          `description: ${description}`,
          ...(disableWorktree ? ['worktree:', '  enabled: false'] : []),
          'nodes:',
          '  - id: work',
          '    prompt: Do the work',
          '',
        ].join('\n')
      );
    }

    beforeEach(async () => {
      mockGetWorkflowRunDb.mockResolvedValue(makeGateRun());
      mockExecuteWorkflow.mockClear();
      mockHydrateResumableRun.mockClear();
      mockValidateAndResolveIsolation.mockClear();
      // Reset, not clear: a queued `…Once` value that a test never consumes would otherwise
      // leak into the next one. Restores the factory default — a run predating captures.
      mockResolveContinuationWorkflow.mockReset();
      mockResolveContinuationWorkflow.mockImplementation(() => Promise.resolve(undefined));
      mockDiscoverWorkflowsWithConfig.mockReset();
      mockDiscoverWorkflowsWithConfig.mockResolvedValue({ workflows: [], errors: [] });
    });

    test("continues with the graph the run froze, not the chat turn's discovery list", async () => {
      const frozen = makeTestResolvedWorkflow({ name: 'gated', description: 'frozen' });
      mockResolveContinuationWorkflow.mockResolvedValueOnce({
        workflow: frozen,
        roots: CAPTURED_SOURCE_ROOTS,
        workflows: [{ workflow: frozen, source: 'project' }],
        errors: [],
      });

      await continueResolvedGateRun(
        makePlatform(),
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase(),
        makeGateRun(),
        'approve',
        operator
      );

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const executed = (mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as {
        description?: string;
      };
      expect(executed.description).toBe('frozen');
    });

    test('uses the captured graph for host worktree policy', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-host-captured-policy-')));
      const source = join(root, 'source');
      await writeGateWorkflow(source, 'Captured graph', true);
      const capture = await captureWorkflowSource({
        sourceRoot: source,
        captureRoot: join(root, 'capture'),
      });
      // Same name, opposite policy. A host that bypasses the run capture creates
      // isolation here; the recorded graph explicitly disables it.
      await writeGateWorkflow(source, 'Conflicting live graph', false);
      mockResolveContinuationWorkflow.mockImplementationOnce((...args) =>
        realResolveContinuationWorkflow(...args)
      );
      mockDiscoverWorkflowsWithConfig.mockImplementation((...args) =>
        realDiscoverWorkflowsWithConfig(...args)
      );
      const run = makeGateRun();
      run.working_path = source;
      run.metadata = {
        workflow_source: {
          version: 1,
          root: capture.anchor.root,
          origin: capture.origin,
          captured_at: capture.manifest.captured_at,
          digest: capture.manifest.digest,
          source_config: capture.manifest.source_config,
          file_count: capture.manifest.file_count,
          byte_count: capture.manifest.byte_count,
        },
      };

      await continueResolvedGateRun(
        makePlatform(),
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase({ default_cwd: source }),
        run,
        'approve',
        operator
      );

      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(
        ((mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as { description: string }).description
      ).toBe('Captured graph');
    });

    test('continues a run whose workflow the current checkout no longer has', async () => {
      // The refusal this replaces was a false one: the chat turn's list describes the
      // checkout, and a workflow deleted or renamed since the run started is missing from
      // it — while the run's own captured source still holds exactly what it was running.
      const frozen = makeTestResolvedWorkflow({ name: 'gated', description: 'frozen' });
      mockResolveContinuationWorkflow.mockResolvedValueOnce({
        workflow: frozen,
        roots: CAPTURED_SOURCE_ROOTS,
        workflows: [{ workflow: frozen, source: 'project' }],
        errors: [],
      });

      const platform = makePlatform();
      await continueResolvedGateRun(
        platform,
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase(),
        makeGateRun(),
        'approve',
        operator
      );

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        c => (c as unknown[])[1] as string
      );
      expect(messages.some(m => m.includes('was not found'))).toBe(false);
    });

    test('a run predating captures still resolves from the live list', async () => {
      // resolveContinuationWorkflow returns undefined for it, and the fallback is the only
      // thing that can name its graph.
      mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'gated', description: 'live' })],
        errors: [],
      });
      await continueResolvedGateRun(
        makePlatform(),
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase(),
        makeGateRun(),
        'approve',
        operator
      );

      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      const executed = (mockExecuteWorkflow.mock.calls[0] as unknown[])[4] as {
        description?: string;
      };
      expect(executed.description).toBe('live');
    });

    test('an unreadable captured source refuses instead of running something else', async () => {
      mockResolveContinuationWorkflow.mockRejectedValueOnce(
        new Error('captured source digest mismatch')
      );

      const platform = makePlatform();
      await continueResolvedGateRun(
        platform,
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase(),
        makeGateRun(),
        'approve',
        operator
      );

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        c => (c as unknown[])[1] as string
      );
      expect(messages[0]).toContain('Continuation requested');
      expect(messages.some(m => m.includes('digest mismatch'))).toBe(true);
      expect(mockHydrateResumableRun).not.toHaveBeenCalled();
    });

    // #2910: both sides of the recovery branch. An ordinary resume failure leaves the
    // run resumable, so `/workflow resume` is right. A rejected terminal write leaves the
    // row non-terminal — `/workflow resume` refuses those, so that advice would send the
    // operator down a dead end for a run that may well have finished its work.
    async function continueWithRejection(
      platform: ReturnType<typeof makePlatform>,
      rejection: unknown
    ): Promise<string[]> {
      mockExecuteWorkflow.mockRejectedValueOnce(rejection);
      mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'gated', description: 'live' })],
        errors: [],
      });
      await continueResolvedGateRun(
        platform,
        'conv-1',
        makeConversation({ codebase_id: 'codebase-1' }),
        makeCodebase(),
        makeGateRun(),
        'approve',
        operator
      );
      return (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        c => (c as unknown[])[1] as string
      );
    }

    test('an ordinary resume failure points at /workflow resume', async () => {
      const messages = await continueWithRejection(makePlatform(), new Error('resume boom'));

      expect(messages.some(m => m.includes('retry with `/workflow resume run-gated`'))).toBe(true);
    });

    test('a rejected terminal write says the status is unknown, not "retry the resume"', async () => {
      const messages = await continueWithRejection(
        makePlatform(),
        new TerminalStatusWriteError(new Error('db is gone'))
      );

      expect(messages.some(m => m.includes('final status could not be saved'))).toBe(true);
      expect(messages.some(m => m.includes('retry with `/workflow resume'))).toBe(false);
    });

    describe('recovery commands use the surface spelling', () => {
      // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
      function makeSlackPlatform(): ReturnType<typeof makePlatform> &
        Pick<IPlatformAdapter, 'formatWorkflowCommand'> {
        return {
          ...makePlatform(),
          formatWorkflowCommand: (command: string) => `/archon-workflow ${command}`,
        };
      }

      function expectSlackSpelling(messages: string[]): void {
        const text = messages.join('\n');
        expect(text).toContain('/archon-workflow ');
        expect(text.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
      }

      test('an ordinary resume failure', async () => {
        const messages = await continueWithRejection(makeSlackPlatform(), new Error('resume boom'));
        expect(messages.some(m => m.includes('`/archon-workflow resume run-gated`'))).toBe(true);
        expectSlackSpelling(messages);
      });

      test('a rejected terminal write', async () => {
        const messages = await continueWithRejection(
          makeSlackPlatform(),
          new TerminalStatusWriteError(new Error('db is gone'))
        );
        expect(messages.some(m => m.includes('`/archon-workflow get run-gated`'))).toBe(true);
        expectSlackSpelling(messages);
      });

      test('no project attached', async () => {
        const platform = makeSlackPlatform();
        await continueResolvedGateRun(
          platform,
          'conv-1',
          makeConversation(),
          null,
          makeGateRun(),
          'approve',
          operator
        );
        const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
          c => (c as unknown[])[1] as string
        );
        expectSlackSpelling(messages);
      });
    });
  });
}
