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
