import { describe, expect, test } from 'bun:test';
import { makeTestWorkflow } from './test-utils';
import { formatDryRunTrace } from './dry-run';
import type { DryRunResolution } from './dry-run';
import { buildAiProfile } from './model-validation';
import { resolveWorkflowModelScope } from './node-model-resolution';
import { expandWorkflowIncludes } from './include-expander';
import { dryRunWorkflow } from './dry-run-test-utils';

describe('dryRunWorkflow — effective provider/model per node', () => {
  const config = {
    assistant: 'claude',
    assistants: { claude: { model: 'claude-default' }, codex: { model: 'codex-default' } },
    commands: {},
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };
  const aiProfile = buildAiProfile('claude', {
    repoTiers: { large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' } },
  });

  async function trace(nodes: unknown[]): Promise<Map<string, DryRunResolution | undefined>> {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({ name: 'resolve', nodes }),
      userMessage: 'go',
      stubs: Object.fromEntries((nodes as { id: string }[]).map(n => [n.id, 'ok'])),
      config,
      aiProfile,
    });
    return new Map(result.trace.map(e => [e.nodeId, e.resolution]));
  }

  test('reports a node-declared provider/model, and the config fallback for one that declares nothing', async () => {
    const byId = await trace([
      { id: 'bare', prompt: 'p' },
      { id: 'own', prompt: 'p', provider: 'codex' },
    ]);

    expect(byId.get('bare')).toMatchObject({
      provider: 'claude',
      model: 'claude-default',
      providerFrom: 'default assistant',
    });
    expect(byId.get('own')).toMatchObject({
      provider: 'codex',
      model: 'codex-default',
      providerFrom: 'node',
      modelFrom: 'assistant config',
    });
  });

  test('reports a tier keyword resolved through the profile, with its effort', async () => {
    const byId = await trace([{ id: 'tiered', prompt: 'p', model: 'large' }]);
    expect(byId.get('tiered')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      providerFrom: 'model ref',
      modelFrom: 'model ref',
      effort: 'xhigh',
      effortFrom: 'model ref',
    });
  });

  test('names the workflow a composed node was authored in', async () => {
    const block = makeTestWorkflow({
      name: 'blk',
      provider: 'codex',
      nodes: [{ id: 'work', prompt: 'p' }],
    });
    const parent = makeTestWorkflow({
      name: 'parent',
      nodes: [{ id: 'inc', include: 'blk' }],
    });
    const { workflows } = expandWorkflowIncludes(
      new Map([
        ['blk', block],
        ['parent', parent],
      ])
    );

    const result = await dryRunWorkflow({
      workflow: workflows.get('parent')!,
      userMessage: 'go',
      stubs: { inc__work: 'ok' },
      config,
      aiProfile,
    });

    expect(result.trace[0].resolution).toMatchObject({
      provider: 'codex',
      providerFrom: 'node',
      authoredIn: 'blk',
    });
  });

  test('reports a loop_group body node against the group own resolved model', async () => {
    const byId = await trace([
      {
        id: 'group',
        model: 'large',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [{ id: 'body', prompt: 'p' }],
        },
      },
    ]);

    const group = byId.get('group');
    const body = byId.get('body');
    expect(body).toBeDefined();
    expect(body?.model).toBe(group?.model);
    expect(body?.provider).toBe(group?.provider);
  });

  test('reports a provider/model conflict the real run would warn about', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'conflict',
        nodes: [{ id: 'clash', prompt: 'p', provider: 'claude', model: 'large' }],
      }),
      userMessage: 'go',
      stubs: { clash: 'ok' },
      config,
      aiProfile,
    });
    expect(result.trace[0].resolution).toMatchObject({
      provider: 'codex',
      providerConflict: { declared: 'claude', resolved: 'codex', modelRef: 'large' },
    });
    expect(formatDryRunTrace(result).split('\n')).toContain(
      "  warning: declares provider 'claude' but model 'large' resolves to 'codex' — using 'codex'"
    );
  });

  test('non-AI nodes carry no resolution, and the text trace renders the report', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'mixed',
        nodes: [
          { id: 'shell', bash: 'echo hi' },
          { id: 'think', prompt: 'p', provider: 'codex' },
        ],
      }),
      userMessage: 'go',
      stubs: { shell: 'hi', think: 'ok' },
      config,
      aiProfile,
    });

    expect(result.trace.find(e => e.nodeId === 'shell')?.resolution).toBeUndefined();
    expect(formatDryRunTrace(result)).toContain('runs on: codex (node) / codex-default');
  });
});

describe('resolveWorkflowModelScope — the origin names the value that won', () => {
  const assistantModels = { claude: 'claude-default', codex: 'codex-default' };
  const profile = buildAiProfile('claude', {
    repoTiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
  });

  test('a preset outranks a declared provider, and the origin says so', () => {
    const scope = resolveWorkflowModelScope(
      { provider: 'claude', model: 'large' },
      'claude',
      assistantModels,
      profile
    );
    expect(scope.provider).toBe('codex');
    expect(scope.providerOrigin).toBe('model ref');
  });

  test('a declared provider with a literal model keeps the workflow origin', () => {
    const scope = resolveWorkflowModelScope(
      { provider: 'codex', model: 'gpt-5.6-sol' },
      'claude',
      assistantModels,
      profile
    );
    expect(scope.provider).toBe('codex');
    expect(scope.providerOrigin).toBe('workflow');
  });

  test('no provider and no model falls back to the default assistant', () => {
    const scope = resolveWorkflowModelScope({}, 'claude', assistantModels, profile);
    expect(scope.provider).toBe('claude');
    expect(scope.providerOrigin).toBe('default assistant');
  });
});
