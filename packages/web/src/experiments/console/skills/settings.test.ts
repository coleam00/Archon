import { describe, test, expect } from 'bun:test';
import { buildAssistantUpdate, type AssistantConfigForm } from './settings';

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
