import type { ModelSelection } from '@cursor/sdk';

import type { SendQueryOptions } from '../../types';
import type { CursorProviderDefaults } from './config';

/** SDK server-picked model when config/workflow omit an explicit id. */
export const DEFAULT_MODEL_ID = 'auto';

/** Default efficiency-oriented reasoning when unset. */
export const DEFAULT_MODEL_PARAMS: Record<string, string> = { thinking: 'low' };

export interface ResolvedModelParams {
  params: Record<string, string>;
  warning?: string;
}

function normalizeEffort(value: unknown): string | undefined {
  if (value === 'max') return 'high';
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value === 'xhigh' ? 'high' : value;
  }
  return undefined;
}

/**
 * Resolve Archon workflow `effort` / `thinking` node fields to Cursor SDK
 * `ModelSelection.params` (keyed by parameter id, e.g. `thinking`).
 *
 * Precedence: `thinking` > `effort`. Config `modelParams` merge on top of defaults.
 */
export function resolveModelParams(
  nodeConfig: SendQueryOptions['nodeConfig'] | undefined,
  cursorConfig: CursorProviderDefaults
): ResolvedModelParams {
  const params = { ...DEFAULT_MODEL_PARAMS, ...(cursorConfig.modelParams ?? {}) };

  if (!nodeConfig) return { params };

  const rawThinking = nodeConfig.thinking;
  const rawEffort = nodeConfig.effort;

  if (rawThinking === 'off' || rawEffort === 'off') {
    delete params.thinking;
    return { params };
  }

  const fromThinking = normalizeEffort(rawThinking);
  if (fromThinking) {
    params.thinking = fromThinking;
    return { params };
  }

  const fromEffort = normalizeEffort(rawEffort);
  if (fromEffort) {
    params.thinking = fromEffort;
    return { params };
  }

  if (rawThinking !== undefined && rawThinking !== null && typeof rawThinking === 'object') {
    return {
      params,
      warning:
        'Cursor ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` instead.',
    };
  }

  if (typeof rawThinking === 'string' || typeof rawEffort === 'string') {
    const offender = typeof rawThinking === 'string' ? rawThinking : rawEffort;
    return {
      params,
      warning: `Cursor ignored unknown reasoning level '${String(offender)}'. Valid: low, medium, high, max, off.`,
    };
  }

  return { params };
}

export function toModelSelection(modelId: string, params: Record<string, string>): ModelSelection {
  const paramEntries = Object.entries(params);
  return {
    id: modelId,
    ...(paramEntries.length > 0
      ? {
          params: paramEntries.map(([id, value]) => ({ id, value })),
        }
      : {}),
  };
}

export function resolveModelId(
  requestModel: string | undefined,
  cursorConfig: CursorProviderDefaults
): string {
  const requested = requestModel?.trim();
  const fromConfig = cursorConfig.model?.trim();
  return requested || fromConfig || DEFAULT_MODEL_ID;
}
