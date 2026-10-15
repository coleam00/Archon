import { describe, test, expect } from 'bun:test';
import {
  agentReadiness,
  connectionLabel,
  filterCredentials,
  modelCountByBackend,
  providerOptionHint,
  splitPiCredentials,
  unconsumedConnectionNote,
} from './agent-status';
import type { AgentCredentialStatus, AgentCredentials, PiModelInfo } from '../skills';

/** Server-shaped row: a connection is consumed and the row usable unless the override says otherwise. */
function cred(over: Partial<AgentCredentialStatus> & { vendor: string }): AgentCredentialStatus {
  const connectionConsumed = over.connectionConsumed ?? (over.connected ?? null) !== null;
  return {
    displayName: over.vendor,
    kinds: ['api_key'],
    connected: null,
    connectionConsumed,
    subscriptionAvailable: false,
    installEnv: false,
    usable: connectionConsumed || over.installEnv === true || over.ambientConfigured === true,
    ...over,
  };
}

function agent(over: Partial<AgentCredentials> & { id: string }): AgentCredentials {
  return {
    displayName: over.id,
    catalog: 'static',
    ready: false,
    credentials: [],
    ...over,
  };
}

describe('agentReadiness', () => {
  test('dynamic catalog → dynamic state regardless of credentials', () => {
    // Realistic fixture: even if a future server populated credentials on a
    // dynamic agent, the catalog kind must win.
    const r = agentReadiness(
      agent({
        id: 'opencode',
        catalog: 'dynamic',
        ready: true,
        credentials: [cred({ vendor: 'opencode', connected: 'api_key' })],
      })
    );
    expect(r.state).toBe('dynamic');
  });

  test('server ready:false → needs-credential', () => {
    const r = agentReadiness(agent({ id: 'codex', credentials: [cred({ vendor: 'openai' })] }));
    expect(r).toEqual({ state: 'needs-credential', detail: 'needs credential' });
  });

  test('single-credential agent names the credential kind', () => {
    expect(
      agentReadiness(
        agent({
          id: 'claude',
          ready: true,
          credentials: [
            cred({ vendor: 'anthropic', displayName: 'Anthropic', connected: 'api_key' }),
          ],
        })
      ).detail
    ).toBe('Anthropic key connected');
    expect(
      agentReadiness(
        agent({
          id: 'copilot',
          ready: true,
          credentials: [
            cred({
              vendor: 'github-copilot',
              kinds: ['api_key', 'subscription'],
              connected: 'oauth',
            }),
          ],
        })
      ).detail
    ).toBe('subscription connected');
    expect(
      agentReadiness(
        agent({
          id: 'claude',
          ready: true,
          credentials: [cred({ vendor: 'anthropic', installEnv: true })],
        })
      ).detail
    ).toBe('using install env');
  });

  test('a stored connection the agent does not consume is never named as its reason', () => {
    const claudeSubscriptionOnPi = cred({
      vendor: 'anthropic',
      connected: 'oauth',
      connectionConsumed: false,
      installEnv: true,
    });
    expect(
      agentReadiness(agent({ id: 'pi', ready: true, credentials: [claudeSubscriptionOnPi] })).detail
    ).toBe('using install env');
  });

  test('single-credential agent ready via ambient detection names the chain', () => {
    expect(
      agentReadiness(
        agent({
          id: 'pi-bedrock-only',
          ready: true,
          credentials: [
            cred({ vendor: 'amazon-bedrock', kinds: ['ambient'], ambientConfigured: true }),
          ],
        })
      ).detail
    ).toBe('ambient credentials detected');
  });

  test('multi-credential agent counts usable backends (connected + env + ambient)', () => {
    const pi = agent({
      id: 'pi',
      ready: true,
      credentials: [
        cred({ vendor: 'anthropic', connected: 'api_key' }),
        cred({ vendor: 'openrouter', installEnv: true }),
        cred({ vendor: 'groq' }),
        cred({ vendor: 'amazon-bedrock', kinds: ['ambient'], ambientConfigured: true }),
      ],
    });
    expect(agentReadiness(pi)).toEqual({ state: 'ready', detail: '3 backends connected' });
  });

  test('multi-credential agent with one usable backend uses singular', () => {
    const pi = agent({
      id: 'pi',
      ready: true,
      credentials: [cred({ vendor: 'anthropic', connected: 'api_key' }), cred({ vendor: 'groq' })],
    });
    expect(agentReadiness(pi).detail).toBe('1 backend connected');
  });
});

describe('providerOptionHint', () => {
  const agents = [
    agent({
      id: 'pi',
      ready: true,
      credentials: [
        cred({ vendor: 'anthropic', connected: 'api_key' }),
        cred({ vendor: 'openrouter', connected: 'api_key' }),
        cred({ vendor: 'groq' }),
      ],
    }),
    agent({ id: 'codex', credentials: [cred({ vendor: 'openai' })] }),
    agent({
      id: 'claude',
      ready: true,
      credentials: [cred({ vendor: 'anthropic', connected: 'api_key' })],
    }),
    agent({ id: 'opencode', catalog: 'dynamic' }),
  ];

  test('multi-backend ready agent gets a backend count suffix', () => {
    expect(providerOptionHint(agents, 'pi')).toBe(' — 2 backends connected');
  });

  test('agent without any usable credential gets "no credential"', () => {
    expect(providerOptionHint(agents, 'codex')).toBe(' — no credential');
  });

  test('single-credential ready agent gets no suffix (no extra signal needed)', () => {
    expect(providerOptionHint(agents, 'claude')).toBe('');
  });

  test('dynamic agents and unknown ids get no suffix', () => {
    expect(providerOptionHint(agents, 'opencode')).toBe('');
    expect(providerOptionHint(agents, 'nope')).toBe('');
  });

  test('undefined agents data (401/solo) → no suffix', () => {
    expect(providerOptionHint(undefined, 'pi')).toBe('');
  });
});

describe('splitPiCredentials', () => {
  test('ambient rows are status-only even when also key-connectable', () => {
    const pi = agent({
      id: 'pi',
      credentials: [
        cred({ vendor: 'anthropic', connected: 'api_key' }),
        cred({ vendor: 'openrouter', installEnv: true }),
        cred({ vendor: 'groq' }),
        cred({ vendor: 'google-vertex', kinds: ['api_key', 'ambient'] }),
        cred({ vendor: 'amazon-bedrock', kinds: ['ambient'] }),
      ],
    });
    const groups = splitPiCredentials(pi);
    expect(groups.active.map(c => c.vendor)).toEqual(['anthropic', 'openrouter']);
    expect(groups.addable.map(c => c.vendor)).toEqual(['groq']);
    expect(groups.ambient.map(c => c.vendor)).toEqual(['google-vertex', 'amazon-bedrock']);
  });

  test('subscription-only credential lands in no group until connected (intentional)', () => {
    // A backend with no api_key kind can't be key-connected via the picker;
    // it only surfaces once a subscription connect makes it active.
    const sub = cred({ vendor: 'sub-only', kinds: ['subscription'] });
    const before = splitPiCredentials(agent({ id: 'pi', credentials: [sub] }));
    expect(before.active).toEqual([]);
    expect(before.addable).toEqual([]);
    expect(before.ambient).toEqual([]);

    const after = splitPiCredentials(
      agent({ id: 'pi', credentials: [{ ...sub, connected: 'oauth' }] })
    );
    expect(after.active.map(c => c.vendor)).toEqual(['sub-only']);
  });
});

describe('filterCredentials', () => {
  const creds = [
    cred({ vendor: 'opencode', displayName: 'OpenCode Zen' }),
    cred({ vendor: 'openrouter', displayName: 'OpenRouter' }),
    cred({ vendor: 'groq', displayName: 'Groq' }),
  ];

  test('matches display name and vendor id case-insensitively', () => {
    expect(filterCredentials(creds, 'ZEN').map(c => c.vendor)).toEqual(['opencode']);
    expect(filterCredentials(creds, 'open').map(c => c.vendor)).toEqual(['opencode', 'openrouter']);
  });

  test('blank query returns everything', () => {
    expect(filterCredentials(creds, '  ')).toHaveLength(3);
  });
});

describe('modelCountByBackend', () => {
  test('counts pi catalog models per backend; undefined catalog → empty map', () => {
    const model = (provider: string, id: string): PiModelInfo => ({
      ref: `${provider}/${id}`,
      provider,
      id,
      name: id,
      reasoning: false,
      cost: { input: 1, output: 2 },
      contextWindow: 100000,
    });
    const counts = modelCountByBackend([model('groq', 'a'), model('groq', 'b'), model('xai', 'c')]);
    expect(counts.get('groq')).toBe(2);
    expect(counts.get('xai')).toBe(1);
    expect(modelCountByBackend(undefined).size).toBe(0);
  });
});

describe('connectionLabel', () => {
  test('returns the stored label for a vendor, null otherwise', () => {
    const connections = [
      { provider: 'anthropic', kind: 'api_key' as const, label: 'work' },
      { provider: 'groq', kind: 'api_key' as const, label: null },
    ];
    expect(connectionLabel(connections, 'anthropic')).toBe('work');
    expect(connectionLabel(connections, 'groq')).toBeNull();
    expect(connectionLabel(connections, 'openai')).toBeNull();
  });
});

describe('unconsumedConnectionNote', () => {
  test('a stored connection the agent does not consume points at the env channel', () => {
    const note = unconsumedConnectionNote(
      cred({
        vendor: 'anthropic',
        displayName: 'Anthropic',
        kinds: ['api_key'],
        connected: 'oauth',
        connectionConsumed: false,
      })
    );
    expect(note).toBe(
      'subscription used by another agent · to use Anthropic here, set its API key in the install or codebase env'
    );
  });

  test('a consumed or absent connection has no note', () => {
    expect(unconsumedConnectionNote(cred({ vendor: 'anthropic', connected: 'oauth' }))).toBeNull();
    expect(unconsumedConnectionNote(cred({ vendor: 'anthropic' }))).toBeNull();
  });
});
