import type { UpdateCheckResult } from '@archon/paths';
import { z } from '@hono/zod-openapi';

export const updateCheckResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  })
  .openapi('UpdateCheckResponse');

type Response = z.infer<typeof updateCheckResponseSchema>;
const updateCheckContract: [UpdateCheckResult, keyof UpdateCheckResult] extends [
  Response,
  keyof Response,
]
  ? [Response, keyof Response] extends [UpdateCheckResult, keyof UpdateCheckResult]
    ? true
    : false
  : false = true;
void updateCheckContract;

export const appCommitSchema = z
  .object({
    sha: z
      .string()
      .describe('Short hash of the commit the running server was built or started from'),
    committedAt: z
      .string()
      .nullable()
      .describe(
        'Committer date of that commit (ISO 8601). Null in a compiled binary, which embeds only the hash.'
      ),
  })
  .openapi('AppCommit');

export type AppCommit = z.infer<typeof appCommitSchema>;
