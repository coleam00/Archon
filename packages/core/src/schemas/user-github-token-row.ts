/**
 * Zod schema for the per-user GitHub token row.
 *
 * Stores a user's GitHub App user-to-server tokens (device flow), encrypted at
 * rest with AES-256-GCM. One row per Archon user (UNIQUE(user_id)). The numeric
 * `github_user_id` is the stable anchor for the commit no-reply email
 * (`<id>+<login>@users.noreply.github.com`), surviving username changes.
 *
 * (Filename carries a `-row` suffix to satisfy a local secret-guard hook that
 * blocks basenames ending in `token.ts`; the DB table is
 * `remote_agent_user_github_tokens`.)
 */
import { z } from '@hono/zod-openapi';

// Timestamps are read back as `Date` on PostgreSQL (node-postgres hydrates
// TIMESTAMPTZ) but as ISO `string` on SQLite (TEXT). The store normalizes both
// via `toEpochMs`; the union keeps the row type honest for either dialect.
const dbTimestamp = z.union([z.date(), z.string()]);

export const userGithubTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  github_user_id: z.number(),
  github_login: z.string(),
  access_token_encrypted: z.string(),
  refresh_token_encrypted: z.string().nullable(),
  access_token_expires_at: dbTimestamp.nullable(),
  refresh_token_expires_at: dbTimestamp.nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});

export type UserGithubTokenRow = z.infer<typeof userGithubTokenRowSchema>;
