/**
 * Zod schemas for the per-user AI-preferences endpoints (Phase 3) —
 * personal model tiers, `@custom` aliases, and default assistant under
 * `/api/auth/me/ai-prefs*`. Identity-gated (requireWebUser) but NOT
 * secret-bearing: model names aren't credentials.
 */
import { z } from '@hono/zod-openapi';
import { tierEntrySchema } from './config.schemas';

/**
 * An alias entry — same shape as a tier entry ({ provider, model, effort?,
 * thinking? }). `thinking` is accepted on read for parity but DROPPED on
 * write, mirroring PATCH /api/config/tiers.
 */
export const aliasEntrySchema = tierEntrySchema;

const userTiersSchema = z
  .object({
    small: tierEntrySchema.optional(),
    medium: tierEntrySchema.optional(),
    large: tierEntrySchema.optional(),
  })
  .openapi('UserTiersConfig');

/** GET /api/auth/me/ai-prefs response — the user's stored prefs (raw layer, not merged). */
export const userAiPrefsResponseSchema = z
  .object({
    tiers: userTiersSchema.optional(),
    aliases: z.record(z.string(), aliasEntrySchema).optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
  })
  .openapi('UserAiPrefs');

/** PATCH /api/auth/me/ai-prefs/tiers body — per-key merge; `null` unsets that tier. */
export const updateUserTiersBodySchema = z
  .object({
    tiers: z.object({
      small: tierEntrySchema.nullable().optional(),
      medium: tierEntrySchema.nullable().optional(),
      large: tierEntrySchema.nullable().optional(),
    }),
  })
  .openapi('UpdateUserTiersBody');

/** PATCH /api/auth/me/ai-prefs/aliases body — per-key merge; `null` unsets that alias. */
export const updateUserAliasesBodySchema = z
  .object({
    aliases: z.record(z.string(), aliasEntrySchema.nullable()),
  })
  .openapi('UpdateUserAliasesBody');

/**
 * PATCH /api/auth/me/ai-prefs/default body — sets the per-user default
 * assistant + default CHAT model ATOMICALLY. `provider: null` clears both;
 * `model` omitted or `null` clears any model pin (a pin is only meaningful
 * for the provider it was set with, so it never survives a provider write).
 * `model` with a `null` provider is rejected (400).
 */
export const updateUserDefaultBodySchema = z
  .object({
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable().optional(),
  })
  .openapi('UpdateUserDefaultBody');
