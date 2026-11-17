import { getDatabase } from './connection';
import {
  trustedTextRunMetadataSchema,
  type TrustedTextRunMetadata,
} from '@archon/workflows/trusted-text';
import { trustedTextBindingSchema } from '@archon/workflows/schemas/resource-start';
import { ensureItem } from './items';

export async function declareItemTextRequirement(
  codebaseId: string,
  itemKey: string,
  requirement: TrustedTextRunMetadata['requirement']
): Promise<void> {
  const value = trustedTextBindingSchema.parse(requirement);
  await getDatabase().withTransaction(async query => {
    const itemId = await ensureItem(query, codebaseId, itemKey);
    await query(
      `INSERT INTO remote_agent_item_text_requirements (item_id, requirement)
       VALUES ($1, $2)
       ON CONFLICT(item_id) DO UPDATE SET requirement = excluded.requirement`,
      [itemId, JSON.stringify(value)]
    );
  });
}

export async function readItemTextRequirement(
  itemId: string
): Promise<TrustedTextRunMetadata['requirement'] | null> {
  const result = await getDatabase().query<{ requirement: unknown }>(
    'SELECT requirement FROM remote_agent_item_text_requirements WHERE item_id = $1',
    [itemId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return trustedTextBindingSchema.parse(
    typeof row.requirement === 'string' ? JSON.parse(row.requirement) : row.requirement
  );
}

export async function readItemTextRequirementByKey(
  projectKey: string,
  itemKey: string
): Promise<TrustedTextRunMetadata['requirement'] | null> {
  const result = await getDatabase().query<{ requirement: unknown }>(
    `SELECT r.requirement FROM remote_agent_item_text_requirements r
       JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND i.key = $2`,
    [projectKey, itemKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  return trustedTextBindingSchema.parse(
    typeof row.requirement === 'string' ? JSON.parse(row.requirement) : row.requirement
  );
}

export async function readItemTextAcceptance(
  projectKey: string,
  itemKey: string
): Promise<TrustedTextRunMetadata | null> {
  const result = await getDatabase().query<{ snapshot: unknown }>(
    'SELECT snapshot FROM remote_agent_item_text_acceptances WHERE project_key = $1 AND item_key = $2',
    [projectKey, itemKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  const raw = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
  return trustedTextRunMetadataSchema.parse(raw);
}

export async function readItemTextAcceptanceByItemId(
  itemId: string
): Promise<TrustedTextRunMetadata | null> {
  const result = await getDatabase().query<{ snapshot: unknown }>(
    `SELECT a.snapshot FROM remote_agent_item_text_acceptances a
       JOIN remote_agent_items i ON i.project_key = a.project_key AND i.key = a.item_key
      WHERE i.id = $1`,
    [itemId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return trustedTextRunMetadataSchema.parse(
    typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot
  );
}

export async function writeItemTextAcceptance(
  projectKey: string,
  itemKey: string,
  snapshot: TrustedTextRunMetadata
): Promise<void> {
  const value = trustedTextRunMetadataSchema.parse(snapshot);
  await getDatabase().withTransaction(async query => {
    // A no-op write serializes competing accepts on SQLite; Postgres takes the row lock.
    await query(
      `INSERT INTO remote_agent_item_text_acceptances (project_key, item_key, snapshot)
       VALUES ($1, $2, $3)
       ON CONFLICT(project_key, item_key) DO UPDATE SET
         snapshot = excluded.snapshot, accepted_at = CURRENT_TIMESTAMP`,
      [projectKey, itemKey, JSON.stringify(value)]
    );
  });
}
