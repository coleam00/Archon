/**
 * Raw Slack file attachment metadata, as it appears on `message`/`app_mention`
 * events. `url_private_download` requires the bot token as a Bearer auth
 * header to fetch (scope `files:read`).
 */
export interface SlackFileRef {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

/**
 * Why an attachment did not reach the AI. Returned so the caller can tell the
 * user in-thread — a silently dropped file is indistinguishable, from the
 * user's seat, from Archon not supporting attachments at all.
 */
export type SlackAttachmentSkipReason = 'too_large' | 'timeout' | 'download_failed' | 'too_many';

/** An attachment that was not delivered, and the reason it was dropped. */
export interface SkippedSlackAttachment {
  /** Best available display name; falls back to the Slack file id. */
  readonly name: string;
  readonly reason: SlackAttachmentSkipReason;
}

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
