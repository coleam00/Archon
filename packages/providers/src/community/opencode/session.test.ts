import { describe, expect, test } from 'bun:test';

import { createSessionPromptBody } from './session';

const model = { providerID: 'anthropic', modelID: 'claude-sonnet' };

describe('createSessionPromptBody', () => {
  test('sends appended chat instructions as the system prompt', () => {
    const body = createSessionPromptBody('hi', model, { appendSystemPrompt: 'append' });
    expect(body.system).toBe('append');
  });

  test('prefers an explicit system prompt over appended instructions', () => {
    const body = createSessionPromptBody('hi', model, {
      systemPrompt: 'system',
      appendSystemPrompt: 'append',
    });
    expect(body.system).toBe('system');
  });
});
