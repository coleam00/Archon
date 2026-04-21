export interface CopilotProviderDefaults {
  [key: string]: unknown;
  /** Default Copilot model, e.g. `gpt-5` or `claude-sonnet-4.5`. */
  model?: string;
  /**
   * Path to the Copilot CLI executable. Useful in compiled Archon binaries or
   * when the user wants to override the SDK's bundled CLI resolution.
   */
  copilotCliPath?: string;
  /**
   * Override Copilot's config directory.
   */
  configDir?: string;
  /**
   * Opt in to Copilot's config discovery from the repo.
   * Disabled by default so arbitrary repos do not implicitly load MCP/skills.
   */
  enableConfigDiscovery?: boolean;
  /**
   * Reuse the CLI's logged-in user credentials when no explicit token is
   * provided. Defaults to true.
   */
  useLoggedInUser?: boolean;
  /**
   * CLI log level.
   */
  logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
}

export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const result: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.copilotCliPath === 'string') {
    result.copilotCliPath = raw.copilotCliPath;
  }

  if (typeof raw.configDir === 'string') {
    result.configDir = raw.configDir;
  }

  if (typeof raw.enableConfigDiscovery === 'boolean') {
    result.enableConfigDiscovery = raw.enableConfigDiscovery;
  }

  if (typeof raw.useLoggedInUser === 'boolean') {
    result.useLoggedInUser = raw.useLoggedInUser;
  }

  if (
    raw.logLevel === 'none' ||
    raw.logLevel === 'error' ||
    raw.logLevel === 'warning' ||
    raw.logLevel === 'info' ||
    raw.logLevel === 'debug' ||
    raw.logLevel === 'all'
  ) {
    result.logLevel = raw.logLevel;
  }

  return result;
}
