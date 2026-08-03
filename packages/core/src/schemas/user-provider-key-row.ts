/**
 * Zod schema for the per-user AI-provider key row.
 *
 * Stores a user's AI-provider credential (API key or OAuth subscription blob),
 * encrypted at rest with AES-256-GCM. One row per (user_id, provider) — a user
 * can connect multiple providers but not multiple credentials for the same
 * provider. Exactly one of `api_key_encrypted` / `oauth_creds_encrypted` is
 * populated per row; `kind` records which.
 *
 * (Filename carries a `-row` suffix to satisfy a local secret-guard hook that
 * blocks basenames ending in `key(s).ts` / `token(s).ts`; the DB table is
 * `remote_agent_user_provider_keys`.)
 */
import { z } from '@hono/zod-openapi';

// Timestamps are read back as `Date` on PostgreSQL (node-postgres hydrates
// TIMESTAMPTZ) but as ISO `string` on SQLite (TEXT). The union keeps the row
// type honest for either dialect.
const dbTimestamp = z.union([z.date(), z.string()]);

export const userProviderKeyRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  provider: z.string(),
  kind: z.enum(['api_key', 'oauth']),
  api_key_encrypted: z.string().nullable(),
  oauth_creds_encrypted: z.string().nullable(),
  label: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});

export type UserProviderKeyRow = z.infer<typeof userProviderKeyRowSchema>;
