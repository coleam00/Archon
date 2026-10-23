// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { hostname } from 'node:os';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { handleCommand } from '../command-handler';
import {
  operator,
  makeConversation,
  makeWorkflowRun,
  resumeRequest,
  mockGetWorkflowRun,
  mockFindWorkflowRunsByIdPrefix,
  mockReclaimContainerEnv,
  spyDiscoverWorkflows,
  restoreSpies,
  approveConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('handleCommand', () => {
    // A gate decision that does not continue the run leaves it stranded (#2565).
    // Before #2565 these commands told the user to "type your response to
    // resume", which relied on a natural-language branch that no longer exists.
    describe('/workflow approve|reject — run continuation', () => {
      function pausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
        return makeWorkflowRun({
          origin: { conversationId: 'conv-approve' },
          id: 'run-gate',
          workflow_name: 'gated-wf',
          conversation_id: 'conv-approve',
          status: 'paused' as const,
          user_message: 'original prompt',
          metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Approve?' } },
          last_activity_at: new Date(),
          working_path: '/repo',
          ...overrides,
        });
      }

      /** The gate op reads the run, then the continuation reads it again. */
      function stubRunReads(run: ReturnType<typeof pausedRun>): void {
        mockGetWorkflowRun.mockResolvedValueOnce(run).mockResolvedValueOnce(run);
      }

      function stubWorkflowDiscovery(): void {
        spyDiscoverWorkflows?.mockResolvedValue({
          workflows: [makeTestWorkflowWithSource({ name: 'gated-wf' })],
          errors: [],
        });
      }

      test('approve hands the orchestrator the resume payload for the same run', async () => {
        const run = pausedRun();
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-gate LGTM',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('Continuation requested');
        expect(resumeRequest(result.workflow).run).toBe(run);
      });

      test('reject with an on_reject rework hands back the resume payload', async () => {
        const run = pausedRun({
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve?',
              onRejectPrompt: 'Address $REJECTION_REASON',
            },
          },
        });
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-gate schema is wrong',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Feedback recorded');
        expect(result.message).toContain('Continuation requested');
        expect(resumeRequest(result.workflow).run.id).toBe('run-gate');
      });

      test('reject that cancels the run hands back nothing to resume', async () => {
        // No on_reject prompt ⇒ the run is cancelled, which IS its terminal
        // state — a resume payload here would try to restart a dead run.
        mockGetWorkflowRun.mockResolvedValueOnce(pausedRun());

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-gate no thanks',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('rejected and cancelled');
        expect(result.workflow).toBeUndefined();
      });

      test('reject that cancels a container run reports a failed reclaim', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          pausedRun({
            metadata: {
              approval: { type: 'approval', nodeId: 'review', message: 'Approve?' },
              isolation: 'container',
              isolation_env_id: 'env-a',
              execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
            },
          })
        );
        mockReclaimContainerEnv.mockImplementationOnce(() =>
          Promise.reject(new Error('docker down'))
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-gate no thanks',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('rejected and cancelled');
        expect(result.message).toContain('Could not reclaim container environment env-a');
      });

      // Refusal messages print the 8-character short id; every run-id verb accepts it.
      const projectConversation = makeConversation({
        id: 'conv-approve',
        platform_conversation_id: 'chat-approve',
        codebase_id: 'codebase-123',
      });

      test('approve resolves a short run id within the project', async () => {
        const run = pausedRun({ id: 'abcd1234-0000-4000-8000-000000000000' });
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([run]);
        stubRunReads(run);
        stubWorkflowDiscovery();
        mockGetWorkflowRun.mockClear();

        const result = await handleCommand(
          projectConversation,
          '/workflow approve abcd1234 LGTM',
          operator
        );

        expect(result.success).toBe(true);
        expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith('abcd1234', 'codebase-123');
        expect(mockGetWorkflowRun).toHaveBeenCalledWith(run.id);
        expect(resumeRequest(result.workflow).run).toBe(run);
      });

      test('reject resolves a short run id within the project', async () => {
        const run = pausedRun({ id: 'abcd1234-0000-4000-8000-000000000000' });
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([run]);
        mockGetWorkflowRun.mockClear();
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(
          projectConversation,
          '/workflow reject abcd1234 no',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('rejected and cancelled');
        expect(mockGetWorkflowRun).toHaveBeenCalledWith(run.id);
      });

      test('respond resolves a short run id within the project', async () => {
        const run = pausedRun({ id: 'abcd1234-0000-4000-8000-000000000000' });
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([run]);
        stubRunReads(run);
        stubWorkflowDiscovery();
        mockGetWorkflowRun.mockClear();

        const result = await handleCommand(
          projectConversation,
          '/workflow respond abcd1234 approve LGTM',
          operator
        );

        expect(result.success).toBe(true);
        expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith('abcd1234', 'codebase-123');
        expect(mockGetWorkflowRun).toHaveBeenCalledWith(run.id);
        expect(resumeRequest(result.workflow).run).toBe(run);
      });

      test('resume resolves a short run id within the project', async () => {
        const run = pausedRun({
          id: 'abcd1234-0000-4000-8000-000000000000',
          status: 'failed' as const,
        });
        mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([run]);
        mockGetWorkflowRun.mockClear();
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(
          projectConversation,
          '/workflow resume abcd1234',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toBe('Resume requested');
        expect(mockGetWorkflowRun).toHaveBeenCalledWith(run.id);
        expect(resumeRequest(result.workflow).run).toBe(run);
      });

      for (const command of [
        'approve abcd1234',
        'reject abcd1234',
        'respond abcd1234 approve',
        'resume abcd1234',
      ]) {
        test(`/workflow ${command} refuses a short id that matches more than one run`, async () => {
          mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([
            pausedRun({ id: 'abcd1234-0000-4000-8000-000000000001' }),
            pausedRun({ id: 'abcd1234-0000-4000-8000-000000000002' }),
          ]);
          mockGetWorkflowRun.mockClear();

          const result = await handleCommand(projectConversation, `/workflow ${command}`, operator);

          expect(result.success).toBe(false);
          expect(result.message).toContain("Run id 'abcd1234' matches more than one run");
          expect(mockGetWorkflowRun).not.toHaveBeenCalled();
        });
      }

      test('a container run is resolved but points at the CLI instead of resuming', async () => {
        // Chat cannot rewire the container, so dispatching a resume would fail
        // the run to say what this message says for free.
        const run = pausedRun({ metadata: { ...pausedRun().metadata, isolation: 'container' } });
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-gate',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('isolation container');
        expect(result.message).toContain('archon workflow resume run-gate');
        expect(result.message).not.toContain('/workflow resume run-gate');
        expect(result.workflow).toBeUndefined();
      });

      test('a recorded decision requests continuation without producer source preflight', async () => {
        const run = pausedRun();
        stubRunReads(run);
        spyDiscoverWorkflows?.mockResolvedValue({ workflows: [], errors: [] });

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-gate',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('Continuation requested');
        expect(resumeRequest(result.workflow).run).toBe(run);
        expect(spyDiscoverWorkflows).not.toHaveBeenCalled();
      });
    });
  });
});
