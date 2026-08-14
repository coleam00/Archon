import { z } from '@hono/zod-openapi';

/** File attachment reference as it appears on an inbound Slack message event. */
export const slackFileRefSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  mimetype: z.string().optional(),
  url_private_download: z.string().optional(),
  size: z.number().optional(),
});

export type SlackFileRef = z.infer<typeof slackFileRefSchema>;

/**
 * Slack message event context for the message handler.
 * `displayName` is enriched lazily via `users.info` on first sight of a user;
 * undefined if the API call fails (e.g. missing `users:read` scope) — the
 * server handler treats it as best-effort and resolves to the user UUID
 * regardless. Requires bot token scope `users:read`.
 */
export interface SlackMessageEvent {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  displayName?: string;
  files?: SlackFileRef[];
}
