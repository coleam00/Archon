import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowRunConfigFile,
  parseWorkflowRunConfig,
  sealWorkflowRunConfig,
  unsealWorkflowRunConfig,
} from './run-config';

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
        workflows: { quotaMaxAttempts: 3 },
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
        workflows: { quotaMaxAttempts: 3 },
        docsPath: 'handbook',
        envVars: { BENCH_TOKEN: 'top-secret' },
      },
    });
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
      'paths',
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
    ).toThrow("Invalid run config at 'assistant': unknown provider 'not-registered'");
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
    ).toThrow("Invalid run config at 'tiers.medium.thinking'");
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
      ).toThrow(`Run config key 'assistants.pi.${key}' cannot apply`);
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

  it('rejects Claude-shaped thinking presets for providers that ignore that shape', () => {
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
      ).toThrow("Invalid run config at 'tiers.large.thinking'");
    }
  });

  it('persists the provider-normalized value consumed by execution', () => {
    const parsed = parseWorkflowRunConfig(
      { assistants: { copilot: { modelReasoningEffort: 'max' } } },
      { kind: 'http', label: 'inline' }
    );

    expect(parsed.layer.assistants?.copilot).toEqual({ modelReasoningEffort: 'xhigh' });
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
