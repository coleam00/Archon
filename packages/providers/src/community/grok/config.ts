import type { GrokProviderDefaults } from '../../types';
import { clampEffort, isEffortRung } from '@archon/paths/effort';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../../shared/run-config';

export type { GrokProviderDefaults };

/**
 * Reasoning rungs Grok CLI `--reasoning-effort` accepts (canonical menu,
 * weakest → strongest). `none` is not an Archon rung; `effort: off` omits
 * the flag. `ultra` / `persistent` clamp down to `max`.
 */
export const GROK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type GrokEffort = (typeof GROK_EFFORTS)[number];

export const DEFAULT_GROK_MODEL = 'grok-4.6';

/**
 * Parse raw `assistants.grok` config. Unexpected types are omitted so a
 * broken user config cannot block provider registration.
 */
export function parseGrokConfig(raw: Record<string, unknown>): GrokProviderDefaults {
  const config: GrokProviderDefaults = {};
  if (typeof raw.model === 'string' && raw.model.trim().length > 0) {
    config.model = raw.model.trim();
  }
  if (typeof raw.grokBinaryPath === 'string' && raw.grokBinaryPath.trim().length > 0) {
    config.grokBinaryPath = raw.grokBinaryPath.trim();
  }
  const effort = clampEffort(raw.modelReasoningEffort, GROK_EFFORTS);
  if (effort !== undefined) {
    config.modelReasoningEffort = effort;
  }
  return config;
}

export function parseGrokRunConfig(raw: Record<string, unknown>): GrokProviderDefaults {
  assertKnownRunConfigKeys(raw, ['model', 'grokBinaryPath', 'modelReasoningEffort']);
  const model = normalizeRunConfigString(raw.model, 'model');
  const grokBinaryPath = normalizeRunConfigString(raw.grokBinaryPath, 'grokBinaryPath');
  if (raw.modelReasoningEffort !== undefined && !isEffortRung(raw.modelReasoningEffort)) {
    invalidRunConfigValue('modelReasoningEffort', 'a valid Archon effort level');
  }
  const parsed = parseGrokConfig(raw);
  return {
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(grokBinaryPath === undefined ? {} : { grokBinaryPath }),
  };
}

export function resolveGrokEffort(
  nodeEffort: unknown,
  configured: GrokProviderDefaults['modelReasoningEffort']
): GrokEffort | undefined {
  if (nodeEffort === 'off') return undefined;
  const fromNode = clampEffort(nodeEffort, GROK_EFFORTS);
  if (fromNode !== undefined) return fromNode;
  return clampEffort(configured, GROK_EFFORTS);
}
