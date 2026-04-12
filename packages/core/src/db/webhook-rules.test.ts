import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WebhookRule, WebhookRuleWithCodebaseName } from '../webhooks/types';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  createWebhookRule,
  listWebhookRules,
  findWebhookRuleBySlug,
  updateWebhookRule,
  isWebhookRuleConflictError,
  WebhookRuleConflictError,
} from './webhook-rules';

describe('webhook-rules', () => {
  const baseRule: WebhookRule = {
    id: 'rule-1',
    codebase_id: 'codebase-1',
    path_slug: 'kokot-pr-review',
    workflow_name: 'archon-smart-pr-review',
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  test('createWebhookRule inserts and returns the created rule', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([baseRule]));

    const result = await createWebhookRule({
      codebase_id: 'codebase-1',
      path_slug: 'kokot-pr-review',
      workflow_name: 'archon-smart-pr-review',
      enabled: true,
    });

    expect(result).toEqual(baseRule);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO remote_agent_webhook_rules'),
      ['codebase-1', 'kokot-pr-review', 'archon-smart-pr-review', true]
    );
  });

  test('listWebhookRules returns joined rules with normalized enabled flag', async () => {
    const row: WebhookRuleWithCodebaseName = {
      ...baseRule,
      enabled: 1 as unknown as boolean,
      codebase_name: 'SmelhausJosef/KoKot',
    };
    mockQuery.mockResolvedValueOnce(createQueryResult([row]));

    const result = await listWebhookRules();

    expect(result).toHaveLength(1);
    expect(result[0]?.enabled).toBe(true);
    expect(result[0]?.codebase_name).toBe('SmelhausJosef/KoKot');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM remote_agent_webhook_rules r')
    );
  });

  test('findWebhookRuleBySlug filters by slug and enabled', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([baseRule]));

    const result = await findWebhookRuleBySlug('kokot-pr-review');

    expect(result).toEqual(baseRule);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('AND enabled = $2'), [
      'kokot-pr-review',
      true,
    ]);
  });

  test('updateWebhookRule updates requested fields and reloads the record', async () => {
    const updatedRule: WebhookRule = {
      ...baseRule,
      path_slug: 'kokot-triage',
      workflow_name: 'triage',
      enabled: false,
    };

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    mockQuery.mockResolvedValueOnce(createQueryResult([updatedRule]));

    const result = await updateWebhookRule('rule-1', {
      path_slug: 'kokot-triage',
      workflow_name: 'triage',
      enabled: false,
    });

    expect(result).toEqual(updatedRule);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      'UPDATE remote_agent_webhook_rules\n          SET path_slug = $1, workflow_name = $2, enabled = $3, updated_at = NOW()\n        WHERE id = $4',
      ['kokot-triage', 'triage', false, 'rule-1']
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT * FROM remote_agent_webhook_rules WHERE id = $1',
      ['rule-1']
    );
  });

  test('createWebhookRule maps unique violations to WebhookRuleConflictError', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505', message: 'duplicate key value' });

    await expect(
      createWebhookRule({
        codebase_id: 'codebase-1',
        path_slug: 'kokot-pr-review',
        workflow_name: 'archon-smart-pr-review',
      })
    ).rejects.toBeInstanceOf(WebhookRuleConflictError);
  });

  test('isWebhookRuleConflictError detects sqlite unique failures', () => {
    expect(
      isWebhookRuleConflictError({
        message: 'UNIQUE constraint failed: remote_agent_webhook_rules.path_slug',
      })
    ).toBe(true);
  });
});
