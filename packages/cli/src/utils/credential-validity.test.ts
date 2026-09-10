import { describe, it, expect } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { parseWorkflow } from '@archon/workflows/loader';
import { BUNDLED_WORKFLOWS } from '@archon/workflows/defaults';

import type { WorkflowConfig } from '@archon/workflows/deps';
import { buildAiProfile } from '@archon/workflows/model-validation';
import type { StoredCredentialInspection } from '@archon/core';
import type { WorkflowShape } from './credential-validity';
import {
  assertWorkflowCredentialsValid,
  collectWorkflowRequiredCredentials,
  inspectPiAuthJson,
  parseExpires,
  probePiCredential,
} from './credential-validity';

// The loader validates `provider:` against the registry, exactly as a real invocation
// does after the CLI entrypoint bootstraps it.
registerBuiltinProviders();
registerCommunityProviders();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 10);
const LONG_AGO = Date.UTC(2026, 5, 8);

function config(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    assistant: 'claude',
    commands: {},
    assistants: { claude: {}, codex: {} },
    ...overrides,
  };
}

/** Parse real YAML through the real loader so nodes carry their real parsed shape. */
function workflowFrom(lines: string[]): WorkflowShape & { name: string } {
  const yaml = ['name: wf', 'description: a fixture', ...lines].join('\n');
  const parsed = parseWorkflow(yaml, 'test.yaml');
  if (!parsed.workflow) throw new Error(`fixture failed to parse: ${parsed.error?.error}`);
  return parsed.workflow;
}

const expiredAuthJson = JSON.stringify({
  openrouter: { type: 'oauth', access: 'sk-secret-openrouter', expires: LONG_AGO },
});
const validAuthJson = JSON.stringify({
  openrouter: { type: 'oauth', access: 'sk-secret-openrouter', expires: NOW + DAY },
});
const readAuthJson = (content: string | null) => (): string | null => content;
const noConnectedCredential = async (): Promise<StoredCredentialInspection> => ({
  status: 'missing',
});

describe('collectWorkflowRequiredCredentials — every node that opens a provider session', () => {
  it('sees a command-sourced agent node, not just an inline prompt', () => {
    const commandNode = workflowFrom([
      'provider: pi',
      'model: openrouter/some-model',
      'nodes:',
      '  - id: a',
      '    command: some-command',
    ]);
    expect(collectWorkflowRequiredCredentials(commandNode, { config: config() })).toEqual([
      { runner: 'pi', vendor: 'openrouter' },
    ]);
  });

  it('sees a gate whose decision carries a rework reprompt', () => {
    const gate = workflowFrom([
      'provider: pi',
      'model: openrouter/some-model',
      'nodes:',
      '  - id: a',
      '    bash: echo hi',
      '  - id: g',
      '    approval:',
      '      message: Approve?',
      '      on_reject:',
      '        prompt: Try again',
      '    depends_on: [a]',
    ]);
    expect(collectWorkflowRequiredCredentials(gate, { config: config() })).toEqual([
      { runner: 'pi', vendor: 'openrouter' },
    ]);
  });

  it('needs no credential for a workflow whose nodes never call a provider', () => {
    const deterministic = workflowFrom([
      'provider: pi',
      'nodes:',
      '  - id: a',
      '    bash: echo hi',
    ]);
    expect(collectWorkflowRequiredCredentials(deterministic, { config: config() })).toEqual([]);
  });

  it('resolves a tier through the AI profile instead of gating on the wrong vendor', () => {
    const tiered = workflowFrom(['nodes:', '  - id: a', '    prompt: do it', '    model: small']);
    const tiers = { small: { provider: 'pi', model: 'openrouter/cheap' } };
    const aiProfile = buildAiProfile('claude', { repoTiers: tiers });

    // Without the profile the tier keyword is not a model ref, so the node falls back to
    // the workflow's own provider — a different vendor's credential entirely.
    expect(collectWorkflowRequiredCredentials(tiered, { config: config() })).toEqual([
      { runner: 'claude', vendor: 'anthropic' },
    ]);
    expect(
      collectWorkflowRequiredCredentials(tiered, { config: config({ tiers }), aiProfile })
    ).toEqual([{ runner: 'pi', vendor: 'openrouter' }]);
  });

  it('maps a runner to its vendor-canonical credential id', () => {
    const claudeNode = workflowFrom([
      'nodes:',
      '  - id: a',
      '    prompt: do it',
      '    provider: codex',
    ]);
    expect(collectWorkflowRequiredCredentials(claudeNode, { config: config() })).toEqual([
      { runner: 'codex', vendor: 'openai' },
    ]);
  });

  it('covers every bundled workflow that runs an AI node', () => {
    const uncovered: string[] = [];
    let checked = 0;
    for (const [name, yaml] of Object.entries(BUNDLED_WORKFLOWS)) {
      const parsed = parseWorkflow(yaml, `${name}.yaml`);
      // Pack workflows that need `include:` expansion are not this function's subject.
      if (!parsed.workflow) continue;
      const hasAgentNode = parsed.workflow.nodes.some(n => n.kind === 'agent' || n.kind === 'loop');
      if (!hasAgentNode) continue;
      checked += 1;
      if (collectWorkflowRequiredCredentials(parsed.workflow, { config: config() }).length === 0) {
        uncovered.push(name);
      }
    }
    expect(uncovered).toEqual([]);
    // Guards the loop against becoming a no-op if bundling or parsing changes shape.
    expect(checked).toBeGreaterThan(20);
  });
});

describe('assertWorkflowCredentialsValid — refuses whatever it cannot prove usable', () => {
  const piWorkflow = workflowFrom([
    'provider: pi',
    'model: openrouter/some-model',
    'nodes:',
    '  - id: a',
    '    command: some-command',
  ]);

  it('blocks a command-sourced node whose credential expired', async () => {
    await expect(
      assertWorkflowCredentialsValid(piWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson(expiredAuthJson),
        inspectConnected: noConnectedCredential,
      })
    ).rejects.toThrow(/openrouter credential expired 8 June 2026/);
  });

  it('blocks when no store Archon reads holds a credential for a Pi vendor', async () => {
    await expect(
      assertWorkflowCredentialsValid(piWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson(null),
        inspectConnected: noConnectedCredential,
      })
    ).rejects.toThrow(/no openrouter credential found/);
  });

  it('blocks when the connected-credential store cannot answer', async () => {
    await expect(
      assertWorkflowCredentialsValid(piWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson(null),
        inspectConnected: async () => ({
          status: 'undetermined',
          reason: 'TOKEN_ENCRYPTION_KEY is not set',
        }),
      })
    ).rejects.toThrow(
      /could not verify the openrouter credential.*TOKEN_ENCRYPTION_KEY is not set/s
    );
  });

  it('blocks when auth.json exists but cannot be parsed', async () => {
    await expect(
      assertWorkflowCredentialsValid(piWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson('{ truncated'),
        inspectConnected: noConnectedCredential,
      })
    ).rejects.toThrow(/could not verify the openrouter credential/);
  });

  it("does not refuse a non-Pi run over Pi's own unreadable store", async () => {
    // `auth.json` is Pi's. A Claude Code node never reads it, so a corrupt one there is
    // not a reason to refuse this run.
    const claudeWorkflow = workflowFrom(['nodes:', '  - id: a', '    command: some-command']);
    await assertWorkflowCredentialsValid(claudeWorkflow, {
      config: config(),
      env: {},
      now: NOW,
      authJsonPath: '/nope/auth.json',
      readAuthJson: readAuthJson('{ truncated'),
      inspectConnected: noConnectedCredential,
    });
  });

  it('passes a credential that is present and unexpired', async () => {
    await assertWorkflowCredentialsValid(piWorkflow, {
      config: config(),
      env: {},
      now: NOW,
      authJsonPath: '/nope/auth.json',
      readAuthJson: readAuthJson(validAuthJson),
      inspectConnected: noConnectedCredential,
    });
  });

  it('passes on the vendor env var the runner will actually read', async () => {
    await assertWorkflowCredentialsValid(piWorkflow, {
      config: config(),
      env: { OPENROUTER_API_KEY: 'sk-secret' },
      now: NOW,
      authJsonPath: '/nope/auth.json',
      readAuthJson: readAuthJson(expiredAuthJson),
      inspectConnected: noConnectedCredential,
    });
  });

  it('leaves a runner with its own credential store alone when Archon holds nothing', async () => {
    // Claude Code authenticates from its own store, which Archon deliberately does not
    // read (#3274). Silence there is the normal state, not a verdict.
    const claudeWorkflow = workflowFrom(['nodes:', '  - id: a', '    command: some-command']);
    await assertWorkflowCredentialsValid(claudeWorkflow, {
      config: config(),
      env: {},
      now: NOW,
      authJsonPath: '/nope/auth.json',
      readAuthJson: readAuthJson(null),
      inspectConnected: noConnectedCredential,
    });
  });

  it('blocks a runner with its own store when a connected credential HAS expired', async () => {
    const claudeWorkflow = workflowFrom(['nodes:', '  - id: a', '    command: some-command']);
    await expect(
      assertWorkflowCredentialsValid(claudeWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson(null),
        inspectConnected: async () => ({ status: 'expired', expires: LONG_AGO }),
      })
    ).rejects.toThrow(/anthropic connected credential expired 8 June 2026/);
  });

  it('does not gate a workflow with no AI node at all', async () => {
    const deterministic = workflowFrom([
      'provider: pi',
      'nodes:',
      '  - id: a',
      '    bash: echo hi',
    ]);
    await assertWorkflowCredentialsValid(deterministic, {
      config: config(),
      env: {},
      now: NOW,
      authJsonPath: '/nope/auth.json',
      readAuthJson: readAuthJson(null),
      inspectConnected: async () => {
        throw new Error('must not be consulted for a workflow with no AI node');
      },
    });
  });
});

describe('no credential value reaches a message', () => {
  const SECRET = 'sk-ant-oat01-DO-NOT-LEAK-ME';

  it('keeps secrets out of every failure path the gate can throw', async () => {
    const piWorkflow = workflowFrom([
      'provider: pi',
      'model: openrouter/some-model',
      'nodes:',
      '  - id: a',
      '    command: some-command',
    ]);
    const bodies = [
      JSON.stringify({ openrouter: { type: 'oauth', access: SECRET, expires: LONG_AGO } }),
      JSON.stringify({ openrouter: { type: 'oauth', access: '', refresh: SECRET } }),
      JSON.stringify({ openrouter: { type: 'api_key', key: '' }, other: SECRET }),
      `{ ${SECRET}`,
      SECRET,
      `[${JSON.stringify(SECRET)}]`,
    ];
    for (const body of bodies) {
      const message = await assertWorkflowCredentialsValid(piWorkflow, {
        config: config(),
        env: {},
        now: NOW,
        authJsonPath: '/nope/auth.json',
        readAuthJson: readAuthJson(body),
        inspectConnected: noConnectedCredential,
      }).then(
        () => '',
        (err: Error) => err.message
      );
      expect(message).not.toContain(SECRET);
      // A partial echo leaks just as much; the parsers truncate rather than omit.
      expect(message).not.toContain(SECRET.slice(0, 10));
    }
  });

  it('keeps secrets out of the inspection result', async () => {
    const result = await inspectPiAuthJson(
      '/nope/auth.json',
      NOW,
      readAuthJson(`{"anthropic":{"type":"oauth","access":"${SECRET}"`)
    );
    expect(JSON.stringify(result)).not.toContain(SECRET.slice(0, 10));
  });
});

describe('parseExpires', () => {
  it('reads epoch seconds, epoch milliseconds and ISO dates as the same instant', () => {
    expect(parseExpires(1_780_000_000)).toBe(1_780_000_000_000);
    expect(parseExpires(1_780_000_000_000)).toBe(1_780_000_000_000);
    expect(parseExpires('1780000000')).toBe(1_780_000_000_000);
    expect(parseExpires('2026-06-08T00:00:00.000Z')).toBe(LONG_AGO);
    expect(parseExpires(undefined)).toBeUndefined();
    expect(parseExpires('whenever')).toBeUndefined();
  });
});

describe('inspectPiAuthJson', () => {
  it('reports a malformed file without quoting it', async () => {
    const result = await inspectPiAuthJson('/nope/auth.json', NOW, readAuthJson('{oops'));
    expect(result).toEqual({ exists: true, error: 'not valid JSON', entries: [] });
  });

  it('reports a JSON array as the wrong shape', async () => {
    const result = await inspectPiAuthJson('/nope/auth.json', NOW, readAuthJson('[]'));
    expect(result.error).toBe('expected JSON object');
  });

  it('reports a missing file as absent rather than broken', async () => {
    expect(await inspectPiAuthJson('/nope/auth.json', NOW, readAuthJson(null))).toEqual({
      exists: false,
      entries: [],
    });
  });

  it('treats the exact expiry instant as expired', async () => {
    const at = JSON.stringify({ openrouter: { type: 'oauth', access: 'x', expires: NOW } });
    const result = await inspectPiAuthJson('/nope/auth.json', NOW, readAuthJson(at));
    expect(result.entries[0]?.status).toBe('expired');
  });

  it('flags an empty API key', async () => {
    const empty = JSON.stringify({ openrouter: { type: 'api_key', key: '  ' } });
    const result = await inspectPiAuthJson('/nope/auth.json', NOW, readAuthJson(empty));
    expect(result.entries[0]?.status).toBe('invalid');
  });
});

describe('probePiCredential', () => {
  it('reports a missing pi binary as unreachable, never as ready', async () => {
    // The real spawn: `pi` is absent in CI, which is exactly the ENOENT case. A probe
    // that cannot run must not answer "this credential works".
    const original = process.env.PATH;
    process.env.PATH = '/nonexistent-bin';
    try {
      expect(await probePiCredential('anthropic')).toBe('unreachable');
    } finally {
      process.env.PATH = original;
    }
  });
});
