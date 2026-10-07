import { z } from 'zod';

export const CHAT_PLUGIN_PROTOCOL = 'archon-chat/1';
export const identityPlatformSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const envVarSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const chatPluginDescriptorSchema = z.object({
  protocol: z.literal(CHAT_PLUGIN_PROTOCOL),
  id: identityPlatformSchema,
  displayName: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.object({
    canDetachProject: z.literal(true).optional(),
    defaultWorkflowDispatch: z.enum(['foreground', 'background']),
    resultFooter: z.literal(true).optional(),
    runEvents: z.literal(true).optional(),
  }),
  workflowCommand: z.object({ prefix: z.string().min(1) }).optional(),
  policy: z.object({
    workspaceRetention: z.enum(['age-based', 'retain']),
    streaming: z
      .object({
        defaultMode: z.enum(['stream', 'batch']),
        envVar: envVarSchema,
      })
      .optional(),
  }),
  allowlist: z.object({ envVar: envVarSchema }).optional(),
});
export type ChatPluginDescriptor = z.infer<typeof chatPluginDescriptorSchema>;

export const chatActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1) }),
  z.object({ kind: z.literal('unidentified') }),
]);
export type ChatActor = z.infer<typeof chatActorSchema>;
