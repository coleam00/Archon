import { DEFAULTS } from './defaults';
import { resolveEnvIndirection } from './coerce';

export interface TrackerLinearConfig {
  kind: 'linear';
  apiKey: string;
  endpoint: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
  /** `owner/repo` shorthand surfaced to the dashboard for grouping. */
  repository: string | null;
}

export interface TrackerGitHubConfig {
  kind: 'github';
  token: string;
  owner: string;
  repo: string;
  activeStates: string[];
  terminalStates: string[];
}

export type TrackerConfig = TrackerLinearConfig | TrackerGitHubConfig;
export type TrackerKind = TrackerConfig['kind'];

export interface RetryConfig {
  continuationDelayMs: number;
  failureBaseDelayMs: number;
  maxBackoffMs: number;
}

export interface DispatchConfig {
  maxConcurrent: number;
  /** Per-state caps; keys are lowercased state names. */
  maxConcurrentByState: Record<string, number>;
  retry: RetryConfig;
}

export interface PollingConfig {
  intervalMs: number;
}

export interface CodebaseMapping {
  tracker: TrackerKind;
  /** `owner/repo` for matching against tracker-derived repository labels. */
  repository: string;
  codebaseId: string | null;
}

export interface ConfigSnapshot {
  trackers: TrackerConfig[];
  dispatch: DispatchConfig;
  polling: PollingConfig;
  /**
   * Maps issue.state (case-sensitive) to a workflow name. The Phase 2 stub
   * dispatcher reads this; Phase 3 will pass the workflow into Archon's
   * executeWorkflow.
   */
  stateWorkflowMap: Record<string, string>;
  codebases: CodebaseMapping[];
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStringList(v: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  return v.filter((x): x is string => typeof x === 'string');
}

function asPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return fallback;
}

function asNumberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof key !== 'string') continue;
    const num = asPositiveInt(value, -1);
    if (num >= 0) out[key.toLowerCase()] = num;
  }
  return out;
}

function asStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof value === 'string' && value.trim() !== '') {
      out[key] = value.trim();
    }
  }
  return out;
}

function buildTracker(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  errors: string[]
): TrackerConfig | null {
  const kind = typeof raw.kind === 'string' ? raw.kind.toLowerCase() : '';
  if (kind === 'linear') {
    const apiKey = resolveEnvIndirection(raw.api_key, env) ?? '';
    if (!apiKey) {
      errors.push('linear tracker is missing api_key (set $LINEAR_API_KEY in env or inline)');
      return null;
    }
    const projectSlug =
      typeof raw.project_slug === 'string' && raw.project_slug.trim() !== ''
        ? raw.project_slug.trim()
        : '';
    if (!projectSlug) {
      errors.push('linear tracker is missing project_slug');
      return null;
    }
    const endpoint =
      typeof raw.endpoint === 'string' && raw.endpoint.trim() !== ''
        ? raw.endpoint.trim()
        : DEFAULTS.tracker.endpoint_linear;
    return {
      kind: 'linear',
      apiKey,
      endpoint,
      projectSlug,
      activeStates: asStringList(raw.active_states, DEFAULTS.tracker.linear_active_states),
      terminalStates: asStringList(raw.terminal_states, DEFAULTS.tracker.linear_terminal_states),
      repository:
        typeof raw.repository === 'string' && raw.repository.trim() !== ''
          ? raw.repository.trim()
          : null,
    };
  }
  if (kind === 'github') {
    const token = resolveEnvIndirection(raw.token, env) ?? '';
    if (!token) {
      errors.push('github tracker is missing token (set $GITHUB_TOKEN in env or inline)');
      return null;
    }
    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : '';
    if (!owner || !repo) {
      errors.push('github tracker is missing owner or repo');
      return null;
    }
    return {
      kind: 'github',
      token,
      owner,
      repo,
      activeStates: asStringList(raw.active_states, DEFAULTS.tracker.github_active_states),
      terminalStates: asStringList(raw.terminal_states, DEFAULTS.tracker.github_terminal_states),
    };
  }
  errors.push(`unknown tracker kind '${kind}' (expected 'linear' or 'github')`);
  return null;
}

function buildCodebases(raw: unknown, errors: string[]): CodebaseMapping[] {
  const out: CodebaseMapping[] = [];
  for (const entry of asArray(raw)) {
    const obj = asObject(entry);
    const tracker = typeof obj.tracker === 'string' ? obj.tracker.toLowerCase() : '';
    const repository = typeof obj.repository === 'string' ? obj.repository.trim() : '';
    if (tracker !== 'linear' && tracker !== 'github') {
      errors.push(`codebases[].tracker must be 'linear' or 'github', got '${tracker}'`);
      continue;
    }
    if (!repository) {
      errors.push('codebases[].repository is required');
      continue;
    }
    out.push({
      tracker: tracker,
      repository,
      codebaseId:
        typeof obj.codebase_id === 'string' && obj.codebase_id.trim() !== ''
          ? obj.codebase_id.trim()
          : null,
    });
  }
  return out;
}

export interface BuildSnapshotResult {
  snapshot: ConfigSnapshot;
  errors: string[];
}

export class SnapshotBuildError extends Error {
  constructor(
    message: string,
    public readonly errors: string[]
  ) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

/**
 * Build a fully-resolved snapshot from a raw symphony config object. Throws
 * SnapshotBuildError if no valid tracker can be constructed; otherwise returns
 * the snapshot (errors may still be populated for individual mis-configured
 * trackers/codebases).
 */
export function buildSnapshot(raw: unknown, env: NodeJS.ProcessEnv = process.env): ConfigSnapshot {
  const cfg = asObject(raw);
  const errors: string[] = [];

  const trackers: TrackerConfig[] = [];
  for (const entry of asArray(cfg.trackers)) {
    const built = buildTracker(asObject(entry), env, errors);
    if (built) trackers.push(built);
  }
  if (trackers.length === 0) {
    throw new SnapshotBuildError(
      `symphony config must declare at least one tracker (errors: ${errors.join('; ') || 'no trackers entry'})`,
      errors
    );
  }

  const dispatchRaw = asObject(cfg.dispatch);
  const retryRaw = asObject(dispatchRaw.retry);
  const dispatch: DispatchConfig = {
    maxConcurrent: asPositiveInt(dispatchRaw.max_concurrent, DEFAULTS.dispatch.max_concurrent),
    maxConcurrentByState: asNumberMap(dispatchRaw.max_concurrent_by_state),
    retry: {
      continuationDelayMs: asPositiveInt(
        retryRaw.continuation_delay_ms,
        DEFAULTS.dispatch.retry.continuation_delay_ms
      ),
      failureBaseDelayMs: asPositiveInt(
        retryRaw.failure_base_delay_ms,
        DEFAULTS.dispatch.retry.failure_base_delay_ms
      ),
      maxBackoffMs: asPositiveInt(retryRaw.max_backoff_ms, DEFAULTS.dispatch.retry.max_backoff_ms),
    },
  };

  const pollingRaw = asObject(cfg.polling);
  const polling: PollingConfig = {
    intervalMs: asPositiveInt(pollingRaw.interval_ms, DEFAULTS.polling.interval_ms),
  };

  const stateWorkflowMap = asStringMap(cfg.state_workflow_map);
  const codebases = buildCodebases(cfg.codebases, errors);

  return {
    trackers,
    dispatch,
    polling,
    stateWorkflowMap,
    codebases,
  };
}
