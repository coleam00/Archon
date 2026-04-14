import { z } from '@hono/zod-openapi';

export const updateCheckResponseSchema = z
  .object({
    updateAvailable: z.boolean(),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  })
  .openapi('UpdateCheckResponse');

export const tunnelStatusResponseSchema = z
  .object({
    status: z.enum(['inactive', 'starting', 'active', 'error']),
    url: z.string().nullable(),
  })
  .openapi('TunnelStatusResponse');

export const tunnelStartResponseSchema = z
  .object({ status: z.string() })
  .openapi('TunnelStartResponse');

export const tunnelStopResponseSchema = z
  .object({ status: z.string() })
  .openapi('TunnelStopResponse');
