/**
 * AI Assistant Clients
 *
 * Prefer importing from '@archon/core' for most use cases:
 *   import { ClaudeClient, getAssistantClient } from '@archon/core';
 *
 * Use this submodule path when you only need client-specific code:
 *   import { ClaudeClient } from '@archon/core/clients';
 */

export { ClaudeClient } from './claude';
export { CodexClient } from './codex';
export { PiClient } from './pi';
export { getAssistantClient } from './factory';

// Re-export types for consumers importing from this submodule directly
export type { IAssistantClient, MessageChunk } from '../types';
