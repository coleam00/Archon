/**
 * Bundled adapters that now ship only as chat plugins. An install still
 * configured for one (its env var set) without a plugin of that id gets a boot
 * notice naming the install command. Delete this once no install can still
 * carry the retired configuration.
 */
const RETIRED_ADAPTERS = [
  { id: 'slack', envVar: 'SLACK_BOT_TOKEN', installSource: 'coleam00/Archon/plugins/chat-slack' },
] as const;

export interface RetiredAdapterNotice {
  id: string;
  command: string;
}

export function retiredAdapterNotices(
  env: NodeJS.ProcessEnv,
  installedChatIds: ReadonlySet<string>
): RetiredAdapterNotice[] {
  return RETIRED_ADAPTERS.filter(
    adapter => env[adapter.envVar] && !installedChatIds.has(adapter.id)
  ).map(adapter => ({ id: adapter.id, command: `archon plugin add ${adapter.installSource}` }));
}
