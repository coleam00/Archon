// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { DagNode } from '../schemas';

describe('executeDagWorkflow -- when condition parse errors (fail-closed)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-parse-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: 'sess-parse-err' };
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

  it('skips node (does not run it) when when: expression is unparseable', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-skip-run');

    const nodes: DagNode[] = [
      { id: 'unconditional', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
      // Single = is not valid syntax — will fail to parse
      {
        id: 'guarded',
        kind: 'agent',
        source: { kind: 'command', name: 'my-cmd' },
        depends_on: ['unconditional'],
        when: "$unconditional.output = 'yes'",
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-parse-err-skip',
        cwd: testDir,
        workflow: { name: 'parse-err-skip-test', nodes },
        workflowRun,
      })
    );

    // Only the unconditional node should have triggered an AI call.
    // The guarded node must be skipped (fail-closed), not executed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const skippedEvent = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map((call: unknown[]) => call[0] as { event_type: string; data?: Record<string, unknown> })
      .find(event => event.event_type === 'node_skipped');
    expect(skippedEvent?.data).toMatchObject({
      reason: 'when_condition_parse_error',
      expr: "$unconditional.output = 'yes'",
      cause: { kind: 'condition_parse_error', expr: "$unconditional.output = 'yes'" },
    });
  });

  it('nonnumeric conditions allow OR fallback and record ordinary false skips', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'ok' };
      yield { type: 'result', sessionId: 'numeric-fallback' };
    });
    mockSendQueryDag.mockImplementationOnce(async function* () {
      yield { type: 'agent_message_chunk', text: 'N/A' };
      yield { type: 'result', sessionId: 'numeric-score' };
    });
    const both = "$a.output > 50 && $b.output == 'ok'";
    const nodes: DagNode[] = [
      { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'score' } },
      { id: 'b', kind: 'agent', source: { kind: 'inline', prompt: 'status' }, depends_on: ['a'] },
      {
        id: 'fallback',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'fallback' },
        depends_on: ['a', 'b'],
        when: "$a.output > 50 || $b.output == 'ok'",
      },
      {
        id: 'both',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'both' },
        depends_on: ['a', 'b'],
        when: both,
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'numeric-fallback',
        cwd: testDir,
        workflow: { name: 'numeric-fallback', nodes },
        workflowRun: makeWorkflowRun('numeric-fallback'),
      })
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(3);
    const events = persistedEvents(mockDeps.store);
    expect(
      events.find(event => event.step_name === 'fallback' && event.event_type === 'node_completed')
    ).toBeDefined();
    expect(
      events
        .filter(event => event.event_type === 'node_skipped')
        .map(event => ({
          node: event.step_name,
          reason: event.data?.reason,
          cause: event.data?.cause,
        }))
    ).toEqual([
      { node: 'both', reason: 'when_condition', cause: { kind: 'condition', expr: both } },
    ]);
    expect(deliveredMessages(platform).some(message => message.includes('unparseable'))).toBe(
      false
    );
  });

  it('sends a platform warning message naming the node and stating it was skipped', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-warn-run');

    const nodes: DagNode[] = [
      {
        id: 'gate',
        kind: 'agent',
        source: { kind: 'command', name: 'my-cmd' },
        when: 'not a valid condition',
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-parse-err-warn',
        cwd: testDir,
        workflow: { name: 'parse-warn-test', nodes },
        workflowRun,
      })
    );

    // Fail-closed: the node is skipped, and the notice says so.
    expect(
      persistedEvents(mockDeps.store)
        .filter(event => event.event_type === 'node_skipped')
        .map(event => event.step_name)
    ).toEqual(['gate']);
    expect(deliveredMessages(platform)).toContain(
      '⚠️ Node \'gate\': unparseable `when:` expression "not a valid condition" — node skipped ' +
        "(fail-closed). Check syntax: `$nodeId.output == 'VALUE'`, `$nodeId.output > '5'`, or " +
        "compound `$a.output == 'X' && $b.output != 'Y'`."
    );
  });

  it('fails without throwing when all nodes are skipped via parse error', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-all-skip-run');

    const nodes: DagNode[] = [
      {
        id: 'only',
        kind: 'agent',
        source: { kind: 'command', name: 'my-cmd' },
        when: 'bad expression',
      },
    ];

    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-all-skipped',
          cwd: testDir,
          workflow: { name: 'all-skipped-test', nodes },
          workflowRun,
        })
      )
    ).resolves.toBeUndefined();
    expect(mockDeps.store.failWorkflowRun).toHaveBeenCalledWith(
      workflowRun.id,
      expect.any(String),
      { exitReason: 'no_nodes_completed' }
    );
    expect(mockDeps.store.completeWorkflowRun).not.toHaveBeenCalled();
  });
});
