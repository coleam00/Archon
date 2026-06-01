/**
 * Zod schemas for the GitHub device-flow connect endpoints.
 */
import { z } from '@hono/zod-openapi';

/** POST /api/auth/github/device/start response — codes shown to the user. */
export const deviceStartResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    interval: z.number(),
    expires_in: z.number(),
  })
  .openapi('GithubDeviceStartResponse');

/** POST /api/auth/github/device/poll request — echoes the device_code from start. */
export const devicePollBodySchema = z
  .object({ device_code: z.string().min(1) })
  .openapi('GithubDevicePollBody');

/** POST /api/auth/github/device/poll response. */
export const devicePollResponseSchema = z
  .object({
    status: z.enum(['pending', 'connected', 'expired', 'denied', 'error']),
    githubLogin: z.string().optional(),
    detail: z.string().optional(),
  })
  .openapi('GithubDevicePollResponse');

/** GET /api/auth/github response — current connection status. */
export const githubConnectionStatusSchema = z
  .object({
    connected: z.boolean(),
    githubLogin: z.string().nullable(),
  })
  .openapi('GithubConnectionStatus');

/** DELETE /api/auth/github response. */
export const githubDisconnectResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('GithubDisconnectResponse');
