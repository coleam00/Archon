import type { OpencodeProviderDefaults } from '../../types';
import { InvalidProviderRunConfigError } from '../../errors';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../../shared/run-config';

export type { OpencodeProviderDefaults };

export function parseModelRef(modelRef: string): { providerID: string; modelID: string } | null {
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1) return null;

  const providerID = modelRef.slice(0, slashIndex).trim();
  const modelID = modelRef.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) return null;

  return { providerID, modelID };
}

/**
 * Parse raw YAML-derived config into typed OpenCode defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, and parsePiConfig — never throws, so broken user config
 * can't prevent provider registration or workflow discovery).
 */
export function parseOpencodeConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  const result: OpencodeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.baseUrl === 'string') {
    result.baseUrl = raw.baseUrl;
  }

  const opencodeConfig = raw.opencode as Record<string, unknown> | undefined;
  if (typeof opencodeConfig?.agent === 'string') {
    result.agent = opencodeConfig.agent;
  }

  return result;
}

/** Strict counterpart used only for an explicitly selected per-run layer. */
export function parseOpencodeRunConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  assertKnownRunConfigKeys(raw, ['model', 'baseUrl', 'agent']);
  let model = normalizeRunConfigString(raw.model, 'model');
  if (model !== undefined) {
    const parsed = parseModelRef(model);
    if (parsed === null) {
      invalidRunConfigValue('model', "'<provider>/<model>'");
    }
    model = `${parsed.providerID}/${parsed.modelID}`;
  }
  for (const key of ['baseUrl', 'agent'] as const) {
    if (Object.hasOwn(raw, key)) {
      throw new InvalidProviderRunConfigError(
        key,
        key === 'baseUrl'
          ? 'external OpenCode runtimes are not supported'
          : 'default OpenCode agents are not consumed by workflow runs'
      );
    }
  }
  return model === undefined ? {} : { model };
}
