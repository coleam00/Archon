import { describe, expect, test } from 'bun:test';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';

describe('Pi embedded model catalog', () => {
  test('resolves openai-codex/gpt-5.5 through ModelRegistry', () => {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);

    const model = modelRegistry.find('openai-codex', 'gpt-5.5');

    expect(model).toBeDefined();
    expect(model?.provider).toBe('openai-codex');
    expect(model?.id).toBe('gpt-5.5');
  });
});
