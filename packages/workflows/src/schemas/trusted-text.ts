import { z } from 'zod';
import { forgeSubjectRefSchema } from '@archon/forge';

export const trustedTextBindingSchema = z
  .object({
    subject: forgeSubjectRefSchema,
    maintainersPath: z.string().min(1),
    /** The declared workflow input that receives the frozen title/body snapshot. */
    input: z.string().min(1),
  })
  .strict();
export type TrustedTextBinding = z.infer<typeof trustedTextBindingSchema>;
export const trustedTextDeclarationSchema = trustedTextBindingSchema.omit({ subject: true });
