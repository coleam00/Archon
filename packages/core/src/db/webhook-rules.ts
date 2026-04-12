import { createLogger } from '@archon/paths';
import { getDialect, pool } from './connection';
import type { WebhookRule, WebhookRuleWithCodebaseName } from '../webhooks/types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.webhook-rules');
  return cachedLog;
}

export class WebhookRuleConflictError extends Error {
  constructor(message = 'Webhook rule already exists for this URL slug') {
    super(message);
    this.name = 'WebhookRuleConflictError';
  }
}

function normalizeRuleEnabled<T extends { enabled: unknown }>(rule: T): T & { enabled: boolean } {
  return { ...rule, enabled: Boolean(rule.enabled) };
}

function coerceConflictError(error: unknown): never {
  if (isWebhookRuleConflictError(error)) {
    throw new WebhookRuleConflictError();
  }
  throw error;
}

export function isWebhookRuleConflictError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | undefined;
  const message = err?.message ?? '';
  return (
    err?.code === '23505' ||
    message.includes('idx_webhook_rules_path_slug_unique') ||
    message.includes('duplicate key value violates unique constraint') ||
    message.includes('UNIQUE constraint failed: remote_agent_webhook_rules.path_slug')
  );
}

export async function createWebhookRule(input: {
  codebase_id: string;
  path_slug: string;
  workflow_name: string;
  enabled?: boolean;
}): Promise<WebhookRule> {
  try {
    const result = await pool.query<WebhookRule>(
      `INSERT INTO remote_agent_webhook_rules
         (codebase_id, path_slug, workflow_name, enabled)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.codebase_id, input.path_slug, input.workflow_name, input.enabled ?? true]
    );
    if (!result.rows[0]) {
      throw new Error('Failed to create webhook rule: INSERT returned no row');
    }
    return normalizeRuleEnabled(result.rows[0]);
  } catch (error) {
    coerceConflictError(error);
  }
}

export async function getWebhookRule(id: string): Promise<WebhookRule | null> {
  const result = await pool.query<WebhookRule>(
    'SELECT * FROM remote_agent_webhook_rules WHERE id = $1',
    [id]
  );
  return result.rows[0] ? normalizeRuleEnabled(result.rows[0]) : null;
}

export async function listWebhookRules(): Promise<readonly WebhookRuleWithCodebaseName[]> {
  const result = await pool.query<WebhookRuleWithCodebaseName>(
    `SELECT r.*, c.name AS codebase_name
       FROM remote_agent_webhook_rules r
       INNER JOIN remote_agent_codebases c ON c.id = r.codebase_id
      ORDER BY c.name ASC, r.path_slug ASC`
  );
  return result.rows.map(row => normalizeRuleEnabled(row));
}

export async function findWebhookRuleBySlug(pathSlug: string): Promise<WebhookRule | null> {
  const result = await pool.query<WebhookRule>(
    `SELECT * FROM remote_agent_webhook_rules
      WHERE path_slug = $1
        AND enabled = $2
      LIMIT 1`,
    [pathSlug, true]
  );
  return result.rows[0] ? normalizeRuleEnabled(result.rows[0]) : null;
}

export async function updateWebhookRule(
  id: string,
  updates: {
    codebase_id?: string;
    path_slug?: string;
    workflow_name?: string;
    enabled?: boolean;
  }
): Promise<WebhookRule> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const params: (string | boolean)[] = [];
  let paramIndex = 1;

  if (updates.codebase_id !== undefined) {
    setClauses.push(`codebase_id = $${paramIndex++}`);
    params.push(updates.codebase_id);
  }
  if (updates.path_slug !== undefined) {
    setClauses.push(`path_slug = $${paramIndex++}`);
    params.push(updates.path_slug);
  }
  if (updates.workflow_name !== undefined) {
    setClauses.push(`workflow_name = $${paramIndex++}`);
    params.push(updates.workflow_name);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = $${paramIndex++}`);
    params.push(updates.enabled);
  }

  if (setClauses.length === 0) {
    const existing = await getWebhookRule(id);
    if (!existing) {
      throw new Error(`Webhook rule ${id} not found`);
    }
    return existing;
  }

  setClauses.push(`updated_at = ${dialect.now()}`);
  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE remote_agent_webhook_rules
          SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex}`,
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Webhook rule ${id} not found`);
    }
  } catch (error) {
    coerceConflictError(error);
  }

  const updated = await getWebhookRule(id);
  if (!updated) {
    throw new Error(`Webhook rule ${id} not found after update`);
  }
  return updated;
}

export async function deleteWebhookRule(id: string): Promise<void> {
  const result = await pool.query('DELETE FROM remote_agent_webhook_rules WHERE id = $1', [id]);
  if ((result.rowCount ?? 0) === 0) {
    getLog().debug({ webhookRuleId: id }, 'db.webhook_rule_delete_noop');
  }
}
