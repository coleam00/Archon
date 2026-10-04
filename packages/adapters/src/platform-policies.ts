import type { PlatformPolicy } from '@archon/core/platforms/types';
import { telegramPolicy } from './chat/telegram/policy';
import { slackPolicy } from './chat/slack/policy';
import { discordPolicy } from './community/chat/discord/policy';

export const bundledPlatformPolicies: readonly PlatformPolicy[] = [
  telegramPolicy,
  slackPolicy,
  discordPolicy,
];
