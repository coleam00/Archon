// @archon-test-isolated
import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import { providerRegistry, getProviderCapabilities } from '@archon/providers';
import { removeTempTree } from '@archon/paths/test-utils';
import type {
  DagNode,
  AgentNode,
  LoopGroupNode,
  GateNode,
  IncludeDirective,
  ResolvedWorkflow,
} from '../schemas';
import { dagNodeSchema } from '../schemas';
import { makeTestResolvedWorkflow } from '../test-utils';
import { buildAiProfile } from '../model-validation';
import { settlingProvider } from '../test-settling-provider';
import { executeDagWorkflow } from '../dag-executor';
import {
  assertRunCapabilities,
  collectContainerIncompatibleProviders,
  visitProviderInvokingNodes,
  collectStrictSchemaViolations,
  providerInvocation,
  type ProviderInvocation,
} from './capability-preflight';
import {
  createMockDeps,
  makeWorkflowRun,
  dagOptions,
  mockSendQueryDag,
  minimalConfig,
} from './test-utils';

describe('collectContainerIncompatibleProviders', () => {
  const promptNode = (id: string, provider?: string): DagNode =>
    ({
      id,
      kind: 'agent',
      source: { kind: 'inline', prompt: `do ${id}` },
      ...(provider ? { provider } : {}),
    }) as unknown as DagNode;
  const bashNode = (id: string): DagNode =>
    ({ id, kind: 'exec', runtime: 'sh', script: 'echo hi' }) as unknown as DagNode;

  it('capability preflight follows the supplied descriptor rather than host registrations', () => {
    const claude = providerRegistry.get('claude');
    if (!claude) throw new Error('test registry must contain Claude');
    const blocked = { ...claude, capabilities: { ...claude.capabilities, containerExec: false } };
    const providers = {
      get: (id: string) => (id === blocked.id ? blocked : undefined),
      list: () => [blocked],
    };
    const nodes = [promptNode('a', 'claude')];
    expect([...collectContainerIncompatibleProviders(providers, nodes, 'claude')]).toEqual([
      'claude',
    ]);
    expect([...collectContainerIncompatibleProviders(providerRegistry, nodes, 'claude')]).toEqual(
      []
    );
  });

  it('is empty when all AI nodes resolve to claude (containerExec: true)', () => {
    const nodes = [promptNode('a'), promptNode('b', 'claude'), bashNode('c')];
    const bad = collectContainerIncompatibleProviders(providerRegistry, nodes, 'claude');
    expect([...bad]).toEqual([]);
  });

  it('flags a node whose provider lacks containerExec (codex)', () => {
    const nodes = [promptNode('a'), promptNode('b', 'codex')];
    const bad = collectContainerIncompatibleProviders(providerRegistry, nodes, 'claude');
    expect([...bad]).toEqual(['codex']);
  });

  it('flags the workflow-level provider when a node does not override it', () => {
    const nodes = [promptNode('a')];
    const bad = collectContainerIncompatibleProviders(providerRegistry, nodes, 'codex');
    expect([...bad]).toEqual(['codex']);
  });

  it('coordination wrappers do not require a parent default provider', () => {
    const workflow = makeTestResolvedWorkflow({
      name: 'coordination',
      nodes: [
        { id: 'child', workflow: 'deterministic-child' },
        { id: 'fan', include: 'explicit-child', fan_out: { items: '[1, 2]', as: 'item' } },
      ],
    });
    const visited: string[] = [];
    visitProviderInvokingNodes(workflow.nodes, undefined, undefined, (_node, provider) =>
      visited.push(provider)
    );
    expect(visited).toEqual([]);
    expect([
      ...collectContainerIncompatibleProviders(providerRegistry, workflow.nodes, undefined),
    ]).toEqual([]);
    visitProviderInvokingNodes(
      [promptNode('explicit', 'codex')],
      undefined,
      undefined,
      (_node, provider) => visited.push(provider)
    );
    expect(visited).toEqual(['codex']);
  });

  it('ignores bash/script nodes (deterministic, no provider)', () => {
    const nodes = [bashNode('a'), bashNode('b')];
    const bad = collectContainerIncompatibleProviders(providerRegistry, nodes, 'codex');
    expect([...bad]).toEqual([]);
  });

  it('recurses loop_group bodies', () => {
    const group = {
      id: 'g',
      kind: 'loop_group',
      loop_group: { max_iterations: 2, nodes: [promptNode('inner', 'codex')] },
    } as unknown as DagNode;
    const bad = collectContainerIncompatibleProviders(providerRegistry, [group], 'claude');
    expect([...bad]).toEqual(['codex']);
  });
});

describe('container preflight provider equivalence with dispatch', () => {
  const aiProfile = buildAiProfile('claude', {
    repoTiers: { medium: { provider: 'codex', model: 'gpt-5.5' } },
    repoAliases: { '@review': { provider: 'claude', model: 'claude-sonnet-4-6' } },
  });
  const agent = (extra: Partial<AgentNode> = {}): AgentNode => ({
    id: 'work',
    kind: 'agent',
    source: { kind: 'inline', prompt: 'Do the work' },
    ...extra,
  });
  const group = (body: DagNode, extra: Partial<LoopGroupNode> = {}): LoopGroupNode => ({
    id: 'group',
    kind: 'loop_group',
    loop_group: {
      max_iterations: 1,
      fresh_context: false,
      nodes: [body],
    },
    ...extra,
  });
  const gate = (extra: Partial<GateNode> = {}): GateNode => ({
    id: 'review',
    kind: 'gate',
    message: 'Approve?',
    decisions: [{ id: 'approve' }, { id: 'reject', rework: { prompt: 'Revise', maxAttempts: 3 } }],
    decisionsAuthored: false,
    captureResponse: false,
    ...extra,
  });
  const cases: { name: string; node: DagNode; workflowProvider: string; provider: string }[] = [
    { name: 'workflow claude', node: agent(), workflowProvider: 'claude', provider: 'claude' },
    { name: 'workflow codex', node: agent(), workflowProvider: 'codex', provider: 'codex' },
    {
      name: 'node override codex',
      node: agent({ provider: 'codex' }),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'node override claude',
      node: agent({ provider: 'claude' }),
      workflowProvider: 'codex',
      provider: 'claude',
    },
    {
      name: 'tier',
      node: agent({ model: 'medium' }),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'tier overrides node',
      node: agent({ provider: 'claude', model: 'medium' }),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'alias',
      node: agent({ model: '@review' }),
      workflowProvider: 'codex',
      provider: 'claude',
    },
    {
      name: 'alias overrides node',
      node: agent({ provider: 'codex', model: '@review' }),
      workflowProvider: 'codex',
      provider: 'claude',
    },
    {
      name: 'literal inherits workflow',
      node: agent({ model: 'literal-model' }),
      workflowProvider: 'codex',
      provider: 'codex',
    },
    {
      name: 'literal preserves node',
      node: agent({ provider: 'claude', model: 'literal-model' }),
      workflowProvider: 'codex',
      provider: 'claude',
    },
    {
      name: 'group provider inheritance',
      node: group(agent(), { provider: 'codex' }),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'nested group tier inheritance',
      node: group(group(agent(), { id: 'inner' }), { model: 'medium' }),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'body provider override',
      node: group(agent({ provider: 'codex' })),
      workflowProvider: 'claude',
      provider: 'codex',
    },
    {
      name: 'gate rework',
      node: gate({ provider: 'codex' }),
      workflowProvider: 'claude',
      provider: 'claude',
    },
    {
      name: 'gate rework alias',
      node: gate({ provider: 'codex', model: '@review' }),
      workflowProvider: 'codex',
      provider: 'codex',
    },
  ];

  it.each(cases)('$name', async ({ node, workflowProvider, provider }) => {
    const cwd = join(tmpdir(), `preflight-equivalence-${crypto.randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    try {
      const deps = createMockDeps();
      const dispatched: string[] = [];
      deps.getAgentProvider = selected => {
        dispatched.push(selected);
        return settlingProvider({
          sendQuery: async function* () {
            yield { type: 'agent_message_chunk', text: 'Done' };
            yield { type: 'result', sessionId: 'equivalence-session' };
          },
          checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
          getType: () => selected,
          getCapabilities: () => getProviderCapabilities(selected),
        });
      };
      const workflowRun = makeWorkflowRun(
        'equivalence',
        node.kind === 'gate'
          ? {
              metadata: {
                approval: {
                  type: 'approval',
                  nodeId: node.id,
                  message: 'Approve?',
                  onRejectPrompt: 'Revise',
                  onRejectMaxAttempts: 3,
                },
                rejection_reason: 'Needs revision',
                rejection_count: 1,
              },
            }
          : {}
      );
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd,
          workflowRun,
          workflowProvider,
          aiProfile,
          workflow: { name: 'equivalence', nodes: [node] },
        })
      );
      expect([...new Set(dispatched)]).toEqual([provider]);
      const preflightProviders: string[] = [];
      visitProviderInvokingNodes([node], workflowProvider, aiProfile, (visited, selected) => {
        if (visited.kind !== 'loop_group') preflightProviders.push(selected);
      });
      expect([...new Set(preflightProviders)]).toEqual([...new Set(dispatched)]);
      const incompatible = dispatched.filter(p => !getProviderCapabilities(p).containerExec);
      expect(
        collectContainerIncompatibleProviders(providerRegistry, [node], workflowProvider, aiProfile)
      ).toEqual(new Set(incompatible));
    } finally {
      await removeTempTree(cwd);
    }
  });

  it('skips deterministic nodes and gates without rework, and leaves unknown providers to dispatch', () => {
    const nodes: DagNode[] = [
      { id: 'exec', kind: 'exec', runtime: 'sh', script: 'echo hi', provider: 'codex' },
      gate({ provider: 'codex', decisions: [{ id: 'approve' }, { id: 'reject' }] }),
      agent({ provider: 'unknown-provider' }),
    ];
    expect(
      collectContainerIncompatibleProviders(providerRegistry, nodes, 'codex', aiProfile)
    ).toEqual(new Set());
  });
});

describe('collectStrictSchemaViolations', () => {
  const agentNode = (id: string, extra: Partial<DagNode> = {}): DagNode =>
    ({
      id,
      kind: 'agent',
      source: { kind: 'inline', prompt: `do ${id}` },
      ...extra,
    }) as unknown as DagNode;

  const looseSchema = {
    type: 'object',
    properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
    required: ['ready'],
  };

  it('flags an agent under Codex workflow-level provider with loose schema', () => {
    const violations = collectStrictSchemaViolations(
      providerRegistry,
      [agentNode('a', { output_format: looseSchema })],
      'codex'
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      kind: 'missing-required',
      provider: 'codex',
      nodeId: 'a',
      schemaPath: 'output_format',
      missing: ['note'],
    });
  });

  it('flags a nested bare object with its exact schema path', () => {
    const violations = collectStrictSchemaViolations(
      providerRegistry,
      [
        agentNode('scope', {
          output_format: {
            type: 'object',
            properties: { pr: { type: 'object' } },
            required: ['pr'],
          },
        }),
      ],
      'codex'
    );

    expect(violations).toEqual([
      {
        kind: 'missing-properties',
        provider: 'codex',
        nodeId: 'scope',
        schemaPath: 'output_format.properties.pr',
      },
    ]);
  });

  it('is empty under Claude workflow-level provider', () => {
    const violations = collectStrictSchemaViolations(
      providerRegistry,
      [agentNode('a', { output_format: looseSchema })],
      'claude'
    );
    expect(violations).toEqual([]);
  });

  it('is empty when node pins provider: claude under Codex workflow', () => {
    const violations = collectStrictSchemaViolations(
      providerRegistry,
      [agentNode('a', { output_format: looseSchema, provider: 'claude' })],
      'codex'
    );
    expect(violations).toEqual([]);
  });

  it('flags loop_group body agent under Codex', () => {
    const group = {
      id: 'g',
      kind: 'loop_group',
      loop_group: {
        max_iterations: 1,
        nodes: [agentNode('inner', { output_format: looseSchema })],
      },
    } as unknown as DagNode;
    const violations = collectStrictSchemaViolations(providerRegistry, [group], 'codex');
    expect(violations).toHaveLength(1);
    expect(violations[0].nodeId).toBe('inner');
  });

  it("uses the loop_group's resolved provider as the body default", () => {
    const group = {
      id: 'g',
      kind: 'loop_group',
      provider: 'codex',
      loop_group: {
        max_iterations: 1,
        nodes: [agentNode('inner', { output_format: looseSchema })],
      },
    } as unknown as DagNode;

    const violations = collectStrictSchemaViolations(providerRegistry, [group], 'claude');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ provider: 'codex', nodeId: 'inner' });
  });

  it('lets a body node override the inherited loop_group provider', () => {
    const group = {
      id: 'g',
      kind: 'loop_group',
      provider: 'codex',
      loop_group: {
        max_iterations: 1,
        nodes: [
          agentNode('inner', {
            provider: 'claude',
            output_format: looseSchema,
          }),
        ],
      },
    } as unknown as DagNode;

    expect(collectStrictSchemaViolations(providerRegistry, [group], 'claude')).toEqual([]);
  });

  it('skips loop_group inert output_format', () => {
    const group = {
      id: 'g',
      kind: 'loop_group',
      output_format: looseSchema,
      loop_group: { max_iterations: 1, nodes: [] },
    } as unknown as DagNode;
    const violations = collectStrictSchemaViolations(providerRegistry, [group], 'codex');
    expect(violations).toEqual([]);
  });

  it('skips gate nodes with output_format (inert)', () => {
    const gate = {
      id: 'gate',
      kind: 'gate',
      decisions: [{ rework: 'reassess' }],
      output_format: looseSchema,
    } as unknown as DagNode;
    const violations = collectStrictSchemaViolations(providerRegistry, [gate], 'codex');
    expect(violations).toEqual([]);
  });

  it('skips unknown provider gracefully', () => {
    const node = agentNode('a', {
      output_format: looseSchema,
      provider: 'unknown-provider',
    });
    expect(() =>
      collectStrictSchemaViolations(providerRegistry, [node], 'unknown-provider')
    ).not.toThrow();
  });

  it('skips node without output_format entirely', () => {
    const violations = collectStrictSchemaViolations(providerRegistry, [agentNode('a')], 'codex');
    expect(violations).toEqual([]);
  });
});

describe('executeDagWorkflow -- strict-schema preflight', () => {
  it('rejects a Codex bare object before sending any query', async () => {
    const testDir = join(
      tmpdir(),
      `dag-strict-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();

    try {
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(),
            cwd: testDir,
            workflow: {
              name: 'strict-schema-preflight',
              nodes: [
                {
                  id: 'scope',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'Declare the review scope.' },
                  output_format: {
                    type: 'object',
                    properties: { pr: { type: 'object' } },
                    required: ['pr'],
                  },
                },
              ],
            },
            workflowRun: makeWorkflowRun('strict-schema-preflight'),
            workflowProvider: 'codex',
            config: { ...minimalConfig, assistant: 'codex' },
          })
        )
      ).rejects.toThrow(
        /node 'scope', output_format\.properties\.pr is an object schema without 'properties'.*Provider 'codex'/
      );
      expect(mockSendQueryDag).not.toHaveBeenCalled();
    } finally {
      await removeTempTree(testDir);
    }
  });
});

describe('assertRunCapabilities', () => {
  it('names the properties a strict provider needs listed in required', () => {
    const workflow: Pick<ResolvedWorkflow, 'name' | 'nodes'> = {
      name: 'preflight',
      nodes: [
        {
          id: 'work',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Do the work' },
          output_format: {
            type: 'object',
            properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
            required: ['ready'],
          },
        },
      ],
    };
    const host = { kind: 'host' } as const;
    expect(() =>
      assertRunCapabilities(providerRegistry, workflow, 'codex', undefined, host)
    ).toThrow(
      "output_format schema strict-mode violation: workflow 'preflight', node 'work', output_format declares note not in 'required'"
    );
    expect(() =>
      assertRunCapabilities(providerRegistry, workflow, 'claude', undefined, host)
    ).not.toThrow();
  });
});

describe('providerInvocation', () => {
  type Kind = (DagNode | IncludeDirective)['kind'];
  // One authored node per kind; the Record type makes a new kind a compile error here too.
  const authored: Record<Kind, unknown> = {
    agent: { id: 'agent', prompt: 'work' },
    exec: { id: 'exec', bash: 'echo' },
    gate: { id: 'gate', approval: { message: 'ok?', on_reject: { prompt: 'fix it' } } },
    halt: { id: 'halt', cancel: 'stop' },
    wait: { id: 'wait', wait: { duration_ms: 10 } },
    loop: { id: 'loop', loop: { prompt: 'work', until: 'DONE', max_iterations: 2 } },
    loop_group: {
      id: 'loop_group',
      loop_group: { max_iterations: 2, until: 'DONE', nodes: [{ id: 'body', prompt: 'work' }] },
    },
    workflow: { id: 'workflow', workflow: 'child' },
    compose_fan_out: {
      id: 'compose_fan_out',
      include: 'block',
      fan_out: { items: "['a']", as: 'item', max_parallel: 1 },
    },
    include: { id: 'include', include: 'block' },
  };
  const expected: Record<Kind, ProviderInvocation['kind']> = {
    agent: 'invokes',
    loop: 'invokes',
    loop_group: 'group',
    gate: 'gate_rework',
    exec: 'none',
    halt: 'none',
    wait: 'none',
    workflow: 'none',
    compose_fan_out: 'none',
    include: 'none',
  };

  it('selects exactly agent, loop, loop_group and a gate with rework', () => {
    const classified = Object.fromEntries(
      Object.entries(authored).map(([kind, input]) => {
        const node = dagNodeSchema.parse(input);
        expect<string>(node.kind).toBe(kind);
        return [kind, providerInvocation(node).kind];
      })
    );
    expect(classified).toEqual(expected);
  });

  it('gives a gate without rework no provider invocation', () => {
    const gate = dagNodeSchema.parse({ id: 'gate', approval: { message: 'ok?' } });
    expect(providerInvocation(gate)).toEqual({ kind: 'none' });
  });
});
