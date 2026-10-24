// @archon-test-isolated
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowRunConfigFile,
  parseWorkflowRunConfig,
  sealWorkflowRunConfig,
  unsealWorkflowRunConfig,
  workflowRunConfigFromRun,
  workflowRunConfigKeys,
} from './run-config';
import { workflowRunConfigLayerSchema } from '@archon/workflows/schemas/run-config';
import { decodeWorkflowRunConfigHandoff } from './run-config-handoff';

const TEST_KEY = 'ab'.repeat(32);
let previousKey: string | undefined;

beforeAll(() => {
  registerBuiltinProviders();
  registerCommunityProviders();
});

beforeEach(() => {
  previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
});

describe('workflow run config', () => {
  it('normalizes the complete runtime-owned sparse surface', () => {
    const parsed = parseWorkflowRunConfig(
      {
        defaultAssistant: 'pi',
        assistants: { pi: { model: 'minimax/MiniMax-M3', enableExtensions: false } },
        tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        aliases: { '@planner': { provider: 'claude', model: 'opus' } },
        workflows: { quotaMaxAttempts: 3, toolCallAttentionMs: 60000 },
        docs: { path: 'handbook' },
        env: { BENCH_TOKEN: 'top-secret' },
      },
      { kind: 'http', label: 'inline' }
    );

    expect(parsed).toEqual({
      source: { kind: 'http', label: 'inline' },
      layer: {
        assistant: 'pi',
        assistants: { pi: { model: 'minimax/MiniMax-M3', enableExtensions: false } },
        tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        aliases: { '@planner': { provider: 'claude', model: 'opus' } },
        workflows: { quotaMaxAttempts: 3, toolCallAttentionMs: 60000 },
        docsPath: 'handbook',
        envVars: { BENCH_TOKEN: 'top-secret' },
      },
    });
  });

  it('projects every accepted runtime key to its layer field and sealed key paths', () => {
    const projections = {
      assistant: { value: 'pi', layer: { assistant: 'pi' }, paths: ['assistant'] },
      defaultAssistant: { value: 'pi', layer: { assistant: 'pi' }, paths: ['assistant'] },
      assistants: {
        value: { pi: { enableExtensions: false, extensionFlags: { auth: 'secret' } }, codex: {} },
        layer: {
          assistants: {
            pi: { enableExtensions: false, extensionFlags: { auth: 'secret' } },
            codex: {},
          },
        },
        paths: [
          'assistants.codex',
          'assistants.pi.enableExtensions',
          'assistants.pi.extensionFlags',
        ],
      },
      aliases: {
        value: { '@planner': { provider: 'claude', model: 'opus' } },
        layer: { aliases: { '@planner': { provider: 'claude', model: 'opus' } } },
        paths: ['aliases.@planner'],
      },
      tiers: {
        value: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        layer: { tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } } },
        paths: ['tiers.large'],
      },
      workflows: {
        value: { toolCallAttentionMs: 60000 },
        layer: { workflows: { toolCallAttentionMs: 60000 } },
        paths: ['workflows.toolCallAttentionMs'],
      },
      docs: { value: { path: 'handbook' }, layer: { docsPath: 'handbook' }, paths: ['docs.path'] },
      env: {
        value: { BENCH_TOKEN: 'test-value' },
        layer: { envVars: { BENCH_TOKEN: 'test-value' } },
        paths: ['env.BENCH_TOKEN'],
      },
    };
    expect(Object.keys(projections).sort()).toEqual([...workflowRunConfigKeys].sort());
    const entries = Object.values(projections);
    expect([...new Set(entries.flatMap(entry => Object.keys(entry.layer)))].sort()).toEqual(
      [...workflowRunConfigLayerSchema.keyof().options].sort()
    );
    for (const [key, { value, layer, paths }] of Object.entries(projections)) {
      const parsed = parseWorkflowRunConfig({ [key]: value }, { kind: 'http', label: key });
      expect(parsed.layer).toEqual(layer);
      expect(sealWorkflowRunConfig(parsed.layer, parsed.source).keys).toEqual(paths);
    }
    const combined = workflowRunConfigLayerSchema.parse(
      Object.assign({}, ...entries.map(entry => entry.layer))
    );
    expect(sealWorkflowRunConfig(combined, { kind: 'http', label: 'inline' }).keys).toEqual(
      [...new Set(entries.flatMap(entry => entry.paths))].sort()
    );
  });

  it('rejects unknown, ambiguous, and every unavailable top-level key with its name', () => {
    expect(() => parseWorkflowRunConfig(null, { kind: 'http', label: 'inline' })).toThrow(
      "Invalid run config at 'document'"
    );
    expect(() =>
      parseWorkflowRunConfig({ mystery: true }, { kind: 'http', label: 'inline' })
    ).toThrow("Unknown run config key 'mystery'");
    expect(() =>
      parseWorkflowRunConfig(
        { assistant: 'pi', defaultAssistant: 'claude' },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("both 'assistant' and 'defaultAssistant'");
    expect(() =>
      parseWorkflowRunConfig(
        { workflows: { quotaMaxAttempts: 2, mystery: true } },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'workflows'");

    for (const key of [
      'commands',
      'defaults',
      'worktree',
      'container',
      'botName',
      'streaming',
      'concurrency',
      'recommendedWorkflows',
    ]) {
      expect(() =>
        parseWorkflowRunConfig({ [key]: {} }, { kind: 'http', label: 'inline' })
      ).toThrow(`Run config key '${key}' cannot apply`);
    }
  });

  it('rejects model settings that cannot execute or survive resume', () => {
    expect(() =>
      parseWorkflowRunConfig({ assistant: 'not-registered' }, { kind: 'http', label: 'inline' })
    ).toThrow("Invalid run config at 'assistant': Unknown provider: 'not-registered'");
    expect(() =>
      parseWorkflowRunConfig(
        { aliases: { planner: { provider: 'claude', model: 'opus' } } },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'aliases.planner'");
    expect(() =>
      parseWorkflowRunConfig(
        {
          tiers: {
            large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'banana' },
          },
        },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'tiers.large.effort'");
    expect(() =>
      parseWorkflowRunConfig(
        {
          tiers: {
            large: { provider: 'codex', model: 'gpt-5.6-sol', typo: true },
          },
        },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'tiers.large'");
    for (const provider of ['pi', 'opencode']) {
      expect(() =>
        parseWorkflowRunConfig(
          { aliases: { '@bad': { provider, model: 'banana' } } },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow("Invalid run config at 'aliases.@bad.model'");
    }
    for (const value of ['', '   ']) {
      expect(() =>
        parseWorkflowRunConfig(
          { tiers: { large: { provider: 'claude', model: value } } },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow("Invalid run config at 'tiers.large.model'");
      expect(() =>
        parseWorkflowRunConfig(
          { assistants: { codex: { model: value } } },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow("Invalid run config at 'assistants.codex.model'");
    }
    expect(() =>
      parseWorkflowRunConfig(
        {
          aliases: {
            '@unsupported': { provider: 'opencode', model: 'openai/gpt-5', effort: 'high' },
          },
        },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'aliases.@unsupported.effort'");
    expect(() =>
      parseWorkflowRunConfig(
        {
          tiers: {
            medium: { provider: 'codex', model: 'gpt-5.6', thinking: 'adaptive' },
          },
        },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow(/tiers\.medium\.thinking.*effort:/);
  });

  it('rejects Pi defaults whose consumers own process-lifetime state', () => {
    for (const [key, value] of [
      ['env', { TOKEN: 'secret' }],
      ['maxConcurrent', 1],
    ] as const) {
      expect(() =>
        parseWorkflowRunConfig(
          { assistants: { pi: { [key]: value } } },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow(`Invalid run config at 'assistants.pi.${key}': Pi `);
    }
  });

  it('rejects provider defaults that execution would silently discard', () => {
    for (const [provider, defaults, path] of [
      ['codex', { modelReasoningEffort: 'banana' }, 'assistants.codex.modelReasoningEffort'],
      ['codex', { webSearchMode: 'realtime' }, 'assistants.codex.webSearchMode'],
      ['codex', { typo: true }, 'assistants.codex.typo'],
      ['claude', { settingSources: 'project' }, 'assistants.claude.settingSources'],
      ['claude', { claudeBinaryPath: '   ' }, 'assistants.claude.claudeBinaryPath'],
      ['codex', { codexBinaryPath: '' }, 'assistants.codex.codexBinaryPath'],
      ['copilot', { copilotCliPath: '   ' }, 'assistants.copilot.copilotCliPath'],
      ['copilot', { configDir: '' }, 'assistants.copilot.configDir'],
      ['pi', { apiKey: 'secret' }, 'assistants.pi.apiKey'],
      ['pi', { model: 'banana' }, 'assistants.pi.model'],
      ['opencode', { model: 'gpt-5' }, 'assistants.opencode.model'],
      ['opencode', { baseUrl: 'http://localhost:4096' }, 'assistants.opencode.baseUrl'],
      ['opencode', { agent: 'general' }, 'assistants.opencode.agent'],
    ] as const) {
      expect(() =>
        parseWorkflowRunConfig(
          { assistants: { [provider]: defaults } },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow(`Invalid run config at '${path}'`);
    }
  });

  it('rejects retired thinking presets for every provider and names effort', () => {
    for (const provider of ['pi', 'copilot']) {
      expect(() =>
        parseWorkflowRunConfig(
          {
            tiers: {
              large: { provider, model: 'openai/gpt-5.6', thinking: 'enabled' },
            },
          },
          { kind: 'http', label: 'inline' }
        )
      ).toThrow(/tiers\.large\.thinking.*effort:/);
    }
  });

  it('persists the provider-normalized value consumed by execution', () => {
    const parsed = parseWorkflowRunConfig(
      { assistants: { copilot: { modelReasoningEffort: 'max' } } },
      { kind: 'http', label: 'inline' }
    );

    expect(parsed.layer.assistants?.copilot).toEqual({ modelReasoningEffort: 'max' });
    expect(
      parseWorkflowRunConfig(
        { assistants: { opencode: { model: ' anthropic / claude-sonnet-4-5 ' } } },
        { kind: 'http', label: 'inline' }
      ).layer.assistants?.opencode
    ).toEqual({ model: 'anthropic/claude-sonnet-4-5' });
    expect(
      parseWorkflowRunConfig(
        {
          aliases: {
            '@open': { provider: 'opencode', model: ' openai / gpt-5.6 ' },
          },
        },
        { kind: 'http', label: 'inline' }
      ).layer.aliases?.['@open']
    ).toEqual({ provider: 'opencode', model: 'openai/gpt-5.6' });
    expect(
      parseWorkflowRunConfig(
        {
          assistants: { pi: { model: ' openai / gpt-5.6 ' } },
          tiers: { large: { provider: 'pi', model: ' openai / gpt-5.6 ' } },
        },
        { kind: 'http', label: 'inline' }
      ).layer
    ).toMatchObject({
      assistants: { pi: { model: 'openai/gpt-5.6' } },
      tiers: { large: { provider: 'pi', model: 'openai/gpt-5.6' } },
    });
  });

  it('seals secrets for replay while exposing only attribution and key paths', () => {
    const input = parseWorkflowRunConfig(
      {
        assistants: { pi: { extensionFlags: { auth: 'provider-secret' } } },
        env: { TOKEN: 'env-secret' },
      },
      { kind: 'cli', label: 'config.minimax.yaml' }
    );
    const metadata = sealWorkflowRunConfig(input.layer, input.source);
    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('env-secret');
    expect(metadata.keys).toEqual(['assistants.pi.extensionFlags', 'env.TOKEN']);
    expect(unsealWorkflowRunConfig(metadata)).toEqual(input.layer);
  });

  it('reads the run config another run started with, naming that run as the source', () => {
    const run_config = sealWorkflowRunConfig(
      { assistant: 'codex' },
      { kind: 'cli', label: 'config.claude.yaml' }
    );
    expect(workflowRunConfigFromRun({ id: 'r1', metadata: { run_config } })).toEqual({
      layer: { assistant: 'codex' },
      source: { kind: 'cli', label: 'run r1 (config.claude.yaml)' },
    });
    // A run started without --config ran on the install's config alone.
    expect(workflowRunConfigFromRun({ id: 'r2', metadata: {} })).toBeUndefined();
  });

  it('fails explicitly when persisted ciphertext is tampered with', () => {
    const input = parseWorkflowRunConfig(
      { env: { TOKEN: 'env-secret' } },
      { kind: 'http', label: 'inline' }
    );
    const metadata = sealWorkflowRunConfig(input.layer, input.source);
    expect(() =>
      unsealWorkflowRunConfig({ ...metadata, ciphertext: `${metadata.ciphertext.slice(0, -2)}xx` })
    ).toThrow('could not be decrypted');
  });

  it('decodes a detached handoff before provider-dependent normalization', () => {
    const metadata = sealWorkflowRunConfig(
      { assistant: 'not-registered' },
      { kind: 'cli', label: 'config.yaml' }
    );

    expect(decodeWorkflowRunConfigHandoff(JSON.stringify(metadata))).toEqual({
      source: { kind: 'cli', label: 'config.yaml' },
      layer: { assistant: 'not-registered' },
    });
  });

  it('loads a CLI YAML file through the strict parser', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-run-config-'));
    const fixture = join(dir, 'config.minimax.yaml');
    try {
      await writeFile(
        fixture,
        'tiers:\n  small: { provider: pi, model: minimax/MiniMax-M3 }\ndocs:\n  path: handbook\n'
      );
      await expect(loadWorkflowRunConfigFile(fixture)).resolves.toMatchObject({
        source: { kind: 'cli', label: 'config.minimax.yaml' },
        layer: {
          tiers: { small: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
          docsPath: 'handbook',
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
