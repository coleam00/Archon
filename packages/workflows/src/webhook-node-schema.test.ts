import { describe, test, expect } from 'bun:test';
import { dagNodeSchema, isWebhookNode, isPersistableNode } from './schemas';

const baseNode = {
  id: 'wh-1',
};

describe('WebhookNode schema', () => {
  test('valid webhook node with no config parses successfully', () => {
    const result = dagNodeSchema.safeParse({ ...baseNode, webhook: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isWebhookNode(result.data)).toBe(true);
    }
  });

  test('valid webhook node with message and timeout parses successfully', () => {
    const result = dagNodeSchema.safeParse({
      ...baseNode,
      webhook: { message: 'Waiting for Zapier trigger', timeout: 60000 },
    });
    expect(result.success).toBe(true);
    if (result.success && isWebhookNode(result.data)) {
      expect(result.data.webhook.message).toBe('Waiting for Zapier trigger');
      expect(result.data.webhook.timeout).toBe(60000);
    }
  });

  test('webhook node with negative timeout fails validation', () => {
    const result = dagNodeSchema.safeParse({
      ...baseNode,
      webhook: { timeout: -1 },
    });
    expect(result.success).toBe(false);
  });

  test('node with both webhook and prompt fails mutual-exclusivity check', () => {
    const result = dagNodeSchema.safeParse({
      ...baseNode,
      webhook: {},
      prompt: 'do something',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mutually exclusive');
    }
  });

  test('node with both webhook and bash fails mutual-exclusivity check', () => {
    const result = dagNodeSchema.safeParse({
      ...baseNode,
      webhook: {},
      bash: 'echo hi',
    });
    expect(result.success).toBe(false);
  });

  test('isWebhookNode returns false for non-webhook nodes', () => {
    const promptNode = dagNodeSchema.parse({ ...baseNode, prompt: 'hello' });
    expect(isWebhookNode(promptNode)).toBe(false);

    const bashNode = dagNodeSchema.parse({ ...baseNode, bash: 'echo hi' });
    expect(isWebhookNode(bashNode)).toBe(false);
  });

  test('isPersistableNode returns false for webhook nodes', () => {
    const result = dagNodeSchema.safeParse({ ...baseNode, webhook: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isPersistableNode(result.data)).toBe(false);
    }
  });

  test('webhook node preserves depends_on and other base fields', () => {
    const result = dagNodeSchema.safeParse({
      id: 'after-setup',
      depends_on: ['setup'],
      webhook: { message: 'Trigger me' },
    });
    expect(result.success).toBe(true);
    if (result.success && isWebhookNode(result.data)) {
      expect(result.data.id).toBe('after-setup');
      expect(result.data.depends_on).toEqual(['setup']);
    }
  });
});
