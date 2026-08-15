/**
 * AiderDesk provider config defaults and defensive parser.
 *
 * Canonical definition of the config shape for `assistants.aiderdesk.*` in
 * .archon/config.yaml. The parser is defensive — invalid fields are dropped
 * silently (matches parseClaudeConfig, parseCodexConfig, parsePiConfig —
 * never throws, so broken user config can't prevent provider registration
 * or workflow discovery).
 */
import type { AiderDeskProviderDefaults } from '../../types';

export type { AiderDeskProviderDefaults };

export type ParsedAiderdeskConfig = AiderDeskProviderDefaults;

const VALID_MODES: ReadonlySet<string> = new Set(['code', 'ask', 'architect', 'context', 'agent']);

/**
 * Parse raw YAML-derived config into typed AiderDesk defaults.
 * Defensive: invalid fields are dropped silently — never throws, so broken
 * user config can't prevent provider registration or workflow discovery.
 */
export function parseAiderdeskConfig(raw: Record<string, unknown>): ParsedAiderdeskConfig {
  const result: ParsedAiderdeskConfig = {};

  if (!raw || typeof raw !== 'object') return result;

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.apiUrl === 'string') {
    result.apiUrl = raw.apiUrl;
  }

  if (typeof raw.agentProfileId === 'string') {
    result.agentProfileId = raw.agentProfileId;
  }

  if (typeof raw.mode === 'string' && VALID_MODES.has(raw.mode)) {
    result.mode = raw.mode as AiderDeskProviderDefaults['mode'];
  }

  if (typeof raw.pollIntervalMs === 'number' && raw.pollIntervalMs > 0) {
    result.pollIntervalMs = raw.pollIntervalMs;
  }

  if (typeof raw.requestTimeoutMs === 'number' && raw.requestTimeoutMs > 0) {
    result.requestTimeoutMs = raw.requestTimeoutMs;
  }

  if (typeof raw.clearContextAfterRun === 'boolean') {
    result.clearContextAfterRun = raw.clearContextAfterRun;
  }

  return result;
}
