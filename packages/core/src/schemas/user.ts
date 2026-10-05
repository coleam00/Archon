/**
 * Zod schemas for user and user identity row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// IdentityPlatform
// ---------------------------------------------------------------------------

export const identityPlatformSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export type IdentityPlatform = z.infer<typeof identityPlatformSchema>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * Roles prepare run-action authorization; enforcement ships separately.
 * The database default stays 'admin' for older writers.
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
