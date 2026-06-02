/**
 * Zod schemas for user and user identity row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// IdentityPlatform
// ---------------------------------------------------------------------------

export const identityPlatformSchema = z.enum([
  'slack',
  'telegram',
  'discord',
  'github',
  'gitea',
  'gitlab',
  'web',
  'cli',
]);

export type IdentityPlatform = z.infer<typeof identityPlatformSchema>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * Identity role seam. Everyone defaults to 'admin' today (visibility stays
 * open); 'member' is reserved for future per-resource scoping.
 */
export const userRoleSchema = z.enum(['admin', 'member']);

export type UserRole = z.infer<typeof userRoleSchema>;

export const userRowSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  role: userRoleSchema,
  created_at: z.date(),
  updated_at: z.date(),
});

export type User = z.infer<typeof userRowSchema>;

// ---------------------------------------------------------------------------
// UserIdentity
// ---------------------------------------------------------------------------

export const userIdentityRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  platform: identityPlatformSchema,
  platform_user_id: z.string(),
  platform_display_name: z.string().nullable(),
  created_at: z.date(),
});

export type UserIdentity = z.infer<typeof userIdentityRowSchema>;
