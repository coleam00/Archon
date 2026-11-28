import { z } from '@hono/zod-openapi';
import {
  forgeErrorSchema,
  pluginIdentitySchema,
  pluginMetadataSchema,
  repoOverviewSchema,
} from '@archon/forge/operations';

const display = pluginMetadataSchema.shape.display.unwrap().shape;

/** Why a forge read failed, by the forge contract's own error kinds. */
const projectForgeErrorSchema = z.object({
  kind: forgeErrorSchema.shape.kind,
  message: z.string(),
});

/**
 * A project's repository on its forge.
 *
 * `none` is a project with no forge: a folder, or a remote no plugin claims. `unresolved`
 * means Archon could not tell which forge serves the remote. A `forge` names the plugin
 * that answered and carries the forge contract's overview as it is, where an absent
 * optional fact is one the forge does not have, never zero; a failed read is a state
 * with its reason, never an empty overview.
 */
export const projectForgeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('unresolved'), error: projectForgeErrorSchema }),
    z.object({
      kind: z.literal('forge'),
      forge: z.object({ name: display.name, icon: display.icon }),
      repo: z.object({ host: z.string(), path: z.string() }),
      plugin: pluginIdentitySchema,
      overview: z.discriminatedUnion('status', [
        z.object({
          status: z.literal('ok'),
          syncedAt: z.iso.datetime(),
          value: repoOverviewSchema,
        }),
        z.object({
          status: z.literal('failed'),
          error: projectForgeErrorSchema,
          remedy: z.string().optional(),
        }),
      ]),
    }),
  ])
  .meta({ id: 'ProjectForge' });
export type ProjectForge = z.infer<typeof projectForgeSchema>;
