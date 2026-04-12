/**
 * Agent Providers
 *
 * Prefer importing from '@archon/core' for most use cases:
 *   import { ClaudeProvider, getAgentProvider } from '@archon/core';
 *
 * Use this submodule path when you only need provider-specific code:
 *   import { ClaudeProvider } from '@archon/core/providers';
 */

export { ClaudeProvider } from './claude';
export { CodexProvider } from './codex';
export { getAgentProvider } from './factory';

// Re-export types for consumers importing from this submodule directly
export type { IAgentProvider, MessageChunk } from '../types';
