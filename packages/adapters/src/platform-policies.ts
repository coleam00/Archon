import type { PlatformPolicy } from '@archon/core/platforms/types';
import { telegramPolicy } from './chat/telegram/policy';
import { slackPolicy } from './chat/slack/policy';
import { discordPolicy } from './community/chat/discord/policy';
import { githubPolicy } from './forge/github/policy';
import { giteaPolicy } from './community/forge/gitea/policy';
import { gitlabPolicy } from './community/forge/gitlab/policy';

export const bundledPlatformPolicies: readonly PlatformPolicy[] = [
  telegramPolicy,
  slackPolicy,
  discordPolicy,
  githubPolicy,
  giteaPolicy,
  gitlabPolicy,
];
