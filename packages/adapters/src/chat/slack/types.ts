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
}
