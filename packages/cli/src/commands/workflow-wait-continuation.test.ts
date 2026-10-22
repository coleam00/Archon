import { testHome, createTestWorkflowHost } from '../test-support/workflow-command-harness';
import { describe, it, expect, spyOn, mock } from 'bun:test';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';
import { RunLiveOwnerAlreadyOwnedError } from '@archon/core/services/run-live-owner';
import { WorkflowNotResumableError } from '@archon/workflows/store';
import { isResumeSuperseded, pendingDurableWait } from './workflow-wait-continuation';

describe('isResumeSuperseded', () => {
  it('recognizes a lease collision, directly or as a cause', () => {
    const collision = new RunLiveOwnerAlreadyOwnedError('/run.sock');
    expect(isResumeSuperseded(collision)).toBe(true);
    expect(isResumeSuperseded(new Error('Cannot resume workflow', { cause: collision }))).toBe(
      true
    );
  });

  it.each(['running', 'cancelled', 'failed', 'completed'] as const)(
    'only treats refused admission as superseded when the run is running (%s)',
    status => {
      expect(
        isResumeSuperseded(
          new Error('Cannot resume workflow', {
            cause: new WorkflowNotResumableError('run', status),
          })
        )
      ).toBe(status === 'running');
    }
  );
});

describe('workflowRunCommand — durable wait occurrence ownership', () => {
  for (const owner of ['node', 'loop_group'] as const) {
    for (const kind of ['time', 'event'] as const) {
      for (const replacement of ['first-read', 'poll', 'none'] as const) {
        it(`keeps its ${owner} ${kind} occurrence when replacement is ${replacement}`, async () => {
          const discovery = await import('@archon/workflows/workflow-discovery');
          const discover = spyOn(discovery, 'discoverWorkflowsWithConfig').mockResolvedValue({
            workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
            errors: [],
          });
          const host = createTestWorkflowHost();
          const codebases = await import('@archon/core/db/codebases');
          const findCodebase = spyOn(codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
            id: 'cb-wait',
            ai_assistant_type: null,
            commands: {},
            name: 'wait',
            repository_url: '',
            default_cwd: testHome,
            kind: 'folder',
            default_branch: 'main',
            created_at: new Date(),
            updated_at: new Date(),
          });
          const wait = {
            owner,
            kind,
            ...(owner === 'loop_group'
              ? { bodyWaitId: 'body-wait', iteration: 2, sessionId: null, sessionProvider: null }
              : {}),
            nodeId: 'checks',
            ...(kind === 'event' ? { event: 'checks.complete' } : {}),
            pauseId: 'occurrence-a',
            waitingSince: new Date().toISOString(),
            resumeAt: '',
          };
          const run: WorkflowRun = {
            id: 'run-wait',
            workflow_name: 'plan',
            status: 'paused',
            working_path: testHome,
            metadata: { wait },
            origin: null,
            conversation_id: null,
            parent_conversation_id: null,
            codebase_id: null,
            outcome: null,
            user_message: 'go',
            started_at: new Date(),
            completed_at: null,
            last_activity_at: null,
            user_id: null,
            parent_run_id: null,
            adopted_from_run_id: null,
            output_root: null,
            checkout_baseline: null,
          };
          wait.resumeAt = new Date(Date.now() + 20).toISOString();
          let reads = 0;
          host.deps.store.getWorkflowRun = mock(async () => {
            reads += 1;
            if (reads === 1 && replacement !== 'first-read') return run;
            if (reads > 1)
              clock.mockReturnValue(
                Date.parse(wait.resumeAt) -
                  (replacement === 'none' && (reads === 2 || kind === 'event') ? 1 : 0)
              );
            return {
              ...run,
              metadata: {
                wait: {
                  ...wait,
                  pauseId: replacement !== 'none' ? 'occurrence-b' : 'occurrence-a',
                  ...(kind === 'event' && (replacement !== 'none' || reads > 2)
                    ? { signaledAt: new Date().toISOString() }
                    : {}),
                },
              },
            };
          });
          const submit = spyOn(host.engine, 'submit').mockResolvedValue({
            success: true,
            workflowRunId: run.id,
            paused: true,
            waitCursor: {
              kind: 'wait',
              nodeId: wait.nodeId,
              resumeAt: wait.resumeAt,
              pauseId: wait.pauseId,
            },
          });
          const resume = spyOn(host.engine, 'resume').mockResolvedValue({
            accepted: true,
            runId: run.id,
            settled: Promise.resolve({ success: true, workflowRunId: run.id }),
          });
          const output = spyOn(console, 'log').mockImplementation(() => {});
          const clock = spyOn(Date, 'now').mockReturnValue(Date.parse(wait.resumeAt) - 20);
          try {
            await workflowRunCommand(host, testHome, 'plan', 'go', {
              noWorktree: true,
              quiet: true,
            });
            expect(submit).toHaveBeenCalledTimes(1);
            expect(reads).toBe(replacement === 'first-read' ? 1 : replacement === 'poll' ? 2 : 4);
            if (replacement !== 'none') expect(resume).not.toHaveBeenCalled();
            else {
              expect(output).toHaveBeenCalledWith(
                '  Usage (recorded totals; completeness unknown):'
              );
              expect(resume).toHaveBeenCalledWith(
                expect.objectContaining({
                  cursor: {
                    kind: 'wait',
                    nodeId: 'checks',
                    resumeAt: wait.resumeAt,
                    pauseId: 'occurrence-a',
                  },
                })
              );
            }
          } finally {
            submit.mockRestore();
            resume.mockRestore();
            output.mockRestore();
            discover.mockRestore();
            findCodebase.mockRestore();
            clock.mockRestore();
          }
        });
      }
    }
  }
});

describe('pendingDurableWait — which pauses this process owns', () => {
  const run = (status: WorkflowRunStatus, metadata: Record<string, unknown>): WorkflowRun =>
    ({ id: 'run-wait', status, metadata }) as unknown as WorkflowRun;

  it('reads the cursor for a time wait', () => {
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'node',
            kind: 'time',
            pauseId: 'time-occurrence',
            nodeId: 'cooldown',
            waitingSince: '2026-01-01T00:00:00.000Z',
            resumeAt: '2026-01-01T00:01:00.000Z',
          },
        })
      )
    ).toEqual({
      stepName: 'cooldown',
      cursor: {
        kind: 'wait',
        nodeId: 'cooldown',
        resumeAt: '2026-01-01T00:01:00.000Z',
        pauseId: 'time-occurrence',
      },
      signaled: false,
    });
  });

  it('marks a signaled event wait and names a loop-owned body wait', () => {
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'loop_group',
            nodeId: 'poll',
            bodyWaitId: 'checks',
            iteration: 2,
            sessionId: null,
            sessionProvider: null,
            kind: 'event',
            event: 'checks.complete',
            waitingSince: '2026-01-01T00:00:00.000Z',
            resumeAt: '2026-01-01T00:05:00.000Z',
            signaledAt: '2026-01-01T00:00:30.000Z',
          },
        })
      )
    ).toEqual({
      stepName: 'poll.checks',
      cursor: { kind: 'wait', nodeId: 'poll', resumeAt: '2026-01-01T00:05:00.000Z' },
      signaled: true,
    });
  });

  it('returns nothing for a running run, an attention wait, or an approval gate', () => {
    expect(pendingDurableWait(run('running', {}))).toBeUndefined();
    expect(
      pendingDurableWait(
        run('paused', {
          wait: {
            owner: 'node',
            kind: 'attention',
            nodeId: 'await-operator',
            waitingSince: '2026-01-01T00:00:00.000Z',
            message: 'Do the outside action',
          },
        })
      )
    ).toBeUndefined();
    expect(
      pendingDurableWait(run('paused', { approval: { nodeId: 'gate', message: 'ok?' } }))
    ).toBeUndefined();
  });
});
