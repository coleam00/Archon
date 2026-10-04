import { registerPlatformPolicy } from '@archon/core/platforms/registry';
import { telegramPolicy } from './chat/telegram/policy';
import { slackPolicy } from './chat/slack/policy';
import { discordPolicy } from './community/chat/discord/policy';

export function registerBundledPlatformPolicies(): void {
  for (const policy of [telegramPolicy, slackPolicy, discordPolicy]) {
    registerPlatformPolicy(policy);
  }
}
