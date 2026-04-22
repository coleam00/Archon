import { describe, it, expect, beforeAll } from 'bun:test';
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
import { isModelCompatible, inferProviderFromModel } from './model-validation';

// Bootstrap registry once for all tests (idempotent)
beforeAll(() => {
  clearRegistry();
  registerBuiltinProviders();
});

describe('model-validation (registry-driven)', () => {
  describe('isModelCompatible', () => {
    it('should accept any model when model is undefined', () => {
      expect(isModelCompatible('claude')).toBe(true);
      expect(isModelCompatible('codex')).toBe(true);
    });

    it('should accept Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'sonnet')).toBe(true);
      expect(isModelCompatible('claude', 'opus')).toBe(true);
      expect(isModelCompatible('claude', 'haiku')).toBe(true);
      expect(isModelCompatible('claude', 'inherit')).toBe(true);
      expect(isModelCompatible('claude', 'claude-opus-4-6')).toBe(true);
    });

    it('should reject non-Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'gpt-5.3-codex')).toBe(false);
      expect(isModelCompatible('claude', 'gpt-4')).toBe(false);
    });

    it('should accept Codex/OpenAI models with codex provider', () => {
      expect(isModelCompatible('codex', 'gpt-5.3-codex')).toBe(true);
      expect(isModelCompatible('codex', 'gpt-5.2-codex')).toBe(true);
      expect(isModelCompatible('codex', 'gpt-4')).toBe(true);
      expect(isModelCompatible('codex', 'o1-mini')).toBe(true);
    });

    it('should reject Claude models with codex provider', () => {
      expect(isModelCompatible('codex', 'sonnet')).toBe(false);
      expect(isModelCompatible('codex', 'opus')).toBe(false);
      expect(isModelCompatible('codex', 'claude-opus-4-6')).toBe(false);
    });

    it('should handle empty string model', () => {
      // Empty string is falsy, so treated as "no model specified"
      expect(isModelCompatible('claude', '')).toBe(true);
      expect(isModelCompatible('codex', '')).toBe(true);
    });

    it('should throw on unknown providers (fail-fast)', () => {
      expect(() => isModelCompatible('my-llm', 'any-model')).toThrow(/Unknown provider 'my-llm'/);
    });
  });

  describe('inferProviderFromModel', () => {
    it('should return default when model is undefined', () => {
      expect(inferProviderFromModel(undefined, 'claude')).toBe('claude');
      expect(inferProviderFromModel(undefined, 'codex')).toBe('codex');
    });

    it('should return default when model is empty string', () => {
      expect(inferProviderFromModel('', 'claude')).toBe('claude');
      expect(inferProviderFromModel('', 'codex')).toBe('codex');
    });

    it('should infer claude from Claude model names', () => {
      expect(inferProviderFromModel('sonnet', 'codex')).toBe('claude');
      expect(inferProviderFromModel('opus', 'codex')).toBe('claude');
      expect(inferProviderFromModel('haiku', 'codex')).toBe('claude');
      expect(inferProviderFromModel('inherit', 'codex')).toBe('claude');
      expect(inferProviderFromModel('claude-opus-4-6', 'codex')).toBe('claude');
    });

    it('should infer codex from non-Claude model names', () => {
      expect(inferProviderFromModel('gpt-5.3-codex', 'claude')).toBe('codex');
      expect(inferProviderFromModel('gpt-4', 'claude')).toBe('codex');
      expect(inferProviderFromModel('o1-mini', 'claude')).toBe('codex');
    });
  });
});
