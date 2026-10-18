// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { settlingProvider } from './test-settling-provider';
import { readNodeRecordEvent } from './node-record-reader';
import { buildTerminalRecord } from './terminal-record';
import { buildRunTerminalTelemetry } from './run-terminal-telemetry';
import { RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import type { SendQueryOptions } from '@archon/provider-contract';
import { mergeTokenUsage, type TokenUsage } from '@archon/provider-contract';
import {
  mockArtifactHome,
  setMockArtifactHome,
  composeScope,
  type MockWorkflowStore,
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  minimalConfig,
  type TestWorkflowDefinition,
  resolveTestWorkflow,
  dagOptions,
  ready,
  makeWorkflowRun,
  readTranscript,
} from './dag/test-utils';
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from './dag-executor';
import { childOutcomeFromRun, type RunChildWorkflowFn } from './dag/child-run';
import { dryRunWorkflow } from './dry-run';
import { nodeArtifactsListingSchema } from './schemas/node-artifact';
import { getWorkflowEventEmitter } from './event-emitter';
import type {
  DagNode,
  LoopGroupNode,
  SkipCause,
  WorkflowRun,
  WorkflowDefinition,
  ResolvedWorkflow,
} from './schemas';
import { dagNodeSchema, skipCauseSchema } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDeps, WorkflowConfig } from './deps';
import type { IWorkflowStore, PersistedNodeOutput } from './store';
import {
  buildAiProfile,
  isLiteralSpec,
  resolveModelSpec,
  type ModelAliasPreset,
  type RawTiersConfig,
} from './model-validation';
describe('executeDagWorkflow options type contract', () => {
  it('requires workflowModel even when it resolves to undefined', () => {
    const validOptions: ExecuteDagWorkflowOptions = {
      deps: createMockDeps(),
      platform: createMockPlatform(),
      conversationId: 'type-contract',
      cwd: '/tmp/type-contract',
      workflow: resolveTestWorkflow({ name: 'type-contract', nodes: [] }),
      workflowRun: makeWorkflowRun('type-contract'),
      workflowProvider: 'claude',
      workflowModel: undefined,
      artifactsDir: '/tmp/type-contract/artifacts',
      stateDir: '/tmp/type-contract/state',
      logDir: '/tmp/type-contract/logs',
      baseBranch: 'main',
      docsDir: 'docs',
      config: minimalConfig,
    };

    const { workflowModel, ...withoutWorkflowModel } = validOptions;
    expect(workflowModel).toBeUndefined();

    // @ts-expect-error workflowModel is a required resolved-policy input, even when undefined.
    const missingWorkflowModel: ExecuteDagWorkflowOptions = withoutWorkflowModel;
    expect(missingWorkflowModel).not.toHaveProperty('workflowModel');
  });
});

it('a sub-run stamps its result contract with the legacy root fields older parents read', async () => {
  const testDir = join(
    tmpdir(),
    `dag-subrun-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(testDir, { recursive: true });
  try {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'child',
          returns: 'r',
          nodes: [
            {
              id: 'r',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"green":true,"note":{"text":"x"}}'`,
              output_format: {
                type: 'object',
                properties: {
                  green: { type: 'boolean' },
                  note: { type: 'object', properties: { text: { type: 'string' } } },
                },
                required: ['green'],
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('child-run', { parent_run_id: 'parent-run' }),
      })
    );
    const metadata = (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock
      .calls[0]?.[2];
    expect(metadata).toMatchObject({
      summary_declared_output_paths: [['green'], ['note'], ['note', 'text']],
      summary_declared_fields: ['green', 'note'],
    });
  } finally {
    await removeTempTree(testDir);
  }
});

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
// Include expansion — the "zero new runtime machinery" proof.
//
// Expand a parent that `include:`s a child (via expandWorkflowIncludes, exactly
// as discovery does), then run the flattened definition through executeDagWorkflow.
// The executor never sees an include node; the namespaced nodes behave as ordinary
// top-level nodes for events, terminal-output selection, resume-skip, and always_run.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- flattened include expansion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-include-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[]): WorkflowDefinition {
    return { name, description: name, nodes: nodes.map(n => dagNodeSchema.parse(n)) };
  }

  /**
   * Parent that includes a 2-node bash child (a -> b) and reads `$inc.output`.
   * Expands to: inc__a -> inc__b -> consumer(reads $inc__b.output). `alwaysRunA`
   * flags the child's entry node so resume re-executes it.
   */
  function expandedParentNodes(alwaysRunA = false): DagNode[] {
    const child = buildWf('inc-child', [
      { id: 'a', bash: 'echo AAA', ...(alwaysRunA ? { always_run: true } : {}) },
      { id: 'b', bash: 'echo BBB', depends_on: ['a'] },
    ]);
    const parent = buildWf('inc-parent', [
      { id: 'inc', include: 'inc-child' },
      { id: 'consumer', bash: 'echo $inc.output', depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['inc-child', child],
        ['inc-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('inc-parent')!.nodes as DagNode[])];
  }

  function expandedGatedParentNodes(
    mode: 'false-condition' | 'skipped-dependency' | 'active',
    alwaysRunGateAndConsumer = false
  ): DagNode[] {
    const child = buildWf('review-block', [
      { id: 'entry', bash: 'echo started' },
      {
        id: 'optional',
        bash: 'echo optional',
        depends_on: ['entry'],
        when: "$entry.output == 'never'",
      },
      { id: 'required', bash: 'echo report', depends_on: ['entry'] },
      {
        id: 'synthesize',
        bash: 'echo synthesized',
        depends_on: ['optional', 'required'],
        trigger_rule: 'all_done',
      },
    ]);
    const gateNodes =
      mode === 'skipped-dependency'
        ? [
            { id: 'source', bash: 'echo ready' },
            {
              id: 'gate',
              bash: 'echo gate',
              depends_on: ['source'],
              when: "$source.output == 'never'",
            },
          ]
        : [
            {
              id: 'gate',
              bash: `echo ${mode === 'active' ? 'run' : 'skip'}`,
              ...(alwaysRunGateAndConsumer ? { always_run: true } : {}),
            },
          ];
    const parent = buildWf('gated-parent', [
      ...gateNodes,
      {
        id: 'review',
        include: 'review-block',
        depends_on: ['gate'],
        ...(mode === 'skipped-dependency' ? {} : { when: "$gate.output == 'run'" }),
      },
      {
        id: 'consumer',
        bash: 'echo $review.output',
        depends_on: ['review'],
        ...(alwaysRunGateAndConsumer ? { always_run: true } : {}),
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['review-block', child],
        ['gated-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('gated-parent')!.nodes as DagNode[])];
  }

  function expandedStructuredGateNodes(): DagNode[] {
    const child = buildWf('structured-gate-block', [{ id: 'entry', bash: 'echo started' }]);
    const parent = buildWf('structured-gate-parent', [
      { id: 'gate', bash: `printf '%s' '{"route":{"ready":true}}'` },
      {
        id: 'review',
        include: 'structured-gate-block',
        depends_on: ['gate'],
        when: "$gate.output.route == 'true'",
      },
      { id: 'consumer', bash: 'echo $review.output', depends_on: ['review'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['structured-gate-block', child],
        ['structured-gate-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('structured-gate-parent')!.nodes as DagNode[])];
  }

  function expandedMultiSinkDependencyNodes(
    entryTriggerRule: 'all_success' | 'one_success'
  ): DagNode[] {
    const upstream = buildWf('upstream', [
      { id: 'start', bash: 'echo start' },
      { id: 'good', bash: 'echo good', depends_on: ['start'] },
      {
        id: 'bad',
        bash: 'echo bad',
        depends_on: ['start'],
        when: "$start.output == 'never'",
      },
    ]);
    const downstream = buildWf('downstream', [
      { id: 'entry', bash: 'echo entry', trigger_rule: entryTriggerRule },
      {
        id: 'synthesize',
        bash: 'echo synthesized',
        depends_on: ['entry'],
        trigger_rule: 'all_done',
      },
    ]);
    const parent = buildWf('multi-sink-parent', [
      { id: 'up', include: 'upstream' },
      { id: 'down', include: 'downstream', depends_on: ['up'] },
      { id: 'consumer', bash: 'echo $down.output', depends_on: ['down'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['upstream', upstream],
        ['downstream', downstream],
        ['multi-sink-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('multi-sink-parent')!.nodes as DagNode[])];
  }

  function expandedMixedEntryTriggerNodes(): DagNode[] {
    const upstream = buildWf('upstream', [
      { id: 'start', bash: 'echo start' },
      { id: 'good', bash: 'echo good', depends_on: ['start'] },
      {
        id: 'bad',
        bash: 'echo bad',
        depends_on: ['start'],
        when: "$start.output == 'never'",
      },
    ]);
    const downstream = buildWf('downstream', [
      { id: 'strict', bash: 'echo strict', trigger_rule: 'all_success' },
      { id: 'lenient', bash: 'echo lenient', trigger_rule: 'one_success' },
    ]);
    const parent = buildWf('mixed-entry-parent', [
      { id: 'up', include: 'upstream' },
      { id: 'down', include: 'downstream', depends_on: ['up'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['upstream', upstream],
        ['downstream', downstream],
        ['mixed-entry-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('mixed-entry-parent')!.nodes as DagNode[])];
  }

  function eventList(
    deps: WorkflowDeps
  ): Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }> {
    return (deps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) =>
        call[0] as { event_type: string; step_name: string; data?: Record<string, unknown> }
    );
  }

  async function executeExpanded(
    nodes: DagNode[],
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<{
    events: Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }>;
    output: string | undefined;
  }> {
    const mockDeps = createMockDeps();
    const output = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'gated-parent', nodes },
        workflowRun: makeWorkflowRun(runId, { workflow_name: 'gated-parent' }),
        priorCompletedNodes,
      })
    );
    if (typeof output === 'object') throw new Error('Unexpected source release');
    return { events: eventList(mockDeps), output };
  }

  it('skips every composed node when the include condition is false', async () => {
    const { events } = await executeExpanded(
      expandedGatedParentNodes('false-condition'),
      'inc-false-condition'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual([
      'consumer',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['gate']);
  });

  it('skips every composed node when the include dependencies are ineligible', async () => {
    const { events } = await executeExpanded(
      expandedGatedParentNodes('skipped-dependency'),
      'inc-skipped-dependency'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual([
      'consumer',
      'gate',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['source']);
  });

  it('persists the cause from include conditions and include dependency rules', async () => {
    const conditionRun = await executeExpanded(
      expandedGatedParentNodes('false-condition'),
      'inc-condition-cause'
    );
    const conditionSkip = conditionRun.events.find(
      event => event.event_type === 'node_skipped' && event.step_name === 'review__required'
    );
    expect(conditionSkip?.data?.cause).toEqual({
      kind: 'condition',
      expr: "$gate.output == 'run'",
    });

    const dependencyRun = await executeExpanded(
      expandedGatedParentNodes('skipped-dependency'),
      'inc-dependency-cause'
    );
    const dependencySkip = dependencyRun.events.find(
      event => event.event_type === 'node_skipped' && event.step_name === 'review__required'
    );
    expect(dependencySkip?.data?.cause).toEqual({
      kind: 'upstream_skipped',
      origin: 'gate',
    });
  });

  it.each(['failed', 'condition'] as const)(
    '#3156: honors %s skip provenance through direct joins, include boundaries, and resume',
    async mode => {
      const deliver = {
        ...buildWf('deliver-block', [
          { id: 'gate-input', bash: 'printf ready' },
          {
            id: 'gate-validated',
            bash: 'exit 1',
            depends_on: ['gate-input'],
            ...(mode === 'condition' ? { when: "$gate-input.output == 'never'" } : {}),
          },
          { id: 'checks', bash: 'echo checks', depends_on: ['gate-validated'] },
          { id: 'result', bash: 'echo delivered', depends_on: ['checks'] },
        ]),
        returns: 'result',
      };
      const action = buildWf('action-block', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const parent = buildWf('direct-joins', [
        { id: 'pr', bash: 'printf ready' },
        { id: 'deliver', include: 'deliver-block', depends_on: ['pr'] },
        {
          id: 'flip-ready',
          script: 'console.log(process.env.INPUTS_DELIVERED)',
          runtime: 'bun',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'none_failed_min_one_success',
          with: { delivered: { from: '$deliver.output', if_skipped: 'fallback' } },
        },
        {
          id: 'action',
          include: 'action-block',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'none_failed_min_one_success',
        },
        {
          id: 'report',
          script: 'console.log(process.env.INPUTS_DELIVERED)',
          runtime: 'bun',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'all_done',
          with: { delivered: { from: '$deliver.output', if_skipped: 'fallback' } },
        },
      ]);
      const expanded = expandWorkflowIncludes(
        new Map([
          ['deliver-block', deliver],
          ['action-block', action],
          ['direct-joins', parent],
        ])
      );
      expect(expanded.errors).toEqual([]);
      const workflow = expanded.workflows.get('direct-joins');
      if (!workflow) throw new Error('direct-joins did not expand');
      const nodes = [...workflow.nodes];
      const initial = await executeExpanded(nodes, `direct-joins-${mode}`);
      const resumed = await executeExpanded(
        nodes,
        `direct-joins-${mode}-resumed`,
        new Map([['pr', { output: 'ready' }]])
      );
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: testDir,
        stubs: {
          pr: 'ready',
          'deliver__gate-input': 'ready',
          'flip-ready': 'fallback',
          report: 'fallback',
          action__entry: 'entry',
          action__tail: 'tail',
        },
      });
      const cause = {
        kind: mode === 'failed' ? 'upstream_failed' : 'upstream_skipped',
        origin: 'deliver__gate-validated',
      };
      const runs = [initial, resumed];
      if (mode === 'failed') {
        runs.push(
          await executeExpanded(
            nodes,
            'direct-joins-cached-before-upgrade',
            new Map([
              ['pr', { output: 'ready' }],
              ['flip-ready', { output: 'previously flipped' }],
              ['action__entry', { output: 'entry' }],
              ['action__tail', { output: 'tail' }],
            ])
          )
        );
      }
      for (const run of runs) {
        for (const id of ['deliver__checks', 'deliver__result']) {
          expect(
            run.events.find(event => event.step_name === id && event.event_type === 'node_skipped')
              ?.data?.cause
          ).toEqual(cause);
        }
        for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
          if (mode === 'failed') {
            expect(
              run.events.find(
                event => event.step_name === id && event.event_type === 'node_skipped'
              )?.data?.cause
            ).toEqual(cause);
            expect(
              run.events.some(
                event => event.step_name === id && event.event_type === 'node_started'
              )
            ).toBe(false);
          } else {
            expect(
              run.events.some(
                event => event.step_name === id && event.event_type === 'node_completed'
              )
            ).toBe(true);
          }
        }
        expect(
          run.events.find(
            event => event.step_name === 'report' && event.event_type === 'node_completed'
          )?.data?.node_output
        ).toContain('fallback');
      }
      for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
        expect(dryRun.trace.find(entry => entry.nodeId === id)).toMatchObject(
          mode === 'failed' ? { state: 'skipped', cause } : { state: 'stubbed' }
        );
      }
    }
  );

  it('recomputes the same skip provenance on resume', async () => {
    const nodes = expandedGatedParentNodes('skipped-dependency');
    const initial = await executeExpanded(nodes, 'inc-resume-cause-initial');
    const resumed = await executeExpanded(
      nodes,
      'inc-resume-cause-resumed',
      new Map([['source', { output: 'ready\n' }]])
    );
    const skipCauses = (
      events: Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }>
    ): Array<readonly [string, SkipCause]> =>
      events
        .filter(event => event.event_type === 'node_skipped')
        .map(event => [event.step_name, skipCauseSchema.parse(event.data?.cause)] as const)
        .sort(([left], [right]) => left.localeCompare(right));

    expect(skipCauses(resumed.events)).toEqual(skipCauses(initial.events));
    expect(skipCauses(resumed.events)).toContainEqual([
      'consumer',
      { kind: 'upstream_skipped', origin: 'gate' },
    ]);
  });

  it('reports the same skip cause in dry-run and executor traces', async () => {
    const nodes: DagNode[] = [
      { id: 'source', kind: 'exec', runtime: 'sh', script: 'printf ready' },
      {
        id: 'branch',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo branch',
        depends_on: ['source'],
        when: "$source.output == 'never'",
      },
      {
        id: 'join',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo join',
        depends_on: ['branch'],
      },
    ];
    const mockDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflowRun: makeWorkflowRun('skip-cause-parity'),
        workflow: { name: 'skip-cause-parity', nodes },
      })
    );
    const executorCauses = eventList(mockDeps)
      .filter(event => event.event_type === 'node_skipped')
      .map(event => [event.step_name, skipCauseSchema.parse(event.data?.cause)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    const dryRun = await dryRunWorkflow({
      workflow: resolveTestWorkflow({ name: 'skip-cause-parity', nodes }),
      userMessage: '',
      cwd: testDir,
      stubs: { source: 'ready', branch: 'unused', join: 'unused' },
    });
    const dryRunCauses = dryRun.trace
      .filter(entry => entry.state === 'skipped')
      .map(entry => [entry.nodeId, entry.cause] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(dryRunCauses).toEqual(executorCauses);
    expect(dryRunCauses).toEqual([
      ['branch', { kind: 'condition', expr: "$source.output == 'never'" }],
      ['join', { kind: 'upstream_skipped', origin: 'branch' }],
    ]);
  });

  it('emits the executor skip causes to live subscribers', async () => {
    const workflowRun = makeWorkflowRun('skip-cause-live');
    const emitted: Array<{ nodeId: string; cause: SkipCause }> = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.type === 'node_skipped' && event.runId === workflowRun.id) {
        emitted.push({ nodeId: event.nodeId, cause: event.cause });
      }
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflowRun,
          workflow: {
            name: 'skip-cause-live',
            nodes: [
              { id: 'source', kind: 'exec', runtime: 'sh', script: 'printf ready' },
              {
                id: 'branch',
                kind: 'exec',
                runtime: 'sh',
                script: 'echo branch',
                depends_on: ['source'],
                when: "$source.output == 'never'",
              },
              {
                id: 'join',
                kind: 'exec',
                runtime: 'sh',
                script: 'echo join',
                depends_on: ['branch'],
              },
            ],
          },
        })
      );
    } finally {
      unsubscribe();
    }

    expect(emitted).toEqual([
      {
        nodeId: 'branch',
        cause: { kind: 'condition', expr: "$source.output == 'never'" },
      },
      { nodeId: 'join', cause: { kind: 'upstream_skipped', origin: 'branch' } },
    ]);
  });

  it('keeps all_done active for intentionally skipped branches inside a running block', async () => {
    const { events, output } = await executeExpanded(
      expandedGatedParentNodes('active'),
      'inc-active-block'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['review__optional']);
    expect(completed).toEqual([
      'consumer',
      'gate',
      'review__entry',
      'review__required',
      'review__synthesize',
    ]);
    expect(output).toContain('synthesized');
  });

  it('keeps a block inactive when one sink of an included dependency is ineligible', async () => {
    const { events } = await executeExpanded(
      expandedMultiSinkDependencyNodes('all_success'),
      'inc-multi-sink-inactive'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['consumer', 'down__entry', 'down__synthesize', 'up__bad']);
    expect(completed).toEqual(['up__good', 'up__start']);
  });

  it('keeps a one_success block active when any sink of an included dependency succeeds', async () => {
    const { events } = await executeExpanded(
      expandedMultiSinkDependencyNodes('one_success'),
      'inc-multi-sink-active'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['up__bad']);
    expect(completed).toEqual([
      'consumer',
      'down__entry',
      'down__synthesize',
      'up__good',
      'up__start',
    ]);
  });

  it('resume discards cached block output when its include gate becomes inactive', async () => {
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['gate', { output: 'run' }],
      ['review__entry', { output: 'started' }],
      ['review__required', { output: 'report' }],
      ['review__synthesize', { output: 'old-sink' }],
      ['consumer', { output: 'old-consumer' }],
    ]);
    const { events } = await executeExpanded(
      expandedGatedParentNodes('false-condition', true),
      'inc-resume-inactive-block',
      priorCompletedNodes
    );

    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();
    const reused = events
      .filter(event => event.event_type === 'node_skipped_prior_success')
      .map(event => event.step_name);

    expect(skipped).toEqual([
      'consumer',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['gate']);
    expect(reused.filter(stepName => stepName.startsWith('review__'))).toEqual([]);
  });

  it("resume evaluates each cached block entry with that entry's trigger rule", async () => {
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['up__start', { output: 'start' }],
      ['up__good', { output: 'good' }],
      ['down__strict', { output: 'old-strict' }],
      ['down__lenient', { output: 'old-lenient' }],
    ]);
    const { events } = await executeExpanded(
      expandedMixedEntryTriggerNodes(),
      'inc-resume-mixed-entry-rules',
      priorCompletedNodes
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name);
    const reused = events
      .filter(event => event.event_type === 'node_skipped_prior_success')
      .map(event => event.step_name);

    expect(skipped).toContain('down__strict');
    expect(reused).toContain('down__lenient');
    expect(reused).not.toContain('down__strict');
  });

  it('fails a cached block entry when its include gate reads a structured field', async () => {
    const { events } = await executeExpanded(
      expandedStructuredGateNodes(),
      'inc-resume-structured-gate',
      new Map([['review__entry', { output: 'prior entry' }]])
    );

    const entryEvents = events.filter(event => event.step_name === 'review__entry');
    expect(entryEvents).toHaveLength(1);
    expect(entryEvents[0]?.event_type).toBe('node_failed');
    expect(entryEvents[0]?.data?.error).toContain(
      "Condition reference '$gate.output.route' resolved to an object"
    );
    expect(
      events.some(
        event =>
          event.step_name === 'review__entry' && event.event_type === 'node_skipped_prior_success'
      )
    ).toBe(false);
  });

  it('emits namespaced step_names and resolves $inc.output to the child terminal node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-run-id', { workflow_name: 'inc-parent' });

    const terminalOutput = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes() },
        workflowRun,
      })
    );

    const events = eventList(mockDeps);
    const completedStepNames = events
      .filter(e => e.event_type === 'node_completed')
      .map(e => e.step_name);
    // Included nodes surface as ordinary namespaced top-level nodes in the event log.
    expect(completedStepNames).toContain('inc__a');
    expect(completedStepNames).toContain('inc__b');
    expect(completedStepNames).toContain('consumer');
    // No include node ever reached the executor.
    expect(events.every(e => e.step_name !== 'inc')).toBe(true);

    // $inc.output was rewritten to the child terminal ($inc__b.output = "BBB"), so the
    // run's terminal output (consumer, the sole sink) carries it.
    expect(terminalOutput).toContain('BBB');
  });

  it('resume skips a completed namespaced node and re-runs the rest', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-resume-id', { workflow_name: 'inc-parent' });

    // Prior run completed the namespaced entry node inc__a.
    const prior = new Map([['inc__a', { output: 'AAA' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes() },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = eventList(mockDeps);
    // inc__a skipped as prior-success (its namespaced id matched the persisted map).
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(true);
    // Downstream namespaced node + consumer still executed.
    const completed = events.filter(e => e.event_type === 'node_completed').map(e => e.step_name);
    expect(completed).toContain('inc__b');
    expect(completed).toContain('consumer');
    expect(completed).not.toContain('inc__a');
  });

  it('always_run on an included node re-executes it on resume', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-always-id', { workflow_name: 'inc-parent' });

    const prior = new Map([['inc__a', { output: 'AAA' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes(true) },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = eventList(mockDeps);
    // always_run survived inlining: inc__a is force-reset (re-executed), not skipped.
    expect(
      events.some(e => e.event_type === 'node_always_run_reset' && e.step_name === 'inc__a')
    ).toBe(true);
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(false);
    expect(events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__a')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// "A workflow runs as authored" (#1764) — the composition invariant, measured.
//
// A workflow's node-affecting configuration is collapsed onto its own nodes at
// expansion and the workflow-level layer is removed, so a composed workflow resolves
// exactly what it would resolve standalone. These tests observe the SAME seat every
// other option test uses — the `sendQuery(prompt, cwd, resume, options)` call — and
// compare a block run standalone against the same block run inside a parent that
// declares different values.
//
// Two pass conditions per case, both required:
//   INVARIANT       composed === standalone
//   REGRESSION      raw standalone === collapsed standalone (nothing shipped moves)
// The invariant alone would pass a collapse bug that shifted BOTH sides equally.
// ---------------------------------------------------------------------------
describe('executeDagWorkflow -- a workflow runs as authored, standalone or composed', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-collapse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  /** Per-node configuration as the provider actually received it. */
  interface EffectiveConfig {
    provider: string;
    model: unknown;
    effort: unknown;
    sandbox: unknown;
    betas: unknown;
    fallbackModel: unknown;
  }

  function wfDef(name: string, nodes: unknown[], workflowLevel: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...workflowLevel,
    };
  }

  const collapseConfig: WorkflowConfig & { assistant: string } = {
    assistant: 'claude',
    assistants: { claude: { model: 'claude-default' }, codex: { model: 'codex-default' } },
    commands: {},
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };

  /**
   * Run one workflow and return each node's effective configuration, keyed by the node's
   * id with any include namespace stripped — so a block's `scope` node is comparable
   * whether it ran standalone or as `blk__scope`.
   *
   * The workflow-level provider/model/preset derivation mirrors executor.ts (the ~15
   * lines above its `executeDagWorkflow` call). Every variant is scored through the same
   * mirror, so a mirror error cancels out instead of biasing one side.
   */
  async function effectiveConfigs(
    defs: readonly WorkflowDefinition[],
    runName: string,
    options: { expand?: boolean; profileProvider?: string; tiers?: RawTiersConfig } = {}
  ): Promise<Map<string, EffectiveConfig>> {
    let workflow: TestWorkflowDefinition;
    if (options.expand === false) {
      workflow = defs.find(d => d.name === runName)!;
    } else {
      const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
      expect(errors).toEqual([]);
      workflow = workflows.get(runName)!;
    }

    const aiProfile = buildAiProfile(options.profileProvider ?? collapseConfig.assistant, {
      ...(options.tiers ? { repoTiers: options.tiers } : {}),
    });

    // --- mirror of executor.ts's workflow-level resolution ---
    let workflowProvider: string = workflow.provider ?? collapseConfig.assistant;
    let workflowModel: string | undefined;
    let workflowPreset: ModelAliasPreset | undefined;
    if (workflow.model) {
      const spec = resolveModelSpec(aiProfile, workflow.model);
      if (isLiteralSpec(spec)) {
        workflowModel = spec.literal;
      } else {
        workflowPreset = spec;
        workflowProvider = spec.provider;
        workflowModel = spec.model;
      }
    }
    workflowModel ??= collapseConfig.assistants[workflowProvider]?.model as string | undefined;
    // --- end mirror ---

    const seen: { provider: string; options: SendQueryOptions }[] = [];
    const deps: WorkflowDeps = {
      providers: providerRegistry,
      store: createMockStore(),
      getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
        (provider): ReturnType<WorkflowDeps['getAgentProvider']> => ({
          sendQuery: mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
            async function* (_prompt, _cwd, _resume, queryOptions) {
              if (!queryOptions) throw new Error('Expected provider query options');
              seen.push({ provider, options: queryOptions });
              yield { type: 'agent_message_chunk', text: 'ok' };
              yield { type: 'result', sessionId: `sid-${String(seen.length)}` };
              yield { type: 'settled' };
            }
          ),
          checkCredential: async () => ({
            state: 'not_checked' as const,
            source: 'native' as const,
          }),
          getType: (): string => provider,
          getCapabilities: provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
        })
      ),
      loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => collapseConfig),
    };

    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-collapse',
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun(`collapse-${runName}`, { workflow_name: runName }),
        workflowProvider,
        workflowModel,
        config: collapseConfig,
        aiProfile,
        workflowPreset,
      })
    );

    const result = new Map<string, EffectiveConfig>();
    for (const { provider, options: queryOptions } of seen) {
      const nodeConfig = queryOptions.nodeConfig;
      if (!nodeConfig) throw new Error('Expected workflow node configuration');
      const rawId = String(nodeConfig.nodeId);
      const id = rawId.includes('__') ? rawId.slice(rawId.lastIndexOf('__') + 2) : rawId;
      result.set(id, {
        provider,
        model: queryOptions.model,
        effort: nodeConfig.effort,
        sandbox: nodeConfig.sandbox,
        betas: nodeConfig.betas,
        fallbackModel: nodeConfig.fallbackModel,
      });
    }
    return result;
  }

  /** The block under test: one node that declares nothing, one that overrides provider. */
  function richBlock(): WorkflowDefinition {
    return wfDef(
      'blk',
      [
        { id: 'scope', prompt: 'scope it' },
        { id: 'impl', prompt: 'implement', depends_on: ['scope'], provider: 'claude' },
      ],
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        sandbox: { enabled: true },
        fallbackModel: 'gpt-5-mini',
      }
    );
  }

  it('AC1 — a configured block resolves identically composed and standalone', async () => {
    const block = richBlock();
    const parent = wfDef(
      'parent',
      [
        { id: 'setup', prompt: 'set up' },
        { id: 'review', include: 'blk', depends_on: ['setup'] },
      ],
      { provider: 'claude', model: 'claude-parent', effort: 'low' }
    );

    const standalone = await effectiveConfigs([block], 'blk');
    const composed = await effectiveConfigs([block, parent], 'parent');

    // INVARIANT: every node of the block resolved the same way in both runs.
    for (const id of ['scope', 'impl']) {
      expect(composed.get(id), `node '${id}' composed`).toEqual(standalone.get(id)!);
    }
    // The block really did declare something different from its parent — without this
    // the invariant could hold because everything collapsed to one provider.
    expect(standalone.get('scope')!.provider).toBe('codex');
    expect(standalone.get('scope')!.effort).toBe('high');
    // The parent's own node keeps the parent's configuration.
    expect(composed.get('setup')!.provider).toBe('claude');
    expect(composed.get('setup')!.effort).toBe('low');
  });

  it('REGRESSION — collapsing does not move a standalone run', async () => {
    const block = richBlock();
    const raw = await effectiveConfigs([block], 'blk', { expand: false });
    const collapsed = await effectiveConfigs([block], 'blk');
    expect(collapsed).toEqual(raw);
  });

  it('AC2 — a block declaring NOTHING resolves from config, not from the parent', async () => {
    // A bare include block, and the case naive push-down gets wrong: with
    // nothing of its own to push, the block's nodes would still inherit the parent's
    // workflow-level values unless that layer is REMOVED.
    const bare = wfDef('bare-blk', [{ id: 'work', prompt: 'work' }]);
    const parent = wfDef('parent', [{ id: 'inc', include: 'bare-blk' }], {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    const standalone = await effectiveConfigs([bare], 'bare-blk');
    const composed = await effectiveConfigs([bare, parent], 'parent');

    expect(composed.get('work')).toEqual(standalone.get('work')!);
    expect(composed.get('work')!.provider).toBe('claude'); // config.assistant
    expect(composed.get('work')!.model).toBe('claude-default');
    expect(composed.get('work')!.effort).toBeUndefined();
  });

  it('AC3 — three providers resolve independently in one run', async () => {
    const piBlock = wfDef('pi-blk', [{ id: 'run', prompt: 'pi work' }], { provider: 'pi' });
    const codexBlock = wfDef('codex-blk', [{ id: 'run', prompt: 'codex work' }], {
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    const parent = wfDef(
      'parent',
      [
        { id: 'own', prompt: 'parent work' },
        { id: 'a', include: 'pi-blk', depends_on: ['own'] },
        { id: 'b', include: 'codex-blk', depends_on: ['a'] },
      ],
      { provider: 'claude' }
    );

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['pi-blk', piBlock],
        ['codex-blk', codexBlock],
        ['parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    const expanded = workflows.get('parent')!;
    const byId = new Map(expanded.nodes.map(n => [n.id, n as DagNode]));
    expect(byId.get('own')?.provider).toBe('claude');
    expect(byId.get('a__run')?.provider).toBe('pi');
    expect(byId.get('b__run')?.provider).toBe('codex');
    expect(byId.get('b__run')?.model).toBe('gpt-5.6-sol');
  });

  it('AC3 — a tier keyword reproduces through the collapse', async () => {
    const tiers = {
      large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' as const },
    };
    const block = wfDef('tier-blk', [{ id: 'work', prompt: 'work' }], { model: 'large' });
    const parent = wfDef('parent', [{ id: 'inc', include: 'tier-blk' }], {
      provider: 'claude',
      model: 'claude-parent',
    });

    const standalone = await effectiveConfigs([block], 'tier-blk', { tiers });
    const composed = await effectiveConfigs([block, parent], 'parent', { tiers });

    expect(composed.get('work')).toEqual(standalone.get('work')!);
    // The tier resolved, rather than the raw keyword reaching the SDK.
    expect(standalone.get('work')!.provider).toBe('codex');
    expect(standalone.get('work')!.model).toBe('gpt-5.6-sol');
    expect(standalone.get('work')!.effort).toBe('xhigh');
  });

  it('AC1 — the collapse reaches loop_group bodies and depth-2 nesting', async () => {
    const inner = wfDef(
      'inner',
      [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'body', prompt: 'body work' }],
          },
        },
      ],
      { provider: 'codex', model: 'gpt-5.6-sol' }
    );
    const mid = wfDef('mid', [{ id: 'in', include: 'inner' }], { provider: 'pi' });
    const top = wfDef('top', [{ id: 'm', include: 'mid' }], { provider: 'claude' });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['inner', inner],
        ['mid', mid],
        ['top', top],
      ])
    );
    expect(errors).toEqual([]);
    const group = workflows.get('top')!.nodes.find(n => n.id === 'm__in__group')! as LoopGroupNode;
    expect(group.provider).toBe('codex');
    // The body node carries the INNER file's provider, not mid's or top's.
    const body = group.loop_group?.nodes[0] as DagNode | undefined;
    expect(body?.provider).toBe('codex');
    expect(body?.model).toBe('gpt-5.6-sol');
  });
});

// ---------------------------------------------------------------------------
// Composition boundaries at run time (#1764):
//   - a composed workflow's entry node starts a session as coldly as it would standalone
//   - a composed workflow's declared inputs reach its shell nodes, named script included
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- composed-workflow run-time boundaries', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-comp-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...extra,
    };
  }

  /** The `node_output` a completed node persisted, read from its node_completed event. */
  function nodeOutputOf(store: MockWorkflowStore, stepName: string): string | undefined {
    const event = store.createWorkflowEvent.mock.calls
      .map(c => c[0])
      .find(e => e.event_type === 'node_completed' && e.step_name === stepName);
    return (event?.data as { node_output?: string } | undefined)?.node_output;
  }

  async function runExpanded(
    defs: readonly WorkflowDefinition[],
    runName: string,
    deps = createMockDeps()
  ): Promise<void> {
    const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
    expect(errors).toEqual([]);
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow: ready(workflows.get(runName)!),
        workflowRun: makeWorkflowRun(`comp-${runName}`, { workflow_name: runName }),
      })
    );
  }

  for (const kind of ['loop', 'loop_group'] as const) {
    for (const composed of [false, true]) {
      it(`#4164: ${kind}.until_bash receives ${composed ? 'composed' : 'run'} inputs`, async () => {
        const predicate = `[ "$INPUTS_TARGET" = "done" ] && [ "$INPUTS_PAYLOAD" = '$(touch injected); "quoted"' ] && [ "$ARGUMENTS" = "real-args" ]`;
        const block = buildWf(
          'input-loop',
          [
            kind === 'loop'
              ? { id: 'poll', loop: { prompt: 'work', until_bash: predicate, max_iterations: 2 } }
              : {
                  id: 'poll',
                  loop_group: {
                    until_bash: predicate,
                    max_iterations: 2,
                    nodes: [{ id: 'work', prompt: 'work' }],
                  },
                },
          ],
          { inputs: { target: { required: true }, payload: { required: true } } }
        );
        const parent = buildWf('input-parent', [
          {
            id: 'inc',
            include: 'input-loop',
            with: { target: 'done', payload: '$(touch injected); "quoted"' },
          },
        ]);
        const { workflows, errors } = expandWorkflowIncludes(
          new Map([
            ['input-loop', block],
            ['input-parent', parent],
          ])
        );
        expect(errors).toEqual([]);
        const store = createMockStore();
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: ready(composed ? workflows.get('input-parent')! : block),
            workflowRun: makeWorkflowRun('input-loop-run', {
              user_message: 'real-args',
              metadata: {
                inputs: {
                  target: composed ? 'wrong-run-value' : 'done',
                  payload: '$(touch injected); "quoted"',
                },
              },
            }),
            config: {
              ...minimalConfig,
              envVars: { INPUTS_TARGET: 'wrong-project-value', ARGUMENTS: 'hijacked' },
            },
          })
        );
        expect(mockSendQueryDag.mock.calls.length).toBe(1);
        expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
        expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
      });
    }
  }

  it("#4164: an included shell's $INPUTS macro reads the input as data", async () => {
    const payload = '$(touch injected); "quoted"';
    const block = buildWf(
      'macro-blk',
      [
        { id: 'echo', bash: "printf '%s' $INPUTS.payload" },
        {
          id: 'poll',
          depends_on: ['echo'],
          loop: { prompt: 'work', until_bash: '[ $INPUTS.target = done ]', max_iterations: 2 },
        },
      ],
      { inputs: { target: { required: true }, payload: { required: true } } }
    );
    const parent = buildWf('macro-parent', [
      { id: 'inc', include: 'macro-blk', with: { target: 'done', payload } },
    ]);
    const store = createMockStore();

    await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

    expect(nodeOutputOf(store, 'inc__echo')).toBe(payload);
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
    expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
  });

  it("a script node's own with: binding beats a colliding composed and run input", async () => {
    const block = buildWf(
      'collide-blk',
      [
        {
          id: 'emit',
          runtime: 'bun',
          script: 'console.log(process.env.INPUTS_TARGET);',
          with: { target: 'local' },
        },
      ],
      { inputs: { target: { required: true } } }
    );
    const parent = buildWf('collide-parent', [
      { id: 'inc', include: 'collide-blk', with: { target: 'composed' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['collide-blk', block],
        ['collide-parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflows.get('collide-parent')!),
        workflowRun: makeWorkflowRun('collide-run', { metadata: { inputs: { target: 'run' } } }),
      })
    );

    expect(nodeOutputOf(store, 'inc__emit')).toBe('local');
  });

  it('AC7 — a composed block entry starts a fresh session even after a same-provider node', async () => {
    const block = buildWf('sess-blk', [
      { id: 'first', prompt: 'block first' },
      { id: 'second', prompt: 'block second', depends_on: ['first'] },
    ]);
    const parent = buildWf('sess-parent', [
      { id: 'lead', prompt: 'parent lead' },
      { id: 'inc', include: 'sess-blk', depends_on: ['lead'] },
    ]);

    await runExpanded([block, parent], 'sess-parent');

    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    // lead: nothing before it.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // inc__first: the block's entry — cold, exactly as it would be standalone, even
    // though `lead` just produced a resumable session on the same provider.
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    // inc__second: inside the block, so the block's own thread continues.
    expect(mockSendQueryDag.mock.calls[2][2]).toBe('session-1');
  });

  it("AC7 — context: 'shared' on the entry node opts back into the parent's thread", async () => {
    const block = buildWf('sess-blk2', [{ id: 'first', prompt: 'block first', context: 'shared' }]);
    const parent = buildWf('sess-parent2', [
      { id: 'lead', prompt: 'parent lead' },
      { id: 'inc', include: 'sess-blk2', depends_on: ['lead'] },
    ]);

    await runExpanded([block, parent], 'sess-parent2');

    expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
  });

  it("AC8 — a composed block's declared inputs reach a NAMED script as INPUTS_* env vars", async () => {
    // The acceptance case the task exists for: a named script file is opaque, so the
    // load-time `$INPUTS` macro can never reach inside it. Env delivery is its only channel.
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, 'report.ts'),
      'console.log(`plan=${process.env.INPUTS_PLAN}|base=${process.env.INPUTS_BASE_BRANCH}`);\n'
    );

    const block = buildWf('script-blk', [{ id: 'run', script: 'report', runtime: 'bun' }], {
      inputs: { plan: { required: true }, 'base-branch': { default: 'dev' } },
    });
    const parent = buildWf('script-parent', [
      { id: 'inc', include: 'script-blk', with: { plan: 'ship it' } },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'script-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    // A hyphenated input name arrives UPPER_SNAKE; the default fills the unsupplied one.
    expect(output).toBe('plan=ship it|base=dev');
  });

  it('AC8 — the stamp survives two nesting levels and keeps the INNER names', async () => {
    const inner = buildWf('inner-blk', [{ id: 'run', bash: 'echo "[$INPUTS_PLAN]"' }], {
      inputs: { plan: { required: true } },
    });
    const mid = buildWf(
      'mid-blk',
      [{ id: 'in', include: 'inner-blk', with: { plan: '$INPUTS.topic' } }],
      {
        inputs: { topic: { required: true } },
      }
    );
    const top = buildWf('nest-parent', [
      { id: 'm', include: 'mid-blk', with: { topic: 'two levels' } },
    ]);

    const store = createMockStore();
    await runExpanded([inner, mid, top], 'nest-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'm__in__run');
    expect(output).toBe('[two levels]');
  });

  it('AC8 — a composed input value resolving a node ref is delivered, not shell-spliced', async () => {
    const block = buildWf('ref-blk', [{ id: 'run', bash: 'echo "<$INPUTS_PAYLOAD>"' }], {
      inputs: { payload: { required: true } },
    });
    const parent = buildWf('ref-parent', [
      { id: 'produce', bash: 'printf "%s" "a b; echo pwned"' },
      {
        id: 'inc',
        include: 'ref-blk',
        depends_on: ['produce'],
        with: { payload: '$produce.output' },
      },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'ref-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    // Delivered verbatim through the env bag — the `;` never reaches the shell as syntax.
    expect(output).toBe('<a b; echo pwned>');
  });

  it('AC8 — a project env var cannot shadow a composed input, and reserved keys still win', async () => {
    const block = buildWf('env-blk', [{ id: 'run', bash: 'echo "$INPUTS_PLAN|$ARGUMENTS"' }], {
      inputs: { plan: { required: true } },
    });
    const parent = buildWf('env-parent', [
      { id: 'inc', include: 'env-blk', with: { plan: 'from-with' } },
    ]);

    const store = createMockStore();
    const deps = createMockDeps(store);
    deps.loadConfig = mock<WorkflowDeps['loadConfig']>(async _cwd => ({
      ...minimalConfig,
      envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
    }));

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['env-blk', block],
        ['env-parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow: ready(workflows.get('env-parent')!),
        workflowRun: makeWorkflowRun('comp-env', {
          workflow_name: 'env-parent',
          user_message: 'real-args',
        }),
        config: {
          ...minimalConfig,
          envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
        },
      })
    );

    const output = nodeOutputOf(store, 'inc__run');
    expect(output).toBe('from-with|real-args');
  });

  it('AC8 — the load-time macro still substitutes $INPUTS into an inline bash body', async () => {
    const block = buildWf('macro-blk', [{ id: 'run', bash: 'echo "$INPUTS.plan"' }], {
      inputs: { plan: { required: true } },
    });
    const parent = buildWf('macro-parent', [
      { id: 'inc', include: 'macro-blk', with: { plan: 'inline-value' } },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    expect(output).toBe('inline-value');
  });
});

// ---------------------------------------------------------------------------
// Governance and resume across the config collapse (#1764 Task 11).
//
// These assert EXISTING behaviour that the collapse must not disturb. A failure here is
// a finding about the change, not a licence to move the assertion.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- composition governance survives the collapse', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-gov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...extra,
    };
  }

  it('AC13 — a run paused BEFORE the collapse resumes with collapsed config afterwards', async () => {
    // The snapshot is keyed by persisted `step_name`. The collapse rewrites node PAYLOADS,
    // never node IDS, so a map written by an older build still matches — and the nodes that
    // do re-run pick up the block's own provider rather than the parent's.
    const block = buildWf(
      'resume-blk',
      [
        { id: 'first', prompt: 'first' },
        { id: 'second', prompt: 'second', depends_on: ['first'] },
      ],
      { provider: 'codex', model: 'gpt-5.6-sol' }
    );
    const parent = buildWf('resume-parent', [{ id: 'inc', include: 'resume-blk' }], {
      provider: 'claude',
    });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['resume-blk', block],
        ['resume-parent', parent],
      ])
    );
    expect(errors).toEqual([]);

    // Written by a build that predates this change: bare namespaced ids, no payload.
    const prior = new Map([['inc__first', { output: 'FIRST OUTPUT' }]]);

    const store = createMockStore();
    const seen: string[] = [];
    const deps: WorkflowDeps = {
      providers: providerRegistry,
      store,
      getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
        (provider): ReturnType<WorkflowDeps['getAgentProvider']> => {
          seen.push(provider);
          return settlingProvider({
            sendQuery: mockSendQueryDag,
            checkCredential: async () => ({
              state: 'not_checked' as const,
              source: 'native' as const,
            }),
            getType: (): string => provider,
            getCapabilities: provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
          });
        }
      ),
      loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => minimalConfig),
    };

    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-gov',
        cwd: testDir,
        workflow: ready(workflows.get('resume-parent')!),
        workflowRun: makeWorkflowRun('gov-resume', { workflow_name: 'resume-parent' }),
        priorCompletedNodes: prior,
      })
    );

    const events = store.createWorkflowEvent.mock.calls.map(call => call[0]);
    expect(
      events.some(
        e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__first'
      )
    ).toBe(true);
    expect(
      events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__second')
    ).toBe(true);
    // The one node that re-ran used the BLOCK's provider, not the parent's.
    expect(seen).toEqual(['codex']);
  });

  it('AC12 — a composed approval pauses the PARENT run, with no child run id', async () => {
    const block = buildWf('gate-blk', [
      { id: 'plan', prompt: 'plan' },
      {
        id: 'gate',
        approval: { message: 'Approve?', capture_response: false },
        depends_on: ['plan'],
      },
    ]);
    const parent = buildWf('gate-parent', [{ id: 'inc', include: 'gate-blk' }], {
      interactive: true,
    });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['gate-blk', block],
        ['gate-parent', parent],
      ])
    );
    expect(errors).toEqual([]);

    const store = createMockStore();
    const runId = 'gov-gate-run';
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-gov',
        cwd: testDir,
        workflow: ready(workflows.get('gate-parent')!),
        workflowRun: makeWorkflowRun(runId, { workflow_name: 'gate-parent' }),
      })
    );

    const pauseCalls = store.pauseWorkflowRun.mock.calls;
    expect(pauseCalls.length).toBe(1);
    // One addressable run: the composition pauses the run that composed it. A `workflow:`
    // node would instead pause a second row the human approves by its own id.
    expect(pauseCalls[0][0]).toBe(runId);
    const ctx = pauseCalls[0][1];
    expect(ctx).toMatchObject({ type: 'approval', nodeId: 'inc__gate' });
    expect('childRunId' in ctx).toBe(false);
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TokenUsage axis seam guard (#2674)
//
// `TokenUsage` crosses boundaries where its fields are re-listed by hand on
// both sides, with nothing tying writer to reader. #2662 added one optional
// field, `cachePartial`, and three carrying sites dropped it while the full
// suite stayed green.
//
// The guard is two TYPE-level anchors plus runtime proof of what they claim:
//
//   1. `Required<TokenUsage>` — adding an axis makes AXIS_SPECIMEN a compile
//      error, so `bun run type-check` fails before a single test runs.
//   2. `Record<keyof TokenUsage, string | null>` — each seam's key map is
//      exhaustive, so a new axis must be dispositioned per seam: a key it is
//      carried under, or `null` for "this seam deliberately does not carry it".
//   3. Every non-null entry is then driven through the REAL production path,
//      because a declared key spelling is only a claim until a run proves it.
//
// SCOPE: the workflow engine's seams. `getDagResumeSnapshot` is one of them but
// lives in @archon/core, which this package cannot import; it is guarded there,
// under the same block name. Both packages compile their anchors through their
// normal TypeScript projects.
//
// Two hand-mapped hops are deliberately OUTSIDE the guard, both in telemetry:
//   - `captureChatTurn` (@archon/core orchestrator-agent) maps usage for the
//     direct-chat path, carrying gross totals only;
//   - `@archon/paths` remaps `buildRunUsageProps`'s output a fourth time on the
//     way to PostHog, and sits at the root of the dependency order, so it cannot
//     import `TokenUsage` and no anchor can fire there.
// A new axis therefore reaches PostHog only if someone follows it past this
// block. Tracked separately; this block covers the first hop, where the
// `TokenUsage` axes are still named.
//
// What this guard does NOT do: make a new *site* loud. No type can require an
// author to register the hand-mapped seam they just wrote. The maps below are
// the discoverable inventory a reviewer checks a new site against.
// ───────────────────────────────────────────────────────────────────────────
describe('TokenUsage axis seam guard', () => {
  /**
   * One value per axis, all distinct so a swapped key spelling fails instead of
   * passing on a coincidence.
   *
   * `Required<TokenUsage>` is the anchor. Adding `foo?: number` to TokenUsage
   * fails here with `TS2741: Property 'foo' is missing in type ... but required
   * in type 'Required<TokenUsage>'`.
   *
   * A provider never sets `cachePartial` — it is aggregation-only (see the field
   * docs in @archon/providers types). The specimen sets it anyway because this
   * guard tests CARRIAGE, not the fold rule that normally produces the flag;
   * `mergeTokenUsage` propagates an incoming `cachePartial`, so a one-node run
   * is enough to observe the axis at every seam.
   */
  const AXIS_SPECIMEN: Required<TokenUsage> = {
    input: 5000,
    output: 1200,
    cacheRead: 4000,
    cacheWrite: 250,
    cachePartial: true,
    total: 6400,
    cost: 0.25,
  };

  /**
   * How one seam spells each axis on its wire. `null` = this seam deliberately
   * does not carry the axis. Exhaustive over `keyof TokenUsage`, so a new axis
   * is a compile error at every seam until someone decides which it is.
   */
  type SeamAxisKeys = Record<keyof TokenUsage, string | null>;

  /**
   * Seams that carry the `TokenUsage` object whole, so the axis names ARE the
   * wire keys. They share one map because they share one decision: a new axis
   * either rides the object or does not. Each still gets its own assertion —
   * "carries it whole" is a claim about today's code, not a guarantee.
   *
   * `total` and `cost` cross none of the seams below, and both `null`s are
   * load-bearing — each is asserted absent, not merely declared:
   *  - No seam below reads `TokenUsage.cost`. Each carries its own scalar
   *    (`total_cost_usd`, `cost_usd`, `costUsd`, `signaledCostUsd`) sourced from
   *    the result message's `cost` field, which providers are expected to set —
   *    Pi's event bridge copies it there. `opencode/multi-agent.ts` does not, so
   *    on that path cost is stranded on the usage object. The fold seam carries
   *    no cost scalar at all.
   *  - `total` is set by several providers (Claude, Pi, and both OpenCode
   *    paths — the multi-agent one re-synthesizes it after its own internal
   *    fold) and then dropped by the engine's fold: `mergeTokenUsage` documents
   *    that it does not aggregate it. So no seam below carries it. It is NOT a
   *    dead axis: it is read by `formatCostFooter` in @archon/adapters on the
   *    direct-chat path, which never folds, and by OpenCode's own multi-agent
   *    sum. Recorded, not fixed.
   */
  const WHOLE_OBJECT_AXIS_KEYS: SeamAxisKeys = {
    input: 'input',
    output: 'output',
    cacheRead: 'cacheRead',
    cacheWrite: 'cacheWrite',
    cachePartial: 'cachePartial',
    total: null,
    cost: null,
  };

  /** Run metadata written by persistRunUsage and read back by childOutcomeFromRun. */
  const RUN_METADATA_AXIS_KEYS: SeamAxisKeys = {
    input: 'total_tokens_in',
    output: 'total_tokens_out',
    cacheRead: 'total_cache_read_tokens',
    cacheWrite: 'total_cache_write_tokens',
    cachePartial: 'total_cache_partial',
    total: null,
    cost: null,
  };

  /** Terminal telemetry props — a third spelling, remapped again inside @archon/paths. */
  const TELEMETRY_AXIS_KEYS: SeamAxisKeys = {
    input: 'tokensIn',
    output: 'tokensOut',
    cacheRead: 'cacheReadTokens',
    cacheWrite: 'cacheWriteTokens',
    cachePartial: 'cachePartialTokens',
    total: null,
    cost: null,
  };

  /**
   * Assert that every axis `keys` declares carried arrived under its declared key
   * with the specimen's value, AND that every axis it declares `null` really is
   * absent.
   *
   * The negative half matters as much as the positive one. Without it a `null`
   * asserts nothing and stays green forever after it stops being true — teach
   * `mergeTokenUsage` to aggregate `total` and it would start flowing to the
   * seams that spread the object whole while the ones that rebuild or rename it
   * drop it — with every map still reading `total: null` and every row green.
   * That is #2662 again, for the axis most likely to move next.
   *
   * Seam and axis are folded into the compared object's KEY, not into a sibling
   * field: bun's diff prints only a narrow window around the changed line, so a
   * sibling `axis` field is elided from the failure and the report names the seam
   * without saying which axis went missing.
   */
  function expectSeamCarriesAxes(
    seam: string,
    keys: SeamAxisKeys,
    carried: Record<string, unknown> | undefined
  ): void {
    expect({ [`${seam} carried usage`]: carried !== undefined }).toEqual({
      [`${seam} carried usage`]: true,
    });
    for (const [axis, key] of Object.entries(keys) as [keyof TokenUsage, string | null][]) {
      if (key === null) {
        // No declared key to look under, so the axis's own name is what a
        // careless passthrough would surface it as.
        const label = `${seam} → ${axis} (declared not carried)`;
        expect({ [label]: carried?.[axis] }).toEqual({ [label]: undefined });
        continue;
      }
      const label = `${seam} → ${axis} (as '${key}')`;
      expect({ [label]: carried?.[key] }).toEqual({ [label]: AXIS_SPECIMEN[axis] });
    }
  }

  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-axis-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
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
    // Restore the file-level provider stubs. `mockClear()` drops call records
    // but leaves implementations in place, and this block's last test installs a
    // generator that yields "should never run" — a describe appended after this
    // one (the header invites exactly that) would inherit it.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(_provider => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  /**
   * One AI node whose provider reports the specimen. Four seams read off this
   * single run: the node event, the run metadata, the telemetry props, and the
   * JSONL transcript row.
   */
  async function runSpecimenDag(outcome: 'completed' | 'failed' = 'completed'): Promise<{
    store: MockWorkflowStore;
    runId: string;
    logDir: string;
  }> {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done' };
      yield {
        type: 'result',
        sessionId: 'axis-sid',
        tokens: AXIS_SPECIMEN,
        // The provider reports its usage and its failure on the SAME chunk, so the
        // node reaches a failure writer with the specimen already accumulated. Any
        // earlier throw would leave nothing for the failure sink to carry, and the
        // row would pass the guard by being empty on both sides.
        ...(outcome === 'failed' ? { isError: true, errorSubtype: 'stream_error' } : {}),
      };
    });
    const store = createMockStore();
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun(`axis-seam-run-${outcome}`);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'axis-seam',
          nodes: [{ id: 'step', kind: 'agent', source: { kind: 'inline', prompt: 'Do thing.' } }],
        },
        workflowRun,
        logDir,
      })
    );
    return { store, runId: workflowRun.id, logDir };
  }

  function nodeCompletedTokens(store: MockWorkflowStore, stepName: string): unknown {
    const completed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => {
        const event = call[0] as { event_type: string; step_name?: string };
        return event.event_type === 'node_completed' && event.step_name === stepName;
      }
    );
    expect(completed.length).toBe(1);
    return (
      (completed[0][0] as { data: Record<string, unknown> }).data as {
        tokens?: Record<string, unknown>;
      }
    ).tokens;
  }

  it('aggregation fold (mergeTokenUsage) carries every axis it claims', () => {
    // The chokepoint: every other seam's value passes through this fold first.
    // It rebuilds `{input, output}` rather than spreading, which is why a new
    // axis needs a deliberate merge rule here before any seam can carry it.
    expectSeamCarriesAxes(
      'mergeTokenUsage',
      WHOLE_OBJECT_AXIS_KEYS,
      mergeTokenUsage([AXIS_SPECIMEN]) as unknown as Record<string, unknown>
    );
  });

  it('node_completed event carries every axis it claims', async () => {
    const { store } = await runSpecimenDag();
    expectSeamCarriesAxes(
      'node_completed.data.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeCompletedTokens(store, 'step') as Record<string, unknown>
    );
  });

  it('run metadata round-trips every axis it claims, writer to reader', async () => {
    const { store } = await runSpecimenDag();
    const written = runUsageWrites(store);
    expect(written.length).toBe(1);
    // Writer: persistRunUsage's `total_*` key list.
    expectSeamCarriesAxes('run metadata (write)', RUN_METADATA_AXIS_KEYS, written[0]);
    // Reader: childOutcomeFromRun's SEPARATE, independently maintained key list.
    // Nothing in production fails if the two disagree — this is the pair the
    // issue calls the sharpest illustration of the seam.
    expectSeamCarriesAxes(
      'run metadata (read)',
      WHOLE_OBJECT_AXIS_KEYS,
      childOutcomeFromRun(
        makeWorkflowRun('axis-child', { status: 'completed', metadata: written[0] })
      ).tokens as unknown as Record<string, unknown>
    );
  });

  it('terminal telemetry props carry every axis they claim', () => {
    // The run store projects terminal telemetry from the cumulative usage fold, so
    // this hop starts at that fold's output rather than at a DAG run.
    const { cost: _cost, total: _total, ...tokens } = AXIS_SPECIMEN;
    const props = buildRunTerminalTelemetry({
      run: {
        id: 'axis-run',
        workflow_name: 'axis',
        parent_run_id: null,
        status: 'completed',
        metadata: {},
      },
      events: [],
      usage: { costUsd: AXIS_SPECIMEN.cost, tokens },
    });
    expectSeamCarriesAxes(
      'telemetry props',
      TELEMETRY_AXIS_KEYS,
      props as unknown as Record<string, unknown>
    );
  });

  it('JSONL transcript node_complete row carries every axis it claims', async () => {
    const { runId, logDir } = await runSpecimenDag();
    const rows = await readTranscript(logDir, runId);
    const nodeComplete = rows.find(row => row.type === 'node_complete' && row.step === 'step');
    expectSeamCarriesAxes(
      'JSONL node_complete.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeComplete?.tokens as Record<string, unknown>
    );
  });

  it('JSONL transcript node_error row carries every axis it claims', async () => {
    // The failure sink joins the guard here (#2693). It reuses the whole-object map
    // because logNodeError spreads the same WorkflowUsage carrier logNodeComplete
    // does — one decision, so a new axis either rides both rows or neither.
    const { runId, logDir } = await runSpecimenDag('failed');
    const rows = await readTranscript(logDir, runId);
    const nodeError = rows.find(row => row.type === 'node_error' && row.step === 'step');
    expectSeamCarriesAxes(
      'JSONL node_error.tokens',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeError?.tokens as Record<string, unknown>
    );
  });

  it('loop gate round-trips every axis it claims, pause to resume', async () => {
    // Writer: the gate persists the loop's cumulative usage whole.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'Pass one. <promise>APPROVED</promise>' };
      yield { type: 'result', sessionId: 'axis-loop-sid', tokens: AXIS_SPECIMEN };
    });
    const loopNodes: DagNode[] = [
      {
        id: 'refine',
        kind: 'loop',
        loop: {
          fresh_context: false,
          prompt: 'Refine.',
          until: 'APPROVED',
          max_iterations: 10,
          interactive: true,
          gate_message: 'Review.',
        },
      },
    ];
    const pausingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: pausingDeps,
        cwd: testDir,
        workflow: { name: 'axis-loop-pause', nodes: loopNodes },
        workflowRun: makeWorkflowRun('axis-loop-pause-run'),
      })
    );
    const pauseCalls = (
      pausingDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    const signaledTokens = (pauseCalls[0][1] as { signaledTokens?: Record<string, unknown> })
      .signaledTokens;
    expectSeamCarriesAxes('loop gate (write)', WHOLE_OBJECT_AXIS_KEYS, signaledTokens);

    // Reader: readSignaledTokens decodes it through a fixed key destructure.
    // Resumed on a BARE approve so the finalize path (#2074) completes from the
    // persisted usage without running another iteration — a new iteration would
    // add its own usage and destroy the value identity this assertion needs.
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'should never run' };
      yield { type: 'result', sessionId: 'never' };
    });
    const resumingDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: resumingDeps,
        cwd: testDir,
        workflow: { name: 'axis-loop-resume', nodes: loopNodes },
        workflowRun: makeWorkflowRun('axis-loop-resume-run', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 1,
              sessionId: 'axis-loop-sid',
              message: 'gate',
              completionSignaled: true,
              signaledOutput: 'REPORT',
              signaledTokens,
            },
            loop_user_input: 'Approved',
            loop_feedback_given: false,
          },
        }),
      })
    );
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expectSeamCarriesAxes(
      'loop gate (read)',
      WHOLE_OBJECT_AXIS_KEYS,
      nodeCompletedTokens(resumingDeps.store, 'refine') as Record<string, unknown>
    );
  });
});

// ---------------------------------------------------------------------------
// #2637 — workflow values survive every boundary; resource-backed nodes bind
// them by name. AC1 (persistence round-trip), AC4 (node-local bindings),
// AC5 (skipped-branch reads).
// ---------------------------------------------------------------------------

describe('value transport (#2637): persistence, resume, and node-local bindings', () => {
  let testDir: string;

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  const PRODUCER_PAYLOAD = { green: true, items: ['a', 'b'], count: 2 };
  const PRODUCER_SCHEMA = {
    type: 'object',
    properties: {
      green: { type: 'boolean' },
      items: { type: 'array' },
      count: { type: 'number' },
    },
    required: ['green', 'items', 'count'],
  };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-value-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
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

  /** Provider mock: the producer prompt returns the structured payload; every other
   *  prompt is captured so consumer-side delivery is observable. */
  function mockStructuredProducer(capture: (prompt: string) => void): void {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('PRODUCE')) {
        yield { type: 'agent_message_chunk', text: JSON.stringify(PRODUCER_PAYLOAD) };
        yield { type: 'result', sessionId: 'sid-prod', structuredOutput: PRODUCER_PAYLOAD };
        return;
      }
      capture(prompt);
      yield { type: 'agent_message_chunk', text: 'consumer done' };
      yield { type: 'result', sessionId: 'sid-cons' };
    });
  }

  async function runDag(
    workflow: WorkflowDefinition,
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>,
    workflowRunOverrides?: Partial<WorkflowRun>
  ): Promise<{ events: PersistedEvent[]; store: MockWorkflowStore }> {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2637',
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun(runId, workflowRunOverrides),
        priorCompletedNodes,
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    return { events, store };
  }

  it.each([false, true])(
    'preserves incomplete resumed output provenance (structured=%s)',
    async structured => {
      const preview = 'x'.repeat(32_768);
      const spillPath = join(testDir, 'missing-original-spill.txt');
      const resumed = await runDag(
        {
          name: 'incomplete-replay',
          description: 'resume preview',
          returns: 'producer',
          nodes: [dagNodeSchema.parse({ id: 'producer', bash: 'echo should-not-run' })],
        },
        'incomplete-replay',
        new Map([
          [
            'producer',
            {
              output: preview,
              outputTruncation: { originalBytes: 40_000, spillPath },
              ...(structured ? { structuredOutput: { answer: 42 } } : {}),
            },
          ],
        ])
      );
      const replay = resumed.events.find(
        event => event.event_type === 'node_skipped_prior_success'
      );
      expect(replay?.data).toMatchObject({
        node_output: preview,
        node_output_truncated: true,
        node_output_original_bytes: 40_000,
        node_output_spill_path: spillPath,
      });
      if (structured) expect(replay?.data?.structured_output).toEqual({ answer: 42 });
      expect(resumed.events.some(event => event.event_type === 'node_started')).toBe(false);
      const record = await buildTerminalRecord({
        run: makeWorkflowRun('incomplete-replay', {
          status: 'completed',
          metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['producer'], returns: 'producer' } },
        }),
        events: resumed.events.map(event => ({ ...event, data: event.data ?? {} })),
      });
      expect(record.returns).toEqual(
        structured
          ? { availability: 'available', node_id: 'producer', value: { answer: 42 } }
          : {
              availability: 'truncated',
              node_id: 'producer',
              original_bytes: 40_000,
              spill_path: spillPath,
            }
      );
    }
  );

  function producerConsumerWorkflow(): WorkflowDefinition {
    return {
      name: 'transport-roundtrip',
      description: 'structured producer feeding a typed consumer',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE the classification',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt:
            'green=[$producer.output.green] items=[$producer.output.items] whole=[$producer.output]',
          depends_on: ['producer'],
        }),
      ],
    };
  }

  it('AC1: persists structured_output in node_completed and rehydrates identical values on cold resume', async () => {
    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });

    const fresh = await runDag(producerConsumerWorkflow(), 'transport-fresh');

    // The producer's node_completed event carries the logical value beside its text.
    const producerCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'producer'
    );
    expect(producerCompleted?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);
    expect(String(producerCompleted?.data?.node_output)).toBe(JSON.stringify(PRODUCER_PAYLOAD));
    expect(freshPrompt).toBe(
      `green=[true] items=[["a","b"]] whole=[${JSON.stringify(PRODUCER_PAYLOAD)}]`
    );

    // Cold resume: the snapshot the store would rebuild from that event.
    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    const prior = new Map<string, PersistedNodeOutput>([
      [
        'producer',
        {
          output: String(producerCompleted?.data?.node_output),
          structuredOutput: producerCompleted?.data?.structured_output,
        },
      ],
    ]);
    const resumed = await runDag(producerConsumerWorkflow(), 'transport-resumed', prior);

    // Byte-identical consumer view — the invariant the whole slice exists for.
    expect(resumedPrompt).toBe(freshPrompt);
    // The re-emit copies the logical value forward so a SECOND resume still sees it.
    const replayed = resumed.events.find(e => e.event_type === 'node_skipped_prior_success');
    expect(replayed?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);

    // A pre-#2637 snapshot row (text only) still resolves via the text-parse fallback.
    let legacyPrompt: string | undefined;
    mockStructuredProducer(p => {
      legacyPrompt = p;
    });
    await runDag(
      producerConsumerWorkflow(),
      'transport-legacy',
      new Map([['producer', { output: JSON.stringify(PRODUCER_PAYLOAD) }]])
    );
    expect(legacyPrompt).toBe(freshPrompt);
  });

  it('AC1: a loop_group persists its terminal sink structured payload and re-exposes it after resume', async () => {
    const groupWorkflow = (): WorkflowDefinition => ({
      name: 'transport-group',
      description: 'loop_group whose terminal sink emits a structured payload',
      nodes: [
        dagNodeSchema.parse({
          id: 'group',
          loop_group: {
            until_bash: 'exit 0',
            max_iterations: 1,
            fresh_context: false,
            nodes: [
              {
                id: 'emit',
                prompt: 'PRODUCE inside the group',
                output_format: PRODUCER_SCHEMA,
              },
            ],
          },
        }),
        dagNodeSchema.parse({
          id: 'consumer',
          prompt: 'field=[$group.output.green]',
          depends_on: ['group'],
        }),
      ],
    });

    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });
    const fresh = await runDag(groupWorkflow(), 'transport-group-fresh');

    const groupCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'group'
    );
    expect(groupCompleted?.data?.structured_output).toEqual(PRODUCER_PAYLOAD);
    expect(freshPrompt).toBe('field=[true]');

    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    await runDag(
      groupWorkflow(),
      'transport-group-resumed',
      new Map([
        [
          'group',
          {
            output: String(groupCompleted?.data?.node_output),
            structuredOutput: groupCompleted?.data?.structured_output,
          },
        ],
      ])
    );
    expect(resumedPrompt).toBe(freshPrompt);
  });

  it('AC4: a command node binds upstream values by name through $INPUTS (typed, whole-ref, and template)', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'consume.md'),
      'g=[$INPUTS.green] t=[$INPUTS.typed] items=[$INPUTS.items] msg=[$INPUTS.msg]'
    );
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-command-binding',
      description: 'command node with node-local bindings',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: {
            green: '$producer.output.green',
            typed: 42,
            items: '$producer.output.items',
            msg: 'count is $producer.output.count',
          },
          depends_on: ['producer'],
        }),
      ],
    };

    await runDag(workflow, 'transport-cmd-bind');
    // Whole refs keep the logical value (boolean/array), the literal stays typed, and
    // the template splices canonical text — all through one deterministic rule.
    expect(consumerPrompt).toBe('g=[true] t=[42] items=[["a","b"]] msg=[count is 2]');
  });

  it('AC4: a script node receives bindings as INPUTS_<UPPER_SNAKE> env text, single-encoded', async () => {
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-script-binding',
      description: 'script node with node-local bindings',
      nodes: [
        dagNodeSchema.parse({
          id: 'producer',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'emit',
          script:
            'console.log(`g=${process.env.INPUTS_GREEN}|payload=${process.env.INPUTS_PAYLOAD}`);',
          runtime: 'bun',
          depends_on: ['producer'],
          with: {
            green: '$producer.output.green',
            payload: '$producer.output',
          },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'script said [$emit.output]',
          depends_on: ['emit'],
        }),
      ],
    };

    await runDag(workflow, 'transport-script-bind');
    // Boolean delivers as its canonical text `true` (never re-quoted), and the whole
    // structured payload arrives single-encoded — no artifact-file bridge required.
    expect(consumerPrompt).toBe(`script said [g=true|payload=${JSON.stringify(PRODUCER_PAYLOAD)}]`);
  });

  it('AC4: node-local bindings win over a run input of the same name (nearest contract)', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'consume.md'), 'v=[$INPUTS.green]');
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-binding-precedence',
      description: 'node-local binding shadows the run input',
      nodes: [
        dagNodeSchema.parse({ id: 'producer', prompt: 'PRODUCE', output_format: PRODUCER_SCHEMA }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { green: '$producer.output.green' },
          depends_on: ['producer'],
        }),
      ],
    };

    await runDag(workflow, 'transport-precedence', undefined, {
      metadata: { inputs: { green: 'from-run-input' } },
    });
    expect(consumerPrompt).toBe('v=[true]');
  });

  it('AC4: an unknown or non-upstream binding fails the node with an actionable error, never an empty string', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'consume.md'), 'v=[$INPUTS.v]');
    mockStructuredProducer(() => {});

    // Built programmatically (the loader rejects this at load time) to prove the
    // runtime seam fails loudly too.
    const workflow: WorkflowDefinition = {
      name: 'transport-binding-unknown',
      description: 'binding to a producer that never ran',
      nodes: [
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { v: '$ghost.output' },
        }),
      ],
    };

    const { events } = await runDag(workflow, 'transport-unknown');
    const failed = events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("'$ghost.output' references node 'ghost'");
  });

  it('AC5: a binding on a skipped producer takes if_skipped; without one the node fails naming the fix', async () => {
    await writeFile(join(testDir, '.archon', 'commands', 'gate.md'), 'ready=[$INPUTS.ready]');
    let consumerPrompt: string | undefined;
    mockStructuredProducer(p => {
      consumerPrompt = p;
    });

    const skippedProducerWorkflow = (withValue: unknown): WorkflowDefinition => ({
      name: 'transport-skipped',
      description: 'reads across a skipped branch',
      nodes: [
        dagNodeSchema.parse({ id: 'seed', bash: "printf '%s' no" }),
        dagNodeSchema.parse({
          id: 'maybe',
          prompt: 'PRODUCE',
          output_format: PRODUCER_SCHEMA,
          depends_on: ['seed'],
          when: "$seed.output == 'yes'",
        }),
        dagNodeSchema.parse({
          id: 'gate',
          command: 'gate',
          with: { ready: withValue },
          depends_on: ['maybe'],
          trigger_rule: 'all_done',
        }),
      ],
    });

    // With the declared default, the skipped branch resolves to it — explicitly.
    await runDag(
      skippedProducerWorkflow({ from: '$maybe.output.green', if_skipped: false }),
      'transport-skipped-default'
    );
    expect(consumerPrompt).toBe('ready=[false]');

    // Without it, the node fails and the message names the binding, producer, and fix.
    const { events } = await runDag(
      skippedProducerWorkflow({ from: '$maybe.output.green' }),
      'transport-skipped-loud'
    );
    const failed = events.find(e => e.event_type === 'node_failed');
    expect(String(failed?.data?.error)).toContain("binding 'ready' reads '$maybe.output.green'");
    expect(String(failed?.data?.error)).toContain("'maybe' did not run");
    expect(String(failed?.data?.error)).toContain('if_skipped');
  });

  it('AC1+AC4 (issue acceptance): bindings resolve identically from a rehydrated snapshot after cold resume', async () => {
    await writeFile(
      join(testDir, '.archon', 'commands', 'consume.md'),
      'g=[$INPUTS.green] items=[$INPUTS.items]'
    );
    let freshPrompt: string | undefined;
    mockStructuredProducer(p => {
      freshPrompt = p;
    });

    const workflow = (): WorkflowDefinition => ({
      name: 'transport-resume-binding',
      description: 'binding consumer after resume',
      nodes: [
        dagNodeSchema.parse({ id: 'producer', prompt: 'PRODUCE', output_format: PRODUCER_SCHEMA }),
        dagNodeSchema.parse({
          id: 'consume',
          command: 'consume',
          with: { green: '$producer.output.green', items: '$producer.output.items' },
          depends_on: ['producer'],
        }),
      ],
    });

    const fresh = await runDag(workflow(), 'transport-resume-bind-fresh');
    const producerCompleted = fresh.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'producer'
    );

    let resumedPrompt: string | undefined;
    mockStructuredProducer(p => {
      resumedPrompt = p;
    });
    await runDag(
      workflow(),
      'transport-resume-bind-resumed',
      new Map([
        [
          'producer',
          {
            output: String(producerCompleted?.data?.node_output),
            structuredOutput: producerCompleted?.data?.structured_output,
          },
        ],
      ])
    );
    expect(resumedPrompt).toBe(freshPrompt);
    expect(resumedPrompt).toBe('g=[true] items=[["a","b"]]');
  });

  it('implement pattern (PR #2627): a boolean travels producer → script binding with no artifact file', async () => {
    // Deliberately overlaps the AC4 script-env test's code path: this one exists as
    // the issue's named acceptance bar (#2627's `.green` bridge, replicated as a
    // fixture), so the acceptance claim stays pinned even if the AC4 test evolves.
    let checkPrompt: string | undefined;
    mockStructuredProducer(p => {
      checkPrompt = p;
    });

    const workflow: WorkflowDefinition = {
      name: 'transport-implement-pattern',
      description: 'the .green file bridge, replaced by a binding',
      nodes: [
        dagNodeSchema.parse({
          id: 'impl',
          prompt: 'PRODUCE the validation verdict',
          output_format: PRODUCER_SCHEMA,
        }),
        dagNodeSchema.parse({
          id: 'record',
          script: 'console.log(`green=${process.env.INPUTS_GREEN}`);',
          runtime: 'bun',
          depends_on: ['impl'],
          with: { green: '$impl.output.green' },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'recorded [$record.output]',
          depends_on: ['record'],
        }),
      ],
    };

    await runDag(workflow, 'transport-implement');
    expect(checkPrompt).toBe('recorded [green=true]');
  });

  it('deliver pattern (PR #2627): an all_done join binds two mutually exclusive producers via if_skipped, on both branches', async () => {
    const deliverWorkflow = (seed: 'initial' | 'iteration'): WorkflowDefinition => ({
      name: 'transport-deliver-pattern',
      description: 'the .ready latch, replaced by explicit skipped-branch bindings',
      nodes: [
        dagNodeSchema.parse({ id: 'route', bash: `printf '%s' ${seed}` }),
        dagNodeSchema.parse({
          id: 'initial-ready',
          bash: `printf '%s' '{"ready":true,"source":"initial"}'`,
          output_format: {
            type: 'object',
            properties: { ready: { type: 'boolean' }, source: { type: 'string' } },
          },
          depends_on: ['route'],
          when: "$route.output == 'initial'",
        }),
        dagNodeSchema.parse({
          id: 'iteration-ready',
          bash: `printf '%s' '{"ready":true,"source":"iteration"}'`,
          output_format: {
            type: 'object',
            properties: { ready: { type: 'boolean' }, source: { type: 'string' } },
          },
          depends_on: ['route'],
          when: "$route.output == 'iteration'",
        }),
        dagNodeSchema.parse({
          id: 'join',
          script:
            'console.log(`initial=${process.env.INPUTS_INITIAL}|iteration=${process.env.INPUTS_ITERATION}`);',
          runtime: 'bun',
          depends_on: ['initial-ready', 'iteration-ready'],
          trigger_rule: 'all_done',
          with: {
            initial: { from: '$initial-ready.output.ready', if_skipped: false },
            iteration: { from: '$iteration-ready.output.ready', if_skipped: false },
          },
        }),
        dagNodeSchema.parse({
          id: 'check',
          prompt: 'joined [$join.output]',
          depends_on: ['join'],
        }),
      ],
    });

    const checkPrompts: string[] = [];
    mockStructuredProducer(p => {
      checkPrompts.push(p);
    });
    await runDag(deliverWorkflow('initial'), 'transport-deliver-initial');
    expect(checkPrompts).toEqual(['joined [initial=true|iteration=false]']);

    checkPrompts.length = 0;
    await runDag(deliverWorkflow('iteration'), 'transport-deliver-iteration');
    expect(checkPrompts).toEqual(['joined [initial=false|iteration=true]']);
  });

  // --- loop_group producer bindings, the real deliver topology (#2696) ---
  //
  // `deliver`'s `gate-ready` binds `{ from: '$corrections.output', if_skipped: null }`
  // on a `loop_group` (not a plain node), joined via `trigger_rule: all_done`. Three
  // cases: the group completes, the group is skipped, and the group fails. All three
  // build the same shape — a bash-only `corrections` loop_group feeding a `gate-ready`
  // script node — so each test constructs its own `nodes` array inline rather than a
  // shared builder, keeping every producer state (completed/skipped/failed) visible at
  // its call site.

  it("loop_group binding (#2696): a completed group's output resolves through an all_done join, not the if_skipped default", async () => {
    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: 'console.log(process.env.INPUTS_CORRECTIONS);',
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: 'NO_CORRECTIONS_RAN' },
        },
      }),
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-completed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-completed'),
      })
    );

    // The group's real whole-ref output resolved — the `if_skipped` default never fired.
    expect(result).toBe('CORRECTIONS_APPLIED');
  });

  it("loop_group binding (#2696): a skipped group's binding takes if_skipped", async () => {
    const nodes = [
      dagNodeSchema.parse({ id: 'gate', bash: "printf 'skip'", depends_on: [] }),
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: ['gate'],
        when: "$gate.output == 'run'",
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: 'console.log(process.env.INPUTS_CORRECTIONS);',
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: 'NO_CORRECTIONS_RAN' },
        },
      }),
    ];

    const result = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-skipped', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-skipped'),
      })
    );

    // The group never ran — the binding took its declared default, unchanged by #2696.
    expect(result).toBe('NO_CORRECTIONS_RAN');
  });

  it("loop_group binding (#2696): a failed group's binding fails the consumer instead of resolving stale output", async () => {
    // Reproduces run 6607bf20 (issue #2696): the group fails via max_iterations
    // exhaustion, but its one completed iteration left real, non-empty output behind
    // (captured as `lastIterationOutput` before the completion check that then failed).
    // Before the fix, `gate-ready` would resolve that stale text as if the group had
    // succeeded and run its own body on it — the split-brain that flipped PR #2705.
    const markerPath = join(testDir, 'gate-ready-ran.marker');

    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 1',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        // A stand-in for `flip-ready`'s real public write: proves whether the
        // consumer's own body ever ran, independent of the run's overall status.
        script: `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.INPUTS_CORRECTIONS ?? '');`,
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        with: {
          corrections: { from: '$corrections.output', if_skipped: null },
        },
      }),
    ];

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform,
        conversationId: 'conv-lg-binding',
        cwd: testDir,
        workflow: { name: 'lg-binding-failed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-failed'),
      })
    );

    // gate-ready's body never executed — no public-write consequence from a failed group.
    expect(await Bun.file(markerPath).exists()).toBe(false);

    // The failure names both the failed producer and the node whose binding rejected it.
    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain("Node 'gate-ready'");
    expect(sent).toContain("'corrections' failed");
  });

  // --- sibling gaps to the #2710 binding-directive fix (#2713) ---
  //
  // #2710 fixed exactly one reader of a failed producer's output: the `{ from,
  // if_skipped }` binding directive above. This test proves the sibling it explicitly
  // deferred — a PLAIN (non-directive) `with:` value, which can never use the directive
  // form and so never got #2710's protection — now fails the consumer too, using the
  // same `deliver`-shaped topology and failure mode as the tests above.
  it("sibling gaps (#2713): a failed group's PLAIN with: value fails the consumer instead of resolving stale output", async () => {
    const markerPath = join(testDir, 'gate-ready-plain-with-ran.marker');

    const nodes = [
      dagNodeSchema.parse({
        id: 'corrections',
        loop_group: {
          until_bash: 'exit 1',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'apply', bash: "printf 'CORRECTIONS_APPLIED'", depends_on: [] }],
        },
        depends_on: [],
      }),
      dagNodeSchema.parse({
        id: 'gate-ready',
        script: `require('fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.INPUTS_CORRECTIONS ?? '');`,
        runtime: 'bun',
        depends_on: ['corrections'],
        trigger_rule: 'all_done',
        // Plain whole-ref value — NOT the { from, if_skipped } directive form. This
        // is resolveWorkflowValue's whole-ref tier, not resolveBindingDirective.
        with: {
          corrections: '$corrections.output',
        },
      }),
    ];

    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        platform,
        conversationId: 'conv-lg-binding-plain',
        cwd: testDir,
        workflow: { name: 'lg-binding-plain-with-failed', nodes: nodes as DagNode[] },
        workflowRun: makeWorkflowRun('lg-binding-plain-with-failed'),
      })
    );

    // gate-ready's body never executed — no public-write consequence from a failed group.
    expect(await Bun.file(markerPath).exists()).toBe(false);

    const sent = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(sent).toContain("node 'corrections'");
    expect(sent).toContain('failed');
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

// ---------------------------------------------------------------------------
// #2453 — the composed proof. One run carries a result contract across every
// surface the earlier phases delivered: a `script:` node certifies its own stdout,
// the result points at a file instead of carrying it, an `include:` alias exposes
// that contract to the parent, `fan_out.items` consumes one of its declared fields
// as a real array, each instance certifies its own per-item result, and a cold
// resume reproduces all of it. This is the executable twin of the reference fixture
// `.archon/workflows/test-workflows/e2e-contract-fanout.yaml`.
// ---------------------------------------------------------------------------

describe('a result contract survives the whole composed path (#2453)', () => {
  let testDir: string;
  let outputRoot: string;
  let runArtifactsDir: string;
  const originalArtifactHome = mockArtifactHome;

  const RUN_ID = 'composed-contract-run';
  const UNITS = [
    { id: 'unit-a', title: 'first unit of work' },
    { id: 'unit-b', title: 'second unit of work' },
  ];
  const POINTER = { type: 'archon_artifact', run_id: RUN_ID, path: 'plan.md' };
  const PLAN_RESULT = { units: UNITS, plan: POINTER };
  // Each instance points at the per-item file it wrote. Instances run INSIDE this run,
  // so every pointer names this run — the only run a producer may name.
  const AGGREGATE = UNITS.map(unit => ({
    id: unit.id,
    ok: true,
    report: { type: 'archon_artifact', run_id: RUN_ID, path: `units/${unit.id}.md` },
  }));

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-composed-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    outputRoot = join(testDir, 'workspaces', '_cwd', 'proj');
    runArtifactsDir = join(outputRoot, 'artifacts', 'runs', RUN_ID);
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    // The run's own artifacts directory, which the plan script writes into and its
    // pointer then names — the same directory the pointer gate resolves independently
    // from the run's persisted `output_root`.
    await mkdir(runArtifactsDir, { recursive: true });
    setMockArtifactHome(testDir);
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));

    // The block whose `returns:` node certifies the workflow's result. A deterministic
    // producer (Phase 2) writing the large artifact and returning a small value that
    // points at it (Phase 4).
    await writeFile(
      join(testDir, '.archon', 'workflows', 'plan-block.yaml'),
      `
name: plan-block
description: certifies a result carrying a unit list and a pointer at the full plan
mutates_checkout: false
returns: build
nodes:
  - id: build
    runtime: bun
    script: |
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'plan.md'), '# the full plan');
      console.log(
        JSON.stringify({
          units: ${JSON.stringify(UNITS)},
          plan: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'plan.md' },
        })
      );
    output_format:
      type: object
      properties:
        units:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              title: { type: string }
            required: [id, title]
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [units, plan]
`
    );

    // The per-item body. It owns its own contract, so the aggregate is an array of
    // validated objects rather than an array of prose — each pointing at a per-item file
    // the instance wrote, proved at that producer against the run it runs in.
    await writeFile(
      join(testDir, '.archon', 'workflows', 'unit-block.yaml'),
      `
name: unit-block
description: one instance per unit, certifying its own per-item result
mutates_checkout: false
inputs:
  unit:
    required: true
returns: check
nodes:
  - id: check
    runtime: bun
    script: |
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const unit = JSON.parse(process.env.INPUTS_UNIT);
      mkdirSync(join(process.env.ARTIFACTS_DIR, 'units'), { recursive: true });
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'units', unit.id + '.md'), '# ' + unit.title);
      console.log(JSON.stringify({
        id: unit.id,
        ok: typeof unit.title === 'string',
        report: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'units/' + unit.id + '.md' },
      }));
    output_format:
      type: object
      properties:
        id: { type: string }
        ok: { type: boolean }
        report:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [id, ok, report]
`
    );

    await writeFile(
      join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
      `
name: composed-parent
description: reads the included block's contract and fans a composed body out over it
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.units"
      as: unit
      max_parallel: 2
      join: all_success
  - id: report
    prompt: "aggregate=$work.output pointer=$plan.output.plan"
    depends_on: [work]
`
    );
  });

  afterEach(async () => {
    setMockArtifactHome(originalArtifactHome);
    await removeTempTree(testDir);
  });

  /** The flattened parent, exactly as discovery hands it to the executor. */
  async function expandedParent(): Promise<ResolvedWorkflow> {
    const discovered = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(discovered.errors).toEqual([]);
    const parent = discovered.workflows.find(w => w.workflow.name === 'composed-parent');
    if (!parent) throw new Error('composed-parent was not discovered');
    return parent.workflow;
  }

  async function runComposed(
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<{ events: PersistedEvent[]; prompts: string[] }> {
    const prompts: string[] = [];
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'agent_message_chunk', text: 'reported' };
      yield { type: 'result', sessionId: 'sid-report' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2453-composed',
        cwd: testDir,
        workflow: await expandedParent(),
        workflowRun: makeWorkflowRun(RUN_ID, { output_root: outputRoot }),
        artifactsDir: runArtifactsDir,
        priorCompletedNodes,
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    return { events, prompts };
  }

  const completionOf = (events: PersistedEvent[], step: string): PersistedEvent | undefined =>
    events.find(e => e.event_type === 'node_completed' && e.step_name === step);

  it('certifies a script result, exposes it through an include alias, and fans out over a declared field', async () => {
    const { events, prompts } = await runComposed();

    // The alias resolved to the included block's selected node, which certified its
    // own stdout: canonical text plus the logical value, pointer intact.
    const plan = completionOf(events, 'plan__build');
    expect(plan?.data?.structured_output).toEqual(PLAN_RESULT);
    expect(String(plan?.data?.node_output)).toBe(JSON.stringify(PLAN_RESULT));

    // `fan_out.items` read the DECLARED `units` field as a real array — one instance
    // per element, each certifying its own result.
    const instances = events.filter(
      e =>
        e.event_type === 'node_completed' &&
        (e.step_name ?? '').startsWith(`${composeScope('work')}__`) &&
        (e.step_name ?? '').endsWith('__check')
    );
    expect(instances).toHaveLength(2);
    expect(instances.map(e => e.data?.structured_output)).toEqual(
      expect.arrayContaining(AGGREGATE)
    );

    // The wrapper aggregate is the ordered logical array, serialized exactly once, and
    // it relays each instance's pointer unrewritten: one per item, naming this run and
    // the relative path the instance wrote — a real file under this run's artifacts.
    const wrapper = completionOf(events, 'work');
    expect(wrapper?.data?.structured_output).toEqual(AGGREGATE);
    expect(JSON.parse(String(wrapper?.data?.node_output))).toEqual(AGGREGATE);
    for (const unit of UNITS) {
      expect(existsSync(join(runArtifactsDir, 'units', `${unit.id}.md`))).toBe(true);
    }

    // Downstream, the aggregate is one JSON array and the pointer is still a run id
    // plus a relative path — never expanded, never replaced by the file's contents.
    expect(prompts).toEqual([
      `aggregate=${JSON.stringify(AGGREGATE)} pointer=${JSON.stringify(POINTER)}`,
    ]);
  });

  it('reproduces the same downstream view after a cold resume', async () => {
    const fresh = await runComposed();
    const plan = completionOf(fresh.events, 'plan__build');

    // Only what an event row carries: the text and its logical sibling. Field
    // authorization is re-derived from the loaded block, which is what keeps
    // `$plan.output.units` a declared array rather than a lenient text parse.
    const resumed = await runComposed(
      new Map<string, PersistedNodeOutput>([
        [
          'plan__build',
          {
            output: String(plan?.data?.node_output),
            structuredOutput: plan?.data?.structured_output,
          },
        ],
      ])
    );

    expect(resumed.prompts).toEqual(fresh.prompts);
    expect(completionOf(resumed.events, 'work')?.data?.structured_output).toEqual(AGGREGATE);
    // The producer was not re-run; its contract rode the prior-success re-emit forward.
    expect(completionOf(resumed.events, 'plan__build')).toBeUndefined();
    const replayed = resumed.events.find(
      e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'plan__build'
    );
    expect(replayed?.data?.structured_output).toEqual(PLAN_RESULT);
  });

  it('rejects at load a fan-out that reads a field the contract never declared', async () => {
    await writeFile(
      join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
      `
name: composed-parent
description: fans out over a field the included block does not declare
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      as: unit
      max_parallel: 2
      join: all_success
`
    );

    const discovered = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    // The error names the include alias the author wrote, not the flattened sink id.
    expect(discovered.errors.map(e => e.error)).toEqual([
      expect.stringContaining("'$plan.output.tasks' references field 'tasks'"),
    ]);
    expect(discovered.errors[0]?.error).not.toContain('plan__build');
  });
});

describe('executeDagWorkflow -- unified node-state sinks (#3255)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-unified-sinks-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('retains cause on trigger_rule skip in the transcript', async () => {
    const store = createMockStore();
    const logDir = join(testDir, 'trigger-rule-logs');
    const workflowRun = makeWorkflowRun('trigger-rule-run');

    const failingNode: DagNode = {
      id: 'step1',
      kind: 'exec',
      runtime: 'sh',
      script: 'exit 1',
    };
    const dependentNode: DagNode = {
      id: 'step2',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo done',
      depends_on: ['step1'],
      trigger_rule: 'all_success',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'trigger-rule-workflow',
          nodes: [failingNode, dependentNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const skipRow = rows.find(r => r.type === 'node_skipped' && r.step === 'step2');
    expect(skipRow).toBeDefined();
    expect(skipRow?.content).toBe('trigger_rule');
    expect(skipRow?.cause).toEqual({ kind: 'upstream_failed', origin: 'step1' });
  });

  it('the seven functions emit transcript rows: child workflow, fan-out, loop group, durable wait produce completions in transcript', async () => {
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(testDir, '.archon', 'workflows', 'dummy-child-fanout.yaml'),
      'name: dummy-child-fanout\ndescription: dummy child\nmutates_checkout: false\nnodes:\n  - id: inner\n    bash: echo child\n'
    );

    const store = createMockStore();
    const logDir = join(testDir, 'four-completions-logs');
    const persistedWait = {
      owner: 'node' as const,
      nodeId: 'wait-node',
      kind: 'attention' as const,
      message: 'continue',
      waitingSince: '2026-08-23T00:00:00.000Z',
    };
    const workflowRun = makeWorkflowRun('four-completions-run', {
      metadata: { wait: persistedWait },
    });

    const waitNode: DagNode = {
      id: 'wait-node',
      kind: 'wait',
      wait: { attention: 'continue' },
    };
    const childNode: DagNode = {
      id: 'child-node',
      kind: 'workflow',
      workflow: 'dummy-child',
      depends_on: ['wait-node'],
    };
    const fanOutNode: DagNode = {
      id: 'fanout-node',
      kind: 'workflow',
      workflow: 'dummy-child-fanout',
      depends_on: ['child-node'],
      fan_out: {
        items: '["item1", "item2"]',
        max_parallel: 2,
        join: 'all_success',
      },
    };
    const loopGroupNode: DagNode = {
      id: 'loop-group-node',
      kind: 'loop_group',
      depends_on: ['fanout-node'],
      loop_group: {
        max_iterations: 1,
        fresh_context: true,
        until: 'DONE',
        nodes: [
          {
            id: 'inner',
            kind: 'exec',
            runtime: 'sh',
            script: 'echo DONE',
          },
        ],
      },
    };

    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => ({
      status: 'completed' as const,
      output: 'child-output',
      childRunId: `subrun-${args.nodeId}`,
    }));

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        runChildWorkflow,
        workflow: {
          name: 'all-four-completions',
          nodes: [waitNode, childNode, fanOutNode, loopGroupNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const completeSteps = rows.filter(r => r.type === 'node_complete').map(r => r.step);

    expect(completeSteps).toContain('wait-node');
    expect(completeSteps).toContain('child-node');
    expect(completeSteps).toContain('fanout-node');
    expect(completeSteps).toContain('loop-group-node');
  });

  it('assertCheckoutUntouched writes node_error transcript row on mutates_checkout failure', async () => {
    await git.execFileAsync('git', ['init', '-q'], { cwd: testDir });
    await git.execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'],
      { cwd: testDir }
    );

    const store = createMockStore();
    const logDir = join(testDir, 'untouched-logs');
    const workflowRun = makeWorkflowRun('untouched-run');

    const violatingNode: DagNode = {
      id: 'violator',
      kind: 'exec',
      runtime: 'sh',
      script: 'touch modified-file.txt',
      mutates_checkout: false,
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'violator-workflow',
          nodes: [violatingNode],
        },
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const errorRow = rows.find(r => r.type === 'node_error' && r.step === 'violator');
    expect(errorRow).toBeDefined();
    expect(String(errorRow?.error)).toContain(
      'declared `mutates_checkout: false` but modified the working tree'
    );
  });

  it('persisted data payloads are unchanged and rebuild identical node state across resume', async () => {
    const store = createMockStore();
    const logDir = join(testDir, 'resume-fixture-logs');
    const workflowRun = makeWorkflowRun('resume-fixture-run');

    const node1: DagNode = {
      id: 'producer',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo producer-output',
    };
    const node2: DagNode = {
      id: 'consumer',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo consumer-output',
      depends_on: ['producer'],
    };

    // Run first pass
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun,
        logDir,
        workflow: {
          name: 'resume-fixture-wf',
          nodes: [node1, node2],
        },
      })
    );

    // Collect persisted node_completed event for producer
    const producerEvent = store.persistWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(e => e.event_type === 'node_completed' && e.step_name === 'producer');

    expect(producerEvent).toBeDefined();
    expect(producerEvent?.data).toMatchObject({
      type: 'bash',
      node_output: 'producer-output',
    });

    // Simulate resume using the exact persisted data
    const snapshotStore = createMockStore();
    (
      snapshotStore.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>
    ).mockResolvedValue({
      completedNodeOutputs: new Map([
        ['producer', { output: producerEvent!.data!.node_output as string }],
      ]),
      fanOutSnapshots: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    });

    const resumedRun = makeWorkflowRun('resume-fixture-run-resumed');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(snapshotStore),
        cwd: testDir,
        workflowRun: resumedRun,
        logDir: join(testDir, 'resume-fixture-logs-2'),
        priorCompletedNodes: new Map([
          ['producer', { output: producerEvent!.data!.node_output as string }],
        ]),
        workflow: {
          name: 'resume-fixture-wf',
          nodes: [node1, node2],
        },
      })
    );

    // Producer was skipped due to prior success, consumer completed
    const resumedEvents = snapshotStore.persistWorkflowEvent.mock.calls.map(([e]) => e);
    const priorSuccess = resumedEvents.find(
      e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'producer'
    );
    expect(priorSuccess).toBeDefined();
    expect(priorSuccess?.data?.reason).toBe('prior_success');
  });
});

describe('executeDagWorkflow -- node checkout starts (#3375)', () => {
  let root: string;
  let repoDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `dag-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoDir = join(root, 'repo');
    await mkdir(repoDir, { recursive: true });
    await git.execFileAsync('git', ['init', '-q'], { cwd: repoDir });
    await git.execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
    await git.execFileAsync('git', ['config', 'user.name', 't'], { cwd: repoDir });
    await writeFile(join(repoDir, 'a.txt'), 'a\n');
    await git.execFileAsync('git', ['add', '-A'], { cwd: repoDir });
    await git.execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repoDir });
  });

  afterEach(async () => {
    await removeTempTree(root);
  });

  const head = async (): Promise<string> =>
    (await git.execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

  const run = async (nodes: DagNode[]): Promise<ReturnType<typeof createMockDeps>> => {
    const deps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: repoDir,
        // Run artifacts live outside the checkout, as they do in a real run.
        artifactsDir: join(root, 'artifacts'),
        stateDir: join(root, 'state'),
        logDir: join(root, 'logs'),
        workflow: { name: 'checkout-starts', nodes },
        workflowRun: makeWorkflowRun('checkout-run'),
      })
    );
    return deps;
  };

  const terminal = (
    deps: ReturnType<typeof createMockDeps>,
    stepName: string
  ): NonNullable<ReturnType<typeof readNodeRecordEvent>>[] =>
    (deps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls
      .map(([event]) => event)
      .filter(
        event =>
          event.step_name === stepName &&
          (event.event_type === 'node_completed' || event.event_type === 'node_failed')
      )
      .map(event => {
        const record = readNodeRecordEvent({
          ...event,
          step_name: event.step_name ?? null,
          data: event.data ?? {},
        });
        if (!record) throw new Error(`unreadable ${event.event_type} for ${stepName}`);
        return record;
      });

  it('a node records the checkout it started at, even after an earlier node moved it', async () => {
    const initial = await head();
    const deps = await run([
      {
        id: 'commit',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo b > b.txt && git add b.txt && git commit -qm b',
      },
      { id: 'after', kind: 'exec', runtime: 'sh', script: 'true', depends_on: ['commit'] },
    ]);
    const moved = await head();
    expect(moved).not.toBe(initial);

    const [commitRecord] = terminal(deps, 'commit');
    const [afterRecord] = terminal(deps, 'after');
    expect(commitRecord?.metadata?.attempt.checkoutStart).toMatchObject({
      kind: 'git',
      commit: initial,
      worktree: { status: 'clean' },
    });
    expect(commitRecord?.metadata?.invocation.checkoutStart).toEqual(
      commitRecord?.metadata?.attempt.checkoutStart
    );
    expect(afterRecord?.metadata?.attempt.checkoutStart).toMatchObject({
      kind: 'git',
      commit: moved,
    });
  });

  it('a retry samples its own attempt start while the invocation keeps the first', async () => {
    const deps = await run([
      {
        id: 'flaky',
        kind: 'exec',
        runtime: 'sh',
        // First attempt leaves an untracked file behind and fails; the retry succeeds.
        script: 'if [ -f marker ]; then exit 0; fi; touch marker; exit 1',
        retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' },
      },
    ]);
    const [failed, completed] = terminal(deps, 'flaky');
    expect(failed?.eventType).toBe('node_failed');
    expect(completed?.eventType).toBe('node_completed');
    expect(completed?.metadata?.invocation).toEqual(failed?.metadata?.invocation);
    expect(completed?.metadata?.invocation.checkoutStart).toMatchObject({
      worktree: { status: 'clean' },
    });
    expect(completed?.metadata?.attempt.checkoutStart).toMatchObject({
      worktree: { status: 'dirty', untracked: 1 },
    });
  });

  it('binds a producer invocation start and hands a script its own execution record', async () => {
    const deps = await run([
      { id: 'producer', kind: 'exec', runtime: 'sh', script: 'echo dirty > a.txt' },
      {
        id: 'consumer',
        kind: 'exec',
        runtime: 'bun',
        depends_on: ['producer'],
        with: { start: '$producer.execution.checkoutStart' },
        script:
          'console.log(process.env.INPUTS_START); console.log(process.env.ARCHON_NODE_EXECUTION);',
      },
    ]);
    const [producer] = terminal(deps, 'producer');
    const [consumer] = terminal(deps, 'consumer');
    const [bound, own] = (consumer?.data.node_output ?? '').split('\n');
    expect(JSON.parse(bound ?? '')).toEqual(producer?.metadata?.invocation.checkoutStart);
    const execution = JSON.parse(own ?? '') as {
      runId: string;
      attempt: { checkoutStart: unknown };
    };
    expect(execution.runId).toBe('checkout-run');
    expect(execution.attempt.checkoutStart).toEqual(consumer?.metadata?.attempt.checkoutStart);
    expect(execution.attempt.checkoutStart).toMatchObject({ worktree: { status: 'dirty' } });
  });

  it('fails a binding whose producer records no checkout start', async () => {
    const deps = await run([
      { id: 'gate', kind: 'exec', runtime: 'sh', script: 'true' },
      {
        id: 'consumer',
        kind: 'exec',
        runtime: 'bun',
        depends_on: ['gate'],
        with: { start: '$gate.execution.checkoutStart', other: '$missing.execution.checkoutStart' },
        script: 'console.log(process.env.INPUTS_START, process.env.INPUTS_OTHER);',
      },
    ]);
    const [consumer] = terminal(deps, 'consumer');
    expect(consumer?.eventType).toBe('node_failed');
    expect(consumer?.data.error).toContain('$missing.execution.checkoutStart');
  });
});

describe('executeDagWorkflow -- substituted values reach the node verbatim (#4046)', () => {
  let testDir: string;
  // Reference syntax and a replacement pattern, as a brief that discusses the engine
  // quotes them. None of these may be read as template text once substituted.
  const quoted =
    "Check $gate.output.decision, read $gate.output, use $INPUTS.plan, keep $& and it's done.";

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-verbatim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  const prompts = (): string[] => mockSendQueryDag.mock.calls.map(call => call[0] as string);

  async function runPrompt(
    prompt: string,
    options: { userMessage?: string; issueContext?: string } = {}
  ): Promise<MockWorkflowStore> {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        ...(options.issueContext !== undefined ? { issueContext: options.issueContext } : {}),
        workflow: {
          name: 'verbatim',
          nodes: [{ id: 'summarize', kind: 'agent', source: { kind: 'inline', prompt } }],
        },
        workflowRun: makeWorkflowRun('verbatim-run', {
          user_message: options.userMessage ?? 'plain request',
        }),
      })
    );
    return store;
  }

  it('sends the run message exactly as written', async () => {
    const store = await runPrompt('Summarize this request: $ARGUMENTS', { userMessage: quoted });

    expect(prompts()).toEqual([`Summarize this request: ${quoted}`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it('sends issue context exactly as written, substituted or appended', async () => {
    const substituted = await runPrompt('Context: $CONTEXT', { issueContext: quoted });
    expect(substituted.failWorkflowRun).not.toHaveBeenCalled();
    expect(prompts()).toEqual([`Context: ${quoted}`]);

    mockSendQueryDag.mockClear();
    const appended = await runPrompt('Review the issue.', { issueContext: quoted });
    expect(appended.failWorkflowRun).not.toHaveBeenCalled();
    expect(prompts()).toEqual([`Review the issue.\n\n---\n\n${quoted}`]);
  });

  it('does not read a run message that names a context variable as the issue context', async () => {
    await runPrompt('Request: $ARGUMENTS', {
      userMessage: 'explain $CONTEXT',
      issueContext: 'ISSUE BODY',
    });
    expect(prompts()).toEqual(['Request: explain $CONTEXT\n\n---\n\nISSUE BODY']);
  });

  it("sends an upstream node's output exactly as written", async () => {
    const upstream = 'Use $ARGUMENTS and $INPUTS.plan and $gate.output and $& here';
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: upstream };
      yield { type: 'result', sessionId: 'verbatim-upstream' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-upstream',
          nodes: [
            { id: 'gate', kind: 'agent', source: { kind: 'inline', prompt: 'decide' } },
            {
              id: 'act',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Got: $gate.output' },
              depends_on: ['gate'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-upstream-run'),
      })
    );

    expect(prompts()).toEqual(['decide', `Got: ${upstream}`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it('still fails a mistyped field reference in the template with the unknown-node error', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: '{"decision":"approve"}' };
      yield { type: 'result', sessionId: 'verbatim-typo' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-typo',
          nodes: [
            { id: 'gate', kind: 'agent', source: { kind: 'inline', prompt: 'decide' } },
            {
              id: 'act',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Act on $gaet.output.decision' },
              depends_on: ['gate'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-typo-run'),
      })
    );

    const failure = (store.failWorkflowRun as Mock<IWorkflowStore['failWorkflowRun']>).mock
      .calls[0]?.[1];
    expect(failure).toContain(
      "'$gaet.output.decision' references node 'gaet', but no node with that id has produced output"
    );
    expect(failure).toContain("Did you mean: 'gate'?");
  });

  it('sends a rejection reason exactly as written to the rework prompt', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-reject',
          nodes: [
            {
              id: 'review',
              kind: 'gate',
              message: 'Approve this plan?',
              decisions: [
                { id: 'approve' },
                {
                  id: 'reject',
                  rework: { prompt: 'Fix based on: $REJECTION_REASON', maxAttempts: 3 },
                },
              ],
              captureResponse: true,
              decisionsAuthored: false,
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-reject-run', {
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve this plan?',
              onRejectPrompt: 'Fix based on: $REJECTION_REASON',
              onRejectMaxAttempts: 3,
            },
            rejection_reason: quoted,
            rejection_count: 1,
          },
        }),
      })
    );

    expect(prompts()).toEqual([`Fix based on: ${quoted}`]);
    // The rework succeeded, so the gate re-pauses for another review.
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("sends a loop node's previous output exactly as written", async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? quoted : 'DONE' };
      yield { type: 'result', sessionId: `verbatim-loop-${calls}` };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-loop',
          nodes: [
            {
              id: 'refine',
              kind: 'loop',
              loop: {
                prompt: 'Previous: [$LOOP_PREV_OUTPUT]',
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-loop-run'),
      })
    );

    expect(prompts()[1]).toBe(`Previous: [${quoted}]`);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('sends an interactive loop_group reply exactly as written to a body prompt', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DONE' };
      yield { type: 'result', sessionId: 'verbatim-reply' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-reply',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                interactive: true,
                gate_message: 'Review and reply.',
                nodes: [
                  {
                    id: 'revise',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Reply: [$LOOP_USER_INPUT]' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-reply-run', {
          metadata: {
            approval: {
              type: 'interactive_loop',
              nodeId: 'grp',
              iteration: 0,
              message: 'Review and reply.',
            },
            loop_user_input: quoted,
            loop_feedback_given: true,
          },
        }),
      })
    );

    expect(prompts()).toEqual([`Reply: [${quoted}]`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('sends a previous-iteration output exactly as written to a loop_group body prompt', async () => {
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: calls === 1 ? quoted : 'DONE' };
      yield { type: 'result', sessionId: `verbatim-prev-${calls}` };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'verbatim-prev',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 3,
                fresh_context: true,
                nodes: [
                  {
                    id: 'draft',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'Prior: [$LOOP_PREV.draft.output]' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('verbatim-prev-run'),
      })
    );

    expect(prompts()).toEqual(['Prior: []', `Prior: [${quoted}]`]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });
});
