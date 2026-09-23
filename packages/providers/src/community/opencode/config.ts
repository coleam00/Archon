import type { OpencodeProviderDefaults, ProviderConfigScope } from '../../types';
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

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseOpencodeConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope
): OpencodeProviderDefaults {
  assertKnownRunConfigKeys(raw, ['model', 'baseUrl', 'agent']);
  // `agent` names an opencode.json agent that no consumer reads on either
  // surface; `baseUrl` points the provider at an already-running OpenCode
  // server, which a single run cannot switch mid-process.
  if (Object.hasOwn(raw, 'agent')) {
    throw new InvalidProviderRunConfigError('agent', 'default OpenCode agents are not consumed');
  }
  const baseUrl = normalizeRunConfigString(raw.baseUrl, 'baseUrl');
  if (baseUrl !== undefined && scope === 'run') {
    throw new InvalidProviderRunConfigError(
      'baseUrl',
      'external OpenCode runtimes are not supported'
    );
  }
  let model = normalizeRunConfigString(raw.model, 'model');
  if (model !== undefined) {
    const parsed = parseModelRef(model);
    if (parsed === null) {
      invalidRunConfigValue('model', "'<provider>/<model>'");
    }
    model = `${parsed.providerID}/${parsed.modelID}`;
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}
