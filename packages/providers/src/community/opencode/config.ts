import type { ProviderDefaults } from '../../types';

export interface OpencodeProviderDefaults extends ProviderDefaults {
  /** Default model ref in '<provider-id>/<model-id>' format, e.g. 'anthropic/claude-sonnet-4' */
  model?: string;
  /** OpenCode Server hostname. @default '127.0.0.1' */
  hostname?: string;
  /** OpenCode Server port. @default 4096 */
  port?: number;
  /** OpenCode Server password for HTTP Basic Auth. If unset, auto-generated. */
  serverPassword?: string;
  /** Auto-start OpenCode Server on first use. @default true */
  autoStartServer?: boolean;
}

/**
 * Parse raw YAML-derived config into typed OpenCode defaults.
 * Defensive: invalid fields are dropped silently.
 */
export function parseOpencodeConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  const result: OpencodeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.hostname === 'string') {
    result.hostname = raw.hostname;
  }

  if (typeof raw.port === 'number') {
    result.port = raw.port;
  }

  if (typeof raw.serverPassword === 'string') {
    result.serverPassword = raw.serverPassword;
  }

  if (typeof raw.autoStartServer === 'boolean') {
    result.autoStartServer = raw.autoStartServer;
  }

  return result;
}
