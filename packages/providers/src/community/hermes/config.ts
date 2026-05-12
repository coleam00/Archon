import type { HermesProviderDefaults } from '../../types';

export type { HermesProviderDefaults };

export function parseHermesConfig(raw: Record<string, unknown>): HermesProviderDefaults {
  const result: HermesProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.provider === 'string') {
    result.provider = raw.provider;
  }

  if (typeof raw.hermesBinaryPath === 'string') {
    result.hermesBinaryPath = raw.hermesBinaryPath;
  }

  if (typeof raw.toolsets === 'string') {
    result.toolsets = raw.toolsets;
  }

  if (Array.isArray(raw.skills)) {
    const skills = (raw.skills as unknown[]).filter((s): s is string => typeof s === 'string');
    if (skills.length > 0) {
      result.skills = skills;
    }
  }

  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) {
      result.env = env;
    }
  }

  if (typeof raw.maxTurns === 'number' && Number.isInteger(raw.maxTurns) && raw.maxTurns > 0) {
    result.maxTurns = raw.maxTurns;
  }

  if (typeof raw.yolo === 'boolean') {
    result.yolo = raw.yolo;
  }

  if (typeof raw.checkpoints === 'boolean') {
    result.checkpoints = raw.checkpoints;
  }

  if (typeof raw.worktree === 'boolean') {
    result.worktree = raw.worktree;
  }

  return result;
}
