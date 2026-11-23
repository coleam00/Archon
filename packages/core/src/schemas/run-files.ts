/**
 * What removing a deleted run's files left on disk. The cleanup service returns it, and the
 * run delete route serves it as is, so the two cannot drift.
 */
import { z } from '@hono/zod-openapi';

export const runFilesReportSchema = z.object({
  removedBytes: z.number(),
  /** Paths that are still on disk, with the error that kept each. */
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
  /** Runs whose files cannot be located: no trusted root, or an id that is not a run id. */
  unlocated: z.array(z.string()),
});

export type RunFilesReport = z.infer<typeof runFilesReportSchema>;
