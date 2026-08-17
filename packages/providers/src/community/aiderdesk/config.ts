/**
 * AiderDesk provider config defaults and defensive parser.
 *
 * Canonical definition of the config shape for `assistants.aiderdesk.*` in
 * .archon/config.yaml. The parser is defensive — invalid fields are dropped
 * silently (matches parseClaudeConfig, parseCodexConfig, parsePiConfig —
 * never throws, so broken user config can't prevent provider registration
 * or workflow discovery).
 */
import type {
  AiderDeskProjectDirRemap,
  AiderDeskProviderDefaults,
} from '../../types';

export type { AiderDeskProviderDefaults };

export type ParsedAiderdeskConfig = AiderDeskProviderDefaults;

const VALID_MODES: ReadonlySet<string> = new Set(['code', 'ask', 'architect', 'context', 'agent']);

/**
 * Validate the operator-declared `projectDirRemap` shape. Defensive like the
 * rest of the parser — invalid shapes drop the field rather than throw. We
 * share the same validation that `translateProjectDir`'s runtime JSON parse
 * would apply, so a typo in YAML produces an undefined field rather than a
 * per-turn `parse failed` system chunk.
 */
function parseProjectDirRemap(raw: unknown): AiderDeskProjectDirRemap | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const out: { from: string; to: string }[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { from?: unknown }).from === 'string' &&
        typeof (entry as { to?: unknown }).to === 'string'
      ) {
        out.push({
          from: (entry as { from: string }).from,
          to: (entry as { to: string }).to,
        });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
        out[k] = v;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

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

  const projectDirRemap = parseProjectDirRemap(raw.projectDirRemap);
  if (projectDirRemap !== undefined) {
    result.projectDirRemap = projectDirRemap;
  }

  return result;
}
