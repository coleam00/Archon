import { describe, expect, test } from 'bun:test';
import { retiredAdapterNotices } from './retired-adapters';

describe('retiredAdapterNotices', () => {
  test('a configured Slack token without an installed plugin names the install command', () => {
    expect(retiredAdapterNotices({ SLACK_BOT_TOKEN: 'xoxb-x' }, new Set())).toEqual([
      {
        id: 'slack',
        command: 'archon plugin add coleam00/Archon/plugins/chat-slack',
        guidance: expect.stringContaining(
          'Docker images provision Slack offline when SLACK_BOT_TOKEN is set'
        ),
      },
    ]);
  });

  test('an installed plugin with the retired id silences the notice', () => {
    expect(retiredAdapterNotices({ SLACK_BOT_TOKEN: 'xoxb-x' }, new Set(['slack']))).toEqual([]);
  });

  test('an install that never configured the adapter gets no notice', () => {
    expect(retiredAdapterNotices({ SLACK_BOT_TOKEN: '' }, new Set())).toEqual([]);
  });
});
