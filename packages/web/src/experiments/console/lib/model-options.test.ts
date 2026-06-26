import { describe, test, expect } from 'bun:test';
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  COPILOT_MODEL_OPTIONS,
  curatedOptionsForAgent,
  effortOptionsForAgent,
  filterModelOptions,
  findPiModel,
  modelPickerShape,
  modelRefBackend,
  normalizeEffortForAgent,
  opencodeBackendOptions,
  piDisconnectedBackendHint,
  piModelHint,
  piModelOptions,
  usablePiBackends,
} from './model-options';
import type {
  AgentCredentialStatus,
  AgentCredentials,
  OpencodeCredentialProvider,
  PiModelInfo,
} from '../skills';

function cred(over: Partial<AgentCredentialStatus> & { vendor: string }): AgentCredentialStatus {
  return {
    displayName: over.vendor,
    kinds: ['api_key'],
    connected: null,
    subscriptionAvailable: false,
    installEnv: false,
    ...over,
  };
}

function piAgent(credentials: AgentCredentialStatus[]): AgentCredentials {
  return { id: 'pi', displayName: 'Pi', catalog: 'static', ready: true, credentials };
}

function model(over: Partial<PiModelInfo> & { ref: string; provider: string }): PiModelInfo {
  return {
    id: over.ref.split('/').slice(1).join('/'),
    name: over.ref,
    reasoning: false,
    cost: { input: 1, output: 2 },
    contextWindow: 200_000,
    ...over,
  };
}

describe('modelPickerShape', () => {
  test('maps each known agent to its shape', () => {
    expect(modelPickerShape('pi')).toBe('pi');
    expect(modelPickerShape('opencode')).toBe('opencode');
    expect(modelPickerShape('copilot')).toBe('select');
    expect(modelPickerShape('claude')).toBe('curated');
    expect(modelPickerShape('codex')).toBe('curated');
  });

  test('unknown agents (and the unset row sentinel) fall back to free text', () => {
    expect(modelPickerShape('')).toBe('free');
    expect(modelPickerShape('some-future-agent')).toBe('free');
  });
});

describe('curatedOptionsForAgent', () => {
  test('claude/codex/copilot get their curated lists; others get none', () => {
    expect(curatedOptionsForAgent('claude')).toBe(CLAUDE_MODEL_OPTIONS);
    expect(curatedOptionsForAgent('codex')).toBe(CODEX_MODEL_OPTIONS);
    expect(curatedOptionsForAgent('copilot')).toBe(COPILOT_MODEL_OPTIONS);
    expect(curatedOptionsForAgent('pi')).toEqual([]);
    expect(curatedOptionsForAgent('')).toEqual([]);
  });

  test("copilot's list includes 'auto' (the SDK default when nothing is configured)", () => {
    expect(COPILOT_MODEL_OPTIONS.some(o => o.value === 'auto')).toBe(true);
  });
});

describe('effortOptionsForAgent', () => {
  test('claude and codex expose their (distinct) vocabularies', () => {
    expect(effortOptionsForAgent('claude')).toEqual(['low', 'medium', 'high', 'max']);
    expect(effortOptionsForAgent('codex')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  test('agents where tier effort does not route get null (field hidden)', () => {
    expect(effortOptionsForAgent('pi')).toBeNull();
    expect(effortOptionsForAgent('opencode')).toBeNull();
    expect(effortOptionsForAgent('copilot')).toBeNull();
    expect(effortOptionsForAgent('')).toBeNull();
  });
});

describe('normalizeEffortForAgent', () => {
  test('keeps a value the new vocabulary accepts (codex→claude keeps high)', () => {
    expect(normalizeEffortForAgent('claude', 'high')).toBe('high');
  });

  test('clears values the new vocabulary rejects (claude max → codex)', () => {
    expect(normalizeEffortForAgent('codex', 'max')).toBe('');
    expect(normalizeEffortForAgent('claude', 'minimal')).toBe('');
  });

  test('clears any value for agents without an effort concept', () => {
    expect(normalizeEffortForAgent('pi', 'high')).toBe('');
    expect(normalizeEffortForAgent('', 'high')).toBe('');
  });
});

describe('usablePiBackends', () => {
  test('null when the matrix is unavailable or carries no pi rows', () => {
    expect(usablePiBackends(undefined)).toBeNull();
    expect(usablePiBackends([])).toBeNull();
    expect(usablePiBackends([piAgent([])])).toBeNull();
  });

  test('collects vendors with a usable credential (connected / env / ambient)', () => {
    const backends = usablePiBackends([
      piAgent([
        cred({ vendor: 'anthropic', connected: 'api_key' }),
        cred({ vendor: 'openrouter', installEnv: true }),
        cred({ vendor: 'amazon-bedrock', kinds: ['ambient'], ambientConfigured: true }),
        cred({ vendor: 'groq' }),
      ]),
    ]);
    expect(backends).not.toBeNull();
    expect([...(backends ?? [])].sort()).toEqual(['amazon-bedrock', 'anthropic', 'openrouter']);
  });

  test('pi present but nothing usable → empty set (filter to nothing, not null)', () => {
    const backends = usablePiBackends([piAgent([cred({ vendor: 'groq' })])]);
    expect(backends?.size).toBe(0);
  });
});

describe('piModelOptions', () => {
  const catalog = [
    model({ ref: 'anthropic/claude-haiku-4-5', provider: 'anthropic' }),
    model({ ref: 'anthropic/claude-opus-4-5', provider: 'anthropic', reasoning: true }),
    model({ ref: 'groq/llama-4', provider: 'groq' }),
    model({ ref: 'openrouter/qwen/qwen3-coder', provider: 'openrouter' }),
  ];
  const connected = new Set(['anthropic']);

  test('default-filters to usable backends and reports the hidden count', () => {
    const r = piModelOptions(catalog, '', connected, false, 30);
    expect(r.options.map(o => o.value)).toEqual([
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-5',
    ]);
    expect(r.matchTotal).toBe(2);
    expect(r.hiddenByFilter).toBe(2);
  });

  test('showAll lifts the backend filter', () => {
    const r = piModelOptions(catalog, '', connected, true, 30);
    expect(r.options).toHaveLength(4);
    expect(r.hiddenByFilter).toBe(0);
  });

  test('null backends (matrix unavailable) means no filtering', () => {
    const r = piModelOptions(catalog, '', null, false, 30);
    expect(r.options).toHaveLength(4);
  });

  test('query matches ref and name case-insensitively', () => {
    const r = piModelOptions(catalog, 'QWEN', connected, true, 30);
    expect(r.options.map(o => o.value)).toEqual(['openrouter/qwen/qwen3-coder']);
  });

  test('matches the display name alone when it differs from the ref', () => {
    const named = [
      model({ ref: 'anthropic/claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5' }),
      model({ ref: 'groq/llama-4', provider: 'groq', name: 'Llama 4' }),
    ];
    // '4.5' appears only in the display name — the ref spells it '4-5'.
    const r = piModelOptions(named, '4.5', null, false, 30);
    expect(r.options.map(o => o.value)).toEqual(['anthropic/claude-haiku-4-5']);
  });

  test('caps options at limit but reports the full match total', () => {
    const r = piModelOptions(catalog, '', connected, true, 2);
    expect(r.options).toHaveLength(2);
    expect(r.matchTotal).toBe(4);
  });

  test('backend filter and limit cap combine without double-counting', () => {
    const wide = [
      model({ ref: 'anthropic/a', provider: 'anthropic' }),
      model({ ref: 'anthropic/b', provider: 'anthropic' }),
      model({ ref: 'anthropic/c', provider: 'anthropic' }),
      model({ ref: 'groq/d', provider: 'groq' }),
      model({ ref: 'xai/e', provider: 'xai' }),
    ];
    const r = piModelOptions(wide, '', new Set(['anthropic']), false, 2);
    expect(r.options.map(o => o.value)).toEqual(['anthropic/a', 'anthropic/b']);
    expect(r.matchTotal).toBe(3); // every filtered match, not just the rendered cap
    expect(r.hiddenByFilter).toBe(2); // groq + xai, unaffected by the cap
  });

  test('undefined catalog → empty result', () => {
    const r = piModelOptions(undefined, '', null, false, 30);
    expect(r.options).toEqual([]);
    expect(r.matchTotal).toBe(0);
    expect(r.hiddenByFilter).toBe(0);
  });

  test('options carry the cost/context hint', () => {
    const r = piModelOptions(catalog, 'opus', connected, false, 30);
    expect(r.options[0]?.hint).toBe('$1/M in · $2/M out · reasoning · 200k ctx');
  });
});

describe('piModelHint', () => {
  test('formats cost, reasoning flag, and rounded context window', () => {
    const m = model({
      ref: 'x/y',
      provider: 'x',
      reasoning: true,
      cost: { input: 3, output: 15 },
      contextWindow: 1_048_576,
    });
    expect(piModelHint(m)).toBe('$3/M in · $15/M out · reasoning · 1049k ctx');
    expect(piModelHint(model({ ref: 'x/z', provider: 'x' }))).toBe('$1/M in · $2/M out · 200k ctx');
  });

  test('zero-cost (free-tier) models render $0 rather than dropping the hint', () => {
    expect(
      piModelHint(model({ ref: 'x/free', provider: 'x', cost: { input: 0, output: 0 } }))
    ).toBe('$0/M in · $0/M out · 200k ctx');
  });
});

describe('findPiModel', () => {
  const catalog = [model({ ref: 'groq/llama-4', provider: 'groq' })];

  test('exact ref match, input trimmed', () => {
    expect(findPiModel(catalog, '  groq/llama-4 ')?.ref).toBe('groq/llama-4');
  });

  test('no match / blank / undefined catalog → undefined', () => {
    expect(findPiModel(catalog, 'groq/llama')).toBeUndefined();
    expect(findPiModel(catalog, '')).toBeUndefined();
    expect(findPiModel(undefined, 'groq/llama-4')).toBeUndefined();
  });
});

describe('modelRefBackend', () => {
  test('extracts the backend prefix of backend/model refs', () => {
    expect(modelRefBackend('groq/llama-4')).toBe('groq');
    expect(modelRefBackend('openrouter/qwen/qwen3-coder')).toBe('openrouter');
  });

  test('no slash, leading slash, or empty → null', () => {
    expect(modelRefBackend('sonnet')).toBeNull();
    expect(modelRefBackend('/oops')).toBeNull();
    expect(modelRefBackend('')).toBeNull();
  });
});

describe('piDisconnectedBackendHint', () => {
  const agents = [
    piAgent([
      cred({ vendor: 'anthropic', connected: 'api_key' }),
      cred({ vendor: 'groq', displayName: 'Groq' }),
    ]),
  ];

  test('known backend without usable credential → non-blocking hint', () => {
    const hint = piDisconnectedBackendHint('groq/llama-4', agents);
    expect(hint).toContain('Groq');
    expect(hint).toContain('saves fine');
  });

  test('usable backend → no hint', () => {
    expect(piDisconnectedBackendHint('anthropic/claude-opus-4-5', agents)).toBeNull();
  });

  test('unknown backend (custom models.json provider) → no hint, we cannot know', () => {
    expect(piDisconnectedBackendHint('my-custom/model', agents)).toBeNull();
  });

  test('no prefix or no matrix → no hint', () => {
    expect(piDisconnectedBackendHint('sonnet', agents)).toBeNull();
    expect(piDisconnectedBackendHint('groq/llama-4', undefined)).toBeNull();
  });
});

describe('filterModelOptions', () => {
  const options = [{ value: 'sonnet' }, { value: 'opus' }, { value: 'haiku' }];

  test('case-insensitive substring over values; blank returns all', () => {
    expect(filterModelOptions(options, 'OP').map(o => o.value)).toEqual(['opus']);
    expect(filterModelOptions(options, '  ')).toHaveLength(3);
    expect(filterModelOptions(options, 'gpt')).toEqual([]);
  });
});

describe('opencodeBackendOptions', () => {
  const provider = (
    over: Partial<OpencodeCredentialProvider> & { id: string }
  ): OpencodeCredentialProvider => ({
    name: over.id,
    env: [],
    connected: false,
    modelCount: 0,
    authMethods: [],
    ...over,
  });

  test('connected backends sort first, then by model count, then id', () => {
    const opts = opencodeBackendOptions([
      provider({ id: 'zed', modelCount: 99 }),
      provider({ id: 'anthropic', connected: true, modelCount: 5 }),
      provider({ id: 'openai', connected: true, modelCount: 12 }),
      provider({ id: 'alpha', modelCount: 99 }),
    ]);
    expect(opts.map(o => o.value)).toEqual(['openai/', 'anthropic/', 'alpha/', 'zed/']);
  });

  test('options are prefix completions with model-count + connected hints', () => {
    const [opt] = opencodeBackendOptions([
      provider({ id: 'anthropic', name: 'Anthropic', connected: true, modelCount: 1 }),
    ]);
    expect(opt?.value).toBe('anthropic/');
    expect(opt?.prefix).toBe(true);
    expect(opt?.hint).toBe('Anthropic · 1 model · connected');
  });
});
