import { describe, it, expect } from 'bun:test';
import {
  isClaudeModel,
  isPiModel,
  isModelCompatible,
  inferProviderFromModel,
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

  describe('isPiModel', () => {
    it('recognises pi: prefixed strings', () => {
      expect(isPiModel('pi:google/gemini-2.5-pro')).toBe(true);
      expect(isPiModel('pi:openai/gpt-4o')).toBe(true);
    });

    it('rejects non-pi strings', () => {
      expect(isPiModel('sonnet')).toBe(false);
      expect(isPiModel('gpt-4o')).toBe(false);
      expect(isPiModel('')).toBe(false);
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

    it('should accept pi: models with pi provider', () => {
      expect(isModelCompatible('pi', 'pi:google/gemini-2.5-pro')).toBe(true);
      expect(isModelCompatible('pi', 'pi:openai/gpt-4o')).toBe(true);
    });

    it('should reject non-pi models with pi provider', () => {
      expect(isModelCompatible('pi', 'sonnet')).toBe(false);
      expect(isModelCompatible('pi', 'gpt-4o')).toBe(false);
    });

    it('should reject pi: models with codex provider', () => {
      expect(isModelCompatible('codex', 'pi:google/gemini-2.5-pro')).toBe(false);
    });

    it('should reject pi: models with claude provider', () => {
      expect(isModelCompatible('claude', 'pi:google/gemini-2.5-pro')).toBe(false);
    });

    it('should handle empty string model', () => {
      // Empty string is falsy, so treated as "no model specified"
      expect(isModelCompatible('claude', '')).toBe(true);
      expect(isModelCompatible('codex', '')).toBe(true);
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

    it('should infer pi from pi: model strings', () => {
      expect(inferProviderFromModel('pi:google/gemini-2.5-pro', 'claude')).toBe('pi');
      expect(inferProviderFromModel('pi:openai/gpt-4o', 'codex')).toBe('pi');
    });
  });
});
