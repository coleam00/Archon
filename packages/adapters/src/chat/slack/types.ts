/**
 * Outcome of resolving a Slack channel ID to its human-readable name.
 *
 * Modelled as a result union rather than `string | undefined` so callers can
 * tell a genuinely nameless channel (a DM) apart from a failed lookup (missing
 * `channels:read`/`groups:read` scope, or an API error) and explain the
 * difference to the user instead of guessing.
 */
export type SlackChannelNameResult =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'dm' }
  | { readonly kind: 'unavailable' };

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
