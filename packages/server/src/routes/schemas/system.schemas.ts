import { z } from '@hono/zod-openapi';

export const updateCheckResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  })
  .openapi('UpdateCheckResponse');

export const operatorResponseSchema = z
  .object({
    name: z.string(),
    host: z.string(),
    uptimeSeconds: z.number(),
  })
  .openapi('OperatorResponse');
