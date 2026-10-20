// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { ExecNode } from '../schemas';

describe('executeDagWorkflow -- persisted node output', () => {
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

  it('stores node_output in node_completed event data for bash nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-output-persist-run');

    const bashNode: ExecNode = {
      id: 'stats',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo "bash output"',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash-output',
        cwd: testDir,
        workflow: { name: 'bash-output-test', nodes: [bashNode] },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'stats'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toContain(
      'bash output'
    );
  });

  it('persists bash output at or below the byte cap unchanged without truncation metadata', async () => {
    for (const [nodeId, byteCount] of [
      ['below-cap', 32_767],
      ['exact-cap', 32_768],
    ] as const) {
      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const workflowRun = makeWorkflowRun(`bash-output-${nodeId}`);

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          conversationId: `conv-${nodeId}`,
          cwd: testDir,
          workflow: {
            name: `bash-output-${nodeId}`,
            nodes: [
              {
                id: nodeId,
                kind: 'exec',
                runtime: 'sh',
                script: `printf '%${String(byteCount)}s' '' | tr ' ' x`,
              },
            ],
          },
          workflowRun,
        })
      );

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as { event_type: string }).event_type === 'node_completed' &&
          (call[0] as { step_name: string }).step_name === nodeId
      );
      const data = (
        completedEvent![0] as {
          data: Record<string, unknown> & { node_output: string };
        }
      ).data;
      expect(data.node_output).toBe('x'.repeat(byteCount));
      expect(data.node_output_truncated).toBeUndefined();
      expect(data.node_output_original_bytes).toBeUndefined();
    }
  });

  it('caps over-limit persisted bash output with a marker and byte metadata', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('bash-output-over-cap');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-over-cap',
        cwd: testDir,
        workflow: {
          name: 'bash-output-over-cap',
          nodes: [
            {
              id: 'over-cap',
              kind: 'exec',
              runtime: 'sh',
              script: "printf '%32769s' '' | tr ' ' x",
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'over-cap'
    );
    const data = (
      completedEvent![0] as {
        data: {
          node_output: string;
          node_output_truncated: boolean;
          node_output_original_bytes: number;
          node_output_spill_path: string;
        };
      }
    ).data;
    expect(Buffer.byteLength(data.node_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.node_output).toEndWith('\n\n… [truncated; original output was 32769 bytes]');
    expect(data.node_output_truncated).toBe(true);
    expect(data.node_output_original_bytes).toBe(32_769);
    // The full bytes are spilled alongside the bounded preview (#2726) so a resumed run
    // rehydrates the same value a fresh run's in-process consumer would have seen.
    expect(dirname(data.node_output_spill_path)).toBe(
      join(testDir, 'artifacts', '.archon', 'node-output-spills', 'persisted')
    );
    expect(await readFile(data.node_output_spill_path, 'utf8')).toBe('x'.repeat(32_769));
  });

  it('keeps a persisted UTF-8 preview valid when the byte cap splits a code point', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('bash-output-utf8-cap');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-utf8-cap',
        cwd: testDir,
        workflow: {
          name: 'bash-output-utf8-cap',
          nodes: [
            {
              id: 'utf8-cap',
              kind: 'exec',
              runtime: 'sh',
              script: `bun -e "process.stdout.write('🙂'.repeat(8193))"`,
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'utf8-cap'
    );
    const data = (
      completedEvent![0] as { data: { node_output: string; node_output_spill_path: string } }
    ).data;
    expect(Buffer.byteLength(data.node_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.node_output).not.toContain('\ufffd');
    expect(data.node_output).toEndWith('\n\n… [truncated; original output was 32772 bytes]');
    // The spilled full copy needs no boundary splitting -- it round-trips byte-for-byte.
    expect(await readFile(data.node_output_spill_path, 'utf8')).toBe('🙂'.repeat(8193));
  });

  it('persists script output at or below the byte cap unchanged without truncation metadata (#2726)', async () => {
    for (const [nodeId, byteCount] of [
      ['script-below-cap', 32_767],
      ['script-exact-cap', 32_768],
    ] as const) {
      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const workflowRun = makeWorkflowRun(`script-output-${nodeId}`);

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          conversationId: `conv-${nodeId}`,
          cwd: testDir,
          workflow: {
            name: `script-output-${nodeId}`,
            nodes: [
              {
                id: nodeId,
                kind: 'exec',
                runtime: 'bun',
                script: `process.stdout.write('x'.repeat(${String(byteCount)}))`,
              },
            ],
          },
          workflowRun,
        })
      );

      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const completedEvent = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as { event_type: string }).event_type === 'node_completed' &&
          (call[0] as { step_name: string }).step_name === nodeId
      );
      const data = (
        completedEvent![0] as {
          data: Record<string, unknown> & { node_output: string };
        }
      ).data;
      expect(data.node_output).toBe('x'.repeat(byteCount));
      expect(data.node_output_truncated).toBeUndefined();
      expect(data.node_output_original_bytes).toBeUndefined();
      expect(data.node_output_spill_path).toBeUndefined();
    }
  });

  it('caps over-limit persisted script output with a marker, byte metadata, and a spill file (#2726)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('script-output-over-cap');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-script-over-cap',
        cwd: testDir,
        workflow: {
          name: 'script-output-over-cap',
          nodes: [
            {
              id: 'script-over-cap',
              kind: 'exec',
              runtime: 'bun',
              script: `process.stdout.write('x'.repeat(32769))`,
            },
          ],
        },
        workflowRun,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'script-over-cap'
    );
    const data = (
      completedEvent![0] as {
        data: {
          node_output: string;
          node_output_truncated: boolean;
          node_output_original_bytes: number;
          node_output_spill_path: string;
        };
      }
    ).data;
    expect(Buffer.byteLength(data.node_output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(data.node_output).toEndWith('\n\n… [truncated; original output was 32769 bytes]');
    expect(data.node_output_truncated).toBe(true);
    expect(data.node_output_original_bytes).toBe(32_769);
    expect(dirname(data.node_output_spill_path)).toBe(
      join(testDir, 'artifacts', '.archon', 'node-output-spills', 'persisted')
    );
    expect(await readFile(data.node_output_spill_path, 'utf8')).toBe('x'.repeat(32_769));
  });

  it('uses full bash output for same-run when and downstream substitution despite persistence cap', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('bash-output-live-full');
    const paddingBytes = 33_000;
    const artifactsDir = join(testDir, 'artifacts');
    const logDir = join(testDir, 'logs');
    await mkdir(artifactsDir, { recursive: true });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-live-full',
        cwd: testDir,
        workflow: {
          name: 'bash-output-live-full',
          nodes: [
            {
              id: 'producer',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '{"status":"PASS","padding":"'; printf '%${String(paddingBytes)}s' '' | tr ' ' x; printf '"}'`,
            },
            {
              id: 'consumer',
              kind: 'exec',
              runtime: 'sh',
              script: 'value=$producer.output; printf %s "${#value}"',
              depends_on: ['producer'],
              when: "$producer.output.status == 'PASS'",
            },
          ],
        },
        workflowRun,
        artifactsDir,
        logDir,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const producerEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    const consumerEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(
      (producerEvent![0] as { data: { node_output_truncated: boolean } }).data.node_output_truncated
    ).toBe(true);
    expect((consumerEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      String(paddingBytes + 30)
    );
    expect(await Bun.file(join(logDir, 'producer.nodeoutput')).exists()).toBe(false);
  });

  it('resolves $node.output.field on a resumed exec node whose prior output is a large JSON blob (#2726)', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const paddingBytes = 40_000;
    // Simulates a fixed getDagResumeSnapshot: the FULL text read back from the spill,
    // not the 32KB-truncated preview a resumed run saw before this fix. Truncated JSON
    // here would not parse, and the consumer's `when:` field access would throw
    // (OutputRefError) instead of resolving -- exactly the naive-fix regression #2726
    // warns against.
    const producerOutput = `{"status":"PASS","padding":"${'z'.repeat(paddingBytes)}"}`;
    const priorCompletedNodes = new Map([['producer', { output: producerOutput }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-resume-large-field',
        cwd: testDir,
        workflow: {
          name: 'resume-large-field',
          nodes: [
            { id: 'producer', kind: 'exec', runtime: 'sh', script: 'echo unused' },
            {
              id: 'consumer',
              kind: 'exec',
              runtime: 'sh',
              script: 'value=$producer.output; printf %s "${#value}"',
              depends_on: ['producer'],
              when: "$producer.output.status == 'PASS'",
            },
          ],
        },
        workflowRun: makeWorkflowRun('resume-large-field'),
        priorCompletedNodes,
      })
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    // producer was resumed (skipped), so it must never re-execute.
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const producerSkipped = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(producerSkipped).toBeDefined();
    // The consumer's `when:` needed .field access on the full resumed value to
    // evaluate true and run at all -- had it thrown, no node_completed event for
    // 'consumer' would exist.
    const consumerEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerEvent).toBeDefined();
    if (!consumerEvent) throw new Error('Expected consumer to run after resolving .field access');
    expect((consumerEvent[0] as { data: { node_output: string } }).data.node_output).toBe(
      String(producerOutput.length)
    );
  });

  it('resolves $node.output.field on resume for a REAL script:/runtime bun producer, via its actual spilled write (#2726)', async () => {
    // The test above proves the generic resume-read mechanism (resolveNodeOutputField
    // doesn't branch on producer kind). This test closes the gap the earlier naive/
    // reverted fix broke specifically: executeScriptNode's own write-side call to
    // formatPersistedNodeOutput, combined end-to-end with a resumed .field access —
    // by actually running a runtime: 'bun' producer, spilling for real, and feeding the
    // exact bytes read back from that real spill file (not a hand-authored string) into
    // a second, simulated-resume run.
    const artifactsDir = join(testDir, 'artifacts');
    const paddingBytes = 40_000;

    // Pass 1: a real script node produces an over-cap JSON output and spills for real.
    const freshStore = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(freshStore),
        conversationId: 'conv-script-fresh-large-field',
        cwd: testDir,
        workflow: {
          name: 'script-fresh-large-field',
          nodes: [
            {
              id: 'producer',
              kind: 'exec',
              runtime: 'bun',
              script: `process.stdout.write(JSON.stringify({status:'PASS',padding:'z'.repeat(${String(paddingBytes)})}))`,
            },
          ],
        },
        workflowRun: makeWorkflowRun('script-fresh-large-field'),
        artifactsDir,
      })
    );

    const freshEventCalls = (freshStore.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const producerEvent = freshEventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(producerEvent).toBeDefined();
    if (!producerEvent) throw new Error('Expected producer to complete on the fresh pass');
    const producerData = producerEvent[0].data as {
      node_output_truncated: boolean;
      node_output_spill_path: string;
    };
    expect(producerData.node_output_truncated).toBe(true);
    // This is exactly what foldDagResumeSnapshot (dag-resume-snapshot.ts) reads back on resume.
    const spilledFullOutput = await readFile(producerData.node_output_spill_path, 'utf8');
    expect(JSON.parse(spilledFullOutput)).toEqual({
      status: 'PASS',
      padding: 'z'.repeat(paddingBytes),
    });

    // Pass 2: simulate the resume, seeding priorCompletedNodes with the REAL spilled
    // bytes (not a hand-authored string), and prove a downstream consumer's .field
    // access on it resolves rather than hard-failing.
    const resumedStore = createMockStore();
    const priorCompletedNodes = new Map([['producer', { output: spilledFullOutput }]]);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        conversationId: 'conv-script-resumed-large-field',
        cwd: testDir,
        workflow: {
          name: 'script-resumed-large-field',
          nodes: [
            {
              id: 'producer',
              kind: 'exec',
              runtime: 'bun',
              script: `process.stdout.write('unused')`,
            },
            {
              id: 'consumer',
              kind: 'exec',
              runtime: 'sh',
              script: 'value=$producer.output; printf %s "${#value}"',
              depends_on: ['producer'],
              when: "$producer.output.status == 'PASS'",
            },
          ],
        },
        workflowRun: makeWorkflowRun('script-resumed-large-field'),
        artifactsDir,
        priorCompletedNodes,
      })
    );

    const resumedEventCalls = (resumedStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls;
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const producerSkipped = resumedEventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'producer'
    );
    expect(producerSkipped).toBeDefined();
    const consumerEvent2 = resumedEventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'consumer'
    );
    expect(consumerEvent2).toBeDefined();
    if (!consumerEvent2) throw new Error('Expected consumer to run after resolving .field access');
    expect((consumerEvent2[0] as { data: { node_output: string } }).data.node_output).toBe(
      String(spilledFullOutput.length)
    );
  });
});
