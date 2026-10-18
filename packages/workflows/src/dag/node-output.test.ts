// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { isAbsolute, join } from 'path';
import { tmpdir } from 'os';
import {
  mockArtifactHome,
  setMockArtifactHome,
  type MockWorkflowStore,
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  dagOptions,
  makeWorkflowRun,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { nodeArtifactsListingSchema } from '../schemas/node-artifact';
import type { WorkflowDefinition } from '../schemas';
import { dagNodeSchema } from '../schemas';
import type { PersistedNodeOutput } from '../store';

describe('executeDagWorkflow -- typed artifacts (output_type)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-typed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });
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

  it('node with output_type writes nodes/<id>.md + .meta.json with the declared type', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'typed-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'plan',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const body = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    expect(body).toBe('AI response');
    const meta = JSON.parse(
      await readFile(join(testDir, 'artifacts', 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      runId: 'dag-test-run-id',
      path: join('nodes', 'planner.md'),
    });
    expect(meta).not.toHaveProperty('sessionId');
    expect(typeof meta.producedAt).toBe('string');
  });

  it('delivers a current-run listing to an exec node through TYPED_ARTIFACTS_FILE', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'typed-listing-exec',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'plan',
            },
            {
              id: 'reader',
              kind: 'exec',
              runtime: 'sh',
              // Braced form: the engine substitute is not applied, so this reads the
              // reserved process environment the exec builder delivers.
              script: 'cp "${TYPED_ARTIFACTS_FILE}" "$ARTIFACTS_DIR/observed-listing.json"',
              depends_on: ['planner'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('dag-typed-exec-listing'),
      })
    );

    const listing = nodeArtifactsListingSchema.parse(
      JSON.parse(await readFile(join(testDir, 'artifacts', 'observed-listing.json'), 'utf8'))
    );
    expect(listing.runId).toBe('dag-typed-exec-listing');
    expect(listing.artifactsByType.plan?.map(entry => entry.nodeId)).toEqual(['planner']);
    // The pointer names a content path that is readable relative to the artifacts dir.
    const planPath = listing.artifactsByType.plan?.[0]?.path;
    if (planPath === undefined) throw new Error('expected a listed plan artifact');
    expect(await readFile(join(testDir, 'artifacts', planPath), 'utf8')).toBe('AI response');
  });

  it('resolves $TYPED_ARTIFACTS_FILE in an agent prompt to a readable listing', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'typed-listing-agent',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'plan',
            },
            {
              id: 'consumer',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Listing: $TYPED_ARTIFACTS_FILE' },
              depends_on: ['planner'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('dag-typed-agent-listing'),
      })
    );

    const consumerPrompt = mockSendQueryDag.mock.calls.at(-1)?.[0] as string | undefined;
    expect(consumerPrompt?.startsWith('Listing: ')).toBe(true);
    const listingPath = (consumerPrompt ?? '').slice('Listing: '.length).trim();
    expect(isAbsolute(listingPath)).toBe(true);
    const listing = nodeArtifactsListingSchema.parse(
      JSON.parse(await readFile(listingPath, 'utf8'))
    );
    expect(listing.runId).toBe('dag-typed-agent-listing');
    expect(listing.artifactsByType.plan?.map(entry => entry.nodeId)).toEqual(['planner']);
  });

  it('persists the declared output type beside an agent structured output', async () => {
    const structuredOutput = {
      repo: { host: 'github.com', path: 'example/repo' },
      number: 42,
    };
    const outputFormat = {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'object' as const,
          properties: {
            host: { type: 'string' as const },
            path: { type: 'string' as const },
          },
          required: ['host', 'path'],
        },
        number: { type: 'integer' as const },
      },
      required: ['repo', 'number'],
    };
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 'typed-session', structuredOutput };
    });
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'typed-event-test',
          nodes: [
            {
              id: 'typed-pr',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'pull-request',
              output_format: outputFormat,
            },
            {
              id: 'untyped-pr',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_format: outputFormat,
              depends_on: ['typed-pr'],
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(
        call =>
          call[0] as { event_type: string; step_name?: string; data?: Record<string, unknown> }
      )
      .filter(event => event.event_type === 'node_completed');
    expect(events.find(event => event.step_name === 'typed-pr')?.data).toMatchObject({
      output_type: 'pull-request',
      structured_output: structuredOutput,
    });
    const untypedData = events.find(event => event.step_name === 'untyped-pr')?.data;
    expect(untypedData).toMatchObject({ structured_output: structuredOutput });
    expect(untypedData).not.toHaveProperty('output_type');
  });

  it('bash node with output_type writes a sidecar with no sessionId', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'bash-typed',
          nodes: [
            {
              id: 'metrics',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo "result-data"',
              output_type: 'metrics',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const body = await readFile(join(testDir, 'artifacts', 'nodes', 'metrics.md'), 'utf8');
    expect(body).toContain('result-data');
    const meta = JSON.parse(
      await readFile(join(testDir, 'artifacts', 'nodes', 'metrics.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({ nodeId: 'metrics', outputType: 'metrics' });
    // Bash nodes have no provider session — the field is omitted, not null.
    expect('sessionId' in meta).toBe(false);
    // Bash node does not invoke the AI client.
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('artifact write failure is non-fatal — the node still completes', async () => {
    // Force writeNodeArtifact to throw by putting a FILE where the nodes/ dir must
    // go, so its mkdir fails. The node must still complete (best-effort write).
    const artifactsDir = join(testDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'nodes'), 'not a directory', 'utf8');

    // Resolves without throwing — the best-effort catch swallows the write failure.
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'typed-fail',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'plan',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
        artifactsDir,
      })
    );

    // The node executed despite the artifact write being impossible.
    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
  });

  it('node without output_type writes no sidecar artifact', async () => {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'untyped-test',
          nodes: [{ id: 'planner', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    let wrote = true;
    try {
      await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #2453 — a result may point at a file instead of carrying it. The producing node
// proves every reserved `archon_artifact` pointer names its own run and a real
// regular file under that run's artifacts directory, before the value is
// persisted, and keeps the value a run id plus a relative path.
// ---------------------------------------------------------------------------

describe('artifact pointers (#2453)', () => {
  let testDir: string;
  let outputRoot: string;
  const originalArtifactHome = mockArtifactHome;

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  const POINTER_SCHEMA = {
    type: 'object',
    properties: {
      ready: { type: 'boolean' },
      plan: {
        type: 'object',
        properties: {
          type: { const: 'archon_artifact' },
          run_id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['type', 'run_id', 'path'],
      },
    },
    required: ['ready', 'plan'],
  };

  const RUN_ID = 'pointer-run';
  const result = (runId: string, path: string): Record<string, unknown> => ({
    ready: true,
    plan: { type: 'archon_artifact', run_id: runId, path },
  });

  function artifactsDir(runId: string): string {
    return join(outputRoot, 'artifacts', 'runs', runId);
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-pointer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    outputRoot = join(testDir, 'workspaces', '_cwd', 'proj');
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    setMockArtifactHome(testDir);
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
    setMockArtifactHome(originalArtifactHome);
    await removeTempTree(testDir);
  });

  async function writeArtifact(runId: string, relPath: string): Promise<void> {
    await mkdir(artifactsDir(runId), { recursive: true });
    await writeFile(join(artifactsDir(runId), relPath), '# the full plan');
  }

  /** A script producer emitting `value`, and a consumer reading the pointer field. */
  function pointerWorkflow(value: Record<string, unknown>): WorkflowDefinition {
    return {
      name: 'pointer-contract',
      description: 'a result that points at a file instead of carrying it',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          runtime: 'bun',
          script: `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`,
          output_format: POINTER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt: 'plan=[$producer.output.plan]',
          depends_on: ['producer'],
        }),
      ],
    };
  }

  async function runPointerDag(
    workflow: WorkflowDefinition,
    runId: string,
    options?: {
      store?: MockWorkflowStore;
      priorCompletedNodes?: Map<string, PersistedNodeOutput>;
    }
  ): Promise<{ events: PersistedEvent[]; prompts: string[] }> {
    const prompts: string[] = [];
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'agent_message_chunk', text: 'consumer done' };
      yield { type: 'result', sessionId: 'sid-cons' };
    });
    const store = options?.store ?? createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2453-pointer',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun(runId, { output_root: outputRoot }),
        priorCompletedNodes: options?.priorCompletedNodes,
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    return { events, prompts };
  }

  const producerCompletion = (events: PersistedEvent[]): PersistedEvent | undefined =>
    events.find(e => e.event_type === 'node_completed' && e.step_name === 'producer');
  const producerError = (events: PersistedEvent[]): string =>
    String(
      (
        events.find(e => e.event_type === 'node_failed' && e.step_name === 'producer')?.data as
          | { error?: string }
          | undefined
      )?.error
    );

  it('a pointer at the producing run survives to the consumer as a run id and relative path', async () => {
    await writeArtifact(RUN_ID, 'plan.md');

    const { events, prompts } = await runPointerDag(
      pointerWorkflow(result(RUN_ID, 'plan.md')),
      RUN_ID
    );

    expect(producerCompletion(events)?.data?.structured_output).toEqual(result(RUN_ID, 'plan.md'));
    // Never expanded into an absolute path, and never replaced by the file contents.
    expect(prompts).toEqual([
      `plan=[{"type":"archon_artifact","run_id":"${RUN_ID}","path":"plan.md"}]`,
    ]);
  });

  it('a pointer whose file does not exist fails the producing node before node_completed', async () => {
    await mkdir(artifactsDir(RUN_ID), { recursive: true });

    const { events, prompts } = await runPointerDag(
      pointerWorkflow(result(RUN_ID, 'plan.md')),
      RUN_ID
    );

    expect(producerCompletion(events)).toBeUndefined();
    expect(producerError(events)).toContain('refers to a file that does not exist');
    expect(prompts).toEqual([]);
  });

  it('a traversal pointer fails the producing node naming the run, the path, and the rule', async () => {
    await writeArtifact(RUN_ID, 'plan.md');

    const { events } = await runPointerDag(
      pointerWorkflow(result(RUN_ID, '../../plan.md')),
      RUN_ID
    );

    const error = producerError(events);
    expect(error).toContain("Script node 'producer'");
    expect(error).toContain(`run '${RUN_ID}'`);
    expect(error).toContain("path '../../plan.md'");
    expect(error).toContain("may not contain '..' path segments");
  });

  it('a pointer at another run fails the producing node even when that file exists', async () => {
    await writeArtifact('some-other-run', 'plan.md');
    const store = createMockStore();

    const { events } = await runPointerDag(
      pointerWorkflow(result('some-other-run', 'plan.md')),
      RUN_ID,
      { store }
    );

    // Own run only: the producer never asks the store about the other run.
    expect(producerError(events)).toContain(
      "a result may only point at its own run's artifacts today"
    );
    expect(store.getWorkflowRun).not.toHaveBeenCalled();
  });

  it('a validated pointer resolves identically after a cold resume', async () => {
    await writeArtifact(RUN_ID, 'plan.md');
    const fresh = await runPointerDag(pointerWorkflow(result(RUN_ID, 'plan.md')), RUN_ID);
    const completed = producerCompletion(fresh.events);

    const resumed = await runPointerDag(pointerWorkflow(result(RUN_ID, 'plan.md')), RUN_ID, {
      priorCompletedNodes: new Map<string, PersistedNodeOutput>([
        [
          'producer',
          {
            output: String(completed?.data?.node_output),
            structuredOutput: completed?.data?.structured_output,
          },
        ],
      ]),
    });

    expect(resumed.prompts).toEqual(fresh.prompts);
  });
});
