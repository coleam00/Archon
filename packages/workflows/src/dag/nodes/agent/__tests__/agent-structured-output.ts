import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeDagWorkflow } from '../../../../dag-executor';
import { foldDagResumeSnapshot } from '../../../../dag-resume-snapshot';
import { readNodeRecordEvent } from '../../../../node-record-reader';
import type { DagNode, WorkflowDefinition } from '../../../../schemas';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
  node,
  persistedEvents,
  runUsageWrites,
} from '../../../test-utils';

export function registerStructuredOutputTests() {
  describe('executeDagWorkflow -- output_format structured output', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-output-fmt-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, 'classify.md'), 'Classify this: $USER_MESSAGE');

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

    for (const kind of ['agent', 'loop'] as const) {
      for (const mode of ['stream', 'reask', 'unknown-first-reask', 'iterations'] as const) {
        if (kind === 'agent' && mode === 'iterations') continue;
        it(`keeps ${kind} node tokens unknown after an unavailable interval (${mode})`, async () => {
          const reask = mode === 'reask' || mode === 'unknown-first-reask';
          const usage = { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 };
          let calls = 0;
          mockSendQueryDag.mockImplementation(async function* () {
            calls++;
            const unknown = mode === 'unknown-first-reask' ? calls === 1 : calls === 2;
            if (mode === 'stream') {
              yield { type: 'result', sessionId: 's', tokens: usage, cost: 0.1 };
              yield { type: 'result', sessionId: 's', tokensUnknown: true, cost: 0.2 };
              yield {
                type: 'result',
                sessionId: 's',
                tokens: usage,
                cost: 0.1,
                text: '<promise>COMPLETE</promise>',
              };
            } else {
              yield {
                type: 'result',
                sessionId: 's',
                cost: 0.1,
                ...(unknown ? { tokensUnknown: true } : { tokens: usage }),
                ...(reask
                  ? { structuredOutput: calls === 1 ? {} : { done: true } }
                  : { text: calls === 3 ? '<promise>COMPLETE</promise>' : 'Keep working.' }),
              };
            }
          });
          const store = createMockStore();
          const outputFormat = {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          };
          function unknownTokenNode(): DagNode {
            return kind === 'agent'
              ? {
                  id: 'work',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'Work.' },
                  ...(reask ? { output_format: outputFormat } : {}),
                }
              : {
                  id: 'work',
                  kind: 'loop',
                  ...(reask ? { output_format: outputFormat } : {}),
                  loop: {
                    prompt: 'Work.',
                    fresh_context: false,
                    max_iterations: 3,
                    ...(reask ? { until_field: 'done' } : { until: 'COMPLETE' }),
                  },
                };
          }
          await executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              cwd: testDir,
              workflow: { name: 'unknown-node-tokens', nodes: [unknownTokenNode()] },
              workflowRun: makeWorkflowRun('unknown-node-tokens-run'),
              workflowProvider: reask ? 'pi' : 'claude',
              config: { ...minimalConfig, assistant: reask ? 'pi' : 'claude' },
            })
          );
          expect(calls).toBe(mode === 'stream' ? 1 : reask ? 2 : 3);
          const completed = persistedEvents(store).find(
            event => event.event_type === 'node_completed' && event.step_name === 'work'
          );
          expect(completed).toBeDefined();
          expect(completed?.data?.tokens).toBeUndefined();
          const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
          expect(record?.metadata?.spend.tokens).toMatchObject({ source: 'unavailable' });
          expect(completed?.data?.cost_usd).toBeCloseTo(
            mode === 'stream' ? 0.4 : reask ? 0.2 : 0.3
          );
          expect(store.completeWorkflowRun).toHaveBeenCalled();
        });
      }
    }

    for (const scope of ['retry', 'run', 'loop-group'] as const) {
      for (const unknownFirst of [true, false]) {
        it(`keeps ${scope} aggregate tokens unknown (unknown first: ${unknownFirst})`, async () => {
          let calls = 0;
          mockSendQueryDag.mockImplementation(async function* () {
            calls++;
            yield {
              type: 'result',
              sessionId: 's',
              text: 'Work completed.',
              cost: calls === 1 ? 0.1 : 0.2,
              ...((calls === 1) === unknownFirst
                ? { tokensUnknown: true }
                : { tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 } }),
              ...(scope === 'retry' && calls === 1
                ? { isError: true, failure: { class: 'unknown', evidence: 'failed attempt' } }
                : {}),
            };
          });
          const body: DagNode[] = ['first', 'second'].map((id, i) => ({
            id,
            kind: 'agent',
            source: { kind: 'inline', prompt: 'Work.' },
            ...(i === 1 ? { depends_on: ['first'] } : {}),
          }));
          const nodes: DagNode[] =
            scope === 'retry'
              ? [
                  {
                    id: 'work',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Work.' },
                    retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' },
                  },
                ]
              : scope === 'run'
                ? body
                : [
                    {
                      id: 'work',
                      kind: 'loop_group',
                      loop_group: {
                        until_bash: 'exit 0',
                        max_iterations: 1,
                        fresh_context: false,
                        nodes: body,
                      },
                    },
                  ];
          const store = createMockStore();
          await executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              cwd: testDir,
              workflow: { name: 'unknown-aggregate', nodes },
              workflowRun: makeWorkflowRun('unknown-aggregate-run'),
            })
          );
          expect(calls).toBe(2);
          const usage = runUsageWrites(store).at(-1);
          expect(usage?.total_cost_usd).toBeCloseTo(0.3);
          expect(usage?.total_tokens_unknown).toBe(true);
          expect(usage?.total_tokens_in).toBeNull();
          if (scope === 'loop-group') {
            const completed = persistedEvents(store).find(
              event => event.event_type === 'node_completed' && event.step_name === 'work'
            );
            const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
            expect(record?.metadata?.spend.tokens).toEqual({
              source: 'unavailable',
              reason: 'incomplete',
            });
          }
          const snapshot = await foldDagResumeSnapshot(
            persistedEvents(store),
            'unknown-aggregate-run'
          );
          expect(snapshot.tokens).toBeUndefined();
          expect(snapshot.tokensUnknown).toBe(true);
          expect(snapshot.costUsd).toBeCloseTo(0.3);
        });
      }
    }

    for (const feedback of [true, false]) {
      it(`keeps tokens unknown across interactive loop resume (feedback: ${feedback})`, async () => {
        const workflow: WorkflowDefinition = {
          name: 'unknown-gated',
          description: 'Unknown token resume',
          nodes: [
            {
              id: 'work',
              kind: 'loop',
              loop: {
                prompt: 'Work.',
                until: 'COMPLETE',
                fresh_context: false,
                max_iterations: 3,
                interactive: true,
                gate_message: 'Review.',
              },
            },
          ],
        };
        mockSendQueryDag.mockImplementation(async function* () {
          yield {
            type: 'result',
            sessionId: 's',
            cost: 0.1,
            tokensUnknown: true,
            text: '<promise>COMPLETE</promise>',
          };
        });
        const store = createMockStore();
        const run = makeWorkflowRun('unknown-gated-run');
        await executeDagWorkflow(
          dagOptions({ deps: createMockDeps(store), cwd: testDir, workflow, workflowRun: run })
        );
        const approval = store.pauseWorkflowRun.mock.calls[0]?.[1];
        expect(approval?.execution?.spend.tokens).toEqual({
          source: 'unavailable',
          reason: 'incomplete',
        });
        mockSendQueryDag.mockClear();
        mockSendQueryDag.mockImplementation(async function* () {
          yield {
            type: 'result',
            sessionId: 's',
            cost: 0.2,
            tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 },
            text: '<promise>COMPLETE</promise>',
          };
        });
        const resumedStore = createMockStore();
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(resumedStore),
            cwd: testDir,
            workflow,
            workflowRun: makeWorkflowRun(run.id, {
              metadata: {
                approval,
                loop_feedback_given: feedback,
                loop_user_input: feedback ? 'Continue.' : '',
              },
            }),
          })
        );
        expect(mockSendQueryDag.mock.calls).toHaveLength(feedback ? 1 : 0);
        const completed = persistedEvents(resumedStore).find(
          event => event.event_type === 'node_completed' && event.step_name === 'work'
        );
        expect(completed?.data?.tokens).toBeUndefined();
        const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
        expect(record?.metadata?.spend.tokens).toEqual({
          source: 'unavailable',
          reason: 'incomplete',
        });
        expect(completed?.data?.cost_usd).toBeCloseTo(feedback ? 0.3 : 0.1);
        expect(runUsageWrites(resumedStore).at(-1)?.total_tokens_unknown).toBe(true);
      });
    }

    it('uses structuredOutput from result when output_format is set', async () => {
      const structuredJson = { run_code_review: 'true', run_tests: 'false' };

      // Mock yields prose + JSON as assistant text, then result with structuredOutput
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Let me analyze the PR scope...\n' };
        yield { type: 'agent_message_chunk', text: JSON.stringify(structuredJson) };
        yield { type: 'result', sessionId: 'sid-1', structuredOutput: structuredJson };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('output-fmt-run', {
        user_message: 'classify this PR',
      });

      const nodes: DagNode[] = [
        {
          id: 'classify',
          kind: 'agent',
          source: { kind: 'command', name: 'classify' },
          output_format: {
            type: 'object',
            properties: {
              run_code_review: { type: 'string', enum: ['true', 'false'] },
              run_tests: { type: 'string', enum: ['true', 'false'] },
            },
          },
        },
        {
          id: 'review',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Review the code' },
          depends_on: ['classify'],
          when: "$classify.output.run_code_review == 'true'",
        },
        {
          id: 'test',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Run tests' },
          depends_on: ['classify'],
          when: "$classify.output.run_tests == 'true'",
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-output-fmt',
          cwd: testDir,
          workflow: { name: 'output-fmt-test', nodes },
          workflowRun,
        })
      );

      // The review node's when condition should evaluate to true (run_code_review == 'true')
      // The test node's when condition should evaluate to false (run_tests == 'false', not 'true')
      // So sendQuery should be called for classify + review = 2 times (not 3)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
    });

    it('does NOT override nodeOutputText with structuredOutput when output_format is absent', async () => {
      // Even if the SDK returns structuredOutput, nodes without output_format use concatenated text
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'prose analysis text' };
        yield { type: 'result', sessionId: 'sid-no-fmt', structuredOutput: { type: 'BUG' } };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('no-output-fmt-run', {
        user_message: 'test guard',
      });

      const nodes: DagNode[] = [
        { id: 'a', kind: 'agent', source: { kind: 'command', name: 'classify' } },
        {
          id: 'b',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Got: $a.output' },
          depends_on: ['a'],
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-no-fmt',
          cwd: testDir,
          workflow: { name: 'no-fmt-test', nodes },
          workflowRun,
        })
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);

      // Second node's prompt should contain the concatenated prose, not the JSON
      const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
      expect(secondCallPrompt).toContain('prose analysis text');
      expect(secondCallPrompt).not.toContain('"type"');
    });

    it('falls back to concatenated text when structuredOutput is absent', async () => {
      // Mock without structuredOutput on result — backward compatible
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'plain text response' };
        yield { type: 'result', sessionId: 'sid-2' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('no-structured-run', {
        user_message: 'test fallback',
      });

      const nodes: DagNode[] = [
        { id: 'a', kind: 'agent', source: { kind: 'command', name: 'classify' } },
        {
          id: 'b',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Use output: $a.output' },
          depends_on: ['a'],
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-fallback',
          cwd: testDir,
          workflow: { name: 'fallback-test', nodes },
          workflowRun,
        })
      );

      // Both nodes should execute (no output_format, no when conditions)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);

      // Second node's prompt should contain the concatenated text from node a
      const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
      expect(secondCallPrompt).toContain('plain text response');
    });

    it('passes outputFormat to Codex nodes and uses inline JSON response', async () => {
      // Codex provider normalizes inline JSON into structuredOutput on the result chunk
      const classifyJson = { run_code_review: 'true', run_tests: 'false' };
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'codex',
        getCapabilities: mockCodexCapabilities,
      }));
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: JSON.stringify(classifyJson) };
        yield { type: 'result', sessionId: 'codex-sid-1', structuredOutput: classifyJson };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('codex-output-fmt-run', {
        user_message: 'classify this PR',
      });

      const nodes: DagNode[] = [
        {
          id: 'classify',
          kind: 'agent',
          source: { kind: 'command', name: 'classify' },
          output_format: {
            type: 'object',
            properties: {
              run_code_review: { type: 'string', enum: ['true', 'false'] },
              run_tests: { type: 'string', enum: ['true', 'false'] },
            },
            required: ['run_code_review', 'run_tests'],
          },
        },
        {
          id: 'review',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Review the code' },
          depends_on: ['classify'],
          when: "$classify.output.run_code_review == 'true'",
        },
        {
          id: 'test',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Run tests' },
          depends_on: ['classify'],
          when: "$classify.output.run_tests == 'true'",
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-codex-fmt',
          cwd: testDir,
          workflow: { name: 'codex-output-fmt', nodes },
          workflowRun,
          workflowProvider: 'codex',
        })
      );

      // classify + review = 2 calls (test node skipped because run_tests == 'false')
      expect(mockSendQueryDag.mock.calls.length).toBe(2);

      // Verify outputFormat was passed to the Codex client (4th arg = options)
      const classifyOptions = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
      expect(classifyOptions.outputFormat).toEqual({
        type: 'json_schema',
        schema: nodes[0].output_format,
      });
    });

    it('does not warn about missing structuredOutput for Codex nodes', async () => {
      // Codex provider normalizes inline JSON into structuredOutput on the result chunk
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'codex',
        getCapabilities: mockCodexCapabilities,
      }));
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: '{"status":"ok"}' };
        yield { type: 'result', sessionId: 'codex-sid-2', structuredOutput: { status: 'ok' } };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('codex-no-warn-run', {
        user_message: 'check it',
      });

      const nodes: DagNode[] = [
        {
          id: 'check',
          kind: 'agent',
          source: { kind: 'command', name: 'classify' },
          output_format: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-codex-no-warn',
          cwd: testDir,
          workflow: { name: 'codex-no-warn', nodes },
          workflowRun,
          workflowProvider: 'codex',
        })
      );

      // Verify no "structured output missing" warning was sent to the user
      const sendCalls = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock
        .calls;
      const warningMessages = sendCalls
        .map(call => call[1] as string)
        .filter(msg => typeof msg === 'string' && msg.includes('did not return structured output'));
      expect(warningMessages).toHaveLength(0);
    });
  });
}

export function registerStreamingTests() {
  describe('executeDagWorkflow -- tool events reach a streaming platform', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(
        tmpdir(),
        `dag-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

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

    it('calls sendStructuredEvent for tool messages in streaming mode during DAG', async () => {
      const mockStore = createMockStore();
      const mockDeps = createMockDeps(mockStore);
      const platform = createMockPlatform();
      platform.getStreamingMode.mockReturnValue('stream');
      const workflowRun = makeWorkflowRun();

      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'call-w',
          name: 'Write',
          rawInput: { path: '/bar', content: 'x' },
        };
        yield { type: 'agent_message_chunk', text: 'Wrote the file.' };
        yield { type: 'result', sessionId: 'dag-session-tool' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-dag-tool',
          cwd: testDir,
          workflow: { name: 'dag-tool-test', nodes: [node('my-cmd')] },
          workflowRun,
        })
      );

      expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-dag-tool', {
        type: 'tool_call',
        toolCallId: 'call-w',
        name: 'Write',
        rawInput: { path: '/bar', content: 'x' },
      });
    });
  });
}
