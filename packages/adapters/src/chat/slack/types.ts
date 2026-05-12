/**
 * Slack message event context for the message handler
 */
export interface SlackMessageEvent {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}
