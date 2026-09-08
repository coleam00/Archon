import { CHECKS_STATE_OP, RESOLVE_OP, FORGE_PROTOCOL_VERSION } from '../protocol';
import type { PluginMetadata } from '../schemas';
export const GITHUB_HOST = 'github.com';
export const metadata: PluginMetadata = {
  protocol: FORGE_PROTOCOL_VERSION,
  name: 'github',
  version: '1.0.0',
  forge: 'github',
  hosts: [GITHUB_HOST],
  capabilities: [RESOLVE_OP, CHECKS_STATE_OP],
  token_env: 'GH_TOKEN',
};
