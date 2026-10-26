import { afterEach, beforeEach, describe, expect, it, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { DagNode, WorkflowRun } from '../../../../schemas';
import type { WorkflowDeps } from '../../../../deps';
import type { IWorkflowStore } from '../../../../store';

export function registerProviderThreadingTests() {
  describe('executeDagWorkflow -- provider-boundary session threading (#1992)', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-provbound-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
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

    async function runWorkflow(
      conversationId: string,
      workflow: { name: string; nodes: DagNode[] },
      workflowRun: WorkflowRun
    ): Promise<WorkflowDeps> {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId,
          cwd: testDir,
          workflow,
          workflowRun,
        })
      );
      return mockDeps;
    }

    async function runTwoNodeWorkflow(secondNode: DagNode): Promise<void> {
      await runWorkflow(
        'conv-prov-bound',
        {
          name: 'dag-provider-boundary',
          nodes: [
            { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'First step' } },
            secondNode,
          ],
        },
        makeWorkflowRun('provider-boundary-run')
      );
    }

    it('sequential node on a DIFFERENT provider gets a fresh session (no cross-provider resume)', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'step done' };
        yield { type: 'result', sessionId: 'sess-a' };
      });

      await runTwoNodeWorkflow({
        id: 'b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Second step' },
        depends_on: ['a'],
        provider: 'codex',
      });

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Node a (claude) ran fresh; node b (codex) must NOT inherit a's claude session id.
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    });

    it('sequential node on the SAME provider still threads the session', async () => {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'step done' };
        yield { type: 'result', sessionId: 'sess-a' };
      });

      await runTwoNodeWorkflow({
        id: 'b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Second step' },
        depends_on: ['a'],
      });

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      expect(mockSendQueryDag.mock.calls[1][2]).toBe('sess-a');
    });

    it('node after a loop node on a DIFFERENT provider gets a fresh session', async () => {
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        if (prompt.includes('Iterate')) {
          yield { type: 'agent_message_chunk', text: 'all done <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-sess' };
        } else {
          yield { type: 'agent_message_chunk', text: 'downstream done' };
          yield { type: 'result', sessionId: 'sess-after' };
        }
      });

      await runWorkflow(
        'conv-prov-bound-loop',
        {
          name: 'dag-provider-boundary-loop',
          nodes: [
            {
              id: 'work',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Iterate until done.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
            {
              id: 'after',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Summarize' },
              depends_on: ['work'],
              provider: 'codex',
            },
          ],
        },
        makeWorkflowRun('provider-boundary-loop-run')
      );

      // 1 loop iteration + 1 downstream call.
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Downstream codex node must NOT resume the loop's claude session.
      expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    });

    it('node after a loop node on the SAME provider still threads the loop session', async () => {
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        if (prompt.includes('Iterate')) {
          yield { type: 'agent_message_chunk', text: 'all done <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-sess' };
        } else {
          yield { type: 'agent_message_chunk', text: 'downstream done' };
          yield { type: 'result', sessionId: 'sess-after' };
        }
      });

      await runWorkflow(
        'conv-same-prov-loop',
        {
          name: 'dag-same-provider-loop',
          nodes: [
            {
              id: 'work',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Iterate until done.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
            {
              id: 'after',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Summarize' },
              depends_on: ['work'],
            },
          ],
        },
        makeWorkflowRun('same-provider-loop-run')
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      expect(mockSendQueryDag.mock.calls[1][2]).toBe('loop-sess');
    });

    it('loop_group body: provider boundaries stay fresh within and across iterations', async () => {
      // Body: x (claude) -> y (codex), fresh_context: false. y emits DONE on iteration 2.
      // No call may ever receive a resume id: x->y is a provider boundary within the
      // iteration, and each cross-iteration handoff (y's codex cursor into x, x's claude
      // cursor into y) is a provider boundary too.
      let yCalls = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        if (prompt.includes('analyze')) {
          yield { type: 'agent_message_chunk', text: 'analysis output' };
          yield { type: 'result', sessionId: 'sess-x' };
        } else {
          yCalls++;
          const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
          yield { type: 'agent_message_chunk', text: content };
          yield { type: 'result', sessionId: `sess-y-${yCalls}` };
        }
      });

      await runWorkflow(
        'conv-lg-prov',
        {
          name: 'lg-provider-boundary',
          nodes: [
            {
              id: 'fixer',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'x',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'analyze the failure' },
                    depends_on: [],
                  },
                  {
                    id: 'y',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'apply the fix, emit DONE when green' },
                    depends_on: ['x'],
                    provider: 'codex',
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        makeWorkflowRun('lg-provider-boundary')
      );

      // 2 iterations x 2 body nodes = 4 calls, every one fresh.
      expect(mockSendQueryDag.mock.calls.length).toBe(4);
      for (const call of mockSendQueryDag.mock.calls) {
        expect(call[2]).toBeUndefined();
      }
    });

    it('loop_group body: same-provider chain still threads within and across iterations', async () => {
      // Body: x -> y, both claude, fresh_context: false. Threading expectations:
      // iter1: x fresh, y resumes x's session; iter2 seeds y's iter-1 session into x,
      // then y resumes x's iter-2 session.
      let yCalls = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        if (prompt.includes('analyze')) {
          yield { type: 'agent_message_chunk', text: 'analysis output' };
          yield { type: 'result', sessionId: `sess-x-${String(yCalls + 1)}` };
        } else {
          yCalls++;
          const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
          yield { type: 'agent_message_chunk', text: content };
          yield { type: 'result', sessionId: `sess-y-${yCalls}` };
        }
      });

      await runWorkflow(
        'conv-lg-same',
        {
          name: 'lg-same-provider',
          nodes: [
            {
              id: 'fixer',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: false,
                nodes: [
                  {
                    id: 'x',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'analyze the failure' },
                    depends_on: [],
                  },
                  {
                    id: 'y',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'apply the fix, emit DONE when green' },
                    depends_on: ['x'],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        makeWorkflowRun('lg-same-provider')
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(4);
      const resumeIds = mockSendQueryDag.mock.calls.map(call => call[2]);
      // iter1: x fresh, y resumes x. iter2: x resumes y's iter-1 session, y resumes x's.
      expect(resumeIds[0]).toBeUndefined();
      expect(resumeIds[1]).toBe('sess-x-1');
      expect(resumeIds[2]).toBe('sess-y-1');
      expect(resumeIds[3]).toBe('sess-x-2');
    });

    it('interactive loop_group resume without a provider tag (legacy pause) restores fresh', async () => {
      // A run paused BEFORE the provider tag existed has approval metadata with a bare
      // sessionId. Restoring it untagged could thread the session into a different
      // provider, so the resume starts fresh instead (safe degradation).
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'resumed and finished\nDONE' };
        yield { type: 'result', sessionId: 'legacy-resume-sess' };
      });

      await runWorkflow(
        'conv-lg-legacy',
        {
          name: 'lg-legacy-resume',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 5,
                fresh_context: false,
                interactive: true,
                gate_message: 'Review.',
                nodes: [
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Refine the draft.' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        makeWorkflowRun('lg-legacy-resume', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              sessionId: 'pre-tag-sess-1', // no sessionProvider — legacy pause
              message: 'Review.',
            },
            loop_user_input: 'continue',
          },
        })
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // The untagged pre-pause session is NOT restored.
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    });

    it('interactive loop_group gate with no live cursor pauses with EXPLICIT null session fields', async () => {
      // Body tail is a PARALLEL layer (two sibling nodes, nothing downstream), which
      // resets the sequential cursor before the gate. The pause payload states
      // sessionId/sessionProvider as explicit nulls rather than omitting them, so the
      // stored gate record says outright that this gate had no cursor. Readers accept
      // either shape (dag-executor restores only on `typeof … === 'string'`); this
      // pins the payload the gate writes, not a distinction the resume path makes.
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'checked, not done yet' };
        yield { type: 'result', sessionId: 'parallel-tail-sess' };
      });

      const mockDeps = await runWorkflow(
        'conv-lg-nullpause',
        {
          name: 'lg-null-pause',
          nodes: [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 5,
                fresh_context: false,
                interactive: true,
                gate_message: 'Review.',
                nodes: [
                  {
                    id: 'lint',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'run lint checks' },
                    depends_on: [],
                  },
                  {
                    id: 'test',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'run test checks' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        makeWorkflowRun('lg-null-pause')
      );

      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
      ).mock.calls;
      expect(pauseCalls.length).toBe(1);
      const pauseCtx = pauseCalls[0][1];
      // Keys present with explicit null — NOT omitted, NOT a live session pair.
      expect('sessionId' in pauseCtx).toBe(true);
      expect('sessionProvider' in pauseCtx).toBe(true);
      expect(pauseCtx.sessionId).toBeNull();
      expect(pauseCtx.sessionProvider).toBeNull();
    });
  });
}
