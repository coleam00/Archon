import { describe, it, expect } from 'bun:test';
import {
  isClaudeModel,
  isQwenModel,
  inferProviderFromModel,
  isModelCompatible,
} from './model-validation';

describe('model-validation', () => {
  describe('isClaudeModel', () => {
    it('should recognize Claude aliases', () => {
      expect(isClaudeModel('sonnet')).toBe(true);
      expect(isClaudeModel('opus')).toBe(true);
      expect(isClaudeModel('haiku')).toBe(true);
      expect(isClaudeModel('inherit')).toBe(true);
    });

    it('should recognize claude- prefixed models', () => {
      expect(isClaudeModel('claude-sonnet-4-5-20250929')).toBe(true);
      expect(isClaudeModel('claude-opus-4-6')).toBe(true);
      expect(isClaudeModel('claude-3-5-sonnet-20241022')).toBe(true);
    });

    it('should reject non-Claude models', () => {
      expect(isClaudeModel('gpt-5.3-codex')).toBe(false);
      expect(isClaudeModel('gpt-5.2-codex')).toBe(false);
      expect(isClaudeModel('gpt-4')).toBe(false);
      expect(isClaudeModel('o1-mini')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isClaudeModel('')).toBe(false);
    });
  });

  describe('isQwenModel', () => {
    it('should recognize qwen- prefixed models', () => {
      expect(isQwenModel('qwen-coder')).toBe(true);
      expect(isQwenModel('qwen-max')).toBe(true);
      expect(isQwenModel('qwen-turbo')).toBe(true);
      expect(isQwenModel('qwen-plus')).toBe(true);
      expect(isQwenModel('qwen-long')).toBe(true);
    });

    it('should recognize qwq- and qvq- prefixed models', () => {
      expect(isQwenModel('qwq-plus')).toBe(true);
      expect(isQwenModel('qwq-max')).toBe(true);
      expect(isQwenModel('qvq-72b')).toBe(true);
    });

    it('should recognize Qwen model names with different casing', () => {
      expect(isQwenModel('Qwen-Max')).toBe(true);
      expect(isQwenModel('QWEN-CODER')).toBe(true);
      expect(isQwenModel('QwQ-Plus')).toBe(true);
    });

    it('should handle models with extra whitespace', () => {
      expect(isQwenModel('  qwen-max  ')).toBe(true);
      expect(isQwenModel('\tqwen-coder\n')).toBe(true);
    });

    it('should reject non-Qwen models', () => {
      expect(isQwenModel('claude-sonnet-4-5')).toBe(false);
      expect(isQwenModel('gpt-5.3-codex')).toBe(false);
      expect(isQwenModel('gpt-4')).toBe(false);
      expect(isQwenModel('llama-3')).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isQwenModel('')).toBe(false);
    });
  });

  describe('inferProviderFromModel', () => {
    it('should infer claude provider for Claude models', () => {
      expect(inferProviderFromModel('sonnet')).toBe('claude');
      expect(inferProviderFromModel('opus')).toBe('claude');
      expect(inferProviderFromModel('claude-3-5-sonnet')).toBe('claude');
    });

    it('should infer qwen provider for Qwen models', () => {
      expect(inferProviderFromModel('qwen-coder')).toBe('qwen');
      expect(inferProviderFromModel('qwen-max')).toBe('qwen');
      expect(inferProviderFromModel('qwen-turbo')).toBe('qwen');
      expect(inferProviderFromModel('qwen-plus')).toBe('qwen');
      expect(inferProviderFromModel('qwq-plus')).toBe('qwen');
      expect(inferProviderFromModel('qvq-72b')).toBe('qwen');
    });

    it('should return undefined for unrecognized models', () => {
      expect(inferProviderFromModel('gpt-4')).toBe(undefined);
      expect(inferProviderFromModel('llama-3')).toBe(undefined);
    });

    it('should return undefined for undefined model', () => {
      expect(inferProviderFromModel(undefined)).toBe(undefined);
    });
  });

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

    it('should accept Qwen models with qwen provider', () => {
      expect(isModelCompatible('qwen', 'qwen-coder')).toBe(true);
      expect(isModelCompatible('qwen', 'qwen-max')).toBe(true);
      expect(isModelCompatible('qwen', 'qwen-turbo')).toBe(true);
      expect(isModelCompatible('qwen', 'qwen-plus')).toBe(true);
      expect(isModelCompatible('qwen', 'qwq-plus')).toBe(true);
    });

    it('should reject non-Qwen models with qwen provider', () => {
      expect(isModelCompatible('qwen', 'claude-sonnet')).toBe(false);
      expect(isModelCompatible('qwen', 'gpt-4')).toBe(false);
    });

    it('should reject Qwen models with claude provider', () => {
      expect(isModelCompatible('claude', 'qwen-coder')).toBe(false);
      expect(isModelCompatible('claude', 'qwen-max')).toBe(false);
    });

    it('should reject Qwen models with codex provider', () => {
      expect(isModelCompatible('codex', 'qwen-coder')).toBe(false);
      expect(isModelCompatible('codex', 'qwen-max')).toBe(false);
    });

    it('should accept qwen provider with undefined model', () => {
      expect(isModelCompatible('qwen')).toBe(true);
    });
  });
});
