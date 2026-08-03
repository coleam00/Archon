/**
 * Common Zod schemas shared across API route definitions.
 * Import z from @hono/zod-openapi per project conventions.
 */
import { z } from '@hono/zod-openapi';

/** Standard error response body. */
export const errorSchema = z.object({ error: z.string() }).openapi('Error');
export type ErrorResponse = z.infer<typeof errorSchema>;
