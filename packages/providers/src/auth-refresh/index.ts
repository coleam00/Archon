import { refreshClaude } from './claude.js';
import { refreshCodex } from './codex.js';
import type { ProviderName, RefreshResult } from './types.js';

export async function refreshIfAuthFailed(provider: ProviderName): Promise<RefreshResult> {
  if (provider === 'claude') return refreshClaude();
  if (provider === 'codex') return refreshCodex();
  throw new Error(`unknown provider: ${provider satisfies never}`);
}

export { buildReauthMessage, isTerminalRefreshReason } from './shared.js';
export type { ProviderName, RefreshFailureReason, RefreshResult } from './types.js';
