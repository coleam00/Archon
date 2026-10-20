import { getDatabaseType, getDialect } from './connection';

/**
 * SQL for run `r` and its left-joined conversation `c`. Environment IDs compare
 * as text so PostgreSQL UUID links and JSON IDs give parameters the same type.
 */
export function runCheckoutAssociationPredicate(environmentId: string): string {
  const dialect = getDialect();
  const postgres = getDatabaseType() === 'postgresql';
  const conversationEnvId = postgres ? 'c.isolation_env_id::text' : 'c.isolation_env_id';
  const checkoutId = postgres ? 'checkout.id::text' : 'checkout.id';
  return `(${dialect.jsonText('r.metadata', 'isolation_env_id')} = ${environmentId}
    OR ${dialect.jsonText('r.metadata', 'owned_worktree.envId')} = ${environmentId}
    OR ${conversationEnvId} = ${environmentId}
    OR EXISTS (SELECT 1 FROM remote_agent_isolation_environments checkout
      WHERE ${checkoutId} = ${environmentId}
        AND checkout.codebase_id = r.codebase_id AND checkout.working_path = r.working_path))`;
}
