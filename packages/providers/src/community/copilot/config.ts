import type { CopilotProviderDefaults } from '../../types';

export type { CopilotProviderDefaults };

/**
 * Parse raw `assistants.copilot` config into a typed `CopilotProviderDefaults`.
 *
 * Defensive: validates each field's type, silently drops anything malformed,
 * never throws. Mirrors `parseCodexConfig` / `parsePiConfig` — a broken user
 * config must not prevent provider registration or workflow discovery.
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const config: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    config.model = raw.model;
  }

  if (typeof raw.modelReasoningEffort === 'string') {
    const v = raw.modelReasoningEffort;
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') {
      config.modelReasoningEffort = v;
    }
  }

  if (typeof raw.githubToken === 'string') {
    config.githubToken = raw.githubToken;
  }

  if (typeof raw.cliPath === 'string') {
    config.cliPath = raw.cliPath;
  }

  if (
    raw.systemMessage &&
    typeof raw.systemMessage === 'object' &&
    !Array.isArray(raw.systemMessage)
  ) {
    const sm = raw.systemMessage as Record<string, unknown>;
    if (typeof sm.content === 'string') {
      const modeRaw = typeof sm.mode === 'string' ? sm.mode : undefined;
      const mode: 'append' | 'replace' | 'customize' =
        modeRaw === 'replace' || modeRaw === 'customize' ? modeRaw : 'append';
      config.systemMessage = { content: sm.content, mode };
    }
  }

  return config;
}
