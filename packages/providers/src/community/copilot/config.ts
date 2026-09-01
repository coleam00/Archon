import type { SessionConfig } from '@github/copilot-sdk';
import type { CopilotProviderDefaults } from '../../types';
import { clampEffort, isEffortRung, type AssertNever } from '@archon/paths/effort';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../../shared/run-config';

export type { CopilotProviderDefaults };

/**
 * The reasoning-depth rungs Copilot's SDK accepts, weakest → strongest.
 *
 * The SDK does not export `ReasoningEffort` from its barrel, but its public
 * `SessionConfig` retains the union.
 */
type CopilotEffort = NonNullable<SessionConfig['reasoningEffort']>;

export const COPILOT_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly CopilotEffort[];

export type CopilotEffortsAreComplete = AssertNever<
  Exclude<CopilotEffort, (typeof COPILOT_EFFORTS)[number]>
>;

/**
 * Parse raw `assistants.copilot` config into a typed `CopilotProviderDefaults`.
 *
 * Fallback behavior: fields with unexpected types (or enum values outside the
 * declared set) are silently omitted rather than throwing. A broken user
 * config must not prevent provider registration or workflow discovery.
 * Callers that want strict validation should validate upstream.
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const config: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    config.model = raw.model;
  }

  // Accept any rung of Archon's shared ladder and clamp it to the SDK's enum
  // (which has neither `minimal` nor `max`/`ultra`), so
  // `assistants.copilot.*` takes the same vocabulary a workflow's `effort:`
  // does. Normalizing at parse time keeps
  // `CopilotProviderDefaults.modelReasoningEffort` SDK-shaped.
  const effort = clampEffort(raw.modelReasoningEffort, COPILOT_EFFORTS);
  if (effort !== undefined) {
    config.modelReasoningEffort = effort;
  }

  if (typeof raw.copilotCliPath === 'string') {
    config.copilotCliPath = raw.copilotCliPath;
  }

  if (typeof raw.configDir === 'string') {
    config.configDir = raw.configDir;
  }

  if (typeof raw.enableConfigDiscovery === 'boolean') {
    config.enableConfigDiscovery = raw.enableConfigDiscovery;
  }

  if (typeof raw.useLoggedInUser === 'boolean') {
    config.useLoggedInUser = raw.useLoggedInUser;
  }

  if (
    raw.logLevel === 'none' ||
    raw.logLevel === 'error' ||
    raw.logLevel === 'warning' ||
    raw.logLevel === 'info' ||
    raw.logLevel === 'debug' ||
    raw.logLevel === 'all'
  ) {
    config.logLevel = raw.logLevel;
  }

  return config;
}

/** Strict counterpart used only for an explicitly selected per-run layer. */
export function parseCopilotRunConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  assertKnownRunConfigKeys(raw, [
    'model',
    'modelReasoningEffort',
    'copilotCliPath',
    'configDir',
    'enableConfigDiscovery',
    'useLoggedInUser',
    'logLevel',
  ]);
  const model = normalizeRunConfigString(raw.model, 'model');
  const copilotCliPath = normalizeRunConfigString(raw.copilotCliPath, 'copilotCliPath');
  const configDir = normalizeRunConfigString(raw.configDir, 'configDir');
  if (raw.modelReasoningEffort !== undefined && !isEffortRung(raw.modelReasoningEffort)) {
    invalidRunConfigValue('modelReasoningEffort', 'a valid Archon effort level');
  }
  for (const key of ['enableConfigDiscovery', 'useLoggedInUser'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      invalidRunConfigValue(key, 'a boolean');
    }
  }
  if (
    raw.logLevel !== undefined &&
    (typeof raw.logLevel !== 'string' ||
      !['none', 'error', 'warning', 'info', 'debug', 'all'].includes(raw.logLevel))
  ) {
    invalidRunConfigValue('logLevel', 'none, error, warning, info, debug, or all');
  }
  const parsed = parseCopilotConfig(raw);
  return {
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(copilotCliPath === undefined ? {} : { copilotCliPath }),
    ...(configDir === undefined ? {} : { configDir }),
  };
}
