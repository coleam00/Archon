import { describe, expect, it } from 'vitest';
import { syncEmbeddingFromLLM, type InstanceConfig } from '../instanceConfigSync';

describe('syncEmbeddingFromLLM', () => {
  it('should copy all settings from LLM config to embedding config', () => {
    const llmConfig: InstanceConfig = {
      name: 'My Ollama Server',
      url: 'https://ollama.example.com/v1',
      useAuth: true,
      authToken: 'secret-token-123',
    };

    const result = syncEmbeddingFromLLM(llmConfig);

    expect(result.name).toBe('My Ollama Server');
    expect(result.url).toBe('https://ollama.example.com/v1');
    expect(result.useAuth).toBe(true);
    expect(result.authToken).toBe('secret-token-123');
  });

  it('should use default name when LLM config name is empty', () => {
    const llmConfig: InstanceConfig = {
      name: '',
      url: 'https://ollama.example.com/v1',
      useAuth: false,
      authToken: '',
    };

    const result = syncEmbeddingFromLLM(llmConfig);

    expect(result.name).toBe('Default Ollama');
  });

  it('should use custom default name when provided', () => {
    const llmConfig: InstanceConfig = {
      name: '',
      url: 'https://ollama.example.com/v1',
      useAuth: false,
      authToken: '',
    };

    const result = syncEmbeddingFromLLM(llmConfig, 'Custom Default');

    expect(result.name).toBe('Custom Default');
  });

  it('should copy auth settings even when useAuth is false', () => {
    const llmConfig: InstanceConfig = {
      name: 'Server',
      url: 'http://localhost:11434',
      useAuth: false,
      authToken: 'some-token', // Token might exist but auth is disabled
    };

    const result = syncEmbeddingFromLLM(llmConfig);

    expect(result.useAuth).toBe(false);
    expect(result.authToken).toBe('some-token');
  });

  it('should handle empty auth token', () => {
    const llmConfig: InstanceConfig = {
      name: 'Server',
      url: 'http://localhost:11434',
      useAuth: true,
      authToken: '',
    };

    const result = syncEmbeddingFromLLM(llmConfig);

    expect(result.useAuth).toBe(true);
    expect(result.authToken).toBe('');
  });

  it('should not mutate the original config', () => {
    const llmConfig: InstanceConfig = {
      name: 'Original',
      url: 'https://example.com',
      useAuth: true,
      authToken: 'token',
    };

    const result = syncEmbeddingFromLLM(llmConfig);
    result.name = 'Modified';
    result.authToken = 'changed';

    expect(llmConfig.name).toBe('Original');
    expect(llmConfig.authToken).toBe('token');
  });
});
