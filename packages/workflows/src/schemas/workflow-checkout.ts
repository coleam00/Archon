import { z } from 'zod';

/** A fresh run's immutable start, independent of its merge destination. */
export const workflowCheckoutSchema = z
  .object({
    revision: z
      .string()
      .length(40)
      .regex(/^[a-f0-9]{40}$/),
    base_branch: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine(
        value =>
          value.trim() === value &&
          value !== 'HEAD' &&
          !value.includes('..') &&
          !value.endsWith('.') &&
          value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))
      ),
  })
  .strict();
export type WorkflowCheckout = z.infer<typeof workflowCheckoutSchema>;
