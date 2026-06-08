import { describe, test, expect } from 'bun:test';
import {
  buildAssistantUpdate,
  buildTiersUpdate,
  type AssistantConfigForm,
  type TiersForm,
  type TierRowForm,
} from './settings';

function form(over: Partial<AssistantConfigForm> = {}): AssistantConfigForm {
  return {
    assistant: 'claude',
    models: {},
    modelReasoningEffort: '',
    webSearchMode: '',
    ...over,
  };
}

describe('buildAssistantUpdate', () => {
  test('passes the default assistant through', () => {
    expect(buildAssistantUpdate(form({ assistant: 'codex' })).assistant).toBe('codex');
  });

  test('omits a provider whose model is blank (never writes {model: ""})', () => {
    const body = buildAssistantUpdate(form({ models: { claude: '', pi: '   ' } }));
    expect(body.assistants).toBeUndefined();
  });

  test('trims the model before writing it', () => {
    const body = buildAssistantUpdate(form({ models: { claude: '  sonnet  ' } }));
    expect(body.assistants).toEqual({ claude: { model: 'sonnet' } });
  });

  test('a provider with only a model writes just { model }', () => {
    const body = buildAssistantUpdate(form({ models: { pi: 'anthropic/claude-haiku-4-5' } }));
    expect(body.assistants).toEqual({ pi: { model: 'anthropic/claude-haiku-4-5' } });
  });

  test('codex attaches reasoning effort + web search alongside its model', () => {
    const body = buildAssistantUpdate(
      form({
        assistant: 'codex',
        models: { codex: 'gpt-5.3-codex' },
        modelReasoningEffort: 'high',
        webSearchMode: 'live',
      })
    );
    expect(body.assistants).toEqual({
      codex: { model: 'gpt-5.3-codex', modelReasoningEffort: 'high', webSearchMode: 'live' },
    });
  });

  test('codex enums attach even when its model is blank (effort-only edit)', () => {
    const body = buildAssistantUpdate(
      form({ models: { codex: '' }, modelReasoningEffort: 'medium' })
    );
    expect(body.assistants).toEqual({ codex: { modelReasoningEffort: 'medium' } });
  });

  test('reasoning/web-search are NOT attached to non-codex providers', () => {
    const body = buildAssistantUpdate(
      form({ models: { claude: 'opus' }, modelReasoningEffort: 'high', webSearchMode: 'live' })
    );
    expect(body.assistants).toEqual({ claude: { model: 'opus' } });
  });

  test('everything blank → just the assistant, no assistants key', () => {
    const body = buildAssistantUpdate(form({ models: { claude: '', codex: '' } }));
    expect(body).toEqual({ assistant: 'claude' });
  });
});

const BLANK: TierRowForm = { provider: '', model: '', effort: '' };
function tierForm(
  over: Partial<Record<'small' | 'medium' | 'large', Partial<TierRowForm>>>
): TiersForm {
  return {
    small: { ...BLANK, ...over.small },
    medium: { ...BLANK, ...over.medium },
    large: { ...BLANK, ...over.large },
  };
}

describe('buildTiersUpdate', () => {
  test('a fully-set row → entry with provider/model/effort', () => {
    const body = buildTiersUpdate(
      tierForm({ large: { provider: 'claude', model: 'opus', effort: 'high' } })
    );
    expect(body.tiers.large).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });

  test('omits effort when blank', () => {
    const body = buildTiersUpdate(tierForm({ large: { provider: 'claude', model: 'opus' } }));
    expect(body.tiers.large).toEqual({ provider: 'claude', model: 'opus' });
  });

  test('blank provider → null (unset)', () => {
    const body = buildTiersUpdate(tierForm({ large: { provider: '', model: 'opus' } }));
    expect(body.tiers.large).toBeNull();
  });

  test('blank model → null (unset) — the OR-blank branch is not inverted', () => {
    const body = buildTiersUpdate(tierForm({ large: { provider: 'claude', model: '' } }));
    expect(body.tiers.large).toBeNull();
  });

  test('always sends all three tiers (set + null)', () => {
    const body = buildTiersUpdate(tierForm({ small: { provider: 'claude', model: 'haiku' } }));
    expect(body.tiers.small).toEqual({ provider: 'claude', model: 'haiku' });
    expect(body.tiers.medium).toBeNull();
    expect(body.tiers.large).toBeNull();
  });

  test('trims whitespace on every field', () => {
    const body = buildTiersUpdate(
      tierForm({ large: { provider: '  claude ', model: ' opus ', effort: ' high ' } })
    );
    expect(body.tiers.large).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });
});
