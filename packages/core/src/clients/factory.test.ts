import { describe, test, expect } from 'bun:test';
import { getAssistantClient } from './factory';

describe('factory', () => {
  describe('getAssistantClient', () => {
    test('returns ClaudeClient for claude type', () => {
      const client = getAssistantClient('claude');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('claude');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('returns CodexClient for codex type', () => {
      const client = getAssistantClient('codex');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('codex');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('returns QwenClient for qwen type', () => {
      const client = getAssistantClient('qwen');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('qwen');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('throws error for unknown type', () => {
      expect(() => getAssistantClient('unknown')).toThrow(
        "Unknown assistant type: unknown. Supported types: 'claude', 'codex', 'qwen'"
      );
    });

    test('throws error for empty string', () => {
      expect(() => getAssistantClient('')).toThrow(
        "Unknown assistant type: . Supported types: 'claude', 'codex', 'qwen'"
      );
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAssistantClient('Claude')).toThrow(
        "Unknown assistant type: Claude. Supported types: 'claude', 'codex', 'qwen'"
      );
    });

    test('each call returns new instance', () => {
      const client1 = getAssistantClient('claude');
      const client2 = getAssistantClient('claude');

      // Each call should return a new instance
      expect(client1).not.toBe(client2);
    });
  });
});
