/**
 * Zod schema for the per-user AI-preferences row.
 *
 * Stores a user's personal model tiers, `@custom` aliases, and default
 * assistant. NON-encrypted — model names aren't secrets (mirrors
 * codebase_env_vars, not the provider-key store). One row per user
 * (`UNIQUE(user_id)`); `tiers` / `aliases` are JSON-as-TEXT, parsed in the
 * store layer so SQLite and Postgres behave identically.
 */
import { z } from '@hono/zod-openapi';

// Timestamps are read back as `Date` on PostgreSQL (node-postgres hydrates
// TIMESTAMPTZ) but as ISO `string` on SQLite (TEXT). The union keeps the row
// type honest for either dialect.
const dbTimestamp = z.union([z.date(), z.string()]);

export const userAiPrefsRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  tiers: z.string().nullable(),
  aliases: z.string().nullable(),
  default_provider: z.string().nullable(),
  created_at: dbTimestamp,
  updated_at: dbTimestamp,
});

export type UserAiPrefsRow = z.infer<typeof userAiPrefsRowSchema>;
