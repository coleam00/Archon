import { describe, test, expect } from 'bun:test';
import { isDiscordMentionRequired } from './discord-mention';

describe('isDiscordMentionRequired', () => {
  test('true by default when DISCORD_REQUIRE_MENTION is unset (guild messages stay gated)', () => {
    expect(isDiscordMentionRequired({})).toBe(true);
  });

  test('false when DISCORD_REQUIRE_MENTION=false (un-mentioned guild messages activate the bot)', () => {
    expect(isDiscordMentionRequired({ DISCORD_REQUIRE_MENTION: 'false' })).toBe(false);
  });

  test('true when DISCORD_REQUIRE_MENTION=true', () => {
    expect(isDiscordMentionRequired({ DISCORD_REQUIRE_MENTION: 'true' })).toBe(true);
  });

  test("only the literal string 'false' opts out ('FALSE', '0', '' keep the gate on)", () => {
    expect(isDiscordMentionRequired({ DISCORD_REQUIRE_MENTION: 'FALSE' })).toBe(true);
    expect(isDiscordMentionRequired({ DISCORD_REQUIRE_MENTION: '0' })).toBe(true);
    expect(isDiscordMentionRequired({ DISCORD_REQUIRE_MENTION: '' })).toBe(true);
  });
});
