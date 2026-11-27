import { z } from 'zod';
import { runModelOverridesSchema } from './model-binding';

/**
 * A fire's own choices for one start: the config layer it runs on (`--config`) and its tier or
 * `@alias` rebindings (`--model`). The two are stored as the operator typed them — a path and
 * raw `name=spec` mappings — never as a resolved profile, which belongs to the install at
 * preparation time.
 *
 * A run keeps them beside its stored intent rather than inside it, because the intent is what
 * every binary on the database parses and this shape is newer than most of them: stored with
 * the start and read back by another binary, so a key this shape does not know is dropped, not
 * refused. A later release may add one, and an older reader must still prepare the start.
 */
export const startOverridesSchema = z.object({
  config: z.object({ path: z.string().min(1) }).optional(),
  models: runModelOverridesSchema.optional(),
});
export type StartOverrides = z.infer<typeof startOverridesSchema>;

/**
 * The intent's `startOverrides` field, as a fragment the intent schema spreads. A binding file
 * and a source plugin read their intents through schemas that omit the key: which config and
 * models a start uses is the operator's choice at the fire, never a file's or a plugin's
 * (`triggerConfigSchema`, `sourcePluginAcceptanceSchema`).
 */
export const startOverridesField = { startOverrides: startOverridesSchema.optional() };
