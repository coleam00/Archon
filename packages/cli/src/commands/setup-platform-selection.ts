export const SETUP_PLATFORMS = [
  { value: 'github', label: 'GitHub', hint: 'Respond to issues/PRs via webhooks' },
  { value: 'telegram', label: 'Telegram', hint: 'Chat bot via BotFather' },
  { value: 'slack', label: 'Slack', hint: 'Workspace app with Socket Mode' },
] as const;

type SetupPlatform = (typeof SETUP_PLATFORMS)[number]['value'];
export type PlatformSelection = Record<SetupPlatform, boolean>;

export function createPlatformSelection(
  selected: (platform: SetupPlatform) => boolean
): PlatformSelection {
  // fromEntries loses the key union; mapping the owning list supplies every key.
  return Object.fromEntries(
    SETUP_PLATFORMS.map(({ value }) => [value, selected(value)])
  ) as PlatformSelection;
}

export function platformNames(platforms: PlatformSelection): string[] {
  return SETUP_PLATFORMS.filter(({ value }) => platforms[value]).map(({ label }) => label);
}
