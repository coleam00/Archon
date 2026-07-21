/**
 * Whether Discord guild (server) messages require an explicit @mention of the
 * bot to activate it. On by default; `DISCORD_REQUIRE_MENTION=false` opts out
 * so the bot responds to any authorized guild message. Only the literal string
 * 'false' disables the gate. DMs never require a mention regardless of this
 * setting, and mention stripping stays unconditional (a mention that is
 * present is still removed from the message content).
 */
export function isDiscordMentionRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISCORD_REQUIRE_MENTION !== 'false';
}
