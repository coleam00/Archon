import { z } from 'zod';

/**
 * The surface a write or answer came through, recorded as an audit fact: `cli`, `api`,
 * `manage_run`, or a chat platform's id such as `slack`. The surface's own code sets
 * it; nothing infers it, and it never names or classifies who acted. A string rather
 * than an enum because chat platforms are pluggable, and so a reader built before a
 * new surface existed still reads its records.
 */
export const recordSurfaceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export type RecordSurface = z.infer<typeof recordSurfaceSchema>;
