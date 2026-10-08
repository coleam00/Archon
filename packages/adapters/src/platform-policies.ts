import type { PlatformPolicy } from '@archon/core/platforms/types';
import { apiPolicy } from '@archon/core/workflows/headless-policy';
import { cliPolicy } from './cli/policy';
import { webPolicy } from './web/policy';
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

export const defaultPlatformPolicies: readonly PlatformPolicy[] = [
  cliPolicy,
  webPolicy,
  apiPolicy,
  ...bundledPlatformPolicies,
];
