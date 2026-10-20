/**
 * Bundled adapters that now ship only as chat plugins. An install still
 * configured for one (its env var set) without a plugin of that id gets a boot
 * notice naming the install command. Delete this once no install can still
 * carry the retired configuration.
 */
export const SLACK_PLUGIN = {
  id: 'slack',
  envVar: 'SLACK_BOT_TOKEN',
  installSource: 'coleam00/Archon/plugins/chat-slack',
  guidance:
    'Docker images provision Slack offline when SLACK_BOT_TOKEN is set. Check provisioning logs and restart with a current image. Outside Docker, install the plugin and restart.',
} as const;

const RETIRED_ADAPTERS = [SLACK_PLUGIN];

export interface RetiredAdapterNotice {
  id: string;
  command: string;
  guidance: string;
}

export function retiredAdapterNotices(
  env: NodeJS.ProcessEnv,
  installedChatIds: ReadonlySet<string>
): RetiredAdapterNotice[] {
  return RETIRED_ADAPTERS.filter(
    adapter => env[adapter.envVar] && !installedChatIds.has(adapter.id)
  ).map(adapter => ({
    id: adapter.id,
    command: `archon plugin add ${adapter.installSource}`,
    guidance: adapter.guidance,
  }));
}
