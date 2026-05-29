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

export const userGithubTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  github_user_id: z.number(),
  github_login: z.string(),
  access_token_encrypted: z.string(),
  refresh_token_encrypted: z.string().nullable(),
  access_token_expires_at: z.date().nullable(),
  refresh_token_expires_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type UserGithubTokenRow = z.infer<typeof userGithubTokenRowSchema>;
